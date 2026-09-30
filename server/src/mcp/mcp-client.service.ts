import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { mcpSnapshotSchema, type McpSnapshot, type McpTransport } from '@weragen/types';
import { AppConfigService } from '../config/app-config.service.js';
import { McpFailure, createTransport, describeTransport } from './mcp-transport.js';
import { normalizeCallResult, type McpCallOutcome } from './mcp-result.js';

/**
 * Обращения к внешним серверам MCP.
 *
 * Служба знает два действия: обнаружить состав инструментов и вызвать инструмент. Хранением
 * карточек она не занимается — этим занят реестр.
 *
 * Соединение живёт один ход агента и открывается лениво, при первом вызове инструмента
 * данного подключения. Ход, не обратившийся к внешним инструментам, не подключается вовсе.
 * Это возможно потому, что состав инструментов берётся из снимка: обнаружение ушло с пути
 * подготовки хода, и открывать соединение раньше первого вызова незачем. Пул соединений,
 * разделяемый между ходами, не нужен: снимок фиксирует состав инструментов для хода,
 * а соединение требуется только при фактическом вызове.
 */

/** Сколько байт вывода в stderr сохраняется для объяснения отказа. */
const STDERR_TAIL_CHARS = 2000;

/**
 * Отказ вызова инструмента. Различие двух причин определяет реакцию: `unreachable` означает
 * недоступность сервера и не говорит ничего о снимке, `rejected` означает, что сервер
 * ответил отказом на сам вызов, и тогда снимок мог разойтись с действительным составом.
 */
export class McpCallFailure extends Error {
    constructor(
        readonly kind: 'unreachable' | 'rejected',
        message: string,
    ) {
        super(message);
        this.name = 'McpCallFailure';
    }
}

/** Подключение в том виде, в каком оно нужно для обращения к серверу. */
export type McpTarget = {
    readonly id: string;
    readonly name: string;
    readonly transport: McpTransport;
};

@Injectable()
export class McpClientService {
    private readonly logger = new Logger(McpClientService.name);

    constructor(private readonly config: AppConfigService) {}

    /**
     * Обнаружение состава: подключение, инициализация, запрос перечня инструментов, закрытие.
     *
     * Проверка карточки выполняется тем же способом, что и работа. Второй механизм ради
     * одной операции был бы избыточен.
     */
    async discover(transport: McpTransport): Promise<McpSnapshot> {
        const timeoutMs = this.config.mcp.connectTimeoutMs;
        const opened = await this.open(transport, timeoutMs);

        try {
            const listed = await opened.client.listTools(undefined, { timeout: timeoutMs });
            const version = opened.client.getServerVersion();
            const capabilities = opened.client.getServerCapabilities() ?? {};

            const unused: string[] = [];
            if (capabilities.resources !== undefined) unused.push('ресурсы');
            if (capabilities.prompts !== undefined) unused.push('промпты');

            return mcpSnapshotSchema.parse({
                discoveredAt: new Date().toISOString(),
                serverName: version?.name ?? null,
                serverVersion: version?.version ?? null,
                instructions: opened.client.getInstructions() ?? null,
                tools: listed.tools.map((tool) => ({
                    name: tool.name,
                    title: tool.title ?? tool.annotations?.title ?? null,
                    description: tool.description ?? '',
                    inputSchema: tool.inputSchema as Record<string, unknown>,
                })),
                unusedCapabilities: unused,
            });
        } catch (cause) {
            throw this.toFailure(cause, transport, opened.stderr());
        } finally {
            await opened.close();
        }
    }

    /** Открывает набор соединений на один ход. Закрывается вызывающей стороной. */
    openSession(): McpSession {
        return new McpSession(
            (transport) => this.open(transport, this.config.mcp.connectTimeoutMs),
            (cause, transport, output) => this.toFailure(cause, transport, output),
            this.logger,
        );
    }

    /**
     * Подключение и инициализация.
     *
     * Вывод дочернего процесса в stderr собирается с самого начала: у сервера, не сумевшего
     * запуститься, это единственное объяснение причины, и получить его после закрытия
     * транспорта уже нельзя.
     */
    private async open(transport: McpTransport, timeoutMs: number): Promise<OpenedClient> {
        const wire: Transport = createTransport(transport);

        let tail = '';
        if (wire instanceof StdioClientTransport) {
            // Поток появляется до старта процесса, поэтому подписка успевает к первым строкам.
            wire.stderr?.on('data', (chunk: Buffer) => {
                tail = (tail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
            });
        }

        const client = new Client(
            { name: 'weragen', version: '0.1.0' },
            // Клиентские возможности не заявляются: sampling, elicitation и roots платформой
            // не поддерживаются, и объявить их означало бы обещать сервису то, чего нет.
            { capabilities: {} },
        );

        try {
            await client.connect(wire, { timeout: timeoutMs });
        } catch (cause) {
            await client.close().catch(() => undefined);
            throw this.toFailure(cause, transport, tail);
        }

        return {
            client,
            stderr: () => tail,
            close: async () => {
                await client.close().catch(() => undefined);
            },
        };
    }

    /**
     * Различает отказы. Ошибка протокола с кодом, относящимся к самому запросу, означает,
     * что сервер отвечает и отвергает вызов; всё остальное означает недоступность.
     */
    private toFailure(cause: unknown, transport: McpTransport, output: string): McpFailure {
        if (cause instanceof McpFailure) return cause;

        const where = describeTransport(transport);
        const detail = output.trim() === '' ? '' : `\n${output.trim()}`;

        if (cause instanceof McpError) {
            if (cause.code === ErrorCode.RequestTimeout) {
                return new McpFailure(
                    'unreachable',
                    `Сервер MCP не ответил за отведённое время (${where})${detail}`,
                );
            }
            if (cause.code === ErrorCode.ConnectionClosed) {
                return new McpFailure(
                    'unreachable',
                    `Соединение с сервером MCP закрыто (${where})${detail}`,
                );
            }
            return new McpFailure(
                'unsatisfied',
                `Ошибка протокола MCP (код ${cause.code}): ${cause.message}${detail}`,
            );
        }

        const message = cause instanceof Error ? cause.message : String(cause);
        return new McpFailure('unreachable', `Сервер MCP недоступен (${where}): ${message}${detail}`);
    }
}

type OpenedClient = {
    readonly client: Client;
    readonly stderr: () => string;
    readonly close: () => Promise<void>;
};

/**
 * Соединения одного хода.
 *
 * Каждое подключение открывается не более одного раза за ход: параллельные вызовы к одному
 * серверу ожидают одного и того же обещания, а не порождают второе соединение. По завершении
 * хода закрываются все открытые.
 */
export class McpSession {
    private readonly clients = new Map<string, Promise<OpenedClient>>();
    private closed = false;

    constructor(
        private readonly open: (transport: McpTransport) => Promise<OpenedClient>,
        private readonly toFailure: (
            cause: unknown,
            transport: McpTransport,
            output: string,
        ) => McpFailure,
        private readonly logger: Logger,
    ) {}

    /**
     * Вызывает инструмент внешнего сервера.
     *
     * Предел времени задаётся на вызов отдельно от предела на подключение.
     * После обнаружения инструментов ограничение подключения уже не действует;
     * отдельный предел не даёт зависшему серверу удерживать ход до отмены.
     */
    async call(
        target: McpTarget,
        remoteName: string,
        args: Record<string, unknown>,
        options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
    ): Promise<McpCallOutcome> {
        if (this.closed) {
            throw new McpCallFailure('unreachable', 'Ход завершён, соединение закрыто');
        }

        let opened: OpenedClient;
        try {
            opened = await this.clientFor(target);
        } catch (cause) {
            const failure =
                cause instanceof McpFailure
                    ? cause
                    : this.toFailure(cause, target.transport, '');
            throw new McpCallFailure('unreachable', failure.message);
        }

        let outcome: McpCallOutcome | undefined;
        let thrown: unknown;
        try {
            const raw = await opened.client.callTool({ name: remoteName, arguments: args }, undefined, {
                timeout: options.timeoutMs,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            outcome = normalizeCallResult(raw);
        } catch (cause) {
            thrown = cause;
        }

        if (thrown === undefined && outcome !== undefined && outcome.ok) return outcome;

        // Неудачный вызов проверяется на расхождение снимка, и проверяется структурно, а не по
        // тексту ошибки. Признак «инструмента нет» приходит от разных серверов по-разному:
        // одни отвечают ошибкой протокола с кодом, другие — обычным результатом с признаком
        // `isError`, и по содержимому эти два случая неотличимы от неверных аргументов.
        // Достоверный признак один: инструмента нет в перечне, который сервер объявляет
        // сейчас. Запрос перечня выполняется по уже открытому соединению и только на пути
        // отказа, который редок.
        if (this.serverAnswered(thrown) && (await this.gone(opened, remoteName, options.timeoutMs))) {
            throw new McpCallFailure(
                'rejected',
                `Сервер "${target.name}" больше не объявляет инструмент ${remoteName}` +
                    (outcome !== undefined && !outcome.ok ? `: ${outcome.message}` : ''),
            );
        }

        if (thrown !== undefined) {
            throw this.toCallFailure(thrown, target, remoteName, opened.stderr());
        }
        return outcome as McpCallOutcome;
    }

    /**
     * Ответил ли сервер вообще. Истечение времени и закрытое соединение не говорят о составе
     * инструментов ничего, и запрашивать перечень в этом случае значит ждать второй раз.
     */
    private serverAnswered(thrown: unknown): boolean {
        if (thrown === undefined) return true;
        if (!(thrown instanceof McpError)) return false;
        return thrown.code !== ErrorCode.RequestTimeout && thrown.code !== ErrorCode.ConnectionClosed;
    }

    /** Отсутствует ли инструмент в том перечне, который сервер объявляет сейчас. */
    private async gone(opened: OpenedClient, remoteName: string, timeoutMs: number): Promise<boolean> {
        try {
            const listed = await opened.client.listTools(undefined, { timeout: timeoutMs });
            return !listed.tools.some((tool) => tool.name === remoteName);
        } catch {
            // Перечень получить не удалось — утверждать расхождение не на чем.
            return false;
        }
    }

    /** Закрывает все открытые за ход соединения. Отказ закрытия не должен ронять ход. */
    async close(): Promise<void> {
        this.closed = true;
        const opened = [...this.clients.values()];
        this.clients.clear();

        await Promise.all(
            opened.map(async (pending) => {
                try {
                    await (await pending).close();
                } catch (cause) {
                    this.logger.warn(
                        `закрытие соединения MCP не удалось: ${
                            cause instanceof Error ? cause.message : String(cause)
                        }`,
                    );
                }
            }),
        );
    }

    private clientFor(target: McpTarget): Promise<OpenedClient> {
        const existing = this.clients.get(target.id);
        if (existing !== undefined) return existing;

        const pending = this.open(target.transport);
        this.clients.set(target.id, pending);
        // Неудачное подключение из карты убирается: иначе первый отказ за ход закрыл бы
        // подключение до конца хода, хотя сервер мог подняться между вызовами.
        pending.catch(() => this.clients.delete(target.id));
        return pending;
    }

    private toCallFailure(
        cause: unknown,
        target: McpTarget,
        remoteName: string,
        output: string,
    ): McpCallFailure {
        if (cause instanceof McpError) {
            // Отказ, относящийся к самому вызову: инструмента нет либо аргументы не подошли.
            // Значит, снимок мог разойтись с действительным составом сервера.
            const rejected =
                cause.code === ErrorCode.InvalidParams ||
                cause.code === ErrorCode.MethodNotFound ||
                cause.code === ErrorCode.InvalidRequest;
            if (rejected) {
                return new McpCallFailure(
                    'rejected',
                    `Сервер "${target.name}" отклонил вызов ${remoteName}: ${cause.message}`,
                );
            }
        }

        const failure = this.toFailure(cause, target.transport, output);
        return new McpCallFailure(
            failure.kind === 'unsatisfied' ? 'rejected' : 'unreachable',
            failure.message,
        );
    }
}
