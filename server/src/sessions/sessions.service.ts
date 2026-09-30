import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type {
    BackfillModelsResponse,
    CreateSessionRequest,
    Session,
    SessionKind,
    SessionStatus,
} from '@weragen/types';
import { PrismaService } from '../database/prisma.service.js';
import { SessionEventBus } from '../agent/session-event-bus.service.js';
import { SessionJournalService } from '../agent/session-journal.service.js';
import { AgentRunnerService } from '../agent/agent-runner.service.js';
import { ModelsService } from '../models/models.service.js';
import { WORKFLOW_RUNNER } from '../workflows/tokens.js';
import type { WorkflowRunnerService } from '../workflows/workflow-runner.service.js';

/** Логин единственной локальной учётной записи версии 0.1.0. */
const LOCAL_LOGIN = 'local';

/**
 * Сессии.
 *
 * Три вида сессии различаются тем, кто подаёт вход и что считается завершением; журнал,
 * поток событий, прерывание и владелец у них общие. Поэтому запись одна на все три, а
 * расходится не она, а дисциплина исполнения: чат и агентскую сессию ведёт служба
 * агентского цикла, сессию воркфлоу — служба процессов воркфлоу.
 *
 * Аутентификации пока нет, но владелец есть: все запросы идут от локальной учётной записи,
 * создаваемой при первом обращении. Когда появится вход, изменится только источник
 * идентификатора владельца, а не запросы.
 */
@Injectable()
export class SessionsService {
    private ownerIdCache: string | undefined;

    constructor(
        private readonly prisma: PrismaService,
        private readonly bus: SessionEventBus,
        private readonly journal: SessionJournalService,
        private readonly models: ModelsService,
        private readonly agent: AgentRunnerService,
        private readonly moduleRef: ModuleRef,
    ) {}

    async currentOwnerId(): Promise<string> {
        if (this.ownerIdCache !== undefined) return this.ownerIdCache;
        const user = await this.prisma.user.upsert({
            where: { login: LOCAL_LOGIN },
            update: {},
            create: { login: LOCAL_LOGIN },
        });
        this.ownerIdCache = user.id;
        return user.id;
    }

    /**
     * Перечень сессий. Показываются только корневые: дочерние читаются из своего родителя
     * по событию о порождении, и в общем списке они были бы шумом.
     *
     * Порядок — по времени последнего события журнала, а не по времени изменения записи.
     * Различие существенно: переименование, смена модели и запись заметки меняют запись, не
     * будучи работой в сессии, и по `updatedAt` перебрасывали бы сессию наверх без причины.
     */
    async list(kind?: SessionKind): Promise<Session[]> {
        const ownerId = await this.currentOwnerId();
        const rows = await this.prisma.session.findMany({
            where: { ownerId, parentId: null, ...(kind === undefined ? {} : { kind }) },
            orderBy: [{ lastEventAt: 'desc' }, { createdAt: 'desc' }],
            include: { model: { select: { identifier: true } }, workflow: { select: { name: true } } },
        });
        return rows.map(toDto);
    }

    /**
     * Создание сессии.
     *
     * Обслуживаются два вида: чат создаёт человек, агентскую сессию — другая сессия, когда
     * ей нужен агентский цикл. Сессия вида `workflow` здесь не создаётся: вместе с ней
     * нужно породить процесс, и этим распоряжается служба воркфлоу.
     */
    async create(request: CreateSessionRequest): Promise<Session> {
        const ownerId = await this.currentOwnerId();
        const kind: SessionKind = request.kind ?? 'chat';

        if (kind === 'workflow') {
            throw new BadRequestException(
                'Сессия воркфлоу создаётся запуском исполнения: POST /api/workflows/runs',
            );
        }
        if (kind === 'agent') {
            if (request.task === undefined) {
                throw new BadRequestException('Для агентской сессии обязательна постановка задачи');
            }
            if (request.parentId === undefined) {
                throw new BadRequestException(
                    'Агентская сессия создаётся только другой сессией: укажите parentId',
                );
            }
            await this.require(request.parentId);
        }

        // Модель выбирается до создания записи. Указанная явно должна существовать: подменять
        // её другой нельзя. Иначе сессия получает модель по умолчанию. Агентская сессия без
        // модели не создаётся вовсе — исполнить задание ей нечем, — а чат при пустом
        // справочнике создаётся без модели и получает её первым ходом.
        const model =
            request.modelId !== undefined
                ? await this.models.require(request.modelId)
                : kind === 'agent'
                  ? await this.models.requireDefault()
                  : await this.models.defaultModel();
        const title =
            request.title?.trim() ||
            (kind === 'agent' ? shorten(request.task ?? 'Задача') : 'Новый чат');

        const row = await this.prisma.session.create({
            data: {
                ownerId,
                kind,
                title,
                modelId: model?.id ?? null,
                modelIdentifier: model?.identifier ?? null,
                ...(request.parentId === undefined ? {} : { parentId: request.parentId }),
            },
            include: { model: { select: { identifier: true } }, workflow: { select: { name: true } } },
        });

        if (request.parentId !== undefined) {
            await this.journal.append(request.parentId, {
                type: 'child_session_started',
                childId: row.id,
                kind,
                title: row.title,
            });
        }

        if (kind === 'agent') {
            await this.agent.submitTask(
                row.id,
                ownerId,
                request.task ?? '',
                request.tools,
                request.traceparent,
            );
        }

        return toDto(row);
    }

    async require(id: string): Promise<Session> {
        const ownerId = await this.currentOwnerId();
        const row = await this.prisma.session.findFirst({
            where: { id, ownerId },
            include: { model: { select: { identifier: true } }, workflow: { select: { name: true } } },
        });
        // Ответ «не найдено» вместо «доступ запрещён» намеренно: код 403 подтвердил бы, что
        // объект с таким идентификатором существует.
        if (row === null) throw new NotFoundException(`Сессия ${id} не найдена`);
        return toDto(row);
    }

    /**
     * Чат-сессия, в которой не идёт ход: только в этом состоянии она принимает сообщение и
     * смену модели.
     *
     * TODO: проверить идемпотентность приёма сообщения. Проверка состояния здесь и запись
     * `running` в `AgentRunnerService.run` разделены несколькими обращениями к базе, и два
     * сообщения, пришедшие в этот промежуток, запустят в сессии два хода.
     */
    async requireIdle(id: string): Promise<Session> {
        const session = await this.require(id);
        if (session.status === 'running') {
            throw new ConflictException('В сессии уже выполняется ход');
        }
        if (session.kind !== 'chat') {
            throw new ConflictException(
                'Сообщения принимает только чат-сессия: остальные виды получают вход при создании',
            );
        }
        return session;
    }

    /**
     * Прерывание сессии вместе с потомками.
     *
     * Обход идёт сверху вниз и начинается с потомков: прерванный родитель перестаёт
     * ожидать их результата, и оставленные работать потомки продолжали бы расходовать
     * токены впустую, а результат отдавать стало бы некому.
     */
    async interrupt(id: string): Promise<boolean> {
        await this.require(id);
        return this.interruptTree(id);
    }

    private async interruptTree(id: string): Promise<boolean> {
        const children = await this.prisma.session.findMany({
            where: { parentId: id },
            select: { id: true },
        });
        let any = false;
        for (const child of children) {
            if (await this.interruptTree(child.id)) any = true;
        }

        const row = await this.prisma.session.findUnique({ where: { id }, select: { kind: true } });
        if (row === null) return any;

        if (row.kind === 'workflow') {
            // Служба воркфлоу разрешается по токену: она обращается к сессиям, а сессии —
            // к ней, и ссылка на класс замкнула бы модули в цикл.
            const runner = this.moduleRef.get<WorkflowRunnerService>(WORKFLOW_RUNNER, {
                strict: false,
            });
            return (await runner.interrupt(id)) || any;
        }
        return (await this.agent.interrupt(id)) || any;
    }

    /**
     * Смена модели сессии. Разрешена только когда ход не идёт: смена посреди хода означала
     * бы, что часть шагов выполнена одной моделью, а часть другой, причём незаметно для
     * пользователя.
     *
     * Наличие истории смене не мешает: массив сообщений собирается из журнала заново на
     * каждый ход, поэтому новая модель получает весь прежний диалог как есть.
     */
    async selectModel(id: string, modelId: string): Promise<Session> {
        await this.requireIdle(id);
        const profile = await this.models.require(modelId);
        const row = await this.prisma.session.update({
            where: { id },
            data: { modelId, modelIdentifier: profile.identifier },
            include: { model: { select: { identifier: true } }, workflow: { select: { name: true } } },
        });
        return toDto(row);
    }

    /**
     * Переименование сессии.
     *
     * Разрешено в любом состоянии, включая идущий ход: название есть свойство карточки в
     * списке и на исполнение не влияет. Автоматическое название из первого сообщения после
     * этого не применяется — оно ставится только вместо значения по умолчанию.
     */
    async rename(id: string, title: string): Promise<Session> {
        await this.require(id);
        const row = await this.prisma.session.update({
            where: { id },
            data: { title: title.replace(/\s+/g, ' ').trim() },
            include: { model: { select: { identifier: true } }, workflow: { select: { name: true } } },
        });
        return toDto(row);
    }

    /**
     * Заполнение модели у сессий, где отметка отсутствует.
     *
     * Отметка появилась позже самих сессий, поэтому у созданных до неё модель не записана, и
     * список показывает пустое место там, где ход исполнялся вполне определённой моделью.
     * Восстанавливается она из журнала: событие о начале шага несёт модель, к которой шаг
     * обращался, — это и есть свидетельство того, чем сессия велась.
     *
     * Берётся последний шаг, а не первый: модель сессии можно сменить между ходами, и
     * действующей является та, которой исполнялся последний ход.
     *
     * Сессия без единого шага пропускается. Приписать ей модель по нынешней настройке
     * значило бы записать предположение вместо наблюдения: она ничем не велась.
     *
     * Обход по сессиям, а не одним запросом: операция разовая и выполняется по малому числу
     * записей, а извлечение поля JSON запросом усложнило бы её без выигрыша.
     */
    async backfillModels(): Promise<BackfillModelsResponse> {
        const ownerId = await this.currentOwnerId();
        const rows = await this.prisma.session.findMany({
            where: { ownerId, modelIdentifier: null },
            select: { id: true },
        });

        let updated = 0;
        let skipped = 0;

        for (const row of rows) {
            const event = await this.prisma.sessionEvent.findFirst({
                where: { sessionId: row.id, type: 'step_started' },
                orderBy: { seq: 'desc' },
                select: { payload: true },
            });

            const model = readModel(event?.payload);
            if (model === null) {
                skipped += 1;
                continue;
            }

            // `lastEventAt` не трогается: заполнение отметки не есть работа в сессии, и
            // порядок в списке от него меняться не должен.
            await this.prisma.session.update({
                where: { id: row.id },
                data: { modelIdentifier: model },
            });
            updated += 1;
        }

        return { updated, skipped };
    }

    async remove(id: string): Promise<void> {
        await this.require(id);
        this.bus.close(id);
        await this.prisma.session.delete({ where: { id } });
    }

    /**
     * Заголовок сессии из первого сообщения пользователя. Отдельного обращения к модели за
     * названием версия 0.1.0 не делает: это лишний запрос ради строки в списке.
     */
    async ensureTitle(id: string, firstMessage: string): Promise<void> {
        const session = await this.prisma.session.findUnique({
            where: { id },
            select: { title: true, eventCount: true },
        });
        if (session === null || session.eventCount > 0 || session.title !== 'Новый чат') return;
        await this.prisma.session.update({ where: { id }, data: { title: shorten(firstMessage) } });
    }
}

const shorten = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 60);

/** Модель из полезной нагрузки события о начале шага. */
function readModel(payload: unknown): string | null {
    if (payload === null || typeof payload !== 'object') return null;
    const value = (payload as { model?: unknown }).model;
    return typeof value === 'string' && value !== '' ? value : null;
}

export type SessionRow = {
    id: string;
    title: string;
    kind: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    eventCount: number;
    modelId: string | null;
    modelIdentifier?: string | null;
    model?: { identifier: string } | null;
    parentId: string | null;
    workflowId: string | null;
    workflow?: { name: string } | null;
    result: unknown;
    failureMessage: string | null;
};

const kindOf = (value: string): SessionKind =>
    value === 'workflow' || value === 'agent' ? value : 'chat';

const statusOf = (value: string): SessionStatus =>
    value === 'running' || value === 'completed' || value === 'failed' ? value : 'idle';

export function toDto(row: SessionRow): Session {
    return {
        id: row.id,
        title: row.title,
        kind: kindOf(row.kind),
        status: statusOf(row.status),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        eventCount: row.eventCount,
        modelId: row.modelId,
        // Запомненный идентификатор имеет преимущество перед связью со справочником: сессия
        // ведётся именно им, а запись справочника могла быть изменена после её создания.
        modelName: row.modelIdentifier ?? row.model?.identifier ?? null,
        parentId: row.parentId,
        workflowId: row.workflowId,
        workflowName: row.workflow?.name ?? null,
        result: row.result ?? null,
        failureMessage: row.failureMessage,
    };
}
