import { z } from 'zod';

/**
 * Вид сессии.
 *
 * Виды различаются тем, кто подаёт вход и что считается завершением; всё остальное —
 * журнал, поток событий, прерывание, владелец — у них общее.
 *
 * `chat` — вход от человека, ходов неограниченно, завершения не наступает.
 * `workflow` — вход от триггера, агентского цикла нет вовсе, завершение по сообщению
 * от процесса воркфлоу.
 * `agent` — вход одной постановкой задачи от другой сессии, завершение по вызову
 * терминального инструмента. Участия человека не требует.
 */
export const sessionKindSchema = z.enum(['chat', 'workflow', 'agent']);
export type SessionKind = z.infer<typeof sessionKindSchema>;

/**
 * Состояние сессии. `running` означает, что ход или исполнение идёт прямо сейчас.
 * Терминальные состояния `completed` и `failed` достижимы только для видов `workflow` и
 * `agent`: чат-сессия завершения не имеет и остаётся в `idle` между ходами.
 */
export const sessionStatusSchema = z.enum(['idle', 'running', 'completed', 'failed']);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const renameSessionRequestSchema = z.object({
    title: z.string().min(1).max(200),
});
export type RenameSessionRequest = z.infer<typeof renameSessionRequestSchema>;

/**
 * Итог заполнения модели у сессий, где отметка отсутствует.
 *
 * Пропущенные считаются отдельно от заполненных: сессия без единого хода модели не
 * использовала вовсе, и приписать ей модель было бы вымыслом, а не восстановлением.
 */
export const backfillModelsResponseSchema = z.object({
    updated: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
});
export type BackfillModelsResponse = z.infer<typeof backfillModelsResponseSchema>;

export const sessionSchema = z.object({
    id: z.string(),
    title: z.string(),
    kind: sessionKindSchema,
    status: sessionStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    /** Число событий в журнале — по нему клиент понимает, есть ли что догружать. */
    eventCount: z.number().int().nonnegative(),
    /**
     * Запись справочника, закреплённая за сессией. Пусто в двух случаях: модель ещё не
     * назначалась — чат создан при пустом справочнике и получит модель по умолчанию первым
     * ходом, — либо запись удалена, и тогда ход отклоняется, пока не выбрана другая модель.
     */
    modelId: z.string().nullable(),
    /**
     * Идентификатор модели, назначенной сессии. Сохраняется и после удаления записи
     * справочника: по нему видно, какой моделью велась сессия, и им же называется модель в
     * отказе хода.
     */
    modelName: z.string().nullable(),

    /** Порождающая сессия. Пусто у корневых: чат-сессия потомком не бывает вовсе. */
    parentId: z.string().nullable(),
    /** Карточка реестра — только для сессий вида `workflow`. */
    workflowId: z.string().nullable(),
    workflowName: z.string().nullable(),

    /**
     * Итог завершённой сессии. Для вида `workflow` — объект, сообщённый процессом; для
     * вида `agent` — текст, переданный терминальным вызовом.
     */
    result: z.unknown(),
    failureMessage: z.string().nullable(),
});
export type Session = z.infer<typeof sessionSchema>;
