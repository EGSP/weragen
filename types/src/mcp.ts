import { z } from 'zod';

/**
 * Подключение MCP: внешний сервер, поставляющий платформе инструменты.
 *
 * Платформа не содержит перечня инструментов такого сервера. Она хранит карточку — где
 * сервер находится и чем запускается, — а состав узнаёт у самого сервера обнаружением.
 * Поэтому добавление подключения не требует правок в коде платформы, ровно как и
 * добавление воркфлоу.
 */

/**
 * Транспорт подключения. Различаются не набором настроек, а тем, чем является соединение:
 * дочерним процессом либо сессией HTTP. Отсюда и разные последствия отказа: процесс
 * завершается, сессия истекает.
 */
export const mcpTransportSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('stdio'),
        command: z.string().min(1).max(300),
        args: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).default({}),
        /** Рабочий каталог процесса. Пусто означает каталог сервера платформы. */
        cwd: z.string().max(500).nullable().default(null),
    }),
    z.object({
        type: z.literal('http'),
        url: z.string().min(1).max(2000),
        headers: z.record(z.string(), z.string()).default({}),
    }),
    /**
     * Транспорт, объявленный устаревшим в пользу Streamable HTTP. Принимается разбором,
     * но не поддерживается: карточка получает состояние `unsatisfied` с прямым сообщением.
     * Отвергать вставленную конфигурацию целиком из-за одной записи хуже — администратору
     * пришлось бы выяснять, какое именно поле не подошло.
     */
    z.object({
        type: z.literal('sse'),
        url: z.string().min(1).max(2000),
        headers: z.record(z.string(), z.string()).default({}),
    }),
]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

/**
 * Инструмент в снимке.
 *
 * Схема входа хранится готовой JSON Schema: платформа её не составляет, а получает и
 * передаёт дальше — модели либо интерфейсу. Проверка аргументов остаётся за сервером.
 */
export const mcpToolSnapshotSchema = z.object({
    /** Имя на стороне сервера, без префикса подключения. */
    name: z.string(),
    title: z.string().nullable().default(null),
    description: z.string().default(''),
    inputSchema: z.record(z.string(), z.unknown()),
});
export type McpToolSnapshot = z.infer<typeof mcpToolSnapshotSchema>;

/**
 * Снимок состава, полученный при обнаружении.
 *
 * Снимок здесь — источник истины для набора инструментов хода, а не только содержимое
 * карточки. Поэтому представление в интерфейсе и представление у агента совпадают: оно
 * одно. Если состав сервера изменился после обнаружения, снимок нужно обновить:
 * до этого момента вызов может быть отклонён внешним сервером.
 */
export const mcpSnapshotSchema = z.object({
    discoveredAt: z.string(),
    serverName: z.string().nullable(),
    serverVersion: z.string().nullable(),
    /** Текстовая инструкция сервера. Идёт отдельной секцией системного промпта. */
    instructions: z.string().nullable(),
    tools: z.array(mcpToolSnapshotSchema),
    /**
     * Разделы протокола, объявленные сервером и платформой не используемые: ресурсы,
     * промпты. Показываются в карточке, чтобы отсутствие поддержки не выглядело отказом.
     */
    unusedCapabilities: z.array(z.string()).default([]),
});
export type McpSnapshot = z.infer<typeof mcpSnapshotSchema>;

/**
 * Состояние проверки подключения. Словарь совпадает с состояниями воркфлоу намеренно:
 * задача та же — отличить недостачу на стороне платформы от недостижимости внешней
 * стороны, поскольку исправляются они в разных местах.
 */
export const mcpCheckStatusSchema = z.enum(['unknown', 'ok', 'unsatisfied', 'unreachable']);
export type McpCheckStatus = z.infer<typeof mcpCheckStatusSchema>;

/**
 * Режим отбора инструментов подключения.
 *
 * - `all` — используется весь состав снимка; новые инструменты сервера включаются сами.
 * - `except` — весь состав, кроме исключённых; новые инструменты тоже включаются сами.
 * - `selected` — только отобранные; новые инструменты не включаются, пока их не отметят.
 *
 * Режим хранится отдельно от перечней. Кодировать «весь состав» пустым перечнем нельзя:
 * тогда отбор всех имеющихся инструментов и отбор ни одного неотличимы от режима `all`.
 */
export const mcpToolModeSchema = z.enum(['all', 'except', 'selected']);
export type McpToolMode = z.infer<typeof mcpToolModeSchema>;

/**
 * Отбор инструментов подключения: режим и оба перечня.
 *
 * Перечни хранят имена на стороне сервера и не очищаются при обнаружении. Инструмент,
 * исчезнувший с сервера, остаётся в перечне, и если сервер вернёт его, карточка уже знает,
 * используется ли он. В набор агента отсутствующее в снимке имя не попадает: набор строится
 * перебором снимка, а не перечня.
 */
export type McpToolSelection = {
    readonly mode: McpToolMode;
    readonly enabled: readonly string[];
    readonly excluded: readonly string[];
};

/** Используется ли инструмент с данным именем при данном отборе. */
export function isMcpToolUsed(selection: McpToolSelection, name: string): boolean {
    switch (selection.mode) {
        case 'all':
            return true;
        case 'except':
            return !selection.excluded.includes(name);
        case 'selected':
            return selection.enabled.includes(name);
    }
}

/**
 * Имена из перечня текущего режима, которых нет в составе сервера. В режиме `all` перечни
 * не действуют, поэтому отсутствующих имён у него не бывает.
 */
export function missingMcpTools(selection: McpToolSelection, present: readonly string[]): string[] {
    const list =
        selection.mode === 'selected'
            ? selection.enabled
            : selection.mode === 'except'
              ? selection.excluded
              : [];
    const known = new Set(present);
    return list.filter((name) => !known.has(name));
}

/** Карточка подключения в справочнике платформы. */
export const mcpConnectionSchema = z.object({
    id: z.string(),
    /**
     * Слаг подключения. Он же префикс имён инструментов, поэтому ограничен строго:
     * итоговое имя должно проходить проверку формата описания инструментов.
     */
    name: z.string(),
    /** Отображаемое название. Ни на что, кроме отрисовки, не влияет. */
    title: z.string().nullable(),
    enabled: z.boolean(),
    /**
     * Транспорт с вычищенными секретами: значения заголовков и переменных окружения
     * заменены отметкой о наличии. Наружу настоящие значения не возвращаются.
     */
    transport: mcpTransportSchema,
    snapshot: mcpSnapshotSchema.nullable(),
    toolMode: mcpToolModeSchema,
    /** Отобранные инструменты для режима `selected`, именами на стороне сервера. */
    enabledTools: z.array(z.string()),
    /** Исключённые инструменты для режима `except`, именами на стороне сервера. */
    excludedTools: z.array(z.string()),
    checkStatus: mcpCheckStatusSchema,
    /** Что именно непригодно при состоянии `unsatisfied`. */
    problems: z.array(z.string()),
    lastCheckAt: z.string().nullable(),
    lastCheckMessage: z.string().nullable(),
    /**
     * Признак того, что снимок разошёлся с сервером: вызов инструмента отклонён как
     * неизвестный либо не соответствующий схеме. Снимается успешной проверкой.
     */
    stale: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type McpConnection = z.infer<typeof mcpConnectionSchema>;

/** Ограничение имени подключения. Оно же префикс, поэтому проверяется здесь. */
export const MCP_NAME_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;

const connectionName = z
    .string()
    .regex(
        MCP_NAME_PATTERN,
        'Имя начинается со строчной латинской буквы и содержит только строчные латинские ' +
            'буквы, цифры и подчёркивание; длина до 24 символов',
    );

export const createMcpConnectionRequestSchema = z.object({
    name: connectionName,
    title: z.string().max(200).optional(),
    transport: mcpTransportSchema,
});
export type CreateMcpConnectionRequest = z.infer<typeof createMcpConnectionRequestSchema>;

export const updateMcpConnectionRequestSchema = z.object({
    name: connectionName.optional(),
    title: z.string().max(200).optional(),
    transport: mcpTransportSchema.optional(),
    toolMode: mcpToolModeSchema.optional(),
    enabledTools: z.array(z.string()).optional(),
    excludedTools: z.array(z.string()).optional(),
});
export type UpdateMcpConnectionRequest = z.infer<typeof updateMcpConnectionRequestSchema>;

/** Включение и выключение карточки. Включение сопровождается проверкой. */
export const toggleMcpConnectionRequestSchema = z.object({ enabled: z.boolean() });
export type ToggleMcpConnectionRequest = z.infer<typeof toggleMcpConnectionRequestSchema>;

/**
 * Импорт конфигурации в сложившемся формате MCP-клиентов. Передаётся текстом, а не
 * разобранным объектом: разбор выполняет платформа, и сообщение о неверном JSON должно
 * называть место ошибки, а не сводиться к отказу проверки тела запроса.
 */
export const importMcpConnectionsRequestSchema = z.object({
    json: z.string().min(1).max(100_000),
});
export type ImportMcpConnectionsRequest = z.infer<typeof importMcpConnectionsRequestSchema>;

export const mcpConnectionListResponseSchema = z.object({
    connections: z.array(mcpConnectionSchema),
});
export type McpConnectionListResponse = z.infer<typeof mcpConnectionListResponseSchema>;

/**
 * Итог импорта. Записи обрабатываются по отдельности и независимо, поэтому итог
 * двусоставный: одна недостижимая запись не отменяет остальные, но и умалчивать о ней
 * нельзя — администратор считает добавленным всё, что вставил.
 */
export const mcpImportResponseSchema = z.object({
    created: z.array(mcpConnectionSchema),
    /** Причины, по которым запись не добавлена, с указанием её ключа. */
    skipped: z.array(z.string()),
});
export type McpImportResponse = z.infer<typeof mcpImportResponseSchema>;

/* ── Разбор сложившегося формата ──────────────────────────────────────────────────── */

/**
 * Запись сервера в конфигурации MCP-клиентов.
 *
 * Схема описывает чужой формат со всеми его послаблениями и отделена от схемы
 * нормализованного представления платформы намеренно: смешение привело бы к тому, что
 * послабления чужого формата попали бы в базу данных.
 */
const mcpServerEntrySchema = z
    .object({
        type: z.enum(['stdio', 'http', 'sse', 'streamable-http']).optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        cwd: z.string().optional(),
        url: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
    })
    .loose();

/** Верхний ключ у разных клиентов называется по-разному; содержательная часть одна. */
const mcpServersFileSchema = z.union([
    z.object({ mcpServers: z.record(z.string(), mcpServerEntrySchema) }),
    z.object({ servers: z.record(z.string(), mcpServerEntrySchema) }),
    z.record(z.string(), mcpServerEntrySchema),
]);

export type McpImportEntry = {
    /** Имя из ключа конфигурации, приведённое к допустимому слагу. */
    readonly name: string;
    /** Исходный ключ — на случай, если приведение его изменило. */
    readonly sourceKey: string;
    readonly transport: McpTransport;
};

export class McpConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'McpConfigError';
    }
}

/**
 * Приводит ключ конфигурации к слагу подключения. Ключи в чужих конфигурациях пишутся
 * через дефис и в верхнем регистре, тогда как слаг служит префиксом имени инструмента и
 * ограничен строже.
 */
export function toConnectionName(key: string): string {
    const slug = key
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 24)
        .replace(/_+$/, '');
    return /^[a-z]/.test(slug) ? slug : `mcp_${slug}`.slice(0, 24).replace(/_+$/, '');
}

/**
 * Разбирает конфигурацию в сложившемся формате.
 *
 * Тип определяется по составу записи, если он не указан явно: `command` означает `stdio`,
 * `url` — `http`. Одновременное присутствие обоих есть ошибка: угадывание намерения здесь
 * привело бы к подключению не к тому серверу.
 */
export function parseMcpServersFile(json: string): McpImportEntry[] {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch (cause) {
        throw new McpConfigError(
            `JSON не разобран: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    }

    const parsed = mcpServersFileSchema.safeParse(raw);
    if (!parsed.success) {
        throw new McpConfigError(
            'Ожидается объект вида {"mcpServers": {"имя": {…}}} либо перечень серверов ' +
                'без обёртки. Разбор не удался: ' +
                parsed.error.issues
                    .map((issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`)
                    .join('; '),
        );
    }

    const container = parsed.data as Record<string, unknown>;
    const servers = (('mcpServers' in container
        ? container['mcpServers']
        : 'servers' in container
          ? container['servers']
          : container) ?? {}) as Record<string, z.infer<typeof mcpServerEntrySchema>>;

    const entries = Object.entries(servers);
    if (entries.length === 0) throw new McpConfigError('В конфигурации нет ни одного сервера');

    return entries.map(([key, entry]) => ({
        name: toConnectionName(key),
        sourceKey: key,
        transport: toTransport(key, entry),
    }));
}

function toTransport(key: string, entry: z.infer<typeof mcpServerEntrySchema>): McpTransport {
    const hasCommand = entry.command !== undefined && entry.command !== '';
    const hasUrl = entry.url !== undefined && entry.url !== '';

    if (hasCommand && hasUrl) {
        throw new McpConfigError(
            `Сервер "${key}": заданы одновременно command и url. Оставьте одно — по нему ` +
                'определяется транспорт.',
        );
    }

    const declared = entry.type === 'streamable-http' ? 'http' : entry.type;
    const type = declared ?? (hasCommand ? 'stdio' : hasUrl ? 'http' : undefined);

    if (type === undefined) {
        throw new McpConfigError(
            `Сервер "${key}": не заданы ни command, ни url, и тип не указан явно.`,
        );
    }

    if (type === 'stdio') {
        if (!hasCommand) {
            throw new McpConfigError(`Сервер "${key}": для транспорта stdio нужна command.`);
        }
        return {
            type: 'stdio',
            command: entry.command!,
            args: entry.args ?? [],
            env: entry.env ?? {},
            cwd: entry.cwd ?? null,
        };
    }

    if (!hasUrl) {
        throw new McpConfigError(`Сервер "${key}": для транспорта ${type} нужен url.`);
    }
    return { type, url: entry.url!, headers: entry.headers ?? {} };
}
