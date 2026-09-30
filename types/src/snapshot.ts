import { z } from 'zod';
import { toolSourceSchema } from './api.js';

/**
 * Снимок постоянной части запроса к модели: всего, что уходит в запрос помимо переписки, —
 * указаний платформы, секций, дописанных к ним, и описаний инструментов.
 *
 * Переписка восстанавливается из журнала, а постоянная часть в журнал не пишется: описания
 * инструментов занимают десятки килобайт и повторялись бы на каждом шаге. Поэтому она
 * хранится отдельно, одной записью на каждое различающееся содержимое, а событие начала шага
 * ссылается на свой снимок. Журнал вместе со снимками восстанавливает отправленный запрос
 * целиком.
 */

/** Инструмент в том виде, в каком его описание ушло модели, с отметкой происхождения. */
export const snapshotToolSchema = z.object({
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
    source: toolSourceSchema,
});
export type SnapshotTool = z.infer<typeof snapshotToolSchema>;

export const requestSnapshotContentSchema = z.object({
    /** Указания платформы. */
    prompt: z.string(),
    /** Секции, дописанные к указаниям: текстовые инструкции серверов MCP. */
    sections: z.array(z.string()),
    /** Инструменты в том порядке, в каком ушли модели, включая терминальные. */
    tools: z.array(snapshotToolSchema),
});
export type RequestSnapshotContent = z.infer<typeof requestSnapshotContentSchema>;

export const requestSnapshotSchema = requestSnapshotContentSchema.extend({
    /** Хеш содержимого: одинаковое содержимое получает один идентификатор. */
    id: z.string(),
    createdAt: z.string(),
});
export type RequestSnapshot = z.infer<typeof requestSnapshotSchema>;
