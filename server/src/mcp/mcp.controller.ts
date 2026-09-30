import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type {
    AcceptedResponse,
    CreateMcpConnectionRequest,
    ImportMcpConnectionsRequest,
    McpConnection,
    McpConnectionListResponse,
    McpImportResponse,
    ToggleMcpConnectionRequest,
    UpdateMcpConnectionRequest,
} from '@weragen/types';
import {
    createMcpConnectionRequestSchema,
    importMcpConnectionsRequestSchema,
    toggleMcpConnectionRequestSchema,
    updateMcpConnectionRequestSchema,
} from '@weragen/types';
import { McpService } from './mcp.service.js';

/**
 * Контроллер справочника подключений MCP.
 *
 * Устройство маршрутов повторяет реестр воркфлоу: перечень, карточка, проверка. Отличие
 * одно — импорт конфигурации в сложившемся формате MCP-клиентов, которого у воркфлоу нет,
 * потому что общепринятого формата описания воркфлоу не существует.
 */
@Controller('api/mcp')
export class McpController {
    constructor(private readonly connections: McpService) {}

    @Get()
    async list(): Promise<McpConnectionListResponse> {
        return { connections: await this.connections.list() };
    }

    @Post()
    async create(@Body() body: CreateMcpConnectionRequest): Promise<McpConnection> {
        return this.connections.create(createMcpConnectionRequestSchema.parse(body));
    }

    /**
     * Импорт. Объявлен до маршрутов с параметром пути: иначе `import` было бы разобрано как
     * идентификатор карточки.
     */
    @Post('import')
    async import(@Body() body: ImportMcpConnectionsRequest): Promise<McpImportResponse> {
        const parsed = importMcpConnectionsRequestSchema.parse(body);
        return this.connections.import(parsed.json);
    }

    @Get(':id')
    async get(@Param('id') id: string): Promise<McpConnection> {
        return this.connections.require(id);
    }

    @Patch(':id')
    async update(
        @Param('id') id: string,
        @Body() body: UpdateMcpConnectionRequest,
    ): Promise<McpConnection> {
        return this.connections.update(id, updateMcpConnectionRequestSchema.parse(body));
    }

    @Delete(':id')
    async remove(@Param('id') id: string): Promise<AcceptedResponse> {
        await this.connections.remove(id);
        return { accepted: true };
    }

    /** Повторное обнаружение: подключение к серверу и запрос перечня инструментов. */
    @Post(':id/check')
    async check(@Param('id') id: string): Promise<McpConnection> {
        return this.connections.check(id);
    }

    /** Включение сопровождается обнаружением, выключение выполняется без обращения к серверу. */
    @Post(':id/toggle')
    async toggle(
        @Param('id') id: string,
        @Body() body: ToggleMcpConnectionRequest,
    ): Promise<McpConnection> {
        const parsed = toggleMcpConnectionRequestSchema.parse(body);
        return this.connections.toggle(id, parsed.enabled);
    }
}
