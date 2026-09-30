import { Global, Module } from '@nestjs/common';
import { ModelClientService } from '../model/model-client.service.js';
import { ToolsFactory } from '../tools/tools.factory.js';
import { AgentRunnerService } from './agent-runner.service.js';
import { RequestSnapshotService } from './request-snapshot.service.js';
import { SessionEventBus } from './session-event-bus.service.js';
import { SessionJournalService } from './session-journal.service.js';
import { SessionTraceRegistry } from '../telemetry/session-trace.service.js';
import { ToolObserverService } from '../telemetry/tool-observer.service.js';

@Global()
@Module({
    providers: [
        ModelClientService,
        ToolsFactory,
        SessionEventBus,
        SessionJournalService,
        SessionTraceRegistry,
        ToolObserverService,
        RequestSnapshotService,
        AgentRunnerService,
    ],
    exports: [
        AgentRunnerService,
        SessionEventBus,
        SessionJournalService,
        SessionTraceRegistry,
        RequestSnapshotService,
        ToolsFactory,
    ],
})
export class AgentModule {}
