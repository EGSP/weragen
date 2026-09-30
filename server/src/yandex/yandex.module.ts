import { Global, Module } from '@nestjs/common';
import { ModelAvailabilityService } from './model-availability.service.js';
import { YandexAuthService } from './yandex-auth.service.js';
import { YandexModelsController } from './yandex-models.controller.js';
import { YandexModelsService } from './yandex-models.service.js';

/**
 * Домен провайдера модели: аутентификация, перечень моделей каталога и периодическая
 * проверка доступности записей справочника.
 *
 * Аутентификация нужна не только агенту, поэтому экземпляр один: иначе кеш IAM-токена
 * дублировался бы и токен перевыпускался бы чаще необходимого.
 */
@Global()
@Module({
    controllers: [YandexModelsController],
    providers: [YandexAuthService, YandexModelsService, ModelAvailabilityService],
    exports: [YandexAuthService, YandexModelsService, ModelAvailabilityService],
})
export class YandexModule {}
