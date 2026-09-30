// Конфигурация читается до создания модулей: сервисы обращаются к ней в конструкторах.
import './load-env.js';

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { AppConfigService, ConfigError } from './config/app-config.service.js';
import { initTracing, shutdownTracing } from './telemetry/tracing.js';

async function bootstrap(): Promise<void> {
    let config: AppConfigService;
    try {
        config = new AppConfigService();
    } catch (error) {
        if (error instanceof ConfigError) {
            process.stderr.write('\nЗапуск невозможен: конфигурация неполна.\n\n');
            for (const problem of error.problems) process.stderr.write(`  • ${problem}\n`);
            process.stderr.write('\nСкопируйте .env.example в .env и заполните значения.\n\n');
            process.exit(1);
        }
        throw error;
    }

    initTracing(config.tracing);

    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        // Открытые соединения при остановке разрываются принудительно. По умолчанию Fastify
        // дожидается завершения запросов, а поток событий сессии не завершается сам, поэтому
        // остановка длилась бы до предела, отведённого pm2, и заканчивалась принудительным
        // прекращением процесса — то есть тем, от чего добровольное завершение и уводит.
        new FastifyAdapter({ forceCloseConnections: true }),
        { bufferLogs: false },
    );
    // Методы перечисляются явно. Запросы PATCH и DELETE не относятся к простым, поэтому
    // браузер предваряет их запросом OPTIONS, и отсутствие метода в ответе на него приводит
    // к отказу ещё до обращения к серверу — с сообщением о сетевой ошибке, а не о запрете.
    app.enableCors({
        origin: config.corsOrigin,
        credentials: true,
        methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Last-Event-ID'],
    });
    app.enableShutdownHooks();

    await app.listen({ port: config.port, host: '0.0.0.0' });

    const logger = new Logger('bootstrap');
    logger.log(`сервер слушает порт ${config.port}`);
    logger.log(
        config.tracing.enabled
            ? `трассировка отправляется на ${config.tracing.endpoint}`
            : 'трассировка выключена: OTEL_EXPORTER_OTLP_ENDPOINT не задан',
    );

    // Остановка выполняется однократно: требование о завершении приходит и сообщением, и
    // сигналом, а повторное закрытие уже закрытого приложения оканчивается отказом.
    let stopping: Promise<void> | null = null;
    const stop = (): Promise<void> => {
        stopping ??= (async () => {
            await app.close();
            await shutdownTracing();
        })();
        return stopping;
    };
    const stopAndExit = (): void => void stop().then(() => process.exit(0));

    process.on('SIGINT', stopAndExit);
    process.on('SIGTERM', stopAndExit);
    // Сообщение «shutdown» посылает pm2. В Windows сигнал, посланный процессу извне,
    // прекращает работу немедленно, и закрыть слушающий сокет приложение не успевает;
    // сообщение по каналу IPC такой возможности не лишает (см. ecosystem.config.cjs).
    process.on('message', (message) => {
        if (message === 'shutdown') stopAndExit();
    });
}

void bootstrap();
