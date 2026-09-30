import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type {
    AcceptedResponse,
    CreateWorkflowRequest,
    Session,
    StartWorkflowRunRequest,
    UpdateWorkflowRequest,
    Workflow,
    WorkflowListResponse,
    WorkflowResultReport,
    WorkflowStepReport,
} from '@weragen/types';
import {
    createWorkflowRequestSchema,
    startWorkflowRunRequestSchema,
    updateWorkflowRequestSchema,
    workflowResultReportSchema,
    workflowStepReportSchema,
} from '@weragen/types';
import { WorkflowRunnerService } from './workflow-runner.service.js';
import { WorkflowsService } from './workflows.service.js';

/**
 * Контроллер домена воркфлоу.
 *
 * Отдельного шлюза для процессов воркфлоу нет: процесс обращается к обычным контроллерам
 * платформы. Сессии он запрашивает у контроллера сессий, о своих шагах и итоге сообщает
 * сюда. Каждому домену — свой контроллер, и адреса эндпоинтов процессу известны.
 */
@Controller('api/workflows')
export class WorkflowsController {
    constructor(
        private readonly workflows: WorkflowsService,
        private readonly runner: WorkflowRunnerService,
    ) {}

    @Get()
    async list(): Promise<WorkflowListResponse> {
        return { workflows: await this.workflows.list() };
    }

    @Post()
    async create(@Body() body: CreateWorkflowRequest): Promise<Workflow> {
        return this.workflows.create(createWorkflowRequestSchema.parse(body));
    }

    /**
     * Запуск исполнения. Объявлен до маршрутов с параметром пути: иначе `runs` было бы
     * разобрано как идентификатор карточки.
     */
    @Post('runs')
    async start(@Body() body: StartWorkflowRunRequest): Promise<Session> {
        const parsed = startWorkflowRunRequestSchema.parse(body);
        return this.runner.start(parsed.name, parsed.input, parsed.parentId, parsed.traceparent);
    }

    /** Сообщение о шаге от процесса воркфлоу. */
    @Post('runs/:sessionId/steps')
    async report(
        @Param('sessionId') sessionId: string,
        @Body() body: WorkflowStepReport,
    ): Promise<AcceptedResponse> {
        await this.runner.report(sessionId, workflowStepReportSchema.parse(body));
        return { accepted: true };
    }

    /** Сообщение об итоге от процесса воркфлоу. Им исполнение и завершается. */
    @Post('runs/:sessionId/result')
    async finish(
        @Param('sessionId') sessionId: string,
        @Body() body: WorkflowResultReport,
    ): Promise<AcceptedResponse> {
        await this.runner.finish(sessionId, workflowResultReportSchema.parse(body));
        return { accepted: true };
    }

    @Get(':id')
    async get(@Param('id') id: string): Promise<Workflow> {
        return this.workflows.require(id);
    }

    @Patch(':id')
    async update(
        @Param('id') id: string,
        @Body() body: UpdateWorkflowRequest,
    ): Promise<Workflow> {
        return this.workflows.update(id, updateWorkflowRequestSchema.parse(body));
    }

    @Delete(':id')
    async remove(@Param('id') id: string): Promise<AcceptedResponse> {
        await this.workflows.remove(id);
        return { accepted: true };
    }

    /** Повторная проверка требований: запуск процесса и запрос спецификации. */
    @Post(':id/check')
    async check(@Param('id') id: string): Promise<Workflow> {
        return this.workflows.check(id);
    }
}
