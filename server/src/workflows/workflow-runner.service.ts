import {
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    type OnApplicationBootstrap,
} from '@nestjs/common';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import type { Session, SessionStatus, WorkflowResultReport, WorkflowStepReport } from '@weragen/types';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { SessionJournalService } from '../agent/session-journal.service.js';
import { SessionsService, toDto } from '../sessions/sessions.service.js';
import { tracer } from '../telemetry/tracing.js';
import {
    workflowAttributes,
    workflowInputAttributes,
    workflowOutputAttributes,
} from '../telemetry/span-attributes.js';
import { SessionTraceRegistry } from '../telemetry/session-trace.service.js';
import { WorkflowsService } from './workflows.service.js';
import {
    ProcessFailure,
    WorkflowProcessService,
    type WorkflowProcess,
} from './workflow-process.service.js';

/** Отказ исполнения, которое шло в момент остановки сервера. */
const STOPPED = 'Исполнение прервано остановкой сервера.';

/**
 * Исполнения воркфлоу.
 *
 * Служба занимается только процессами воркфлоу: порождение, передача входа, приём сообщений,
 * завершение сессии. Об агентском цикле она не осведомлена — сессии, которые воркфлоу
 * запрашивает для агентских задач, он создаёт сам обращением к контроллеру сессий.
 *
 * Источник истины об исходе — сообщённый результат, а не код выхода. Процесс,
 * завершившийся без сообщённого результата, считается отказавшим независимо от кода;
 * результат, сообщённый до выхода, остаётся действительным, даже если процесс затем
 * завершился ненулевым кодом.
 */
@Injectable()
export class WorkflowRunnerService implements OnApplicationBootstrap {
    private readonly logger = new Logger(WorkflowRunnerService.name);
    /** Работающие процессы по идентификатору сессии: один процесс на одно исполнение. */
    private readonly processes = new Map<string, WorkflowProcess>();
    /** Спаны исполнений: закрываются вместе с записью исхода. */
    private readonly spans = new Map<string, Span>();

    constructor(
        private readonly config: AppConfigService,
        private readonly prisma: PrismaService,
        private readonly journal: SessionJournalService,
        private readonly workflows: WorkflowsService,
        private readonly processService: WorkflowProcessService,
        private readonly sessions: SessionsService,
        private readonly traces: SessionTraceRegistry,
    ) {}

    /**
     * Сверка при запуске сервера.
     *
     * Процессы исполнений учитываются только в памяти, поэтому исполнение, шедшее в момент
     * остановки сервера, после перезапуска осталось бы в состоянии `running` навсегда: ни
     * наблюдать за его процессом, ни прервать его уже нельзя. Такие исполнения завершаются
     * отказом до того, как сервер начинает принимать запросы. Если процесс продолжил работу
     * после остановки сервера и позже сообщит итог, тот записан не будет: исход у сессии уже
     * есть.
     */
    async onApplicationBootstrap(): Promise<void> {
        const rows = await this.prisma.session.findMany({
            where: { kind: 'workflow', status: 'running' },
            select: { id: true },
        });
        for (const row of rows) {
            await this.settle(row.id, { ok: false, result: null, message: STOPPED }).catch(
                (cause: unknown) => {
                    this.logger.error(`сверка исполнения ${row.id} не выполнена: ${describe(cause)}`);
                },
            );
        }
    }

    /**
     * Запускает исполнение. Возвращает управление сразу, как только заведена сессия:
     * порождение процесса занимает до нескольких секунд, и держать вызывающую сторону
     * всё это время незачем — происходящее видно событиями журнала.
     */
    async start(
        name: string,
        input: unknown,
        parentId?: string,
        traceparent?: string,
    ): Promise<Session> {
        const workflow = await this.workflows.requireByName(name);
        if (workflow.checkStatus !== 'ok') {
            throw new ConflictException(
                `Воркфлоу "${name}" запускать нельзя: состояние проверки ${workflow.checkStatus}. ` +
                    (workflow.lastCheckMessage ?? 'Выполните проверку требований.'),
            );
        }

        const ownerId = await this.sessions.currentOwnerId();
        const row = await this.prisma.session.create({
            data: {
                ownerId,
                kind: 'workflow',
                title: workflow.title ?? workflow.name,
                workflowId: workflow.id,
                status: 'running',
                ...(parentId === undefined ? {} : { parentId }),
            },
            include: { model: { select: { identifier: true } }, workflow: { select: { name: true } } },
        });

        if (parentId !== undefined) {
            await this.journal.append(parentId, {
                type: 'child_session_started',
                childId: row.id,
                kind: 'workflow',
                title: row.title,
            });
        }

        await this.journal.append(row.id, {
            type: 'workflow_started',
            workflowName: workflow.name,
            version: workflow.version,
            input,
        });

        // Имя спана несёт вид сессии, потому что в перечне трасс имя — единственное, что
        // видно без раскрытия узла. Родитель берётся из реестра: дерево спанов строится по
        // дереву сессий, известному платформе, а не передачей контекста между процессами.
        const parentContext = this.traces.parentFor(parentId, traceparent);
        const span = tracer().startSpan(
            `workflow ${workflow.name}`,
            {
                attributes: {
                    ...workflowAttributes(row.id, ownerId, workflow.name, workflow.version),
                    ...workflowInputAttributes(
                        workflow.name,
                        input,
                        this.config.tracing.captureContent,
                    ),
                },
            },
            parentContext,
        );
        this.spans.set(row.id, span);
        this.traces.open(row.id, span, parentContext);

        void this.launch(workflow.id, workflow.name, row.id, input);
        return toDto(row);
    }

    private async launch(
        workflowId: string,
        name: string,
        sessionId: string,
        input: unknown,
    ): Promise<void> {
        let process_: WorkflowProcess;
        try {
            process_ = await this.processService.launch(await this.workflows.launchOf(workflowId));
        } catch (cause) {
            const output = cause instanceof ProcessFailure ? cause.output.trim() : '';
            const message = cause instanceof Error ? cause.message : String(cause);
            await this.settle(sessionId, {
                ok: false,
                result: null,
                message: output === '' ? message : `${message}\n${output}`,
            });
            return;
        }

        this.processes.set(sessionId, process_);

        // Наблюдение за выходом ставится до передачи входа: процесс может завершиться и
        // раньше, чем вход будет принят, и тогда сессия иначе осталась бы в состоянии
        // «выполняется» навсегда. Итог, уже записанный сообщением процесса или прерыванием,
        // повторно не записывается: за этим следит `settle`.
        void process_.exited.then((code) => {
            this.processes.delete(sessionId);
            const output = process_.output().trim();
            void this.settle(sessionId, {
                ok: false,
                result: null,
                message:
                    `Процесс воркфлоу "${name}" завершился (код ${code ?? 'сигнал'}), ` +
                    'не сообщив итог.' +
                    (output === '' ? '' : `\n${output}`),
            });
        });

        try {
            // Контекст трассы передаётся вместе с входом: он относится к исполнению, а не
            // к процессу, и заголовком в формате W3C его поймёт любая реализация воркфлоу.
            await process_.call('POST', '/runs', {
                sessionId,
                input,
                traceparent: this.traces.traceparentOf(sessionId),
            });
        } catch (cause) {
            await this.settle(sessionId, {
                ok: false,
                result: null,
                message: `Процесс воркфлоу "${name}" не принял вход: ${describe(cause)}`,
            });
            await process_.stop();
        }
    }

    /**
     * Сообщение о шаге. Записывается в журнал и служит наблюдению.
     *
     * Спан шага здесь не создаётся: его создаёт сам воркфлоу — у него есть интерфейс
     * OpenTelemetry и адрес приёмника, полученный при запуске. Создавать спан ещё и здесь
     * значило бы показать каждый шаг дважды. Данные трассировки в сообщении нужны журналу
     * и интерфейсу, а также воркфлоу, у которого экспортёр не настроен.
     */
    async report(sessionId: string, step: WorkflowStepReport): Promise<void> {
        await this.requireWorkflowSession(sessionId);
        await this.journal.append(sessionId, {
            type: 'workflow_step',
            stepId: step.stepId,
            name: step.name,
            state: step.state,
            startedAt: step.startedAt,
            ...(step.parentStepId === undefined ? {} : { parentStepId: step.parentStepId }),
            ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
            ...(step.detail === undefined ? {} : { detail: step.detail }),
            ...(step.attributes === undefined ? {} : { attributes: step.attributes }),
        });
    }

    /** Сообщение об итоге. Завершает сессию и останавливает процесс. */
    async finish(sessionId: string, report: WorkflowResultReport): Promise<void> {
        await this.requireWorkflowSession(sessionId);
        await this.settle(sessionId, report);
        const process_ = this.processes.get(sessionId);
        if (process_ === undefined) return;

        // Процесс завершается сам, сообщив итог, и до выхода успевает отправить накопленные
        // спаны трассировки: они уходят пачками уже после сообщения об итоге. Немедленное
        // завершение обрывало бы эту отправку, и трасса воркфлоу оказывалась бы пустой при
        // полностью исправной настройке. Поэтому даётся отсрочка, а принудительная
        // остановка снимает только процесс, не завершившийся сам.
        void Promise.race([
            process_.exited,
            new Promise((resolve) =>
                setTimeout(resolve, this.config.workflows.cancelTimeoutMs),
            ),
        ]).then(() => process_.stop());
    }

    /**
     * Прерывание. Двухступенчатое: сначала процесс получает возможность прекратить работу
     * сам и освободить занятое, затем завершается принудительно. Первая ступень существенна
     * именно в Windows, где набор сигналов ограничен.
     */
    async interrupt(sessionId: string): Promise<boolean> {
        const process_ = this.processes.get(sessionId);
        if (process_ === undefined) return false;

        // Исход записывается до остановки, а не после. Процесс, прекративший работу по
        // запросу, выходит не сообщив итог, и наблюдатель выхода записал бы отказ с
        // неверной причиной: прерывание выглядело бы поломкой воркфлоу.
        await this.settle(sessionId, {
            ok: false,
            result: null,
            message: 'Исполнение прервано пользователем.',
        });
        await process_.stop(sessionId);
        return true;
    }

    async outcome(
        sessionId: string,
    ): Promise<{ status: SessionStatus; result: unknown; failureMessage: string | null }> {
        const row = await this.prisma.session.findUnique({
            where: { id: sessionId },
            select: { status: true, result: true, failureMessage: true },
        });
        if (row === null) throw new NotFoundException(`Сессия ${sessionId} не найдена`);
        return {
            status: row.status as SessionStatus,
            result: row.result ?? null,
            failureMessage: row.failureMessage,
        };
    }

    /**
     * Единственное место службы, где записывается исход. Итог может прийти и сообщением от
     * процесса, и наблюдением за его выходом, и эти два события не упорядочены между собой;
     * после перезапуска сервера к ним добавляется сверка при запуске. Записывается первый из
     * них, а повторный вызов ничего не делает: признаком служит состояние записи сессии, а не
     * отметка в памяти, которая перезапуска не переживает.
     */
    private async settle(sessionId: string, report: WorkflowResultReport): Promise<void> {
        const message = report.message ?? 'Исполнение завершилось отказом без указания причины.';
        const recorded = await this.journal.settle(
            sessionId,
            report.ok
                ? { type: 'session_completed', result: report.result }
                : { type: 'session_failed', message },
        );
        if (!recorded) return;

        const span = this.spans.get(sessionId);
        this.spans.delete(sessionId);
        this.traces.close(sessionId);
        if (span !== undefined) {
            span.setAttributes(
                workflowOutputAttributes(
                    { ok: report.ok, result: report.result, message },
                    this.config.tracing.captureContent,
                ),
            );
            if (report.ok) {
                span.setStatus({ code: SpanStatusCode.OK });
            } else {
                span.setStatus({ code: SpanStatusCode.ERROR, message });
            }
            span.end();
        }

        if (!report.ok) this.logger.warn(`исполнение ${sessionId}: ${message}`);
    }

    private async requireWorkflowSession(sessionId: string): Promise<void> {
        const row = await this.prisma.session.findUnique({
            where: { id: sessionId },
            select: { kind: true },
        });
        if (row === null) throw new NotFoundException(`Сессия ${sessionId} не найдена`);
        if (row.kind !== 'workflow') {
            throw new ConflictException(`Сессия ${sessionId} не является исполнением воркфлоу`);
        }
    }
}

function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}
