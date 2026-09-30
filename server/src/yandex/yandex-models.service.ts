import { Injectable, Logger } from '@nestjs/common';
import type { ProviderModel } from '@weragen/types';
import { AppConfigService } from '../config/app-config.service.js';
import { describeCause, withRetry } from '../common/retry.js';
import { YandexAuthService } from './yandex-auth.service.js';

/** Перечень моделей провайдера с отметкой момента получения либо причиной отказа. */
export type ProviderModelList =
    | { readonly ok: true; readonly models: ProviderModel[]; readonly fetchedAt: Date }
    | { readonly ok: false; readonly error: string };

/** Сколько перечень считается свежим. Меньше интервала проверки, чтобы тот всегда обновлял. */
const CACHE_TTL_MS = 30_000;

/**
 * Перечень моделей, доступных в каталоге провайдера.
 *
 * Запрашивается по стандартному для OpenAI пути `GET /v1/models`. Ответ содержит только
 * идентификатор и владельца: сведений о возможностях модели — поддержке вызова инструментов,
 * режиме рассуждения, размере окна контекста — спецификация не предусматривает, поэтому
 * такие признаки в платформе проставляются вручную.
 *
 * Идентификатор приходит полным URI с вшитым каталогом. Хранить его в таком виде нельзя:
 * смена каталога обесценила бы все записи справочника разом. Поэтому префикс настроенного
 * каталога отрезается, и остаётся короткое имя; полный вид сохраняется только для моделей
 * из чужого каталога.
 */
@Injectable()
export class YandexModelsService {
    private readonly logger = new Logger(YandexModelsService.name);
    private cache: { readonly value: ProviderModelList; readonly at: number } | undefined;

    constructor(
        private readonly config: AppConfigService,
        private readonly auth: YandexAuthService,
    ) {}

    /** Возвращает перечень, при необходимости обновляя его. */
    async list(force = false): Promise<ProviderModelList> {
        if (!force && this.cache !== undefined && Date.now() - this.cache.at < CACHE_TTL_MS) {
            return this.cache.value;
        }
        const value = await this.fetchList();
        this.cache = { value, at: Date.now() };
        return value;
    }

    /** Приводит полный URI к короткому имени, если каталог совпадает с настроенным. */
    toShortName(fullId: string): string {
        const prefix = `gpt://${this.config.folderId}/`;
        return this.config.folderId !== '' && fullId.startsWith(prefix)
            ? fullId.slice(prefix.length)
            : fullId;
    }

    private async fetchList(): Promise<ProviderModelList> {
        try {
            const token = await this.auth.getToken();
            const response = await withRetry(() =>
                fetch(`${this.config.baseUrl}/models`, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        ...(this.config.folderId === ''
                            ? {}
                            : { 'x-folder-id': this.config.folderId }),
                    },
                    signal: AbortSignal.timeout(20_000),
                }),
            );

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                return {
                    ok: false,
                    error: `Перечень моделей недоступен: HTTP ${response.status}. ${body.slice(0, 200)}`.trim(),
                };
            }

            const payload = (await response.json()) as {
                data?: ReadonlyArray<{ id?: unknown; owned_by?: unknown }>;
            };

            const models = (payload.data ?? [])
                .filter((entry): entry is { id: string; owned_by?: unknown } =>
                    typeof entry.id === 'string',
                )
                .map((entry) => ({
                    identifier: this.toShortName(entry.id),
                    fullId: entry.id,
                    vendor: typeof entry.owned_by === 'string' ? entry.owned_by : 'неизвестно',
                }));

            return { ok: true, models, fetchedAt: new Date() };
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            this.logger.warn(`перечень моделей не получен: ${message}`);
            return {
                ok: false,
                error: `Не удалось обратиться к провайдеру: ${message}${describeCause(cause)}`,
            };
        }
    }
}
