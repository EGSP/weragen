import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    NotFoundException,
    Param,
    Patch,
    Post,
    Query,
    Sse,
} from '@nestjs/common';
import { from, interval, map, merge, mergeMap, type Observable } from 'rxjs';
import type {
    AcceptedResponse,
    BackfillModelsResponse,
    SelectModelRequest,
    CreateSessionRequest,
    RequestSnapshot,
    SendMessageRequest,
    Session,
    SessionContextResponse,
    SessionEventsResponse,
    SessionKind,
    SessionListResponse,
    RenameSessionRequest,
    ToolListResponse,
} from '@weragen/types';
import {
    createSessionRequestSchema,
    renameSessionRequestSchema,
    selectModelRequestSchema,
    sendMessageRequestSchema,
} from '@weragen/types';
import { AgentRunnerService } from '../agent/agent-runner.service.js';
import { RequestSnapshotService } from '../agent/request-snapshot.service.js';
import { SessionEventBus } from '../agent/session-event-bus.service.js';
import { SessionJournalService } from '../agent/session-journal.service.js';
import { ToolsFactory } from '../tools/tools.factory.js';
import { SessionsService } from './sessions.service.js';

/** Интервал служебных сообщений потока. Держится меньше таймаута простоя обратного прокси. */
const HEARTBEAT_MS = 25_000;

@Controller('api/sessions')
export class SessionsController {
    constructor(
        private readonly sessions: SessionsService,
        private readonly journal: SessionJournalService,
        private readonly runner: AgentRunnerService,
        private readonly bus: SessionEventBus,
        private readonly tools: ToolsFactory,
        private readonly snapshots: RequestSnapshotService,
    ) {}

    /**
     * Перечень корневых сессий. Отбор по виду разделяет вкладки интерфейса: чаты и
     * исполнения воркфлоу показываются раздельно, хотя запись у них одна.
     */
    @Get()
    async list(@Query('kind') kind?: string): Promise<SessionListResponse> {
        return { sessions: await this.sessions.list(kind as SessionKind | undefined) };
    }

    /**
     * Создание сессии. Обслуживает чат и агентскую сессию: первую создаёт человек, вторую —
     * другая сессия, когда ей нужен агентский цикл. Исполнение воркфлоу запускается своим
     * контроллером, потому что вместе с сессией нужно породить процесс.
     */
    @Post()
    async create(@Body() body: CreateSessionRequest): Promise<Session> {
        return this.sessions.create(createSessionRequestSchema.parse(body ?? {}));
    }

    /** Полный состав инструментов платформы: встроенные и полученные от серверов MCP. */
    /**
     * Заполнение модели у сессий, где отметка отсутствует, по журналу.
     *
     * Объявлено до маршрутов с параметром пути, как и перечень инструментов: иначе адрес
     * был бы разобран как идентификатор сессии.
     */
    @Post('models/backfill')
    async backfillModels(): Promise<BackfillModelsResponse> {
        return this.sessions.backfillModels();
    }

    @Get('tools')
    async listTools(): Promise<ToolListResponse> {
        return { tools: await this.tools.describeAll() };
    }

    /**
     * Снимок постоянной части запроса — промпт и описания инструментов, — на который
     * ссылается событие начала шага. По нему видно, с каким набором модель работала на
     * конкретном шаге. Объявлено до маршрутов с параметром пути по той же причине, что и
     * перечень инструментов.
     */
    @Get('snapshots/:snapshotId')
    async snapshot(@Param('snapshotId') snapshotId: string): Promise<RequestSnapshot> {
        const snapshot = await this.snapshots.find(snapshotId);
        if (snapshot === undefined) {
            throw new NotFoundException(`Снимок запроса ${snapshotId} не найден`);
        }
        return snapshot;
    }

    @Get(':id')
    async get(@Param('id') id: string): Promise<Session> {
        return this.sessions.require(id);
    }

    /** Переименование. Разрешено в любом состоянии: название на исполнение не влияет. */
    @Patch(':id')
    async rename(
        @Param('id') id: string,
        @Body() body: RenameSessionRequest,
    ): Promise<Session> {
        const parsed = renameSessionRequestSchema.parse(body);
        return this.sessions.rename(id, parsed.title);
    }

    @Delete(':id')
    async remove(@Param('id') id: string): Promise<AcceptedResponse> {
        await this.sessions.remove(id);
        return { accepted: true };
    }

    @Get(':id/events')
    async events(
        @Param('id') id: string,
        @Query('after') after?: string,
    ): Promise<SessionEventsResponse> {
        await this.sessions.require(id);
        const afterSeq = Number(after ?? 0) || 0;
        const events = await this.journal.read(id, afterSeq);
        return { events, lastSeq: events.at(-1)?.seq ?? afterSeq };
    }

    /**
     * Приём сообщения. Ход запускается фоном и к времени жизни этого запроса не привязан:
     * ответ возвращается сразу, а результат приходит событиями в поток.
     *
     * Если модели сессии в справочнике нет, сообщение отклоняется с кодом 409 и в журнал не
     * записывается: текст отказа называет причину, и интерфейсу достаточно его показать.
     */
    @Post(':id/messages')
    async send(
        @Param('id') id: string,
        @Body() body: SendMessageRequest,
    ): Promise<AcceptedResponse> {
        const parsed = sendMessageRequestSchema.parse(body);
        await this.sessions.requireIdle(id);
        // Модель определяется до любых записей: при отказе ни название, ни журнал сессии не
        // меняются, и повторная отправка того же сообщения не удваивает его в журнале.
        const model = await this.runner.prepare(id);
        await this.sessions.ensureTitle(id, parsed.text);
        await this.runner.submit(id, await this.sessions.currentOwnerId(), parsed.text, model);
        return { accepted: true };
    }

    /**
     * Состав контекста сессии. Вычисляется в момент запроса и нигде не хранится: числа —
     * оценка по составу текста, и держать их в базе значило бы выдавать догадку за данные.
     */
    @Get(':id/context')
    async context(@Param('id') id: string): Promise<SessionContextResponse> {
        const session = await this.sessions.require(id);
        if (session.kind === 'workflow') {
            throw new BadRequestException(
                'Контекст модели есть только у чат- и агентских сессий: воркфлоу исполняется без агентского цикла',
            );
        }
        return this.runner.measureContext(id);
    }

    /** Смена модели сессии. Допустима только когда ход не идёт. */
    @Post(':id/model')
    async selectModel(
        @Param('id') id: string,
        @Body() body: SelectModelRequest,
    ): Promise<Session> {
        const parsed = selectModelRequestSchema.parse(body);
        return this.sessions.selectModel(id, parsed.modelId);
    }

    /** Прерывание сессии вместе с потомками: продолжать их работу стало бы незачем. */
    @Post(':id/interrupt')
    async interrupt(@Param('id') id: string): Promise<AcceptedResponse> {
        return { accepted: await this.sessions.interrupt(id) };
    }

    /**
     * Поток событий сессии.
     *
     * Сначала досылаются события, пропущенные подписчиком (по порядковому номеру из `after`),
     * затем идут новые. Благодаря этому обрыв связи не приводит к потере части хода: клиент
     * переподключается и продолжает с того места, где остановился.
     */
    @Sse(':id/stream')
    stream(
        @Param('id') id: string,
        @Query('after') after?: string,
    ): Observable<{ id?: string; type: string; data: string }> {
        const afterSeq = Number(after ?? 0) || 0;

        // Сначала события, пропущенные подписчиком, затем идущие сейчас. Слияние, а не
        // последовательное соединение: подписка на живой поток должна начаться немедленно,
        // иначе события, случившиеся во время догрузки, потерялись бы. Возможный повтор
        // безвреден — клиент отбрасывает события с уже виденным порядковым номером.
        const replay = from(this.journal.read(id, afterSeq)).pipe(
            mergeMap((events) => from(events)),
        );

        const events = merge(replay, this.bus.stream(id)).pipe(
            map((event) => ({
                id: String(event.seq),
                type: 'event',
                data: JSON.stringify(event),
            })),
        );

        // Служебные сообщения не дают обратному прокси закрыть простаивающее соединение.
        const heartbeat = interval(HEARTBEAT_MS).pipe(map(() => ({ type: 'ping', data: '' })));

        return merge(events, heartbeat);
    }
}
