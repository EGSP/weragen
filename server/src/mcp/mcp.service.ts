import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { planExternalTools } from '@weragen/ai';
import {
    McpConfigError,
    mcpSnapshotSchema,
    mcpToolModeSchema,
    mcpTransportSchema,
    parseMcpServersFile,
    type CreateMcpConnectionRequest,
    type McpCheckStatus,
    type McpConnection,
    type McpSnapshot,
    type McpToolMode,
    type McpToolSelection,
    type McpTransport,
    type UpdateMcpConnectionRequest,
} from '@weragen/types';
import { PrismaService } from '../database/prisma.service.js';
import { McpClientService } from './mcp-client.service.js';
import { McpFailure } from './mcp-transport.js';

/**
 * Справочник подключений MCP.
 *
 * Устройство повторяет реестр воркфлоу, и это намеренно: у обоих одна форма — карточка,
 * заводимая администратором, состав которой платформа узнаёт не из своего кода, а у внешней
 * стороны. Различие в том, что здесь полученный состав хранится и служит источником истины:
 * набор инструментов хода собирается из снимка, без обращения к серверу.
 *
 * Имена встроенных инструментов справочнику не нужны. Он поставляет инструменты, а сверяет
 * имена тот, кто собирает набор целиком.
 */

/** Подключение в том виде, в каком оно нужно сборщику набора инструментов. */
export type ActiveMcpConnection = {
    readonly id: string;
    readonly name: string;
    readonly transport: McpTransport;
    readonly snapshot: McpSnapshot;
    readonly selection: McpToolSelection;
};

/** Отбор новой карточки: весь состав, новые инструменты сервера включаются сами. */
const ALL_TOOLS: McpToolSelection = { mode: 'all', enabled: [], excluded: [] };

@Injectable()
export class McpService {
    private readonly logger = new Logger(McpService.name);
    /** Повторные обнаружения, начатые после расхождения, — по одному на подключение. */
    private readonly rechecks = new Map<string, Promise<void>>();

    constructor(
        private readonly prisma: PrismaService,
        private readonly client: McpClientService,
    ) {}

    async list(): Promise<McpConnection[]> {
        const rows = await this.prisma.mcpConnection.findMany({ orderBy: { name: 'asc' } });
        return rows.map(toDto);
    }

    async require(id: string): Promise<McpConnection> {
        return toDto(await this.row(id));
    }

    /**
     * Подключения, пригодные для набора инструментов: включённые, прошедшие проверку и
     * получившие непустой снимок. Транспорт возвращается без вычищения секретов — он нужен
     * для обращения к серверу, а не для показа.
     *
     * Снимок подключения с отметкой о расхождении известен как неверный, поэтому набор из
     * него не собирается: сначала дожидается повторное обнаружение, затем подключения
     * читаются заново. Ожидание ограничено пределом времени подключения и возникает только
     * после расхождения; обычный ход к серверам по-прежнему не обращается.
     */
    async active(): Promise<ActiveMcpConnection[]> {
        const where = { enabled: true, checkStatus: 'ok' };
        let rows = await this.prisma.mcpConnection.findMany({ where, orderBy: { name: 'asc' } });

        const stale = rows.filter((row) => row.stale);
        if (stale.length > 0) {
            await Promise.all(stale.map((row) => this.recheck(row.id)));
            rows = await this.prisma.mcpConnection.findMany({ where, orderBy: { name: 'asc' } });
        }

        const active: ActiveMcpConnection[] = [];
        for (const row of rows) {
            const snapshot = parseSnapshot(row.snapshot);
            if (snapshot === null) continue;
            const transport = mcpTransportSchema.safeParse(row.config);
            if (!transport.success) {
                this.logger.warn(`подключение "${row.name}": конфигурация не разобрана, пропущено`);
                continue;
            }
            active.push({
                id: row.id,
                name: row.name,
                transport: transport.data,
                snapshot,
                selection: selectionOf(row),
            });
        }
        return active;
    }

    /** Имена инструментов всех пригодных подключений — для сверки требований воркфлоу. */
    async toolNames(): Promise<string[]> {
        const connections = await this.active();
        return connections.flatMap((connection) =>
            planExternalTools(
                connection.name,
                connection.snapshot.tools,
                connection.selection,
            ).accepted.map((tool) => tool.name),
        );
    }

    /**
     * Создание карточки.
     *
     * Обнаружение выполняется до записи: подключение, ни разу не подтвердившее
     * работоспособность, создаёт ложное представление о доступных возможностях. Поэтому
     * недостижимый сервер добавить нельзя, даже если он доступен всё остальное время.
     * Сервер, который ответил, но непригоден — не объявил
     * инструментов либо объявил их с недопустимыми именами, — добавляется с состоянием
     * `unsatisfied`: причина видна в карточке и исправляется настройкой.
     */
    async create(request: CreateMcpConnectionRequest): Promise<McpConnection> {
        const existing = await this.prisma.mcpConnection.findUnique({ where: { name: request.name } });
        if (existing !== null) {
            throw new ConflictException(`Подключение "${request.name}" уже добавлено`);
        }

        const outcome = await this.discover(request.name, request.transport, ALL_TOOLS);
        if (outcome.status === 'unreachable') {
            throw new BadRequestException(`Подключение не создано: ${outcome.message}`);
        }

        const row = await this.prisma.mcpConnection.create({
            data: {
                name: request.name,
                title: request.title ?? null,
                transport: request.transport.type,
                config: request.transport,
                snapshot: outcome.snapshot === null ? undefined : (outcome.snapshot as object),
                toolMode: ALL_TOOLS.mode,
                enabledTools: [],
                excludedTools: [],
                checkStatus: outcome.status,
                problems: outcome.problems,
                stale: false,
                lastCheckAt: new Date(),
                lastCheckMessage: outcome.message,
            },
        });
        return toDto(row);
    }

    /**
     * Импорт конфигурации в сложившемся формате MCP-клиентов.
     *
     * Записи обрабатываются по отдельности и независимо: одна недостижимая не должна
     * отменять остальные. Итог сообщается перечнем добавленного и перечнем причин, по
     * которым остальное не добавлено.
     */
    async import(json: string): Promise<{ created: McpConnection[]; skipped: string[] }> {
        let entries: ReturnType<typeof parseMcpServersFile>;
        try {
            entries = parseMcpServersFile(json);
        } catch (cause) {
            throw new BadRequestException(
                cause instanceof McpConfigError ? cause.message : String(cause),
            );
        }

        const created: McpConnection[] = [];
        const skipped: string[] = [];

        for (const entry of entries) {
            try {
                created.push(
                    await this.create({
                        name: entry.name,
                        ...(entry.sourceKey === entry.name ? {} : { title: entry.sourceKey }),
                        transport: entry.transport,
                    }),
                );
            } catch (cause) {
                const message = cause instanceof Error ? cause.message : String(cause);
                skipped.push(`${entry.sourceKey}: ${message}`);
            }
        }

        if (created.length === 0) {
            throw new BadRequestException(
                `Ни одно подключение не добавлено.\n${skipped.join('\n')}`,
            );
        }
        return { created, skipped };
    }

    /**
     * Правка карточки. Изменение конфигурации обесценивает прежний снимок, поэтому влечёт
     * повторное обнаружение; правка названия и отбора инструментов — не влечёт.
     */
    async update(id: string, request: UpdateMcpConnectionRequest): Promise<McpConnection> {
        const row = await this.row(id);

        if (request.name !== undefined && request.name !== row.name) {
            const clash = await this.prisma.mcpConnection.findUnique({
                where: { name: request.name },
            });
            if (clash !== null) throw new ConflictException(`Имя "${request.name}" уже занято`);
        }

        const name = request.name ?? row.name;
        const previous = mcpTransportSchema.safeParse(row.config);
        const transportChanged =
            request.transport !== undefined &&
            JSON.stringify(request.transport) !==
                JSON.stringify(previous.success ? previous.data : null);
        const transport = request.transport ?? (previous.success ? previous.data : null);

        // Отбор инструментов участвует в проверке имён, поэтому берётся новый, если он задан.
        // Перечни заменяются только целиком и только явно: обнаружение их не трогает.
        const previousSelection = selectionOf(row);
        const selection: McpToolSelection = {
            mode: request.toolMode ?? previousSelection.mode,
            enabled: request.enabledTools ?? previousSelection.enabled,
            excluded: request.excludedTools ?? previousSelection.excluded,
        };

        await this.prisma.mcpConnection.update({
            where: { id },
            data: {
                name,
                // Режим записывается всегда: у карточки, созданной до его появления, он
                // выведен из перечня и с первой правкой становится явным.
                toolMode: selection.mode,
                ...(request.title === undefined ? {} : { title: request.title }),
                ...(request.enabledTools === undefined ? {} : { enabledTools: request.enabledTools }),
                ...(request.excludedTools === undefined
                    ? {}
                    : { excludedTools: request.excludedTools }),
                ...(request.transport === undefined
                    ? {}
                    : { transport: request.transport.type, config: request.transport }),
            },
        });

        if (transport === null) {
            throw new BadRequestException('Конфигурация подключения не разобрана; задайте её заново');
        }

        // Переименование меняет префикс, а с ним и имена инструментов; отбор меняет их
        // состав. И то и другое требует повторной проверки имён, но не обращения к серверу.
        if (transportChanged) return this.check(id);
        return this.revalidate(id, name, selection);
    }

    async remove(id: string): Promise<void> {
        await this.row(id);
        await this.prisma.mcpConnection.delete({ where: { id } });
    }

    /**
     * Включение и выключение. Выключение выполняется без обращения к серверу, включение —
     * с обнаружением: включать подключение, о работоспособности которого ничего не
     * известно, значит обещать агенту инструменты, которых может не быть.
     */
    async toggle(id: string, enabled: boolean): Promise<McpConnection> {
        const row = await this.row(id);

        if (!enabled) {
            const updated = await this.prisma.mcpConnection.update({
                where: { id },
                data: { enabled: false },
            });
            return toDto(updated);
        }

        const checked = await this.check(id);
        if (checked.checkStatus === 'unreachable') {
            throw new BadRequestException(
                `Не удалось включить подключение: ${checked.lastCheckMessage ?? 'сервер недоступен'}`,
            );
        }

        const updated = await this.prisma.mcpConnection.update({
            where: { id },
            data: { enabled: true },
        });
        void row;
        return toDto(updated);
    }

    /** Повторное обнаружение: подключение к серверу и запрос перечня инструментов. */
    async check(id: string): Promise<McpConnection> {
        const row = await this.row(id);
        const transport = mcpTransportSchema.safeParse(row.config);
        if (!transport.success) {
            return this.record(id, {
                snapshot: null,
                status: 'unsatisfied',
                problems: ['конфигурация подключения не разобрана'],
                message: 'Конфигурация подключения не разобрана; задайте её заново.',
            });
        }

        const outcome = await this.discover(row.name, transport.data, selectionOf(row));
        return this.record(id, outcome);
    }

    /**
     * Отметка о расхождении снимка с сервером. Ставится, когда сервер отклонил вызов как
     * неизвестный либо не соответствующий схеме: набор инструментов собран из снимка, и
     * такой отказ означает, что состав на сервере изменился.
     *
     * Отметка влечёт повторное обнаружение в фоне: без него следующий ход собрался бы из того
     * же снимка и снова предложил модели отсутствующий инструмент. Отметка записывается до
     * начала проверки, поэтому переживает перезапуск процесса: если проверка не успела
     * завершиться, её начнёт сборка следующего набора.
     */
    async markStale(id: string, message: string): Promise<void> {
        const marked = await this.prisma.mcpConnection
            .update({
                where: { id },
                data: { stale: true, lastCheckMessage: message },
            })
            .then(() => true)
            .catch(() => false);
        if (marked) void this.recheck(id);
    }

    /**
     * Повторное обнаружение после расхождения. Одновременные расхождения по одному
     * подключению — например, пачка вызовов в одном шаге — сводятся к одной проверке.
     * Проверка снимает отметку при любом исходе, поэтому повторно не запускается.
     */
    private recheck(id: string): Promise<void> {
        const pending = this.rechecks.get(id);
        if (pending !== undefined) return pending;

        const started = this.check(id)
            .then(() => undefined)
            .catch((cause: unknown) => {
                this.logger.warn(
                    `повторное обнаружение подключения ${id} после расхождения не удалось: ${
                        cause instanceof Error ? cause.message : String(cause)
                    }`,
                );
            })
            .finally(() => this.rechecks.delete(id));
        this.rechecks.set(id, started);
        return started;
    }

    /** Проверка имён без обращения к серверу: снимок остаётся прежним. */
    private async revalidate(
        id: string,
        name: string,
        selection: McpToolSelection,
    ): Promise<McpConnection> {
        const row = await this.row(id);
        const snapshot = parseSnapshot(row.snapshot);
        if (snapshot === null) return this.check(id);

        const problems = describeProblems(name, snapshot, selection);
        return this.record(id, {
            snapshot,
            status: problems.length === 0 ? 'ok' : 'unsatisfied',
            problems,
            message:
                problems.length === 0
                    ? `Состав из ${snapshot.tools.length} инструментов принят без обращения к серверу.`
                    : `Непригодно: ${problems.join('; ')}.`,
        });
    }

    /** Обращение к серверу и оценка полученного. */
    private async discover(
        name: string,
        transport: McpTransport,
        selection: McpToolSelection,
    ): Promise<DiscoveryOutcome> {
        let snapshot: McpSnapshot;
        try {
            snapshot = await this.client.discover(transport);
        } catch (cause) {
            const failure =
                cause instanceof McpFailure
                    ? cause
                    : new McpFailure('unreachable', cause instanceof Error ? cause.message : String(cause));
            this.logger.warn(`обнаружение подключения "${name}" не удалось: ${failure.message}`);
            return {
                snapshot: null,
                status: failure.kind,
                problems: [failure.message],
                message: failure.message,
            };
        }

        const problems = describeProblems(name, snapshot, selection);
        return {
            snapshot,
            status: problems.length === 0 ? 'ok' : 'unsatisfied',
            problems,
            message:
                problems.length === 0
                    ? `Получено инструментов: ${snapshot.tools.length}. Сервер ` +
                      `${snapshot.serverName ?? 'без имени'} ${snapshot.serverVersion ?? ''}`.trim()
                    : `Непригодно: ${problems.join('; ')}.`,
        };
    }

    private async record(id: string, outcome: DiscoveryOutcome): Promise<McpConnection> {
        const row = await this.prisma.mcpConnection.update({
            where: { id },
            data: {
                ...(outcome.snapshot === null ? {} : { snapshot: outcome.snapshot as object }),
                checkStatus: outcome.status,
                problems: outcome.problems,
                // Проверка снимает отметку о расхождении: состав получен заново.
                stale: false,
                lastCheckAt: new Date(),
                lastCheckMessage: outcome.message,
            },
        });
        return toDto(row);
    }

    private async row(id: string): Promise<McpRow> {
        const row = await this.prisma.mcpConnection.findUnique({ where: { id } });
        if (row === null) throw new NotFoundException(`Подключение ${id} не найдено`);
        return row as McpRow;
    }
}

type DiscoveryOutcome = {
    readonly snapshot: McpSnapshot | null;
    readonly status: McpCheckStatus;
    readonly problems: string[];
    readonly message: string;
};

/**
 * Что делает подключение непригодным. Совпадение со встроенным инструментом сюда не входит:
 * его обнаруживает сборщик набора, потому что справочнику имена встроенных неизвестны и
 * знать их ему незачем.
 *
 * Имена из перечня отбора, которых нет на сервере, непригодности не означают: перечень
 * хранит их намеренно, а в набор они не попадают. Непригодно подключение, которому нечего
 * передать агенту, и причина называется по режиму, поскольку исправляется по-разному.
 */
function describeProblems(
    name: string,
    snapshot: McpSnapshot,
    selection: McpToolSelection,
): string[] {
    if (snapshot.tools.length === 0) {
        return ['сервер не объявил ни одного инструмента'];
    }

    const plan = planExternalTools(name, snapshot.tools, selection);
    if (plan.accepted.length > 0) return [...plan.rejected];

    // Инструмент, отобранный и имеющийся на сервере, попадает либо в принятые, либо в
    // отвергнутые. Поэтому без отвергнутых пустой итог означает, что ни одного отобранного
    // инструмента на сервере нет.
    const emptiness =
        plan.rejected.length > 0
            ? 'после отбора не осталось ни одного пригодного инструмента'
            : selection.mode === 'except'
              ? 'исключены все инструменты сервера'
              : selection.enabled.length === 0
                ? 'не отобран ни один инструмент'
                : 'ни одного из отобранных инструментов нет на сервере';
    return [...plan.rejected, emptiness];
}

/**
 * Отбор карточки. У карточки, созданной до появления режима, он выводится из перечня так,
 * как перечень толковался тогда: пустой означал весь состав.
 */
function selectionOf(row: {
    readonly toolMode: string | null;
    readonly enabledTools: unknown;
    readonly excludedTools: unknown;
}): McpToolSelection {
    const enabled = asStrings(row.enabledTools);
    const parsed = mcpToolModeSchema.safeParse(row.toolMode);
    const mode: McpToolMode = parsed.success ? parsed.data : enabled.length === 0 ? 'all' : 'selected';
    return { mode, enabled, excluded: asStrings(row.excludedTools) };
}

type McpRow = {
    id: string;
    name: string;
    title: string | null;
    enabled: boolean;
    transport: string;
    config: unknown;
    snapshot: unknown;
    toolMode: string | null;
    enabledTools: unknown;
    excludedTools: unknown;
    checkStatus: string;
    problems: unknown;
    stale: boolean;
    lastCheckAt: Date | null;
    lastCheckMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
};

function asStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseSnapshot(value: unknown): McpSnapshot | null {
    if (value === null || value === undefined) return null;
    const parsed = mcpSnapshotSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

const statusOf = (value: string): McpCheckStatus =>
    value === 'ok' || value === 'unsatisfied' || value === 'unreachable' ? value : 'unknown';

/**
 * Вычищает секреты из транспорта перед выдачей наружу.
 *
 * Шифрование конфигурации отложено, и это отдельное решение. Но возвращать вставленный
 * токен в ответе контроллера не следует и без шифрования: он оказался бы в журнале
 * браузера и в средствах разработчика при первом же открытии карточки.
 */
function maskTransport(value: unknown): McpTransport {
    const parsed = mcpTransportSchema.safeParse(value);
    if (!parsed.success) {
        return { type: 'stdio', command: '(конфигурация не разобрана)', args: [], env: {}, cwd: null };
    }
    const transport = parsed.data;
    const mask = (source: Record<string, string>): Record<string, string> =>
        Object.fromEntries(Object.keys(source).map((key) => [key, '••••••']));

    if (transport.type === 'stdio') {
        return { ...transport, env: mask(transport.env) };
    }
    return { ...transport, headers: mask(transport.headers) };
}

export function toDto(row: McpRow): McpConnection {
    const selection = selectionOf(row);
    return {
        id: row.id,
        name: row.name,
        title: row.title,
        enabled: row.enabled,
        transport: maskTransport(row.config),
        snapshot: parseSnapshot(row.snapshot),
        toolMode: selection.mode,
        enabledTools: [...selection.enabled],
        excludedTools: [...selection.excluded],
        checkStatus: statusOf(row.checkStatus),
        problems: asStrings(row.problems),
        lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
        lastCheckMessage: row.lastCheckMessage,
        stale: row.stale,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}
