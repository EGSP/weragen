import { Effect } from 'effect';
import type { SessionEvent, ToolOutcome } from '@weragen/types';
import { buildMessages } from './build-messages.js';
import { OutputBudgetExhausted, StepLimitReached, type TurnError } from './errors.js';
import type { AgentMessage, AgentToolCall } from './messages.js';
import { Journal, ModelClient, RequestSnapshots, ToolObserver, ToolRegistry } from './requirements.js';
import { requestSnapshot, snapshotPrompt, snapshotSpecs, sourcedTools } from './snapshot.js';
import {
    ASK_USER,
    isTerminal,
    terminalText,
    type CompletionMode,
    type TurnFinish,
} from './terminal.js';
import {
    describeCause,
    formatToolError,
    ToolFailure,
    type AnyAgentTool,
    type ToolResult,
} from './tool.js';

/**
 * Терминология. **Ход** — одно исполнение цикла от сообщения пользователя до итогового
 * ответа. **Шаг** — один виток внутри хода: обращение к модели плюс исполнение вызовов,
 * которые оно затребовало.
 */

export type TurnOptions = {
    /** Идентификатор модели для отметки в журнале. Само обращение выполняет клиент модели. */
    readonly model: string;
    readonly maxSteps: number;
    readonly toolResultMaxChars: number;
    /** Указания платформы. Отсутствие означает промпт по умолчанию для дисциплины. */
    readonly systemPrompt?: string;
    /**
     * Секции, дописываемые после указаний платформы: текстовые инструкции серверов MCP.
     * Идут после указаний, чтобы обещания автора внешнего сервера их не вытесняли.
     */
    readonly sections?: readonly string[];
    /**
     * Дисциплина завершения. В чат-сессии доступны оба терминальных инструмента, в
     * агентской — только объявление итога: спрашивать некого.
     */
    readonly completion?: CompletionMode;
};

export type TurnResult = {
    readonly text: string;
    /**
     * Чем закончился ход: объявлением итога, вопросом либо обычным текстом без
     * терминального вызова. Различие существенно для агентской сессии — итог она отдаёт
     * вызывающей стороне, а вопрос задать некому.
     */
    readonly finish: TurnFinish;
    readonly steps: number;
    readonly toolCalls: number;
    readonly durationMs: number;
};

/**
 * Один ход агента.
 *
 * API модели не имеет памяти: каждое обращение отправляет весь массив сообщений заново.
 * Модель ничего не выполняет — она называет имя функции и аргументы, а выполняет платформа,
 * кладёт результат в массив и отправляет массив снова. Ход завершается, когда ответ модели
 * не содержит требований вызова.
 *
 * Прерывание отдельным исходом здесь не обрабатывается: в Effect отмена волокна не является
 * ошибкой, и различает её вызывающая сторона по `Exit`.
 */
export function runTurn(
    history: readonly SessionEvent[],
    options: TurnOptions,
): Effect.Effect<
    TurnResult,
    TurnError,
    ModelClient | ToolRegistry | Journal | RequestSnapshots | ToolObserver
> {
    return Effect.gen(function* () {
        const model = yield* ModelClient;
        const registry = yield* ToolRegistry;
        const journal = yield* Journal;
        const snapshots = yield* RequestSnapshots;
        const observer = yield* ToolObserver;

        const startedAt = Date.now();
        const mode: CompletionMode = options.completion ?? 'chat';

        // Запрос строится из снимка, а не рядом с ним: промпт и описания инструментов для
        // обращения к модели берутся из того же объекта, что сохраняется. Поэтому ссылка в
        // журнале указывает ровно на то, что получила модель. Набор в пределах хода не
        // меняется, и снимок сохраняется один раз на ход.
        const snapshot = requestSnapshot({
            completion: mode,
            ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
            sections: options.sections ?? [],
            tools: sourcedTools(registry),
        });
        const snapshotId = yield* snapshots.save(snapshot);
        const specs = snapshotSpecs(snapshot);
        const messages: AgentMessage[] = buildMessages(snapshotPrompt(snapshot), history);

        let toolCalls = 0;

        const finish = (text: string, kind: TurnFinish, step: number) =>
            Effect.gen(function* () {
                yield* journal.append({ type: 'assistant_message', text });
                const result: TurnResult = {
                    text,
                    finish: kind,
                    steps: step,
                    toolCalls,
                    durationMs: Date.now() - startedAt,
                };
                yield* journal.append({
                    type: 'turn_finished',
                    steps: result.steps,
                    toolCalls: result.toolCalls,
                    durationMs: result.durationMs,
                });
                return result;
            });

        for (let step = 1; step <= options.maxSteps; step++) {
            // Записывается до обращения к модели: иначе журнал молчит всё время, пока модель
            // формирует ответ, а это почти вся длительность хода.
            yield* journal.append({
                type: 'step_started',
                step,
                maxSteps: options.maxSteps,
                model: options.model,
                snapshotId,
            });

            const reply = yield* model.complete(messages, specs);

            // Ответ записывается до разбора его содержимого: расход токенов нужен и тогда,
            // когда ход на этом ответе оборвётся. Рассуждение журналируется, но в диалог не
            // возвращается: модель не ждёт его обратно, а по объёму оно способно превысить
            // сам диалог.
            yield* journal.append({
                type: 'model_reply',
                step,
                promptTokens: reply.usage.prompt,
                completionTokens: reply.usage.completion,
                ...(reply.finishReason === undefined ? {} : { finishReason: reply.finishReason }),
                ...(reply.reasoning === undefined ? {} : { reasoning: reply.reasoning }),
            });

            const text = reply.content.trim();

            if (reply.toolCalls.length === 0) {
                // Пустой ответ при `length` — не пустой ответ, а исчерпанный бюджет вывода.
                if (text === '' && reply.finishReason === 'length') {
                    return yield* new OutputBudgetExhausted({
                        completionTokens: reply.usage.completion,
                        hadReasoning: reply.reasoning !== undefined,
                    });
                }

                // Терминального вызова не было. Ход всё равно завершается: автопродолжение
                // сюда не входит, оно требует записи подставного сообщения пользователя
                // отдельным типом события и решается отдельно.
                return yield* finish(text, 'plain', step);
            }

            // Вызовы, стоящие в пачке после терминального, отбрасываются: модель уже
            // объявила работу законченной, и исполнять их значило бы действовать после
            // выданного ответа.
            const terminalIndex = reply.toolCalls.findIndex((call) => isTerminal(call.name, mode));
            const executable =
                terminalIndex === -1 ? reply.toolCalls : reply.toolCalls.slice(0, terminalIndex);

            // Ответ модели добавляется в массив вместе с идентификаторами вызовов: сообщения
            // с ролью `tool` привязаны к ним, и без них следующий запрос будет отвергнут.
            if (executable.length > 0) {
                messages.push({ role: 'assistant', content: text, toolCalls: executable });
            }

            // Текст, пришедший вместе с терминальным вызовом, не записывается: итог оформляет
            // терминальный вызов, и вторая запись стала бы вторым ответом на один ход.
            if (text !== '' && terminalIndex === -1) {
                yield* journal.append({ type: 'assistant_note', step, text });
            }

            const batchSize = executable.length;
            for (const [index, call] of executable.entries()) {
                const batchIndex = index + 1;
                toolCalls += 1;

                yield* journal.append({
                    type: 'tool_call',
                    callId: call.id,
                    name: call.name,
                    rawArguments: call.rawArguments,
                    step,
                    batchSize,
                    batchIndex,
                });

                const callStartedAt = Date.now();
                // Наблюдение охватывает вызов целиком, включая сверку имени с набором и
                // разбор аргументов: отказ на этих действиях столь же значим, как отказ
                // исполнения, а происходит он до того, как инструмент найден. Исполнение
                // отложено `suspend`, иначе разбор аргументов случился бы при построении
                // эффекта, то есть до того, как наблюдение началось.
                const result = yield* observer.observe(
                    {
                        callId: call.id,
                        name: call.name,
                        rawArguments: call.rawArguments,
                        step,
                        batchSize,
                        batchIndex,
                    },
                    Effect.suspend(() =>
                        executeCall(
                            registry.find(call.name),
                            registry.names,
                            call,
                            options.toolResultMaxChars,
                        ),
                    ),
                );

                yield* journal.append({
                    type: 'tool_result',
                    callId: call.id,
                    name: call.name,
                    kind: result.kind,
                    content: result.content,
                    durationMs: Date.now() - callStartedAt,
                    step,
                    batchSize,
                    batchIndex,
                });

                messages.push({ role: 'tool', callId: call.id, content: result.content });
            }

            if (terminalIndex !== -1) {
                const call = reply.toolCalls[terminalIndex]!;
                const declared = terminalText(call.rawArguments);
                return yield* finish(
                    declared !== '' ? declared : text,
                    call.name === ASK_USER ? 'question' : 'completion',
                    step,
                );
            }
        }

        return yield* new StepLimitReached({ limit: options.maxSteps });
    });
}

/**
 * Подсказка модели при дефекте.
 *
 * Дефект означает ошибку в коде платформы, а не неверный вызов: повтор даст тот же
 * результат, и единственное осмысленное продолжение — обойтись без этого инструмента.
 */
const DEFECT_HINT =
    'Это внутренняя ошибка платформы, а не ошибка вызова. Повтор того же вызова даст тот ' +
    'же результат: продолжай без этого инструмента либо сообщи, что задача невыполнима.';

/** Отказ вызова. Модели уходит `content`, наблюдателю — `detail`. */
function failedCall(
    kind: Exclude<ToolOutcome, 'ok'>,
    message: string,
    hint: string | undefined,
    detail: string = message,
): ToolResult {
    return { kind, content: formatToolError(message, hint), detail };
}

/**
 * Исполняет один вызов. Отказ инструмента — штатный исход, а не ошибка хода: он возвращается
 * модели результатом вызова, чтобы та исправилась на следующем шаге. Наверх пробрасывается
 * только прерывание, которое Effect обрабатывает отдельно от ошибок.
 *
 * Усечение результата выполняется здесь же, а не у вызывающей стороны, чтобы журнал,
 * сообщение модели и наблюдение содержали ровно один и тот же текст.
 */
function executeCall(
    tool: AnyAgentTool | undefined,
    knownNames: readonly string[],
    call: AgentToolCall,
    maxChars: number,
): Effect.Effect<ToolResult> {
    const capped = (result: ToolResult): ToolResult => ({
        ...result,
        content: truncate(result.content, maxChars),
    });

    if (tool === undefined) {
        return Effect.succeed(
            capped(
                failedCall(
                    'unknown_tool',
                    `Инструмента "${call.name}" не существует`,
                    `Доступны: ${knownNames.join(', ')}. Вызови один из них.`,
                ),
            ),
        );
    }

    let raw: unknown;
    try {
        raw = call.rawArguments === '' ? {} : JSON.parse(call.rawArguments);
    } catch (cause) {
        return Effect.succeed(
            capped(
                failedCall(
                    'bad_arguments',
                    `Аргументы вызова ${call.name} не разобраны: ${describeCause(cause)}`,
                    'Повтори вызов, передав корректный объект JSON.',
                ),
            ),
        );
    }

    // Проверка схемой даёт структурное описание несоответствия — путь до поля, ожидаемый
    // тип, полученное значение, — которое переводится в подсказку модели почти без обработки.
    // У инструмента внешнего сервера проверка сводится к требованию объекта: схему проверяет
    // сам сервер, и его отказ придёт модели тем же путём — результатом вызова.
    const checked = tool.input.check(raw);
    if (!checked.ok) {
        return Effect.succeed(
            capped(
                failedCall(
                    'schema_mismatch',
                    `Аргументы вызова ${call.name} не соответствуют схеме: ${checked.problems}`,
                    'Повтори вызов, исправив перечисленные поля.',
                ),
            ),
        );
    }

    return tool.execute(checked.value as never).pipe(
        Effect.map((value): ToolResult => ({ kind: 'ok', content: JSON.stringify(value) })),
        Effect.catch((failure: ToolFailure) =>
            Effect.succeed(failedCall('tool_failure', failure.message, failure.hint)),
        ),
        // Текст исключения модели не отдаётся: он адресован разработчику, раскрывает
        // устройство платформы и расходует контекст, ничего не подсказывая. Модель получает
        // постоянную формулировку с предписанием, а полный текст уходит наблюдателю —
        // оттуда в спан и в журнал сервера.
        Effect.catchDefect((defect) =>
            Effect.succeed(
                failedCall(
                    'defect',
                    `Инструмент ${call.name} не выполнен: внутренняя ошибка платформы.`,
                    DEFECT_HINT,
                    describeCause(defect),
                ),
            ),
        ),
        Effect.map(capped),
    );
}

/**
 * Ограничение размера результата. Без него один объёмный вывод занимает окно контекста
 * целиком, а поскольку каждый шаг отправляет всю историю заново, цена этого растёт с
 * каждым шагом.
 */
function truncate(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    return (
        `${content.slice(0, maxChars)}\n` +
        `… [результат усечён: показаны первые ${maxChars} из ${content.length} символов]`
    );
}
