import { z } from 'zod';

/**
 * Состав контекста сессии: из чего сложится запрос к модели, если отправить его сейчас.
 *
 * Числа — оценка, а не показания провайдера. Провайдер сообщает расход только суммой по
 * всему запросу и только после обращения, тогда как показать нужно доли — промпт,
 * инструменты, переписку — и до следующего хода. Поэтому состав вычисляется на сервере
 * в момент запроса и нигде не хранится.
 */

/**
 * Часть контекста.
 *
 * `system_prompt` — указания платформы; `mcp_instructions` — текстовые инструкции
 * подключённых серверов MCP, дописанные к промпту; `tools` — описания встроенных и
 * терминальных инструментов; `mcp_tools` — описания инструментов серверов MCP;
 * `messages` — переписка, собранная из журнала.
 */
export const contextSegmentKeySchema = z.enum([
    'system_prompt',
    'mcp_instructions',
    'tools',
    'mcp_tools',
    'messages',
]);
export type ContextSegmentKey = z.infer<typeof contextSegmentKeySchema>;

/**
 * Составляющая части: инструмент по имени либо вид сообщений. Для сообщений имя — один из
 * видов `user`, `assistant`, `tool_calls`, `tool_results`.
 */
export const contextItemSchema = z.object({
    name: z.string(),
    tokens: z.number().int().nonnegative(),
    /** Сколько элементов слито в составляющую: сообщений одного вида, секций. */
    count: z.number().int().nonnegative(),
});
export type ContextItem = z.infer<typeof contextItemSchema>;

export const contextSegmentSchema = z.object({
    key: contextSegmentKeySchema,
    tokens: z.number().int().nonnegative(),
    items: z.array(contextItemSchema),
});
export type ContextSegment = z.infer<typeof contextSegmentSchema>;

export const sessionContextResponseSchema = z.object({
    /** Модель, для которой сделана оценка: от неё зависят и окно, и соотношения. */
    model: z.string(),
    /** Размер окна контекста модели в токенах. */
    window: z.number().int().positive(),
    /**
     * Откуда взят размер окна. `known` — модель есть в перечне платформы; `assumed` — нет, и
     * подставлено осторожное значение, так что процент заполненности приблизителен вдвойне.
     */
    windowSource: z.enum(['known', 'assumed']),
    /** Семейство токенизатора, чьими соотношениями получена оценка. */
    tokenizer: z.string(),
    /** Сумма всех частей. */
    used: z.number().int().nonnegative(),
    /** Части по убыванию размера; составляющие внутри части — так же. */
    segments: z.array(contextSegmentSchema),
});
export type SessionContextResponse = z.infer<typeof sessionContextResponseSchema>;
