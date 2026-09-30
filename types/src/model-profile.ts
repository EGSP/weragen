import { z } from 'zod';
import { sessionKindSchema } from './session.js';

/**
 * Профиль модели — запись в справочнике платформы. Справочник один на всю установку, как и
 * пометка модели по умолчанию: модель есть свойство развёртывания, а не пользователя.
 *
 * Справочник — единственный источник модели. В конфигурации модель не задаётся, и пока
 * справочник пуст, ход агента не запускается: отказ получает то действие, которое ход
 * запускает.
 */

/**
 * Доступность модели.
 *
 * Различаются четыре состояния, потому что они требуют разных действий и разного доверия.
 * `available` — модель присутствует в перечне провайдера. `not_listed` — перечень получен,
 * модели в нём нет: скорее всего ошибка в идентификаторе либо модель отключена в каталоге.
 * `unreachable` — перечень получить не удалось: нет связи или отказано в доступе, и о самой
 * модели ничего не известно. `unknown` — проверка ещё не выполнялась.
 *
 * Различие между `not_listed` и `unreachable` существенно: в первом случае неверна запись,
 * во втором — окружение, и правка карточки ничего не даст.
 */
export const modelAvailabilitySchema = z.enum([
    'unknown',
    'available',
    'not_listed',
    'unreachable',
]);
export type ModelAvailability = z.infer<typeof modelAvailabilitySchema>;

/**
 * Сессия, в которой прямо сейчас идёт ход на модели. Показывается в карточке модели и
 * перечисляется в отказе удаления: запись нельзя удалить, пока ею исполняется ход.
 */
export const modelSessionSchema = z.object({
    id: z.string(),
    title: z.string(),
    kind: sessionKindSchema,
});
export type ModelSession = z.infer<typeof modelSessionSchema>;

export const modelProfileSchema = z.object({
    id: z.string(),
    /**
     * Короткое имя модели (`qwen3.6-35b-a3b/latest`) либо полный URI, если модель лежит в
     * другом каталоге. Короткое имя дополняется каталогом из конфигурации, поэтому смена
     * каталога не требует правки карточек.
     *
     * Задаётся при создании и не меняется, поэтому карточка и модель соответствуют друг
     * другу однозначно: сессия, закреплённая за карточкой, не может перейти на другую модель
     * без явного выбора. Для другой модели заводится новая карточка.
     */
    identifier: z.string(),
    isDefault: z.boolean(),
    /**
     * Признаки, проставляемые вручную. Перечень моделей провайдера сведений о возможностях
     * не содержит — спецификация OpenAI для него описывает только идентификатор и владельца.
     */
    supportsTools: z.boolean(),
    supportsReasoning: z.boolean(),
    availability: modelAvailabilitySchema,
    lastCheckAt: z.string().nullable(),
    lastCheckMessage: z.string().nullable(),
    createdAt: z.string(),
    /**
     * Сессии, в которых прямо сейчас идёт ход на этой модели. Вычисляется на каждый запрос и
     * не хранится: ход начинается и завершается независимо от справочника.
     */
    activeSessions: z.array(modelSessionSchema),
});
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const createModelProfileRequestSchema = z.object({
    identifier: z.string().min(1).max(300),
    isDefault: z.boolean().optional(),
    supportsTools: z.boolean().optional(),
    supportsReasoning: z.boolean().optional(),
});
export type CreateModelProfileRequest = z.infer<typeof createModelProfileRequestSchema>;

/** Правка карточки. Идентификатора в ней нет: он задаётся при создании и не меняется. */
export const updateModelProfileRequestSchema = createModelProfileRequestSchema
    .omit({ identifier: true })
    .partial();
export type UpdateModelProfileRequest = z.infer<typeof updateModelProfileRequestSchema>;

export const modelListResponseSchema = z.object({
    models: z.array(modelProfileSchema),
});
export type ModelListResponse = z.infer<typeof modelListResponseSchema>;

/**
 * Отказ в удалении модели, которой исполняются ходы. Тело ответа с кодом 409 перечисляет
 * эти сессии: к ним можно перейти, чтобы дождаться завершения хода или прервать его.
 */
export const modelInUseErrorSchema = z.object({
    statusCode: z.literal(409),
    error: z.string(),
    message: z.string(),
    sessions: z.array(modelSessionSchema),
});
export type ModelInUseError = z.infer<typeof modelInUseErrorSchema>;

export const selectModelRequestSchema = z.object({ modelId: z.string() });
export type SelectModelRequest = z.infer<typeof selectModelRequestSchema>;

/** Модель из перечня провайдера. */
export const providerModelSchema = z.object({
    /** Короткое имя без префикса каталога, если каталог совпадает с настроенным. */
    identifier: z.string(),
    /** Полный идентификатор, как его вернул провайдер. */
    fullId: z.string(),
    /** Производитель из поля `owned_by`: Yandex, DeepSeek, Alibaba, OpenAI. */
    vendor: z.string(),
});
export type ProviderModel = z.infer<typeof providerModelSchema>;

export const providerModelsResponseSchema = z.object({
    models: z.array(providerModelSchema),
    /** Момент, на который перечень актуален. Пусто, если получить его не удалось. */
    fetchedAt: z.string().nullable(),
    /** Причина, по которой перечень недоступен. */
    error: z.string().nullable(),
});
export type ProviderModelsResponse = z.infer<typeof providerModelsResponseSchema>;
