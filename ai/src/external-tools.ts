import {
    isMcpToolUsed,
    type McpSnapshot,
    type McpToolSelection,
    type McpToolSnapshot,
} from '@weragen/types';

/**
 * Сборка инструментов внешнего сервера в набор платформы.
 *
 * Здесь только то, что не требует ни сети, ни базы данных: построение имени, проверка его
 * допустимости, отбор подмножества. Клиент протокола находится в сервере — ядру о HTTP и
 * дочерних процессах знать незачем.
 */

/**
 * Ограничение формата описания инструментов: имя не длиннее 64 символов из латинских букв,
 * цифр, подчёркивания и дефиса. Обрезка длинного имени порождает
 * совпадения и приводит к молчаливой потере инструмента, поэтому имя отвергается целиком, а
 * причина показывается в карточке подключения.
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Имя внешнего инструмента в пространстве имён платформы. */
export function externalToolName(prefix: string, remoteName: string): string {
    return `${prefix}_${remoteName}`;
}

/** Инструмент, принятый в набор. */
export type PlannedExternalTool = {
    /** Имя в пространстве имён платформы: префикс подключения плюс имя на сервере. */
    readonly name: string;
    /** Имя на стороне сервера — с ним вызывается `tools/call`. */
    readonly remoteName: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
};

export type ExternalToolPlan = {
    readonly accepted: readonly PlannedExternalTool[];
    /** Причины, по которым инструмент в набор не попал. Показываются в карточке. */
    readonly rejected: readonly string[];
};

/**
 * Отбирает инструменты снимка, пригодные для набора.
 *
 * Перебирается снимок, а не перечень отбора: имя, оставшееся в перечне после исчезновения
 * инструмента с сервера, в набор не попадает.
 */
export function planExternalTools(
    prefix: string,
    tools: readonly McpToolSnapshot[],
    selection: McpToolSelection,
): ExternalToolPlan {
    const accepted: PlannedExternalTool[] = [];
    const rejected: string[] = [];

    for (const tool of tools) {
        if (!isMcpToolUsed(selection, tool.name)) continue;

        const name = externalToolName(prefix, tool.name);
        if (!TOOL_NAME_PATTERN.test(name)) {
            rejected.push(
                `${tool.name}: имя "${name}" не проходит проверку формата ` +
                    '(до 64 символов из латинских букв, цифр, подчёркивания и дефиса)',
            );
            continue;
        }

        accepted.push({
            name,
            remoteName: tool.name,
            description: describeExternalTool(tool),
            inputSchema: tool.inputSchema,
        });
    }

    return { accepted, rejected };
}

/**
 * Текст, который увидит модель. Заголовок инструмента, если сервер его сообщил, ставится
 * перед описанием: у части серверов описание пусто, и тогда заголовок остаётся
 * единственным пояснением, а инструмент без пояснения модель вызывает наугад.
 */
function describeExternalTool(tool: McpToolSnapshot): string {
    const title = tool.title === null || tool.title === '' ? null : tool.title;
    const description = tool.description === '' ? null : tool.description;
    if (title !== null && description !== null) return `${title}. ${description}`;
    return title ?? description ?? 'Инструмент внешнего сервера MCP без описания.';
}

/**
 * Секция системного промпта из инструкции сервера.
 *
 * Описания самих инструментов сюда не дублируются: они уходят в поле `tools` запроса к
 * модели, и второй экземпляр расходовал бы контекст без пользы. Инструкция же в поле
 * `tools` не выражается вовсе — иначе передать её нечем.
 */
export function serverInstructionsSection(name: string, snapshot: McpSnapshot): string | null {
    const instructions = snapshot.instructions;
    if (instructions === null || instructions.trim() === '') return null;
    return `## Сервер MCP «${snapshot.serverName ?? name}»\n\n${instructions.trim()}`;
}
