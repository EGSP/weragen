import { Module } from '@nestjs/common';
import { AgentModule } from './agent/agent.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { ModelsModule } from './models/models.module.js';
import { YandexModule } from './yandex/yandex.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';

@Module({
    imports: [
        ConfigModule,
        DatabaseModule,
        YandexModule,
        ModelsModule,
        McpModule,
        AgentModule,
        SessionsModule,
        WorkflowsModule,
    ],
})
export class AppModule {}
