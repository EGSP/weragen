import { Effect } from 'effect';
import {
    ToolFailure,
    planExternalTools,
    rawInput,
    serverInstructionsSection,
    toolFailure,
    type AnyAgentTool,
} from '@weragen/ai';
import { McpCallFailure, type McpSession } from './mcp-client.service.js';
import type { ActiveMcpConnection } from './mcp.service.js';

/**
 * Инструменты внешних серверов в наборе платформы.
 *
 * Инструмент внешнего сервера объявляется тем же типом, что и собственный: у цикла один
 * контракт, и внешний сервер есть один из его адаптеров. Поэтому усечение объёмного
 * результата, запись в журнал, трассировка и отказ инструмента как штатный исход действуют
 * на внешние инструменты сами собой, а не потому, что их отдельно распространили.
 *
 * Соединение здесь не открывается: оно открывается при первом вызове и живёт до конца хода.
 * Набор собирается из снимка, поэтому подготовка хода к серверам не обращается вовсе.
 */

export type McpToolOptions = {
    readonly callTimeoutMs: number;
    /**
     * Сообщение о том, что снимок разошёлся с сервером. Вызывается, когда сервер отклонил
     * вызов как неизвестный либо не соответствующий схеме.
     */
    readonly onDiverged: (connectionId: string, message: string) => void;
};

export function buildMcpTools(
    connections: readonly ActiveMcpConnection[],
    session: McpSession,
    options: McpToolOptions,
): AnyAgentTool[] {
    const tools: AnyAgentTool[] = [];

    for (const connection of connections) {
        const plan = planExternalTools(
            connection.name,
            connection.snapshot.tools,
            connection.selection,
        );

        for (const planned of plan.accepted) {
            tools.push({
                name: planned.name,
                description: planned.description,
                // Схема получена готовой JSON Schema; проверяет аргументы сам сервер.
                input: rawInput(planned.inputSchema),
                source: 'mcp',
                execute: (args) =>
                    // Сигнал прерывания передаётся вниз: отмена хода должна доходить до
                    // обращения к серверу, иначе прерванный ход ждал бы завершения вызова.
                    Effect.tryPromise({
                        try: (signal) =>
                            session.call(
                                {
                                    id: connection.id,
                                    name: connection.name,
                                    transport: connection.transport,
                                },
                                planned.remoteName,
                                (args ?? {}) as Record<string, unknown>,
                                { timeoutMs: options.callTimeoutMs, signal },
                            ),
                        catch: (cause) => toToolFailure(cause, connection, planned.name, options),
                    }).pipe(
                        Effect.flatMap((outcome) =>
                            outcome.ok
                                ? Effect.succeed(outcome.value)
                                : Effect.fail(
                                      new ToolFailure(
                                          outcome.message,
                                          'Это отказ самого инструмента, а не платформы. Прочитай ' +
                                              'текст и исправь аргументы либо возьми другой инструмент.',
                                      ),
                                  ),
                        ),
                    ),
            } as AnyAgentTool);
        }
    }

    return tools;
}

/** Секции системного промпта из текстовых инструкций серверов. */
export function mcpPromptSections(connections: readonly ActiveMcpConnection[]): string[] {
    return connections
        .map((connection) => serverInstructionsSection(connection.name, connection.snapshot))
        .filter((section): section is string => section !== null);
}

/**
 * Переводит отказ обращения в отказ инструмента.
 *
 * Различие двух причин доходит до модели подсказкой, а не только текстом. Недоступность
 * сервера повторным вызовом не исправляется, и модель следует направить в обход. Отклонение
 * вызова означает расхождение снимка с сервером: карточка помечается, а модель извещается,
 * что состав инструментов изменился.
 */
function toToolFailure(
    cause: unknown,
    connection: ActiveMcpConnection,
    toolName: string,
    options: McpToolOptions,
): ToolFailure {
    if (cause instanceof McpCallFailure && cause.kind === 'rejected') {
        options.onDiverged(connection.id, cause.message);
        return new ToolFailure(
            cause.message,
            `Состав инструментов сервера "${connection.name}" изменился с момента последнего ` +
                'обнаружения. Не повторяй тот же вызов: возьми другой инструмент либо сообщи, ' +
                'что инструмент стал недоступен.',
        );
    }

    return toolFailure(
        `Инструмент ${toolName} не выполнен`,
        'Сервер MCP недоступен, и повтор того же вызова даст тот же результат. Если задача ' +
            'выполнима без этого инструмента — продолжай без него, иначе сообщи о недоступности.',
    )(cause);
}
