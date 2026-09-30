import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Effect } from 'effect';
import { z } from 'zod';
import {
    describeCause,
    ToolFailure,
    toolFailure,
    toolSpec,
    zodInput,
    type AgentTool,
    type AnyAgentTool,
    type ToolSpec,
} from '@weragen/ai';
import type { ToolInfo } from '@weragen/types';
import { PrismaService } from '../database/prisma.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { McpClientService, type McpSession } from '../mcp/mcp-client.service.js';
import { McpService } from '../mcp/mcp.service.js';
import { buildMcpTools, mcpPromptSections } from '../mcp/mcp.tool.js';
import { renderChart, sampleSeries } from './chart.tool.js';
import { listWorkflows, runWorkflow } from './workflow.tool.js';

/** Предел объёма заметок: малое значение нужно, чтобы модель встречала отказ инструмента. */
const MAX_NOTES = 3;

/**
 * Подсказка при недоступности базы данных. Отказ хранилища вызовом не исправляется, поэтому
 * модель следует направить в обход, а не к повтору того же вызова.
 */
const STORAGE_HINT =
    'Хранилище платформы недоступно, и повтор того же вызова даст тот же результат. ' +
    'Продолжай без заметок либо сообщи, что сохранить их не удалось.';

/**
 * Схемы инструментов, замкнутых на сессию.
 *
 * Объявлены на уровне модуля, а не внутри фабрики: сами инструменты создаются заново на
 * каждый ход, поскольку замыкаются на идентификатор сессии, тогда как схема от сессии не
 * зависит. Порождение JSON Schema обходит схему целиком, и повторять его на каждый ход
 * незачем.
 */
const NO_ARGUMENTS = zodInput(z.object({}));
const WRITE_NOTE_INPUT = zodInput(
    z.object({
        text: z.string().min(1).describe('Текст заметки, одна строка'),
    }),
);

export type SessionToolRegistry = {
    readonly specs: readonly ToolSpec[];
    readonly find: (name: string) => AnyAgentTool | undefined;
    readonly names: readonly string[];
    /**
     * Секции системного промпта, полученные извне: текстовые инструкции подключённых
     * серверов MCP. Описания инструментов сюда не дублируются — они уходят в поле `tools`.
     */
    readonly instructions: readonly string[];
    /**
     * Закрывает соединения, открытые за ход. Вызывается по завершении хода, каким бы он ни
     * был: соединение живёт ровно ход и переживать его не должно.
     */
    readonly close: () => Promise<void>;
};

/**
 * Сборка набора инструментов под конкретную сессию.
 *
 * Набор собирается на каждый ход, а не создаётся один раз: инструменты работы с заметками
 * замкнуты на свою сессию, и позже сюда же добавится фильтрация по уровню полномочий.
 */
@Injectable()
export class ToolsFactory {
    private readonly logger = new Logger(ToolsFactory.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: AppConfigService,
        private readonly moduleRef: ModuleRef,
        private readonly mcp: McpService,
        private readonly mcpClient: McpClientService,
    ) {}

    /**
     * Трассировкой вызовов фабрика не занимается: спан открывает наблюдатель, объявленный
     * требованием ядра, и охватывает он вызов целиком — вместе со сверкой имени и разбором
     * аргументов, которые происходят до того, как инструмент найден.
     *
     * @param allowed Имена инструментов, доступных сессии. Отсутствие означает весь набор.
     * Перечень только сужает набор: предоставляет инструменты платформа, и воркфлоу,
     * запрашивая сессию, может выбрать из имеющегося, но не добавить своего.
     */
    async forSession(
        sessionId: string,
        allowed?: readonly string[],
    ): Promise<SessionToolRegistry> {
        // Соединения хода. Открываются не здесь, а при первом вызове инструмента: набор
        // собирается из снимков, поэтому подготовка хода к серверам не обращается.
        const session = this.mcpClient.openSession();
        const connections = await this.mcp.active().catch((cause: unknown) => {
            // Отказ справочника не должен уносить ход: он означает недоступность базы, а не
            // недоступность инструментов, и собственные инструменты остаются работоспособны.
            this.logger.warn(`подключения MCP не прочитаны: ${describeCause(cause)}`);
            return [];
        });

        const external = buildMcpTools(connections, session, {
            callTimeoutMs: this.config.mcp.callTimeoutMs,
            onDiverged: (connectionId, message) => {
                void this.mcp.markStale(connectionId, message);
            },
        });

        // Собственные инструменты идут первыми: при совпадении имён побеждает первая
        // регистрация, и уступать имя внешнему серверу платформа не должна.
        const filter = allowed === undefined ? undefined : new Set(allowed);
        const tools = this.deduplicate([...this.builtin(sessionId), ...external]).filter(
            (tool) => filter === undefined || filter.has(tool.name),
        );

        const specs = tools.map((tool) => toolSpec(tool));
        this.warnOnVolume(specs);

        const byName = new Map(tools.map((tool) => [tool.name, tool]));
        return {
            specs,
            find: (name) => byName.get(name),
            names: tools.map((tool) => tool.name),
            instructions: mcpPromptSections(connections),
            close: () => session.close(),
        };
    }

    /** Инструменты, написанные внутри платформы. Ни базы подключений, ни сети не требуют. */
    private builtin(sessionId: string): AnyAgentTool[] {
        return [
            rollDice,
            randomNumber,
            defineTool(sampleSeries),
            defineTool(renderChart),
            this.readNotes(sessionId),
            this.writeNote(sessionId),
            this.clearNotes(sessionId),
            listWorkflows(this.moduleRef),
            runWorkflow(this.moduleRef, sessionId),
        ];
    }

    /** Имена и описания встроенных инструментов. Обращений к внешним серверам не требует. */
    describe(): ToolInfo[] {
        return this.builtin('preview').map((tool) => ({
            name: tool.name,
            description: tool.description,
            source: 'builtin' as const,
        }));
    }

    /** Полный состав для интерфейса: встроенные плюс инструменты подключений MCP. */
    async describeAll(): Promise<ToolInfo[]> {
        const connections = await this.mcp.active();
        const external = buildMcpTools(connections, this.mcpClient.openSession(), {
            callTimeoutMs: this.config.mcp.callTimeoutMs,
            onDiverged: () => undefined,
        });
        return [
            ...this.describe(),
            ...external.map((tool) => ({
                name: tool.name,
                description: tool.description,
                source: 'mcp' as const,
            })),
        ];
    }

    /**
     * Отбрасывает инструменты с уже занятым именем.
     *
     * Совпадение возможно только со встроенным инструментом: префикс подключения уникален по
     * справочнику, а имена внутри одного сервера уникальны по протоколу. Проверка находится
     * здесь, а не в справочнике MCP: справочник поставляет инструменты и об именах остальных
     * не осведомлён.
     */
    private deduplicate(tools: readonly AnyAgentTool[]): AnyAgentTool[] {
        const seen = new Set<string>();
        const kept: AnyAgentTool[] = [];
        for (const tool of tools) {
            if (seen.has(tool.name)) {
                this.logger.error(
                    `имя инструмента "${tool.name}" уже занято; инструмент источника ` +
                        `${tool.source ?? 'builtin'} отброшен — побеждает первая регистрация`,
                );
                continue;
            }
            seen.add(tool.name);
            kept.push(tool);
        }
        return kept;
    }

    /**
     * Предупреждение об объёме набора. Набор не сокращается: сокращение без ведома
     * администратора спрятало бы причину, по которой агент не видит инструмента.
     */
    private warnOnVolume(specs: readonly ToolSpec[]): void {
        const chars = JSON.stringify(specs).length;
        if (specs.length <= this.config.mcp.warnToolCount && chars <= this.config.mcp.warnSchemaChars) {
            return;
        }
        this.logger.warn(
            `набор инструментов велик: ${specs.length} инструментов, ~${chars} символов схем ` +
                `(пороги ${this.config.mcp.warnToolCount} и ${this.config.mcp.warnSchemaChars})`,
        );
    }

    private async notesOf(sessionId: string): Promise<string[]> {
        const session = await this.prisma.session.findUnique({
            where: { id: sessionId },
            select: { notes: true },
        });
        const raw = session?.notes;
        return Array.isArray(raw) ? raw.filter((line): line is string => typeof line === 'string') : [];
    }

    private readNotes(sessionId: string): AnyAgentTool {
        const factory = this;
        return defineTool({
            name: 'read_notes',
            description:
                'Читает заметки текущей сессии и возвращает их строки. Если заметок нет, ' +
                'возвращает пустой список.',
            input: NO_ARGUMENTS,
            // Обращение к базе объявлено способным отказать: `Effect.promise` обратил бы
            // недоступность хранилища в дефект, и модель получила бы текст исключения
            // вместо указания, что делать дальше.
            execute: () =>
                Effect.tryPromise({
                    try: async () => {
                        const lines = await factory.notesOf(sessionId);
                        return { count: lines.length, limit: MAX_NOTES, lines };
                    },
                    catch: toolFailure('Заметки сессии не прочитаны', STORAGE_HINT),
                }),
        });
    }

    private writeNote(sessionId: string): AnyAgentTool {
        const factory = this;
        return defineTool({
            name: 'write_note',
            description:
                `Дописывает одну строку в заметки сессии. Строк не может быть больше ${MAX_NOTES}: ` +
                'если предел достигнут, вызов отклоняется и заметки нужно сначала очистить.',
            input: WRITE_NOTE_INPUT,
            execute: ({ text }) =>
                Effect.gen(function* () {
                    const lines = yield* Effect.tryPromise({
                        try: () => factory.notesOf(sessionId),
                        catch: toolFailure('Заметки сессии не прочитаны', STORAGE_HINT),
                    });
                    if (lines.length >= MAX_NOTES) {
                        // Отказ инструмента — штатная ситуация. Текст написан так, чтобы модель
                        // поняла, что делать дальше, а не повторяла тот же вызов.
                        return yield* Effect.fail(
                            new ToolFailure(
                                `В заметках уже ${lines.length} строк из ${MAX_NOTES}, добавить нельзя.`,
                                'Вызови clear_notes, если старые записи больше не нужны, и повтори запись.',
                            ),
                        );
                    }
                    const next = [...lines, text.replace(/\s+/g, ' ').trim()];
                    yield* Effect.tryPromise({
                        try: () =>
                            factory.prisma.session.update({
                                where: { id: sessionId },
                                data: { notes: next },
                            }),
                        catch: toolFailure('Заметка не сохранена', STORAGE_HINT),
                    });
                    return { written: next[next.length - 1], count: next.length, limit: MAX_NOTES };
                }),
        });
    }

    private clearNotes(sessionId: string): AnyAgentTool {
        const factory = this;
        return defineTool({
            name: 'clear_notes',
            description: 'Полностью очищает заметки сессии. Операция необратима.',
            input: NO_ARGUMENTS,
            execute: () =>
                Effect.tryPromise({
                    try: async () => {
                        const before = (await factory.notesOf(sessionId)).length;
                        await factory.prisma.session.update({
                            where: { id: sessionId },
                            data: { notes: [] },
                        });
                        return { cleared: before };
                    },
                    catch: toolFailure('Заметки сессии не очищены', STORAGE_HINT),
                }),
        });
    }
}

/** Приведение конкретного инструмента к типу реестра. */
function defineTool<Input>(tool: AgentTool<Input>): AnyAgentTool {
    return tool as unknown as AnyAgentTool;
}

const rollDice = defineTool({
    name: 'roll_dice',
    description:
        'Бросает игральные кубики и возвращает выпавшие значения и их сумму. Результат ' +
        'случаен, предсказать его нельзя — его обязательно нужно получить вызовом.',
    input: zodInput(
        z.object({
            count: z.number().int().min(1).max(10).default(1).describe('Сколько кубиков бросить'),
            sides: z.number().int().min(2).max(100).default(6).describe('Сколько граней у кубика'),
        }),
    ),
    execute: ({ count, sides }) =>
        Effect.sync(() => {
            const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
            return { rolls, sum: rolls.reduce((total, value) => total + value, 0), sides };
        }),
});

const randomNumber = defineTool({
    name: 'random_number',
    description:
        'Возвращает случайное целое число в заданном диапазоне включительно. Результат ' +
        'случаен, его нужно получить вызовом, а не придумать.',
    input: zodInput(
        z
            .object({
                min: z.number().int().describe('Нижняя граница диапазона'),
                max: z.number().int().describe('Верхняя граница диапазона'),
            })
            .refine((value) => value.min <= value.max, {
                message: 'min не может быть больше max',
            }),
    ),
    execute: ({ min, max }) =>
        Effect.sync(() => ({
            value: min + Math.floor(Math.random() * (max - min + 1)),
            min,
            max,
        })),
});

