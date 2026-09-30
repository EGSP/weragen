import {
    SpanStatusCode,
    trace,
    type Attributes,
    type Context as OtelContext,
    type Span,
    type Tracer,
} from '@opentelemetry/api';
import { Context, Duration, Effect } from 'effect';
import type { Session, SpanAttributes } from '@weragen/types';
import { api } from './api/generated/client.js';
import { describeDefect } from './defect.js';
import { WorkflowFailure } from './spec.js';
import { tracer } from './tracing.js';

/**
 * Что воркфлоу получает от платформы.
 *
 * Перечень намеренно короток. Воркфлоу не ведёт агентских циклов и не обращается к модели:
 * он просит платформу исполнить сессию с заданной постановкой и набором инструментов и
 * дожидается результата. Всё, что относится к моделям, инструментам и подсчёту расхода,
 * остаётся на стороне платформы — так обращения к моделям и оказываются под контролем.
 */

export type StepOptions<A> = {
    /**
     * Явное указание родительского шага. Обычно не нужно: шаг, вызванный внутри работы
     * другого шага, находит родителя сам. Пригодится там, где вложенность не лексическая —
     * например, шаг запускается отдельным волокном вне работы родителя.
     */
    readonly parent?: string;
    /** Атрибуты спана. Тип взят из OpenTelemetry: своих определений здесь нет. */
    readonly attributes?: Attributes;
    /**
     * Краткое описание результата для журнала и спана. Результат целиком не передаётся
     * намеренно: журнал сессии воркфлоу — запись наблюдений, а не хранилище данных.
     */
    readonly summary?: (result: A) => string;
};

export type WorkflowApi = {
    /** Идентификатор сессии этого исполнения. Он же — адрес журнала наблюдений. */
    readonly sessionId: string;

    /**
     * Трассировщик OpenTelemetry с уже установленным родителем — спаном исполнения.
     * Нужен там, где шага недостаточно: инструментация собственных обращений воркфлоу
     * к базе, к внешним системам, к файлам.
     */
    readonly tracer: Tracer;

    /**
     * Шаг работы: одна функция, а не пара «начать» и «закончить».
     *
     * Обе границы ставит она сама — сообщение о начале уходит до исполнения работы,
     * сообщение о завершении либо об отказе после. Забыть закрыть шаг поэтому нельзя, а
     * шаг, оставшийся в журнале начатым, означает ровно одно: исполнение на нём и
     * остановилось.
     *
     * Тем же вызовом создаётся спан. Время измеряется здесь и передаётся платформе явно:
     * момент получения запроса включает задержку сети, и спан по нему был бы длиннее
     * действительного.
     */
    readonly step: <A, E>(
        stepId: string,
        name: string,
        work: Effect.Effect<A, E>,
        options?: StepOptions<A>,
    ) => Effect.Effect<A, E>;

    /**
     * Пометка в журнале: то, что шагом не является, потому что работы внутри не содержит.
     * Записывается одним сообщением нулевой длительности и добавляется событием в спан.
     */
    readonly note: (name: string, detail?: string) => Effect.Effect<void>;

    /**
     * Запрашивает у платформы агентскую сессию: постановка задачи и набор инструментов на
     * входе, текст итога на выходе. Цикл исполняет платформа; воркфлоу лишь ожидает.
     *
     * Перечень инструментов только сужает набор платформы — добавить своих воркфлоу не
     * может, предоставляет их платформа.
     */
    readonly agent: (task: string, options?: AgentOptions) => Effect.Effect<string, WorkflowFailure>;

    /** Запускает другой воркфлоу дочерним исполнением и дожидается его итога. */
    readonly workflow: (name: string, input: unknown) => Effect.Effect<unknown, WorkflowFailure>;
};

export type AgentOptions = {
    /** Имена инструментов платформы, доступных агенту. Отсутствие означает весь набор. */
    readonly tools?: readonly string[];
    /** Заголовок дочерней сессии в интерфейсе. По умолчанию берётся начало постановки. */
    readonly title?: string;
    /**
     * Запись справочника моделей. Отсутствие означает модель по умолчанию. Указанная запись
     * должна существовать: другой моделью платформа её не подменяет, и сессия не создаётся.
     */
    readonly modelId?: string;
};

export class WorkflowContext extends Context.Service<
    WorkflowContext,
    WorkflowApi
>()('weragen/WorkflowContext') {}

/** Как часто опрашивается состояние дочерней сессии. */
const POLL_INTERVAL = Duration.millis(600);

/**
 * Текущий шаг волокна.
 *
 * Вложенность шагов определяется тем, где шаг вызван, а не тем, что о ней объявлено: шаг,
 * запущенный внутри работы другого шага, становится его потомком сам. Значение переносится
 * ссылкой контекста волокна, поэтому оно наследуется и порождёнными волокнами — например,
 * при одновременном исполнении нескольких шагов.
 */
const currentStep = Context.Reference<{ stepId: string; context: OtelContext } | undefined>(
    'weragen/WorkflowCurrentStep',
    { defaultValue: () => undefined },
);

/**
 * Атрибуты в том виде, в каком их принимает платформа: строки, числа и логические значения.
 * Массивы и пустые значения OpenTelemetry допускает, а схема сообщения — нет, поэтому они
 * отбрасываются здесь, а не отвергаются на другой стороне.
 */
function toWire(attributes: Attributes | undefined): SpanAttributes | undefined {
    if (attributes === undefined) return undefined;
    const result: SpanAttributes = {};
    for (const [key, value] of Object.entries(attributes)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            result[key] = value;
        }
    }
    return Object.keys(result).length === 0 ? undefined : result;
}

/**
 * Реализация над обычными контроллерами платформы. Отдельного шлюза нет: сессии
 * запрашиваются у контроллера сессий, шаги и итог сообщаются контроллеру воркфлоу.
 */
export function makeContext(sessionId: string, runContext: OtelContext): WorkflowApi {
    /** Открытые шаги: нужны, когда родитель указан явно, а не найден по месту вызова. */
    const open = new Map<string, OtelContext>();

    const report = (body: {
        stepId: string;
        name: string;
        state: 'started' | 'finished' | 'failed';
        startedAt: string;
        parentStepId?: string;
        durationMs?: number;
        detail?: string;
        attributes?: SpanAttributes;
    }): Effect.Effect<void> =>
        // Отказ сообщения о шаге не должен останавливать исполнение: наблюдение —
        // не результат работы, и потеря одной записи журнала ничего не меняет.
        Effect.promise(() =>
            api.workflows
                .report(sessionId, body)
                .then(() => undefined)
                .catch(() => undefined),
        );

    /**
     * Ожидание завершения дочерней сессии опросом по идентификатору, а не длительным
     * соединением: ход агента занимает минуты, и удерживать соединение всё это время
     * ненадёжно.
     */
    const await_ = (session: Session, what: string): Effect.Effect<unknown, WorkflowFailure> =>
        Effect.gen(function* () {
            for (;;) {
                yield* Effect.sleep(POLL_INTERVAL);
                const current = yield* Effect.tryPromise({
                    try: () => api.sessions.get(session.id),
                    catch: (cause) =>
                        new WorkflowFailure({
                            message: `Состояние ${what} ${session.id} получить не удалось: ${describe(cause)}`,
                        }),
                });
                if (current.status === 'completed') return current.result;
                if (current.status === 'failed') {
                    return yield* new WorkflowFailure({
                        message: `${what} завершилась отказом: ${current.failureMessage ?? 'причина не сообщена'}`,
                    });
                }
            }
        });

    /**
     * Контекст трассы того места, откуда создаётся дочерняя сессия: текущий шаг, а при его
     * отсутствии — исполнение целиком. Платформа знает дерево сессий и без этого, но
     * привязала бы сессию к исполнению, а не к шагу, внутри которого она создана.
     */
    const currentTraceparent = (): Effect.Effect<string | undefined> =>
        Effect.gen(function* () {
            const enclosing = yield* currentStep;
            const spanContext = trace.getSpanContext(enclosing?.context ?? runContext);
            if (spanContext === undefined) return undefined;
            const flags = (spanContext.traceFlags & 0x1).toString(16).padStart(2, '0');
            return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
        });

    const step = <A, E>(
        stepId: string,
        name: string,
        work: Effect.Effect<A, E>,
        options?: StepOptions<A>,
    ): Effect.Effect<A, E> =>
        Effect.gen(function* () {
            const startedAtMs = Date.now();
            const startedAt = new Date(startedAtMs).toISOString();

            const enclosing = yield* currentStep;
            const explicit = options?.parent;
            const parent = explicit ?? enclosing?.stepId;
            const parentContext =
                (explicit === undefined ? enclosing?.context : open.get(explicit)) ?? runContext;

            const span: Span = tracer().startSpan(
                name,
                {
                    startTime: startedAtMs,
                    attributes: {
                        'openinference.span.kind': 'CHAIN',
                        'session.id': sessionId,
                        'weragen.session.kind': 'workflow',
                        'weragen.workflow.step.id': stepId,
                        ...(parent === undefined ? {} : { 'weragen.workflow.step.parent': parent }),
                        ...options?.attributes,
                    },
                },
                parentContext,
            );
            open.set(stepId, trace.setSpan(parentContext, span));

            const wire = toWire(options?.attributes);
            yield* report({
                stepId,
                name,
                state: 'started',
                startedAt,
                ...(parent === undefined ? {} : { parentStepId: parent }),
                ...(wire === undefined ? {} : { attributes: wire }),
            });

            const close = (): void => {
                open.delete(stepId);
            };

            return yield* work.pipe(
                // Работа шага исполняется с ним самим в качестве текущего: шаг, вызванный
                // внутри неё, находит родителя без указания.
                Effect.provideService(currentStep, { stepId, context: trace.setSpan(parentContext, span) }),
                Effect.tap((value) =>
                    Effect.gen(function* () {
                        const detail = options?.summary?.(value);
                        if (detail !== undefined) span.setAttribute('weragen.workflow.step.summary', detail);
                        span.setStatus({ code: SpanStatusCode.OK });
                        span.end();
                        close();
                        yield* report({
                            stepId,
                            name,
                            state: 'finished',
                            startedAt,
                            durationMs: Date.now() - startedAtMs,
                            ...(parent === undefined ? {} : { parentStepId: parent }),
                            ...(detail === undefined ? {} : { detail }),
                            ...(wire === undefined ? {} : { attributes: wire }),
                        });
                    }),
                ),
                // Дефект завершает шаг наравне с объявленным отказом: `tapError` его не
                // видит — типом он не выражен, — и без этой ветви шаг остался бы в журнале
                // начатым, а его спан незакрытым, то есть не ушёл бы в приёмник вовсе.
                // Незавершённым шаг остаётся только при прерывании, и это различие
                // содержательно: там исполнение остановлено снаружи, здесь — отказало.
                Effect.tapDefect((defect) =>
                    Effect.gen(function* () {
                        const detail = describeDefect(defect).slice(0, 4000);
                        span.setStatus({ code: SpanStatusCode.ERROR, message: detail });
                        span.end();
                        close();
                        yield* report({
                            stepId,
                            name,
                            state: 'failed',
                            startedAt,
                            durationMs: Date.now() - startedAtMs,
                            ...(parent === undefined ? {} : { parentStepId: parent }),
                            detail,
                        });
                    }),
                ),
                Effect.tapError((error) =>
                    Effect.gen(function* () {
                        const detail = describe(error).slice(0, 4000);
                        span.setStatus({ code: SpanStatusCode.ERROR, message: detail });
                        span.end();
                        close();
                        yield* report({
                            stepId,
                            name,
                            state: 'failed',
                            startedAt,
                            durationMs: Date.now() - startedAtMs,
                            ...(parent === undefined ? {} : { parentStepId: parent }),
                            detail,
                        });
                    }),
                ),
                // Прерывание закрывает спан, но сообщения о завершении не шлёт: шаг обязан
                // остаться в журнале начатым, иначе по нему нельзя будет понять, на чём
                // именно исполнение остановилось.
                Effect.onInterrupt(() =>
                    Effect.sync(() => {
                        span.setStatus({ code: SpanStatusCode.ERROR, message: 'прервано' });
                        span.end();
                        close();
                    }),
                ),
            );
        });

    return {
        sessionId,
        tracer: tracer(),
        step,

        note: (name, detail) =>
            Effect.gen(function* () {
                const startedAt = new Date().toISOString();
                trace
                    .getSpan(runContext)
                    ?.addEvent(name, detail === undefined ? undefined : { detail });
                yield* report({
                    stepId: `note-${startedAt}`,
                    name,
                    state: 'finished',
                    startedAt,
                    durationMs: 0,
                    ...(detail === undefined ? {} : { detail }),
                });
            }),

        agent: (task, options) =>
            Effect.gen(function* () {
                const traceparent = yield* currentTraceparent();
                const session = yield* Effect.tryPromise({
                    try: () =>
                        api.sessions.create({
                            kind: 'agent',
                            parentId: sessionId,
                            task,
                            ...(traceparent === undefined ? {} : { traceparent }),
                            ...(options?.tools === undefined ? {} : { tools: [...options.tools] }),
                            ...(options?.title === undefined ? {} : { title: options.title }),
                            ...(options?.modelId === undefined ? {} : { modelId: options.modelId }),
                        }),
                    catch: (cause) =>
                        new WorkflowFailure({
                            message: `Агентская сессия не создана: ${describe(cause)}`,
                        }),
                });
                const result = yield* await_(session, 'Агентская сессия');
                return typeof result === 'string' ? result : JSON.stringify(result);
            }),

        workflow: (name, input) =>
            Effect.gen(function* () {
                const traceparent = yield* currentTraceparent();
                const session = yield* Effect.tryPromise({
                    try: () =>
                        api.workflows.start({
                            name,
                            input,
                            parentId: sessionId,
                            ...(traceparent === undefined ? {} : { traceparent }),
                        }),
                    catch: (cause) =>
                        new WorkflowFailure({
                            message: `Воркфлоу "${name}" не запущен: ${describe(cause)}`,
                        }),
                });
                return yield* await_(session, `Исполнение воркфлоу "${name}"`);
            }),
    };
}

function describe(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    if (typeof cause === 'object' && cause !== null && 'message' in cause) {
        return String((cause as { message: unknown }).message);
    }
    return String(cause);
}
