import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { SpanStatusCode, type Context as OtelContext, type Span } from '@opentelemetry/api';
import { Cause, Effect, Exit, Fiber } from 'effect';
import {
    Journal,
    ModelClient,
    RequestSnapshots,
    ToolObserver,
    ToolRegistry,
    describeTurnError,
    measureContext,
    requestSnapshot,
    runTurn,
    sourcedTools,
    type CompletionMode,
    type TurnError,
    type TurnResult,
} from '@weragen/ai';
import type {
    RequestSnapshotContent,
    SessionContextResponse,
    SessionEvent,
    SessionKind,
    TurnFailureReason,
} from '@weragen/types';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { ModelClientService } from '../model/model-client.service.js';
import { ToolsFactory, type SessionToolRegistry } from '../tools/tools.factory.js';
import { ModelsService, type ModelChoice } from '../models/models.service.js';
import { tracer } from '../telemetry/tracing.js';
import {
    sessionAttributes,
    turnInputAttributes,
    turnOutputAttributes,
} from '../telemetry/span-attributes.js';
import { SessionTraceRegistry } from '../telemetry/session-trace.service.js';
import { ToolObserverService } from '../telemetry/tool-observer.service.js';
import { RequestSnapshotService } from './request-snapshot.service.js';
import { SessionJournalService } from './session-journal.service.js';

/** Отказ хода, который исполнялся в момент остановки сервера. */
const STOPPED = 'Ход прерван остановкой сервера.';

/**
 * Запуск и остановка ходов агента.
 *
 * Служба занимается только агентским циклом — сессиями видов `chat` и `agent`. О воркфлоу
 * она не осведомлена: процессами воркфлоу распоряжается своя служба, а общее у них —
 * запись сессии и журнал.
 *
 * Ход исполняется фоновым волокном и не привязан к времени жизни HTTP-запроса: клиент может
 * закрыть страницу или переключиться на другую сессию, а ход продолжится. Поток событий по
 * SSE — это подписка на ход, а не сам ход.
 *
 * Две дисциплины различаются тем, что считается завершением. В чат-сессии терминальный
 * вызов завершает ход, после чего сессия ожидает следующего сообщения. В агентской сессии
 * тот же вызов завершает сессию целиком: следующего сообщения не будет, а итог отдаётся
 * породившей стороне.
 *
 * Ход без модели из справочника не запускается. Модель определяет метод `prepare`, и
 * запуск хода принимает только её: другого пути получить модель хода нет.
 */
@Injectable()
export class AgentRunnerService implements OnApplicationBootstrap {
    private readonly logger = new Logger(AgentRunnerService.name);
    /**
     * Волокна ходов, исполняющихся в этом процессе. Нужны только для прерывания: признаком
     * идущего хода служит состояние `running` в записи сессии.
     */
    private readonly fibers = new Map<string, Fiber.RuntimeFiber<unknown, unknown>>();

    constructor(
        private readonly config: AppConfigService,
        private readonly prisma: PrismaService,
        private readonly journal: SessionJournalService,
        private readonly modelClient: ModelClientService,
        private readonly tools: ToolsFactory,
        private readonly models: ModelsService,
        private readonly traces: SessionTraceRegistry,
        private readonly snapshots: RequestSnapshotService,
        private readonly toolObserver: ToolObserverService,
    ) {}

    /**
     * Сверка при запуске сервера.
     *
     * Волокно хода существует только в памяти процесса, а состояние `running` хранится в
     * записи сессии и остановку сервера переживает. После перезапуска посреди хода запись
     * осталась бы в этом состоянии, хотя исполнять ход некому: сообщения отклонялись бы, а
     * прервать ход было бы нечем. Сразу после запуска волокон нет ни у одной сессии, поэтому
     * каждая сессия в `running` получает исход прерванного хода.
     *
     * Сверка выполняется до того, как сервер начинает принимать запросы: Nest открывает порт
     * только после хуков инициализации всех модулей. Поэтому проверки по состоянию сессии, в
     * том числе в справочнике моделей, устаревшего значения не видят. Отказ чтения перечня
     * прерывает запуск: принимать запросы при несверенных состояниях нельзя. Отказ по
     * отдельной сессии записывается в журнал сервера и остальных сессий не затрагивает.
     */
    async onApplicationBootstrap(): Promise<void> {
        const rows = await this.prisma.session.findMany({
            where: { status: 'running', kind: { in: ['chat', 'agent'] } },
            select: { id: true, kind: true },
        });
        if (rows.length === 0) return;

        this.logger.warn(`сессий, оставшихся в состоянии running после остановки: ${rows.length}`);
        for (const row of rows) {
            await this.closeInterrupted(row.id, row.kind === 'agent').catch((cause: unknown) => {
                this.logger.error(`сверка сессии ${row.id} не выполнена: ${describe(cause)}`);
            });
        }
    }

    /**
     * Закрывает ход, прерванный остановкой сервера.
     *
     * Сервер мог остановиться и после того, как ход закрыт в журнале, но до смены состояния:
     * между ними закрываются соединения хода, и это занимает время. Поэтому закрывающее
     * событие дописывается, только если последний ход в журнале не закрыт, — иначе к
     * завершённому ходу добавился бы отказ.
     */
    private async closeInterrupted(sessionId: string, terminal: boolean): Promise<void> {
        const last = await this.prisma.sessionEvent.findFirst({
            where: { sessionId, type: { in: ['user_message', 'turn_finished', 'turn_failed'] } },
            orderBy: { seq: 'desc' },
            select: { type: true },
        });
        if (last?.type === 'user_message') {
            await this.journal.append(sessionId, {
                type: 'turn_failed',
                reason: 'internal',
                message: STOPPED,
            });
        }

        if (terminal) {
            await this.fail(sessionId, STOPPED);
            return;
        }
        await this.prisma.session.update({ where: { id: sessionId }, data: { status: 'idle' } });
    }

    /**
     * Модель следующего хода сессии.
     *
     * Определяется до любых записей в сессии: при отказе сессия остаётся нетронутой, и
     * повторная отправка не удваивает сообщение в журнале. Модель, назначенная впервые,
     * закрепляется за сессией, иначе смена модели по умолчанию между ходами переводила бы
     * сессию на другую модель без ведома пользователя.
     */
    async prepare(sessionId: string): Promise<ModelChoice> {
        const session = await this.prisma.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: { modelId: true, modelIdentifier: true },
        });
        const model = await this.models.forTurn(session);
        if (session.modelId !== model.id || session.modelIdentifier !== model.identifier) {
            await this.prisma.session.update({
                where: { id: sessionId },
                data: { modelId: model.id, modelIdentifier: model.identifier },
            });
        }
        return model;
    }

    /**
     * Принимает сообщение пользователя и запускает ход чат-сессии. Возвращает управление
     * сразу: результат приходит событиями журнала. Модель хода определяется заранее методом
     * `prepare`, чтобы отказ пришёл до записи сообщения.
     */
    async submit(
        sessionId: string,
        ownerId: string,
        text: string,
        model: ModelChoice,
    ): Promise<void> {
        await this.journal.append(sessionId, { type: 'user_message', text });
        await this.run(sessionId, ownerId, text, model, { completion: 'chat', terminal: false });
    }

    /**
     * Принимает постановку задачи и запускает агентскую сессию. Постановка записывается тем
     * же событием, что и сообщение человека: для сборки диалога это одно и то же — вход,
     * на который модель отвечает. Различие в том, что за первым ходом второго не будет.
     *
     * Модель назначается агентской сессии при создании, поэтому отказ здесь возможен, только
     * если её запись удалили в промежутке. Тогда сессия завершается с отказом: исполнить
     * задание ей нечем, а подставлять другую модель нельзя.
     */
    async submitTask(
        sessionId: string,
        ownerId: string,
        task: string,
        tools: readonly string[] | undefined,
        traceparent?: string,
    ): Promise<void> {
        let model: ModelChoice;
        try {
            model = await this.prepare(sessionId);
        } catch (cause) {
            await this.fail(sessionId, describe(cause));
            return;
        }

        await this.journal.append(sessionId, { type: 'user_message', text: task });
        await this.run(sessionId, ownerId, task, model, {
            completion: 'task',
            terminal: true,
            tools,
            traceparent,
        });
    }

    private async run(
        sessionId: string,
        ownerId: string,
        input: string,
        model: ModelChoice,
        discipline: {
            completion: CompletionMode;
            /** Завершает ли исход хода сессию целиком. */
            terminal: boolean;
            tools?: readonly string[] | undefined;
            /** Контекст трассы порождающей стороны, если она его передала. */
            traceparent?: string | undefined;
        },
    ): Promise<void> {
        // Сообщение, на которое отвечает ход, к этому моменту уже записано в журнал. Отказ на
        // любом шаге до запуска волокна оставил бы ход незакрытым, а сессию — в состоянии
        // `running` до перезапуска сервера: сообщения отклонялись бы, хотя исполнять ход
        // некому. Поэтому такой отказ записывается как отказ хода, а созданное до него
        // освобождается сразу: в `finish` его освобождать будет некому.
        const started: { span?: Span; registry?: SessionToolRegistry } = {};
        try {
            const session = await this.prisma.session.findUniqueOrThrow({
                where: { id: sessionId },
                select: { kind: true, parentId: true },
            });

            await this.prisma.session.update({
                where: { id: sessionId },
                data: { status: 'running' },
            });

            const history = await this.journal.read(sessionId);

            // Спан хода создаётся явно, а его контекст передаётся вниз параметром. Полагаться
            // на неявное распространение контекста нельзя: волокна Effect продолжаются в
            // микрозадачах, и активный спан там теряется, отчего дерево трассировки распалось
            // бы на корни.
            //
            // Родитель берётся из реестра по порождающей сессии: дерево спанов строится из
            // дерева сессий, которое платформе и так известно.
            const parentContext = this.traces.parentFor(session.parentId, discipline.traceparent);
            const rootSpan = tracer().startSpan(
                session.kind === 'agent' ? `agent ${input.slice(0, 60)}` : 'invoke_agent',
                {
                    attributes: {
                        ...sessionAttributes(sessionId, ownerId),
                        'gen_ai.operation.name': 'invoke_agent',
                        'openinference.span.kind': 'AGENT',
                        'weragen.session.kind': session.kind,
                        'gen_ai.request.model': model.identifier,
                        ...turnInputAttributes(input, this.config.tracing.captureContent),
                    },
                },
                parentContext,
            );
            started.span = rootSpan;
            const parent: OtelContext = this.traces.open(sessionId, rootSpan, parentContext);

            // Набор инструментов собирается до обращения к модели и живёт ровно ход: вместе с
            // ним живут и соединения с серверами MCP, которые он открывает по первому вызову.
            const registry = await this.tools.forSession(sessionId, discipline.tools);
            started.registry = registry;

            const runnable = runTurn(history, {
                model: model.identifier,
                maxSteps: this.config.maxSteps,
                toolResultMaxChars: this.config.toolResultMaxChars,
                completion: discipline.completion,
                // Текстовые инструкции подключённых серверов идут секциями после указаний
                // платформы: обещания автора внешнего сервера не должны их вытеснять.
                sections: registry.instructions,
            }).pipe(
                Effect.provideService(
                    ModelClient,
                    this.modelClient.forSession(sessionId, ownerId, model.identifier, parent),
                ),
                Effect.provideService(ToolRegistry, registry),
                Effect.provideService(Journal, this.journal.forSession(sessionId)),
                Effect.provideService(RequestSnapshots, this.snapshots.forCore),
                Effect.provideService(
                    ToolObserver,
                    this.toolObserver.forSession(sessionId, ownerId, parent),
                ),
            );

            // Отсчёт длительности нужен отказу хода: его записывает не цикл, а эта служба по
            // исходу волокна, и собственного отсчёта цикла она не видит.
            const startedAt = Date.now();
            const fiber = Effect.runFork(runnable);
            this.fibers.set(sessionId, fiber);

            fiber.addObserver((exit) => {
                // Отказ записи исхода не должен завершать процесс: необработанный отказ
                // обещания остановил бы сервер вместе со всеми идущими ходами.
                void this.finish(sessionId, exit, startedAt, rootSpan, discipline.terminal, registry)
                    .catch((cause: unknown) => {
                        this.logger.error(
                            `исход хода сессии ${sessionId} не записан: ${describe(cause)}`,
                        );
                    });
            });
        } catch (cause) {
            await this.failToStart(sessionId, cause, started, discipline.terminal);
        }
    }

    /**
     * Отказ до запуска волокна. Записывается так же, как отказ исполнения: без закрывающего
     * события ход в журнале показывался бы идущим, а без смены состояния сессия осталась бы
     * в `running`.
     */
    private async failToStart(
        sessionId: string,
        cause: unknown,
        started: { span?: Span; registry?: SessionToolRegistry },
        terminal: boolean,
    ): Promise<void> {
        const message = describe(cause);
        this.logger.error(
            `сессия ${sessionId}: ход не запущен: ${
                cause instanceof Error ? (cause.stack ?? message) : message
            }`,
        );
        this.traces.close(sessionId);
        started.span?.setStatus({ code: SpanStatusCode.ERROR, message });
        started.span?.end();
        await started.registry?.close().catch(() => undefined);

        await this.journal.append(sessionId, { type: 'turn_failed', reason: 'internal', message });
        if (terminal) {
            await this.fail(sessionId, message);
            return;
        }
        await this.prisma.session.update({ where: { id: sessionId }, data: { status: 'idle' } });
    }

    /**
     * Состав контекста сессии: промпт, инструменты и переписка, оценённые токенизатором
     * текущей модели сессии. Вычисляется на каждый запрос и не хранится.
     *
     * Постоянная часть берётся из снимка последнего запроса: по нему видно, что модель
     * получала на самом деле, в том числе у агентской сессии, чей набор сужен порождающей
     * стороной. Пока обращений к модели не было, снимка нет, и постоянная часть собирается
     * из нынешнего набора — того, что получит первый запрос.
     *
     * Модель сессии определяет только токенизатор и размер окна: состав запроса от неё не
     * зависит, поэтому смена модели между ходами меняет лишь пересчёт текста в токены.
     */
    async measureContext(sessionId: string): Promise<SessionContextResponse> {
        const session = await this.prisma.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: { modelId: true, modelIdentifier: true, kind: true },
        });
        // Оценка ведётся моделью, которую получит следующий ход. Без модели оценивать не по
        // чему, и запрос завершается тем же отказом, что и отправка сообщения.
        const model = await this.models.forTurn(session);
        const events = await this.journal.read(sessionId);

        const snapshot =
            (await this.lastSnapshot(events)) ??
            (await this.currentSnapshot(sessionId, session.kind));
        return measureContext({ model: model.identifier, snapshot, events });
    }

    /**
     * Снимок, с которым шёл последний запрос. Отсутствует, пока обращений к модели не было,
     * и в журналах, записанных до появления снимков.
     */
    private async lastSnapshot(
        events: readonly SessionEvent[],
    ): Promise<RequestSnapshotContent | undefined> {
        for (let index = events.length - 1; index >= 0; index--) {
            const event = events[index]!;
            if (event.type !== 'step_started') continue;
            return event.snapshotId === undefined
                ? undefined
                : this.snapshots.find(event.snapshotId);
        }
        return undefined;
    }

    /**
     * Постоянная часть, которую получил бы запрос, начнись ход сейчас. Соединения с
     * серверами MCP не открываются: набор строится из сохранённых составов, а соединение
     * открывает только вызов.
     */
    private async currentSnapshot(
        sessionId: string,
        kind: SessionKind,
    ): Promise<RequestSnapshotContent> {
        const registry = await this.tools.forSession(sessionId);
        try {
            return requestSnapshot({
                completion: kind === 'agent' ? 'task' : 'chat',
                sections: registry.instructions,
                tools: sourcedTools(registry),
            });
        } finally {
            await registry.close();
        }
    }

    /** Прерывает ход. Отмена доходит до запроса к модели, поэтому генерация не продолжается. */
    async interrupt(sessionId: string): Promise<boolean> {
        const fiber = this.fibers.get(sessionId);
        if (fiber === undefined) return false;
        await Effect.runPromise(Fiber.interrupt(fiber));
        return true;
    }

    private async finish(
        sessionId: string,
        exit: Exit.Exit<unknown, unknown>,
        startedAt: number,
        rootSpan: Span,
        terminal: boolean,
        registry: SessionToolRegistry,
    ): Promise<void> {
        // Длительность фиксируется до закрытия соединений: оно к ходу уже не относится.
        const durationMs = Date.now() - startedAt;
        this.fibers.delete(sessionId);
        this.traces.close(sessionId);

        // Соединения хода закрываются здесь, а не в цикле: цикл о происхождении
        // инструментов не осведомлён, и знать о внешних серверах ему незачем. Закрытие
        // выполняется при любом исходе, включая прерывание.
        await registry.close().catch((cause: unknown) => {
            this.logger.warn(`закрытие соединений сессии ${sessionId}: ${describe(cause)}`);
        });

        try {
            if (Exit.isFailure(exit)) {
                const failure = classify(exit.cause);
                await this.journal.append(sessionId, {
                    type: 'turn_failed',
                    reason: failure.reason,
                    message: failure.message,
                    durationMs,
                });
                rootSpan.setAttributes(
                    turnOutputAttributes(
                        { ok: false, text: failure.message },
                        this.config.tracing.captureContent,
                    ),
                );
                rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: failure.message });
                if (failure.reason === 'internal') {
                    this.logger.error(`сессия ${sessionId}: ${Cause.pretty(exit.cause)}`);
                }
                if (terminal) await this.fail(sessionId, failure.message);
                return;
            }

            rootSpan.setStatus({ code: SpanStatusCode.OK });
            const result = exit.value as TurnResult;
            rootSpan.setAttributes(
                turnOutputAttributes(
                    { ok: true, text: typeof result.text === 'string' ? result.text : '' },
                    this.config.tracing.captureContent,
                ),
            );

            if (!terminal) return;

            // Вопрос в агентской сессии задать некому. Модель может задать его вопреки
            // промпту, и тогда исход считается отказом: вернуть вызывающей стороне вопрос
            // вместо результата хуже, чем сообщить, что результата нет.
            if (result.finish === 'question') {
                await this.fail(
                    sessionId,
                    `Агент задал уточняющий вопрос, а отвечать некому: ${result.text}`,
                );
                return;
            }
            await this.complete(sessionId, result.text);
        } finally {
            rootSpan.end();
            if (!terminal) {
                await this.prisma.session
                    .update({ where: { id: sessionId }, data: { status: 'idle' } })
                    .catch(() => undefined);
            }
        }
    }

    private async complete(sessionId: string, text: string): Promise<void> {
        await this.journal.settle(sessionId, { type: 'session_completed', result: text });
    }

    private async fail(sessionId: string, message: string): Promise<void> {
        await this.journal.settle(sessionId, { type: 'session_failed', message });
    }
}

/**
 * Различает исходы неудачного хода. Сведённые в одно «ошибка», они требуют разной реакции:
 * предел шагов означает слишком крупную задачу, отказ модели — проблему у провайдера,
 * прерывание — намеренное действие пользователя.
 */
function classify(cause: Cause.Cause<unknown>): {
    reason: TurnFailureReason;
    message: string;
} {
    // В Effect отмена волокна не является ошибкой, поэтому проверяется отдельно и раньше.
    if (Cause.isInterruptedOnly(cause)) {
        return { reason: 'aborted', message: 'Ход прерван пользователем.' };
    }

    const error = Cause.failureOption(cause);
    if (error._tag === 'Some') {
        const failure = error.value as TurnError;
        const reason: TurnFailureReason =
            failure._tag === 'StepLimitReached'
                ? 'step_limit'
                : failure._tag === 'OutputBudgetExhausted'
                  ? 'output_limit'
                  : 'model_error';
        return { reason, message: describeTurnError(failure) };
    }

    return { reason: 'internal', message: Cause.pretty(cause) };
}

function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}
