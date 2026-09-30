import { Global, Module } from '@nestjs/common';
import { WorkflowProcessService } from './workflow-process.service.js';
import { WorkflowRunnerService } from './workflow-runner.service.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';
import { WORKFLOW_REGISTRY, WORKFLOW_RUNNER } from './tokens.js';

/**
 * Домен воркфлоу: реестр карточек, надзор за процессами, исполнения.
 *
 * Модуль объявлен глобальным, потому что к его службам обращаются инструменты агента и
 * прерывание сессии, находящиеся в других модулях. Внедрение в конструктор там невозможно:
 * реестр воркфлоу сам обращается к набору инструментов, чтобы сверить требования, и
 * взаимное внедрение замкнуло бы модули в цикл.
 */
@Global()
@Module({
    controllers: [WorkflowsController],
    providers: [
        WorkflowProcessService,
        WorkflowsService,
        WorkflowRunnerService,
        { provide: WORKFLOW_REGISTRY, useExisting: WorkflowsService },
        { provide: WORKFLOW_RUNNER, useExisting: WorkflowRunnerService },
    ],
    exports: [
        WorkflowProcessService,
        WorkflowsService,
        WorkflowRunnerService,
        WORKFLOW_REGISTRY,
        WORKFLOW_RUNNER,
    ],
})
export class WorkflowsModule {}
