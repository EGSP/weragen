import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { ModelAvailability } from '@weragen/types';
import { PrismaService } from '../database/prisma.service.js';
import { YandexModelsService } from './yandex-models.service.js';

/** Как часто перепроверяется доступность моделей справочника. */
const INTERVAL_MS = 60_000;

/**
 * Периодическая проверка доступности моделей.
 *
 * Доступность определяется наличием модели в перечне провайдера, а не пробным обращением:
 * обращение расходует токены и время, тогда как ответ на вопрос «существует ли модель»
 * даёт перечень.
 *
 * Три исхода различаются намеренно. Модель есть в перечне — доступна. Перечень получен, но
 * модели в нём нет — неверна запись в справочнике либо модель отключена в каталоге. Перечень
 * получить не удалось — неисправно окружение, и о самой модели ничего не известно; в этом
 * случае прежнее суждение о ней не заменяется на «отсутствует», потому что оснований для
 * такого вывода нет.
 *
 * Таймер заведён напрямую, без планировщика: одна периодическая задача не оправдывает
 * дополнительной зависимости, а её остановка при завершении приложения важнее удобства
 * объявления.
 */
@Injectable()
export class ModelAvailabilityService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ModelAvailabilityService.name);
    private timer: NodeJS.Timeout | undefined;
    /** Не допускает наложения проверок, если очередная затянулась дольше интервала. */
    private running = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly models: YandexModelsService,
    ) {}

    onModuleInit(): void {
        void this.refresh();
        this.timer = setInterval(() => void this.refresh(), INTERVAL_MS);
        // Таймер не должен удерживать процесс при завершении работы.
        this.timer.unref();
    }

    onModuleDestroy(): void {
        if (this.timer !== undefined) clearInterval(this.timer);
    }

    /** Обновляет доступность всех записей справочника. Возвращает число обновлённых. */
    async refresh(force = false): Promise<number> {
        if (this.running) return 0;
        this.running = true;
        try {
            const profiles = await this.prisma.llmModel.findMany({
                select: { id: true, identifier: true, availability: true },
            });
            if (profiles.length === 0) return 0;

            const list = await this.models.list(force);
            const now = new Date();

            if (!list.ok) {
                await this.prisma.llmModel.updateMany({
                    data: {
                        availability: 'unreachable' satisfies ModelAvailability,
                        lastCheckAt: now,
                        lastCheckMessage: list.error,
                    },
                });
                return profiles.length;
            }

            const known = new Set(list.models.flatMap((model) => [model.identifier, model.fullId]));

            for (const profile of profiles) {
                const present = known.has(profile.identifier);
                await this.prisma.llmModel.update({
                    where: { id: profile.id },
                    data: {
                        availability: (present
                            ? 'available'
                            : 'not_listed') satisfies ModelAvailability,
                        lastCheckAt: now,
                        lastCheckMessage: present
                            ? `Модель присутствует в перечне провайдера (${list.models.length} моделей).`
                            : 'Модели нет в перечне провайдера. Проверьте идентификатор и каталог.',
                    },
                });
            }

            return profiles.length;
        } catch (cause) {
            this.logger.warn(
                `проверка доступности не выполнена: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
            return 0;
        } finally {
            this.running = false;
        }
    }
}
