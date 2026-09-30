import { z } from 'zod';
import { sessionEventSchema } from './events.js';
import { sessionKindSchema, sessionSchema } from './session.js';

/**
 * Создание сессии.
 *
 * Один запрос обслуживает два вида: чат создаёт человек, агентскую сессию — другая сессия,
 * когда ей нужен агентский цикл. Сессия вида `workflow` здесь не создаётся: её запускает
 * контроллер воркфлоу, потому что вместе с сессией нужно породить процесс.
 */
export const createSessionRequestSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    kind: sessionKindSchema.optional(),
    /** Порождающая сессия. Обязательна для вида `agent`: он создаётся только программно. */
    parentId: z.string().optional(),
    /** Постановка задачи. Обязательна для вида `agent`, для чата не имеет смысла. */
    task: z.string().min(1).max(20000).optional(),
    /**
     * Имена инструментов, доступных агенту. Отсутствие означает весь набор платформы;
     * перечень сужает его, а расширить не может — предоставляет инструменты платформа.
     */
    tools: z.array(z.string()).optional(),
    modelId: z.string().optional(),
    /**
     * Контекст трассы порождающей стороны в формате W3C Trace Context. Указывается, когда
     * сессию создаёт внешний процесс: платформа знает дерево сессий и без него, но привязала
     * бы сессию к исполнению целиком, а не к конкретному шагу, внутри которого она создана.
     */
    traceparent: z.string().max(200).optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const sendMessageRequestSchema = z.object({
    text: z.string().min(1).max(20000),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const sessionListResponseSchema = z.object({ sessions: z.array(sessionSchema) });
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export const sessionEventsResponseSchema = z.object({
    events: z.array(sessionEventSchema),
    /** Порядковый номер последнего события; клиент передаёт его при переподключении. */
    lastSeq: z.number().int().nonnegative(),
});
export type SessionEventsResponse = z.infer<typeof sessionEventsResponseSchema>;

export const acceptedResponseSchema = z.object({ accepted: z.boolean() });
export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;

/**
 * Источник инструмента. Встроенный написан внутри платформы, внешний получен от сервера
 * MCP. Признак нужен журналу, интерфейсу и трассировке; на проверку аргументов он не
 * влияет — она следует из вида схемы, а не из происхождения инструмента.
 */
export const toolSourceSchema = z.enum(['builtin', 'mcp']);
export type ToolSource = z.infer<typeof toolSourceSchema>;

/** Описание инструмента для интерфейса: имя и текст, который видит модель. */
export const toolInfoSchema = z.object({
    name: z.string(),
    description: z.string(),
    source: toolSourceSchema,
});
export type ToolInfo = z.infer<typeof toolInfoSchema>;

export const toolListResponseSchema = z.object({ tools: z.array(toolInfoSchema) });
export type ToolListResponse = z.infer<typeof toolListResponseSchema>;
