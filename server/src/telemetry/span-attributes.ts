import type { Attributes } from '@opentelemetry/api';
import type { AgentMessage, ModelReply, ObservedToolCall, ToolResult } from '@weragen/ai';

/**
 * Атрибуты спанов в двух наборах соглашений сразу.
 *
 * Приёмники договорились по-разному: `gen_ai.*` (OpenTelemetry) понимает Langfuse,
 * `llm.*` и `openinference.*` (OpenInference) — Phoenix. Наборы не конфликтуют, поэтому
 * выставляются оба: это дешевле привязки к одному приёмнику.
 *
 * Различие содержательное. `gen_ai.*` описывает обращение плоскими значениями, а
 * OpenInference раскладывает диалог по сообщениям, и именно из этой раскладки собирается
 * вид переписки.
 */

export function sessionAttributes(sessionId: string, userId: string): Attributes {
    return {
        'session.id': sessionId,
        'user.id': userId,
        'gen_ai.conversation.id': sessionId,
    };
}

/**
 * Атрибуты исполнения воркфлоу.
 *
 * Вид сессии проставляется и отдельным атрибутом, и в имени спана: в перечне трасс имя —
 * единственное, что видно без раскрытия, и `workflow echo` там отличимо, а
 * `invoke_workflow` — нет.
 *
 * `openinference.span.kind` берётся `CHAIN`: у OpenInference это узел управления, а не
 * обращение к модели. Без него приёмник покажет узел безымянным.
 */
export function workflowAttributes(
    sessionId: string,
    userId: string,
    name: string,
    version: string | null,
): Attributes {
    return {
        ...sessionAttributes(sessionId, userId),
        'gen_ai.operation.name': 'invoke_workflow',
        'openinference.span.kind': 'CHAIN',
        'weragen.session.kind': 'workflow',
        'weragen.workflow.name': name,
        ...(version === null ? {} : { 'weragen.workflow.version': version }),
    };
}

/**
 * Предел длины значений входа и итога на спане. Итог воркфлоу ограничений размера не имеет
 * и доходит до мегабайтов, а приёмник хранит атрибуты целиком: полный итог раздувал бы
 * хранилище трасс, ничего не добавляя к пониманию исполнения.
 */
const VALUE_LIMIT = 4000;

function clip(text: string): string {
    return text.length <= VALUE_LIMIT
        ? text
        : `${text.slice(0, VALUE_LIMIT)}… [показаны первые ${VALUE_LIMIT} из ${text.length} символов]`;
}

/**
 * Вход хода агента на спане сессии — сообщение человека либо постановка задачи.
 *
 * Как и у воркфлоу, значение записывается при любой настройке: без него перечень сессий в
 * приёмнике показывает пустую колонку первого входа. Различие лишь в том, попадает ли туда
 * сам текст или только его объём.
 */
export function turnInputAttributes(input: string, captureContent: boolean): Attributes {
    return {
        'input.value': captureContent ? clip(input) : `запрос из ${input.length} символов`,
        'input.mime_type': 'text/plain',
    };
}

/** Итог хода агента на спане сессии. Отказ передаётся текстом — он же в состоянии спана. */
export function turnOutputAttributes(
    outcome: { readonly ok: boolean; readonly text: string },
    captureContent: boolean,
): Attributes {
    if (!outcome.ok) {
        return { 'output.value': clip(`Отказ: ${outcome.text}`), 'output.mime_type': 'text/plain' };
    }
    return {
        'output.value': captureContent
            ? clip(outcome.text)
            : `ответ из ${outcome.text.length} символов`,
        'output.mime_type': 'text/plain',
    };
}

/**
 * Вход исполнения воркфлоу на спане сессии.
 *
 * Записывается всегда, а не только при включённой записи содержимого: перечень сессий в
 * приёмнике показывает первый вход отдельной колонкой, и пустое значение там означает, что
 * сессию нельзя отличить от соседних, не раскрыв её. Поэтому имя воркфлоу входит в значение
 * при любой настройке, а сам входной объект — только когда содержимое записывается.
 */
export function workflowInputAttributes(
    name: string,
    input: unknown,
    captureContent: boolean,
): Attributes {
    const serialized = captureContent ? JSON.stringify(input) : undefined;
    return {
        'input.value':
            serialized === undefined ? `воркфлоу ${name}` : clip(`воркфлоу ${name} · ${serialized}`),
        'input.mime_type': 'text/plain',
    };
}

/**
 * Итог исполнения воркфлоу на спане сессии.
 *
 * Итог приводится к краткому сообщению, а не переносится целиком: колонка приёмника
 * показывает первые символы значения, и объёмный результат в ней всё равно не помещается.
 * Причина отказа передаётся текстом — она же стоит в состоянии спана.
 */
export function workflowOutputAttributes(
    report: { readonly ok: boolean; readonly result: unknown; readonly message: string },
    captureContent: boolean,
): Attributes {
    if (!report.ok) {
        return {
            'output.value': clip(`Отказ: ${report.message}`),
            'output.mime_type': 'text/plain',
        };
    }

    const serialized = JSON.stringify(report.result) ?? 'без результата';
    return {
        'output.value': captureContent
            ? clip(`Завершено. Результат: ${serialized}`)
            : `Завершено. Результат: ${serialized.length} символов.`,
        'output.mime_type': 'text/plain',
    };
}

/** Атрибуты шага воркфлоу. Шаг — тоже узел управления, поэтому вид спана тот же. */
export function workflowStepAttributes(
    sessionId: string,
    userId: string,
    stepId: string,
    workflowName: string,
): Attributes {
    return {
        ...sessionAttributes(sessionId, userId),
        'openinference.span.kind': 'CHAIN',
        'weragen.session.kind': 'workflow',
        'weragen.workflow.name': workflowName,
        'weragen.workflow.step.id': stepId,
    };
}

export function chatRequestAttributes(
    modelName: string,
    modelUri: string,
    temperature: number,
    messages: readonly AgentMessage[],
    toolCount: number,
    captureContent: boolean,
): Attributes {
    const attributes: Attributes = {
        'gen_ai.operation.name': 'chat',
        'gen_ai.system': 'yandex',
        'gen_ai.request.model': modelUri,
        'gen_ai.request.temperature': temperature,
        'openinference.span.kind': 'LLM',
        'llm.model_name': modelName,
        'llm.provider': 'yandex',
        'llm.system': 'openai',
        'llm.invocation_parameters': JSON.stringify({ temperature, tool_count: toolCount }),
    };

    if (!captureContent) return attributes;

    attributes['input.value'] = JSON.stringify({ messages });
    attributes['input.mime_type'] = 'application/json';

    messages.forEach((message, index) => {
        const prefix = `llm.input_messages.${index}.message`;
        attributes[`${prefix}.role`] = message.role;
        if (message.role === 'tool') {
            attributes[`${prefix}.content`] = message.content;
            attributes[`${prefix}.tool_call_id`] = message.callId;
            return;
        }
        if (message.content !== '') attributes[`${prefix}.content`] = message.content;
        if (message.role === 'assistant') {
            message.toolCalls.forEach((call, callIndex) => {
                const callPrefix = `${prefix}.tool_calls.${callIndex}.tool_call`;
                attributes[`${callPrefix}.id`] = call.id;
                attributes[`${callPrefix}.function.name`] = call.name;
                attributes[`${callPrefix}.function.arguments`] = call.rawArguments;
            });
        }
    });

    return attributes;
}

export function chatResponseAttributes(reply: ModelReply, captureContent: boolean): Attributes {
    const attributes: Attributes = {
        'gen_ai.usage.input_tokens': reply.usage.prompt,
        'gen_ai.usage.output_tokens': reply.usage.completion,
        'gen_ai.response.tool_calls': reply.toolCalls.length,
        'llm.token_count.prompt': reply.usage.prompt,
        'llm.token_count.completion': reply.usage.completion,
        'llm.token_count.total': reply.usage.prompt + reply.usage.completion,
        ...(reply.finishReason === undefined
            ? {}
            : { 'gen_ai.response.finish_reasons': [reply.finishReason] }),
    };

    if (!captureContent) return attributes;

    attributes['output.value'] = JSON.stringify(reply);
    attributes['output.mime_type'] = 'application/json';
    attributes['llm.output_messages.0.message.role'] = 'assistant';
    if (reply.finishReason !== undefined) {
        attributes['llm.output_messages.0.message.finish_reason'] = reply.finishReason;
    }

    if (reply.reasoning !== undefined) {
        // Сообщение с рассуждением раскладывается на части: часть с типом `reasoning`
        // приёмник показывает отдельным блоком прямо в виде переписки. При этом
        // `message.content` выставлять нельзя — текст ответа отобразится дважды.
        const parts = 'llm.output_messages.0.message.contents';
        attributes[`${parts}.0.message_content.type`] = 'reasoning';
        attributes[`${parts}.0.message_content.text`] = reply.reasoning;
        if (reply.content !== '') {
            attributes[`${parts}.1.message_content.type`] = 'text';
            attributes[`${parts}.1.message_content.text`] = reply.content;
        }
        attributes['gen_ai.completion.reasoning'] = reply.reasoning.slice(0, 16000);
    } else if (reply.content !== '') {
        attributes['llm.output_messages.0.message.content'] = reply.content;
    }

    reply.toolCalls.forEach((call, index) => {
        const prefix = `llm.output_messages.0.message.tool_calls.${index}.tool_call`;
        attributes[`${prefix}.id`] = call.id;
        attributes[`${prefix}.function.name`] = call.name;
        attributes[`${prefix}.function.arguments`] = call.rawArguments;
    });

    return attributes;
}

export function toolCallAttributes(call: ObservedToolCall, captureContent: boolean): Attributes {
    return {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': call.name,
        'gen_ai.tool.call.id': call.callId,
        'openinference.span.kind': 'TOOL',
        'tool.name': call.name,
        // Место вызова в ходе. Нужно, чтобы отличить повтор того же вызова на следующем шаге
        // от одновременных вызовов в одной пачке: по имени и аргументам они неразличимы.
        'weragen.tool.step': call.step,
        'weragen.tool.batch.size': call.batchSize,
        'weragen.tool.batch.index': call.batchIndex,
        ...(captureContent
            ? {
                  'tool.parameters': call.rawArguments,
                  'input.value': call.rawArguments,
                  'input.mime_type': 'application/json',
              }
            : {}),
    };
}

/**
 * Атрибуты исхода вызова.
 *
 * Класс исхода проставляется всегда, в том числе при успехе: по нему выбираются неверные
 * вызовы, и без него отобрать их можно было бы только по признаку ошибки спана, который
 * ничего не говорит о причине. Общепринятого имени для такого атрибута нет, поэтому взято
 * собственное пространство имён.
 *
 * Содержимое результата пишется только при успехе: у отказа оно дублирует сообщение,
 * вынесенное в состояние спана.
 */
export function toolResultAttributes(result: ToolResult, captureContent: boolean): Attributes {
    return {
        'weragen.tool.outcome': result.kind,
        ...(captureContent && result.kind === 'ok'
            ? {
                  'output.value': result.content.slice(0, 8000),
                  'output.mime_type': 'application/json',
              }
            : {}),
    };
}
