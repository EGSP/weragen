import type {
    ContextItem,
    ContextSegment,
    RequestSnapshotContent,
    SessionContextResponse,
    SessionEvent,
} from '@weragen/types';
import { buildMessages } from './build-messages.js';
import type { ToolSpec } from './tool.js';
import { estimateTokens, tokenizerFor } from './tokenizer.js';

/**
 * Состав контекста: из чего сложится запрос к модели, если отправить его сейчас.
 *
 * Постоянная часть — промпт и описания инструментов — берётся из снимка, а переписка
 * собирается из журнала функцией `buildMessages`, как и в цикле. Поэтому оценка расходится с
 * настоящим запросом только погрешностью подсчёта токенов, а не составом.
 *
 * Токенизатор и размер окна определяются моделью, которую передаёт вызывающая сторона, —
 * текущей моделью сессии. Смена модели меняет только их: состав запроса от модели не зависит.
 */

/**
 * Служебные токены шаблона чата на одно сообщение: метки роли и границ. У разных моделей
 * от трёх до пяти; взято среднее.
 */
const MESSAGE_OVERHEAD = 4;
/** Служебные токены на описание инструмента: обёртка `function`, поля `type` и `name`. */
const TOOL_OVERHEAD = 10;
/** Служебные токены на вызов инструмента в ответе модели: идентификатор, метки. */
const CALL_OVERHEAD = 6;

/**
 * Окна контекста моделей Yandex AI Studio по документации провайдера
 * (aistudio.yandex.ru/docs/ru/ai-studio/concepts/generation/models). Сопоставление по
 * вхождению, поэтому более длинное имя стоит раньше того, что входит в него целиком.
 */
const KNOWN_WINDOWS: readonly (readonly [fragment: string, window: number])[] = [
    ['aliceai-llm-flash', 65_536],
    ['aliceai-llm', 131_072],
    ['yandexgpt', 32_768],
    ['deepseek-v4', 1_048_576],
    ['qwen3-235b', 262_144],
    ['qwen3.6', 262_144],
    ['gpt-oss', 131_072],
];

/**
 * Окно для модели, которой нет в перечне. Взято наименьшее из известных: завышенная
 * заполненность предупреждает заранее, а заниженная скрывает приближение к пределу.
 */
const ASSUMED_WINDOW = 32_768;

export function contextWindowFor(model: string): {
    readonly window: number;
    readonly source: 'known' | 'assumed';
} {
    const name = model.toLowerCase();
    const known = KNOWN_WINDOWS.find(([fragment]) => name.includes(fragment));
    return known === undefined
        ? { window: ASSUMED_WINDOW, source: 'assumed' }
        : { window: known[1], source: 'known' };
}

export type ContextInput = {
    /** Модель, чьим токенизатором ведётся оценка и чьё окно служит пределом. */
    readonly model: string;
    /** Постоянная часть запроса: промпт, секции MCP и инструменты, включая терминальные. */
    readonly snapshot: RequestSnapshotContent;
    readonly events: readonly SessionEvent[];
};

export function measureContext(input: ContextInput): SessionContextResponse {
    const profile = tokenizerFor(input.model);
    const count = (text: string): number => estimateTokens(text, profile);
    const { window, source } = contextWindowFor(input.model);

    const prompt: ContextItem = {
        name: 'system_prompt',
        tokens: count(input.snapshot.prompt) + MESSAGE_OVERHEAD,
        count: 1,
    };

    // Секции присоединяются к промпту через пустую строку — отсюда два токена сверх текста.
    const instructions = input.snapshot.sections.map((section, index) => ({
        name: sectionTitle(section) ?? `Секция ${index + 1}`,
        tokens: count(section) + 2,
        count: 1,
    }));

    const describeTool = (spec: ToolSpec): ContextItem => ({
        name: spec.name,
        tokens: count(JSON.stringify(spec.parameters)) + count(spec.description) + TOOL_OVERHEAD,
        count: 1,
    });
    const { tools } = input.snapshot;
    const builtinTools = tools.filter((tool) => tool.source !== 'mcp').map(describeTool);
    const mcpTools = tools.filter((tool) => tool.source === 'mcp').map(describeTool);

    // Части упорядочены по убыванию: состав смотрят, чтобы найти, что занимает окно, и
    // крупнейшая часть должна стоять первой, какой бы она ни была.
    const segments: ContextSegment[] = [
        segment('system_prompt', [prompt]),
        segment('mcp_instructions', instructions),
        segment('tools', builtinTools),
        segment('mcp_tools', mcpTools),
        segment('messages', measureMessages(input.events, count)),
    ]
        .filter((part) => part.tokens > 0)
        .sort((left, right) => right.tokens - left.tokens);

    return {
        model: input.model,
        window,
        windowSource: source,
        tokenizer: profile.name,
        used: segments.reduce((total, part) => total + part.tokens, 0),
        segments,
    };
}

/**
 * Переписка по видам сообщений. Считается по массиву, собранному из журнала, а не по самим
 * событиям: рассуждение модели в запрос не попадает, а вызову, оставшемуся без результата
 * после прерывания, подставляется отказ, который модель тоже получит.
 */
function measureMessages(
    events: readonly SessionEvent[],
    count: (text: string) => number,
): ContextItem[] {
    const kinds = {
        user: { name: 'user', tokens: 0, count: 0 },
        assistant: { name: 'assistant', tokens: 0, count: 0 },
        tool_calls: { name: 'tool_calls', tokens: 0, count: 0 },
        tool_results: { name: 'tool_results', tokens: 0, count: 0 },
    };
    const add = (kind: keyof typeof kinds, tokens: number): void => {
        kinds[kind].tokens += tokens;
        kinds[kind].count += 1;
    };

    // Первое сообщение — системный промпт, он считается отдельной частью.
    for (const message of buildMessages('', events).slice(1)) {
        switch (message.role) {
            case 'system':
                break;
            case 'user':
                add('user', count(message.content) + MESSAGE_OVERHEAD);
                break;
            case 'tool':
                add('tool_results', count(message.content) + MESSAGE_OVERHEAD);
                break;
            case 'assistant':
                if (message.content !== '' || message.toolCalls.length === 0) {
                    add('assistant', count(message.content) + MESSAGE_OVERHEAD);
                }
                for (const call of message.toolCalls) {
                    add('tool_calls', count(call.name) + count(call.rawArguments) + CALL_OVERHEAD);
                }
                break;
        }
    }

    return Object.values(kinds).filter((kind) => kind.count > 0);
}

function segment(key: ContextSegment['key'], items: ContextItem[]): ContextSegment {
    return {
        key,
        tokens: items.reduce((total, item) => total + item.tokens, 0),
        items: [...items].sort((left, right) => right.tokens - left.tokens),
    };
}

/** Заголовок секции — первая строка без разметки: `## Сервер MCP «…»`. */
function sectionTitle(section: string): string | undefined {
    const first = section.trim().split('\n')[0]?.replace(/^#+\s*/, '').trim();
    return first === undefined || first === '' ? undefined : first;
}
