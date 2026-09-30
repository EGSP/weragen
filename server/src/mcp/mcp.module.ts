import { Global, Module } from '@nestjs/common';
import { McpClientService } from './mcp-client.service.js';
import { McpController } from './mcp.controller.js';
import { McpService } from './mcp.service.js';

/**
 * Домен подключений MCP: справочник карточек, обнаружение состава, обращения к серверам.
 *
 * Модуль объявлен глобальным, потому что к его службам обращается сборщик набора
 * инструментов, находящийся в другом модуле. Цикла зависимостей здесь, в отличие от
 * воркфлоу, не возникает: справочник MCP поставляет инструменты и ни о каких других
 * инструментах платформы не осведомлён — имена сверяет тот, кто собирает набор целиком.
 */
@Global()
@Module({
    controllers: [McpController],
    providers: [McpClientService, McpService],
    exports: [McpClientService, McpService],
})
export class McpModule {}
