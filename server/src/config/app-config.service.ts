import { Injectable } from '@nestjs/common';

/**
 * Учётные данные авторизованного ключа сервисного аккаунта Yandex Cloud.
 */
export type ServiceAccountKey = {
    readonly keyId: string;
    readonly serviceAccountId: string;
    readonly privateKey: string;
};

export type AuthConfig =
    | { readonly kind: 'static'; readonly token: string }
    | { readonly kind: 'serviceAccount'; readonly key: ServiceAccountKey };

/**
 * Надзор за процессами воркфлоу.
 *
 * Процесс запускается на каждое исполнение, отрабатывает и завершается. Отсюда три
 * величины: сколько процессов допустимо держать одновременно, сколько ждать готовности
 * запущенного и сколько ждать после запроса на прекращение работы, прежде чем завершать
 * процесс принудительно.
 */
export type WorkflowConfig = {
    /** Начало диапазона портов, выдаваемых процессам. */
    readonly portRangeStart: number;
    readonly portRangeSize: number;
    /**
     * Предел одновременно работающих процессов. Без него десяток параллельных исполнений
     * тяжёлого воркфлоу исчерпает ресурсы машины.
     */
    readonly maxProcesses: number;
    readonly readyTimeoutMs: number;
    /** Первая ступень прерывания: сколько ждать самостоятельного завершения процесса. */
    readonly cancelTimeoutMs: number;
};

/**
 * Обращения к внешним серверам MCP.
 *
 * Пределы времени для подключения и вызова заданы отдельно. После обнаружения
 * инструментов ограничение подключения уже не действует, поэтому вызову нужен
 * собственный предел: зависший сервер должен освободить ход без ручной отмены.
 */
export type McpConfig = {
    /** Предел на подключение, инициализацию и запрос перечня инструментов. */
    readonly connectTimeoutMs: number;
    /** Предел на один вызов инструмента. */
    readonly callTimeoutMs: number;
    /**
     * Пороги предупреждения об объёме набора инструментов. Набор не сокращается — сокращение
     * без ведома администратора спрятало бы причину, по которой агент не видит инструмента,
     * — но запись в журнале называет число и оценку токенов схем.
     */
    readonly warnToolCount: number;
    readonly warnSchemaChars: number;
};

export type TracingConfig = {
    readonly enabled: boolean;
    readonly endpoint: string;
    readonly serviceName: string;
    /**
     * Записывать ли в спаны тексты запросов и ответов модели. Без них вид переписки в
     * приёмнике не собирается. В рабочей системе значение должно быть противоположным.
     */
    readonly captureContent: boolean;
};

/**
 * Ошибка конфигурации. Несёт перечень проблем целиком, а не первую из них: при первом
 * запуске незаполненных переменных обычно несколько.
 */
export class ConfigError extends Error {
    constructor(readonly problems: readonly string[]) {
        super(problems.join('\n'));
        this.name = 'ConfigError';
    }
}

const trimmed = (name: string): string => (process.env[name] ?? '').trim();
const unescapeNewlines = (raw: string): string => raw.replace(/\\n/g, '\n');

/**
 * Конфигурация приложения, проверяемая при создании. Сервер не стартует с неполной
 * конфигурацией: обнаружить отсутствие учётных данных или каталога на первом же запросе
 * пользователя хуже, чем при запуске.
 *
 * Модели в конфигурации нет: её источник — справочник. Справочник меняется во время работы и
 * может опустеть уже после запуска, поэтому его проверяет не запуск, а начало хода.
 */
@Injectable()
export class AppConfigService {
    readonly port: number;
    /** Разрешённые источники запросов; перечисляются через запятую. */
    readonly corsOrigin: string[];
    readonly databaseUrl: string;

    readonly folderId: string;
    readonly baseUrl: string;
    readonly auth: AuthConfig;

    readonly maxSteps: number;
    readonly temperature: number;
    readonly maxTokens: number | undefined;
    readonly toolResultMaxChars: number;

    readonly tracing: TracingConfig;
    readonly workflows: WorkflowConfig;
    readonly mcp: McpConfig;

    /** Адрес платформы, который передаётся процессам воркфлоу для обратных обращений. */
    readonly publicUrl: string;

    constructor() {
        const problems: string[] = [];

        this.port = Number(trimmed('PORT') || 3100);
        this.corsOrigin = (trimmed('CORS_ORIGIN') || 'http://localhost:5273,http://127.0.0.1:5273')
            .split(',')
            .map((origin) => origin.trim())
            .filter((origin) => origin !== '');

        this.databaseUrl = trimmed('DATABASE_URL');
        if (this.databaseUrl === '') {
            problems.push('DATABASE_URL не задана. Пример: postgresql://weragen:weragen@localhost:5433/weragen');
        }

        this.folderId = trimmed('YANDEX_FOLDER_ID');
        if (this.folderId === '') {
            problems.push(
                'YANDEX_FOLDER_ID не задан. Короткие идентификаторы моделей справочника ' +
                    'дополняются им до URI вида gpt://<folder>/<model>.',
            );
        }

        this.baseUrl = trimmed('YANDEX_BASE_URL') || 'https://llm.api.cloud.yandex.net/v1';

        const staticToken = trimmed('YANDEX_IAM_TOKEN');
        const keyId = trimmed('YANDEX_KEY_ID');
        const serviceAccountId = trimmed('YANDEX_SERVICE_ACCOUNT_ID');
        const privateKey = unescapeNewlines(process.env['YANDEX_PRIVATE_KEY'] ?? '').trim();

        if (staticToken !== '') {
            this.auth = { kind: 'static', token: staticToken };
        } else if (keyId !== '' && serviceAccountId !== '' && privateKey !== '') {
            this.auth = { kind: 'serviceAccount', key: { keyId, serviceAccountId, privateKey } };
        } else {
            this.auth = { kind: 'static', token: '' };
            const missing = [
                keyId === '' ? 'YANDEX_KEY_ID' : null,
                serviceAccountId === '' ? 'YANDEX_SERVICE_ACCOUNT_ID' : null,
                privateKey === '' ? 'YANDEX_PRIVATE_KEY' : null,
            ].filter((name): name is string => name !== null);
            problems.push(
                'Не настроена аутентификация в Yandex Cloud. Задайте либо YANDEX_IAM_TOKEN, ' +
                    `либо ключ сервисного аккаунта целиком — не хватает: ${missing.join(', ')}.`,
            );
        }

        this.maxSteps = Number(trimmed('AGENT_MAX_STEPS') || 10);
        this.temperature = Number(trimmed('AGENT_TEMPERATURE') || 0.3);
        const maxTokensRaw = trimmed('AGENT_MAX_TOKENS');
        this.maxTokens = maxTokensRaw === '' ? undefined : Number(maxTokensRaw);
        this.toolResultMaxChars = Number(trimmed('TOOL_RESULT_MAX_CHARS') || 8000);

        this.mcp = {
            connectTimeoutMs: Number(trimmed('MCP_CONNECT_TIMEOUT_MS') || 30000),
            callTimeoutMs: Number(trimmed('MCP_CALL_TIMEOUT_MS') || 60000),
            warnToolCount: Number(trimmed('MCP_WARN_TOOL_COUNT') || 60),
            warnSchemaChars: Number(trimmed('MCP_WARN_SCHEMA_CHARS') || 60000),
        };

        this.workflows = {
            portRangeStart: Number(trimmed('WORKFLOW_PORT_RANGE_START') || 3200),
            portRangeSize: Number(trimmed('WORKFLOW_PORT_RANGE_SIZE') || 64),
            maxProcesses: Number(trimmed('WORKFLOW_MAX_PROCESSES') || 4),
            readyTimeoutMs: Number(trimmed('WORKFLOW_READY_TIMEOUT_MS') || 20000),
            cancelTimeoutMs: Number(trimmed('WORKFLOW_CANCEL_TIMEOUT_MS') || 5000),
        };

        // Адрес, по которому процесс воркфлоу обращается к платформе. Отдельная переменная,
        // а не сборка из порта: платформа может стоять за обратным прокси, и тогда её
        // собственный порт процессу не подходит.
        this.publicUrl = (trimmed('PUBLIC_URL') || `http://127.0.0.1:${this.port}`).replace(/\/+$/, '');

        const endpoint = trimmed('OTEL_EXPORTER_OTLP_ENDPOINT').replace(/\/+$/, '');
        const capture = trimmed('OTEL_CAPTURE_CONTENT').toLowerCase();
        this.tracing = {
            enabled: endpoint !== '',
            endpoint,
            serviceName: trimmed('OTEL_SERVICE_NAME') || 'weragen-server',
            captureContent: capture !== 'false' && capture !== '0',
        };

        if (problems.length > 0) throw new ConfigError(problems);
    }
}
