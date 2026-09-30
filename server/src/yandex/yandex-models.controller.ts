import { Controller, Get, Post } from '@nestjs/common';
import type { AcceptedResponse, ProviderModelsResponse } from '@weragen/types';
import { ModelAvailabilityService } from './model-availability.service.js';
import { YandexModelsService } from './yandex-models.service.js';

/**
 * Обращения к провайдеру, связанные с моделями: перечень доступных и принудительная
 * перепроверка справочника. Находится в домене провайдера, а не в справочнике моделей,
 * потому что отвечает за общение с внешней системой, а не за хранение записей.
 */
@Controller('api/yandex/models')
export class YandexModelsController {
    constructor(
        private readonly models: YandexModelsService,
        private readonly availability: ModelAvailabilityService,
    ) {}

    /** Перечень моделей каталога — источник вариантов при добавлении в справочник. */
    @Get()
    async list(): Promise<ProviderModelsResponse> {
        const result = await this.models.list();
        return result.ok
            ? { models: result.models, fetchedAt: result.fetchedAt.toISOString(), error: null }
            : { models: [], fetchedAt: null, error: result.error };
    }

    /** Немедленная перепроверка доступности всех записей справочника. */
    @Post('check')
    async check(): Promise<AcceptedResponse> {
        const updated = await this.availability.refresh(true);
        return { accepted: updated > 0 };
    }
}
