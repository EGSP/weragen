import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
    workflowSpecSchema,
    type CreateWorkflowRequest,
    type UpdateWorkflowRequest,
    type Workflow,
    type WorkflowCheckStatus,
    type WorkflowSpec,
} from '@weragen/types';
import { PrismaService } from '../database/prisma.service.js';
import { McpService } from '../mcp/mcp.service.js';
import { ModelsService } from '../models/models.service.js';
import { ToolsFactory } from '../tools/tools.factory.js';
import { ProcessFailure, WorkflowProcessService, type ProcessLaunch } from './workflow-process.service.js';

/**
 * Реестр воркфлоу.
 *
 * Платформа не содержит перечня реализаций: карточку заводит администратор, указывая, где
 * лежит пакет и чем он запускается, а состав воркфлоу платформа узнаёт у самого процесса.
 * Проверка требований выполняется тем же способом, что и исполнение, — запуском процесса, —
 * потому что второй механизм ради одной операции был бы избыточен.
 *
 * Проверка не выдаёт полномочий. Она устанавливает только возможность запуска: заявленное
 * воркфлоу либо есть на платформе, либо его нет.
 */
@Injectable()
export class WorkflowsService {
    private readonly logger = new Logger(WorkflowsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly processes: WorkflowProcessService,
        private readonly tools: ToolsFactory,
        private readonly models: ModelsService,
        private readonly mcp: McpService,
    ) {}

    async list(): Promise<Workflow[]> {
        const rows = await this.prisma.workflow.findMany({ orderBy: { name: 'asc' } });
        return rows.map(toDto);
    }

    async require(id: string): Promise<Workflow> {
        const row = await this.prisma.workflow.findUnique({ where: { id } });
        if (row === null) throw new NotFoundException(`Воркфлоу ${id} не найден`);
        return toDto(row);
    }

    async requireByName(name: string): Promise<Workflow> {
        const row = await this.prisma.workflow.findUnique({ where: { name } });
        if (row === null) throw new NotFoundException(`Воркфлоу "${name}" не зарегистрирован`);
        return toDto(row);
    }

    async create(request: CreateWorkflowRequest): Promise<Workflow> {
        const name = request.name.trim();
        const existing = await this.prisma.workflow.findUnique({ where: { name } });
        if (existing !== null) throw new ConflictException(`Воркфлоу "${name}" уже добавлен`);

        const created = await this.prisma.workflow.create({
            data: {
                name,
                packagePath: request.packagePath.trim(),
                ...(request.command === undefined ? {} : { command: request.command.trim() }),
                ...(request.args === undefined ? {} : { args: request.args }),
                ...(request.env === undefined ? {} : { env: request.env }),
            },
        });

        // Проверка выполняется сразу: карточка не должна оставаться в состоянии
        // «не проверялась» до того, как администратор нажмёт кнопку.
        return this.check(created.id);
    }

    async update(id: string, request: UpdateWorkflowRequest): Promise<Workflow> {
        await this.require(id);
        const name = request.name?.trim();

        await this.prisma.workflow.update({
            where: { id },
            data: {
                ...(name === undefined ? {} : { name }),
                ...(request.packagePath === undefined
                    ? {}
                    : { packagePath: request.packagePath.trim() }),
                ...(request.command === undefined ? {} : { command: request.command.trim() }),
                ...(request.args === undefined ? {} : { args: request.args }),
                ...(request.env === undefined ? {} : { env: request.env }),
                // Любая правка карточки обесценивает прежнее суждение о требованиях:
                // изменился либо пакет, либо способ его запуска.
                checkStatus: 'unknown' satisfies WorkflowCheckStatus,
                missing: [],
                lastCheckAt: null,
                lastCheckMessage: null,
            },
        });

        return this.check(id);
    }

    async remove(id: string): Promise<void> {
        await this.require(id);
        // Сессии сохраняются: связь обнуляется, а журнал исполнений остаётся. Удаление
        // карточки не должно уносить с собой историю того, что уже отработало.
        await this.prisma.workflow.delete({ where: { id } });
    }

    /** Описание запуска процесса по карточке. */
    async launchOf(id: string): Promise<ProcessLaunch> {
        const row = await this.prisma.workflow.findUniqueOrThrow({ where: { id } });
        return {
            name: row.name,
            packagePath: row.packagePath,
            command: row.command,
            args: asStrings(row.args),
            env: asStringMap(row.env),
        };
    }

    /**
     * Проверка требований: запуск процесса, запрос спецификации, сверка заявленного с тем,
     * что есть на платформе. Процесс после запроса завершается — постоянно работающих
     * процессов воркфлоу нет.
     */
    async check(id: string): Promise<Workflow> {
        const launch = await this.launchOf(id);

        let spec: WorkflowSpec;
        try {
            const process_ = await this.processes.launch(launch);
            try {
                const raw = await process_.call<unknown>('GET', '/requirements');
                spec = workflowSpecSchema.parse(raw);
            } finally {
                await process_.stop();
            }
        } catch (cause) {
            const output = cause instanceof ProcessFailure ? cause.output : '';
            const message = cause instanceof Error ? cause.message : String(cause);
            this.logger.warn(`проверка воркфлоу "${launch.name}" не удалась: ${message}`);
            return this.record(id, {
                spec: null,
                status: 'unreachable',
                missing: [],
                message: output === '' ? message : `${message}\n${output.trim()}`,
            });
        }

        if (spec.name !== launch.name) {
            return this.record(id, {
                spec,
                status: 'unsatisfied',
                missing: [],
                message:
                    `Процесс сообщил имя "${spec.name}", а в карточке указано "${launch.name}". ` +
                    'Имена должны совпадать: по имени карточки воркфлоу запускается.',
            });
        }

        const missing = await this.findMissing(spec);
        return this.record(id, {
            spec,
            status: missing.length === 0 ? 'ok' : 'unsatisfied',
            missing,
            message:
                missing.length === 0
                    ? `Требования выполнены. Версия ${spec.version}.`
                    : `Не хватает: ${missing.join(', ')}.`,
        });
    }

    /**
     * Сверка требований с реестрами платформы по совпадению имён. Воркфлоу заявляет, что
     * ему нужно, — предоставляет это платформа, поэтому недостача исправляется её
     * настройкой, а не пакетом воркфлоу.
     */
    private async findMissing(spec: WorkflowSpec): Promise<string[]> {
        const missing: string[] = [];

        // Набор инструментов платформы включает и полученные от серверов MCP: для воркфлоу
        // они неотличимы от встроенных, поскольку предоставляет их в обоих случаях платформа.
        const available = new Set([
            ...this.tools.describe().map((tool) => tool.name),
            ...(await this.mcp.toolNames()),
        ]);
        for (const name of spec.requires.tools) {
            if (!available.has(name)) missing.push(`инструмент ${name}`);
        }

        // Подключение считается имеющимся, если карточка включена и последняя проверка
        // прошла: выключенное либо непроверенное подключение инструментов не поставляет,
        // и запуск воркфлоу с ним закончился бы отказом на первом же вызове.
        const connections = new Map(
            (await this.mcp.list()).map((connection) => [connection.name, connection]),
        );
        for (const name of spec.requires.mcp) {
            const connection = connections.get(name);
            if (connection === undefined) {
                missing.push(`подключение MCP ${name}`);
            } else if (!connection.enabled) {
                missing.push(`подключение MCP ${name} (выключено)`);
            } else if (connection.checkStatus !== 'ok') {
                missing.push(`подключение MCP ${name} (${connection.checkStatus})`);
            }
        }

        if (spec.requires.models.length > 0) {
            const known = new Set((await this.models.list()).map((model) => model.identifier));
            for (const identifier of spec.requires.models) {
                if (!known.has(identifier)) missing.push(`модель ${identifier}`);
            }
        }

        return missing;
    }

    private async record(
        id: string,
        outcome: {
            spec: WorkflowSpec | null;
            status: WorkflowCheckStatus;
            missing: string[];
            message: string;
        },
    ): Promise<Workflow> {
        const row = await this.prisma.workflow.update({
            where: { id },
            data: {
                ...(outcome.spec === null ? {} : { spec: outcome.spec as object }),
                checkStatus: outcome.status,
                missing: outcome.missing,
                lastCheckAt: new Date(),
                lastCheckMessage: outcome.message,
            },
        });
        return toDto(row);
    }
}

type WorkflowRow = {
    id: string;
    name: string;
    packagePath: string;
    command: string;
    args: unknown;
    env: unknown;
    spec: unknown;
    checkStatus: string;
    missing: unknown;
    lastCheckAt: Date | null;
    lastCheckMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
};

function asStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asStringMap(value: unknown): Record<string, string> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string') result[key] = item;
    }
    return result;
}

const statusOf = (value: string): WorkflowCheckStatus =>
    value === 'ok' || value === 'unsatisfied' || value === 'unreachable' ? value : 'unknown';

export function toDto(row: WorkflowRow): Workflow {
    const spec = row.spec === null ? null : workflowSpecSchema.safeParse(row.spec);
    const parsed = spec !== null && spec.success ? spec.data : null;

    return {
        id: row.id,
        name: row.name,
        packagePath: row.packagePath,
        command: row.command,
        args: asStrings(row.args),
        env: asStringMap(row.env),
        version: parsed?.version ?? null,
        title: parsed?.title ?? null,
        description: parsed?.description ?? null,
        inputSchema: parsed?.input ?? null,
        requirements: parsed?.requires ?? null,
        checkStatus: statusOf(row.checkStatus),
        missing: asStrings(row.missing),
        lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
        lastCheckMessage: row.lastCheckMessage,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}
