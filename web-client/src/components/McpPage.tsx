import { useState } from 'react';
import {
    ApiOutlined,
    DeleteOutlined,
    ImportOutlined,
    PlusOutlined,
    ReloadOutlined,
    ToolOutlined,
} from '@ant-design/icons';
import {
    Alert,
    App,
    Button,
    Card,
    Checkbox,
    Empty,
    Flex,
    Form,
    Input,
    Modal,
    Segmented,
    Select,
    Skeleton,
    Space,
    Switch,
    Tag,
    Tooltip,
    Typography,
    theme,
} from 'antd';
import {
    isMcpToolUsed,
    missingMcpTools,
    type McpCheckStatus,
    type McpConnection,
    type McpToolMode,
    type McpToolSelection,
    type UpdateMcpConnectionRequest,
} from '@weragen/types';
import {
    useCheckMcpConnection,
    useCreateMcpConnection,
    useDeleteMcpConnection,
    useImportMcpConnections,
    useMcpConnections,
    useToggleMcpConnection,
    useUpdateMcpConnection,
} from '../api/queries.js';

/**
 * Справочник подключений MCP.
 *
 * Раздел устроен как реестр воркфлоу: администратор заводит карточку, указывая, где
 * находится сервер, а состав инструментов платформа узнаёт у самого сервера обнаружением.
 * Различие в том, что полученный состав здесь показывается не справочно: набор инструментов
 * агента собирается из того же снимка. Поэтому рядом с перечнем стоит время обнаружения — по
 * нему видно, насколько давно состав подтверждался.
 */

const statusLabel: Record<McpCheckStatus, string> = {
    unknown: 'Не проверялось',
    ok: 'Работает',
    unsatisfied: 'Непригодно',
    unreachable: 'Сервер недоступен',
};

const statusColor: Record<McpCheckStatus, string> = {
    unknown: 'default',
    ok: 'success',
    unsatisfied: 'warning',
    unreachable: 'error',
};

/** Пояснение к состоянию: что именно чинить. Различие состояний в этом и состоит. */
const statusHint: Record<McpCheckStatus, string> = {
    unknown: 'Проверка ещё не выполнялась.',
    ok: 'Инструменты подключения входят в набор агента.',
    unsatisfied: 'Сервер отвечает, но подключение непригодно. Исправляется настройкой карточки.',
    unreachable: 'Сервер не отвечает. Причина на его стороне, а не в настройках платформы.',
};

const modeOptions: { label: string; value: McpToolMode }[] = [
    { label: 'Все', value: 'all' },
    { label: 'Все, кроме исключённых', value: 'except' },
    { label: 'Отобранные', value: 'selected' },
];

/** Пояснение к режиму: главное различие режимов в том, как принимаются новые инструменты. */
const modeHint: Record<McpToolMode, string> = {
    all: 'Агент получает весь состав сервера. Новые инструменты включаются сами.',
    except: 'Агент получает весь состав, кроме исключённых. Новые инструменты включаются сами.',
    selected:
        'Агент получает только отобранные инструменты. Новые инструменты не включаются, пока ' +
        'их не отметят.',
};

const MISSING_HINT =
    'Инструмента нет в текущем составе сервера. Он остаётся в перечне и снова будет ' +
    'передаваться агенту, если сервер его вернёт.';

const EXAMPLE_CONFIG = `{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    },
    "sentry": {
      "type": "http",
      "url": "https://mcp.sentry.dev/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}`;

export function McpPage() {
    const { token } = theme.useToken();
    const { data: connections, isLoading } = useMcpConnections();
    const check = useCheckMcpConnection();
    const toggle = useToggleMcpConnection();
    const update = useUpdateMcpConnection();
    const remove = useDeleteMcpConnection();
    const { modal, message } = App.useApp();

    const [importing, setImporting] = useState(false);
    const [adding, setAdding] = useState(false);
    const [picking, setPicking] = useState<McpConnection | undefined>(undefined);

    const confirmDelete = (connection: McpConnection): void => {
        modal.confirm({
            title: `Удалить подключение «${connection.name}»?`,
            content:
                'Инструменты этого сервера исчезнут из набора агента. Журналы сессий, в ' +
                'которых они вызывались, сохранятся.',
            okText: 'Удалить',
            okButtonProps: { danger: true },
            cancelText: 'Отмена',
            onOk: () => remove.mutateAsync(connection.id),
        });
    };

    const fail = (error: unknown, fallback: string): void => {
        message.error(error instanceof Error ? error.message : fallback);
    };

    return (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: token.paddingLG }}>
            <Flex vertical gap={token.margin} style={{ maxWidth: 880, marginInline: 'auto' }}>
                <Flex align="center" gap={token.marginXS}>
                    <Typography.Title level={4} style={{ margin: 0, flex: 1 }}>
                        Подключения MCP
                    </Typography.Title>
                    <Button icon={<ImportOutlined />} onClick={() => setImporting(true)}>
                        Вставить конфигурацию
                    </Button>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
                        Добавить
                    </Button>
                </Flex>

                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    Внешний сервер MCP поставляет платформе инструменты. Состав платформа узнаёт
                    у самого сервера при проверке и сохраняет: набор инструментов агента
                    собирается из сохранённого состава, поэтому подключение к серверу
                    происходит только при вызове инструмента.
                </Typography.Paragraph>

                {isLoading ? <Skeleton active paragraph={{ rows: 4 }} /> : null}

                {!isLoading && (connections ?? []).length === 0 ? (
                    <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="Подключения пока не добавлены"
                    />
                ) : null}

                {(connections ?? []).map((connection) => (
                    <ConnectionCard
                        key={connection.id}
                        connection={connection}
                        checking={check.isPending && check.variables === connection.id}
                        onCheck={() =>
                            check.mutate(connection.id, {
                                onError: (error) => fail(error, 'Проверка не удалась'),
                            })
                        }
                        onToggle={(enabled) =>
                            toggle.mutate(
                                { id: connection.id, enabled },
                                { onError: (error) => fail(error, 'Не удалось переключить') },
                            )
                        }
                        changingMode={update.isPending && update.variables?.id === connection.id}
                        onModeChange={(mode) =>
                            update.mutate(
                                { id: connection.id, body: modeChange(connection, mode) },
                                { onError: (error) => fail(error, 'Не удалось сменить режим') },
                            )
                        }
                        onPickTools={() => setPicking(connection)}
                        onDelete={() => confirmDelete(connection)}
                    />
                ))}
            </Flex>

            <ImportDialog open={importing} onClose={() => setImporting(false)} />
            <AddDialog open={adding} onClose={() => setAdding(false)} />
            {picking === undefined ? null : (
                <ToolPicker connection={picking} onClose={() => setPicking(undefined)} />
            )}
        </div>
    );
}

function ConnectionCard({
    connection,
    checking,
    changingMode,
    onCheck,
    onToggle,
    onModeChange,
    onPickTools,
    onDelete,
}: {
    readonly connection: McpConnection;
    readonly checking: boolean;
    readonly changingMode: boolean;
    readonly onCheck: () => void;
    readonly onToggle: (enabled: boolean) => void;
    readonly onModeChange: (mode: McpToolMode) => void;
    readonly onPickTools: () => void;
    readonly onDelete: () => void;
}) {
    const { token } = theme.useToken();
    const snapshot = connection.snapshot;
    const total = snapshot?.tools.length ?? 0;
    const used = usedNames(connection);
    // В карточке показываются только отсутствующие отобранные инструменты: они были бы
    // переданы агенту, будь они на сервере. Отсутствующие исключённые видны в отборе.
    const missing =
        connection.toolMode === 'selected'
            ? missingMcpTools(selectionOf(connection), presentNames(connection))
            : [];

    return (
        <Card
            size="small"
            title={
                <Flex align="center" gap={token.marginXS} style={{ minWidth: 0 }}>
                    <Typography.Text strong>{connection.name}</Typography.Text>
                    {connection.title === null ? null : (
                        <Typography.Text type="secondary">{connection.title}</Typography.Text>
                    )}
                    <Tag>{connection.transport.type}</Tag>
                    <Tooltip title={statusHint[connection.checkStatus]}>
                        <Tag color={statusColor[connection.checkStatus]}>
                            {statusLabel[connection.checkStatus]}
                        </Tag>
                    </Tooltip>
                    {connection.stale ? (
                        <Tooltip
                            title={
                                'Сервер отклонил вызов инструмента: состав на нём изменился с ' +
                                'момента последнего обнаружения. Выполните проверку.'
                            }
                        >
                            <Tag color="orange">Состав устарел</Tag>
                        </Tooltip>
                    ) : null}
                </Flex>
            }
            extra={
                <Space size="small">
                    <Tooltip title={connection.enabled ? 'Выключить' : 'Включить и проверить'}>
                        <Switch
                            size="small"
                            checked={connection.enabled}
                            onChange={(enabled) => onToggle(enabled)}
                        />
                    </Tooltip>
                    <Tooltip title="Отобрать инструменты">
                        <Button
                            size="small"
                            icon={<ToolOutlined />}
                            disabled={snapshot === null}
                            onClick={onPickTools}
                        />
                    </Tooltip>
                    <Tooltip title="Проверить: подключиться и запросить перечень">
                        <Button
                            size="small"
                            icon={<ReloadOutlined />}
                            loading={checking}
                            onClick={onCheck}
                        />
                    </Tooltip>
                    <Tooltip title="Удалить карточку">
                        <Button size="small" danger icon={<DeleteOutlined />} onClick={onDelete} />
                    </Tooltip>
                </Space>
            }
        >
            <Flex vertical gap={token.marginXS}>
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                    <ApiOutlined />{' '}
                    {connection.transport.type === 'stdio'
                        ? `${connection.transport.command} ${connection.transport.args.join(' ')}`
                        : connection.transport.url}
                </Typography.Text>

                {snapshot === null ? null : (
                    <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                        Сервер {snapshot.serverName ?? 'без имени'} {snapshot.serverVersion ?? ''} ·
                        инструментов {total}, используется {used.length}
                        {missing.length === 0 ? '' : `, нет на сервере ${missing.length}`} ·
                        состав получен {new Date(snapshot.discoveredAt).toLocaleString('ru-RU')}
                    </Typography.Text>
                )}

                {snapshot === null ? null : (
                    <Flex align="center" wrap gap={token.marginXS}>
                        <Segmented<McpToolMode>
                            size="small"
                            value={connection.toolMode}
                            options={modeOptions}
                            disabled={changingMode}
                            onChange={onModeChange}
                        />
                        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                            {modeHint[connection.toolMode]}
                        </Typography.Text>
                    </Flex>
                )}

                {used.length === 0 && missing.length === 0 ? null : (
                    <Flex wrap gap={token.marginXXS}>
                        {used.slice(0, VISIBLE_TAGS).map((name) => (
                            <Tag key={name} style={{ marginInlineEnd: 0 }}>
                                {connection.name}_{name}
                            </Tag>
                        ))}
                        {used.length <= VISIBLE_TAGS ? null : (
                            <Tag color="default">Ещё {used.length - VISIBLE_TAGS}</Tag>
                        )}
                        {missing.map((name) => (
                            <Tooltip key={`missing:${name}`} title={MISSING_HINT}>
                                <Tag
                                    style={{
                                        marginInlineEnd: 0,
                                        borderStyle: 'dashed',
                                        color: token.colorTextDisabled,
                                    }}
                                >
                                    {connection.name}_{name}
                                </Tag>
                            </Tooltip>
                        ))}
                    </Flex>
                )}

                {snapshot === null || snapshot.unusedCapabilities.length === 0 ? null : (
                    <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                        Сервер также объявляет: {snapshot.unusedCapabilities.join(', ')}. Платформа
                        их не использует.
                    </Typography.Text>
                )}

                {connection.checkStatus === 'ok' || connection.lastCheckMessage === null ? null : (
                    <Alert
                        type={connection.checkStatus === 'unknown' ? 'info' : 'warning'}
                        showIcon
                        message={statusHint[connection.checkStatus]}
                        description={
                            <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>
                                {connection.lastCheckMessage}
                            </Typography.Text>
                        }
                    />
                )}
            </Flex>
        </Card>
    );
}

/** Сколько имён показывается в карточке: полный перечень открывается отбором инструментов. */
const VISIBLE_TAGS = 8;

function selectionOf(connection: McpConnection): McpToolSelection {
    return {
        mode: connection.toolMode,
        enabled: connection.enabledTools,
        excluded: connection.excludedTools,
    };
}

/** Имена инструментов в текущем составе сервера. */
function presentNames(connection: McpConnection): string[] {
    return (connection.snapshot?.tools ?? []).map((tool) => tool.name);
}

/** Инструменты текущего состава, которые получит агент. */
function usedNames(connection: McpConnection): string[] {
    const selection = selectionOf(connection);
    return presentNames(connection).filter((name) => isMcpToolUsed(selection, name));
}

/**
 * Запрос смены режима из карточки. Переход к отбору с пустым перечнем заполняет его текущим
 * составом: иначе сама смена режима лишила бы агента всех инструментов подключения.
 */
function modeChange(connection: McpConnection, mode: McpToolMode): UpdateMcpConnectionRequest {
    if (mode === 'selected' && connection.enabledTools.length === 0) {
        return { toolMode: mode, enabledTools: presentNames(connection) };
    }
    return { toolMode: mode };
}

/** Добавляет имена к перечню без повторов, сохраняя порядок. */
function union(list: readonly string[], names: readonly string[]): string[] {
    return [...list, ...names.filter((name) => !list.includes(name))];
}

/**
 * Вставка конфигурации в сложившемся формате MCP-клиентов.
 *
 * Формат тот же, что у настольных клиентов, поэтому конфигурацию можно перенести как есть.
 * Записи обрабатываются по отдельности: недостижимый сервер не отменяет остальные, а
 * причина, по которой он пропущен, показывается отдельно.
 */
function ImportDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
    const { token } = theme.useToken();
    const [text, setText] = useState(EXAMPLE_CONFIG);
    const [skipped, setSkipped] = useState<string[]>([]);
    const load = useImportMcpConnections();
    const { message } = App.useApp();

    const submit = (): void => {
        setSkipped([]);
        load.mutate(text, {
            onSuccess: (result) => {
                message.success(`Добавлено подключений: ${result.created.length}`);
                setSkipped(result.skipped);
                if (result.skipped.length === 0) onClose();
            },
            onError: (error: unknown) =>
                message.error(error instanceof Error ? error.message : 'Импорт не удался'),
        });
    };

    return (
        <Modal
            open={open}
            title="Вставить конфигурацию MCP"
            okText="Добавить и проверить"
            cancelText="Закрыть"
            confirmLoading={load.isPending}
            onOk={submit}
            onCancel={onClose}
            width={720}
        >
            <Flex vertical gap={token.marginXS} style={{ marginBlockStart: token.margin }}>
                <Typography.Text type="secondary">
                    Принимается обычный файл конфигурации MCP-клиента: верхний ключ{' '}
                    <Typography.Text code>mcpServers</Typography.Text> либо{' '}
                    <Typography.Text code>servers</Typography.Text>. Тип определяется по составу
                    записи, если не указан явно. Каждая запись становится отдельной карточкой.
                </Typography.Text>
                <Input.TextArea
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    autoSize={{ minRows: 8, maxRows: 20 }}
                    spellCheck={false}
                />
                {skipped.length === 0 ? null : (
                    <Alert
                        type="warning"
                        showIcon
                        message="Часть записей не добавлена"
                        description={
                            <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>
                                {skipped.join('\n')}
                            </Typography.Text>
                        }
                    />
                )}
            </Flex>
        </Modal>
    );
}

type AddValues = {
    name: string;
    title?: string;
    kind: 'stdio' | 'http';
    command?: string;
    argsText?: string;
    cwd?: string;
    url?: string;
};

/** Добавление одной карточки формой. Для набора серверов удобнее вставка конфигурации. */
function AddDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
    const { token } = theme.useToken();
    const [form] = Form.useForm<AddValues>();
    const kind = Form.useWatch('kind', form) ?? 'stdio';
    const create = useCreateMcpConnection();
    const { message } = App.useApp();

    const submit = (): void => {
        void form.validateFields().then((values) => {
            const args = (values.argsText ?? '')
                .split(/\s+/)
                .map((part) => part.trim())
                .filter((part) => part !== '');

            create.mutate(
                {
                    name: values.name,
                    ...(values.title === undefined || values.title === ''
                        ? {}
                        : { title: values.title }),
                    transport:
                        values.kind === 'http'
                            ? { type: 'http', url: values.url ?? '', headers: {} }
                            : {
                                  type: 'stdio',
                                  command: values.command ?? 'node',
                                  args,
                                  env: {},
                                  cwd:
                                      values.cwd === undefined || values.cwd === ''
                                          ? null
                                          : values.cwd,
                              },
                },
                {
                    onSuccess: () => {
                        onClose();
                        form.resetFields();
                    },
                    onError: (error: unknown) =>
                        message.error(
                            error instanceof Error ? error.message : 'Не удалось добавить',
                        ),
                },
            );
        });
    };

    return (
        <Modal
            open={open}
            title="Добавить подключение MCP"
            okText="Добавить и проверить"
            cancelText="Отмена"
            confirmLoading={create.isPending}
            onOk={submit}
            onCancel={onClose}
        >
            <Form
                form={form}
                layout="vertical"
                initialValues={{ kind: 'stdio' as const }}
                style={{ marginBlockStart: token.margin }}
            >
                <Form.Item
                    name="name"
                    label="Имя"
                    rules={[
                        { required: true, message: 'Имя обязательно' },
                        {
                            pattern: /^[a-z][a-z0-9_]{0,23}$/,
                            message:
                                'Строчные латинские буквы, цифры и подчёркивание, до 24 символов',
                        },
                    ]}
                    extra="Служит префиксом имён инструментов: docs → docs_search."
                >
                    <Input placeholder="docs" />
                </Form.Item>
                <Form.Item name="title" label="Название" extra="Только для отображения.">
                    <Input placeholder="Файловый сервер" />
                </Form.Item>
                <Form.Item
                    name="kind"
                    label="Транспорт"
                    extra="Различаются тем, чем является соединение: дочерним процессом либо сессией HTTP."
                >
                    <Select
                        options={[
                            { value: 'stdio', label: 'stdio — дочерний процесс' },
                            { value: 'http', label: 'http — Streamable HTTP' },
                        ]}
                    />
                </Form.Item>

                {kind === 'http' ? (
                    <Form.Item
                        name="url"
                        label="Адрес"
                        rules={[{ required: true, message: 'Адрес обязателен' }]}
                    >
                        <Input placeholder="http://127.0.0.1:3010/mcp" />
                    </Form.Item>
                ) : (
                    <>
                        <Form.Item
                            name="command"
                            label="Команда"
                            rules={[{ required: true, message: 'Команда обязательна' }]}
                        >
                            <Input placeholder="node" />
                        </Form.Item>
                        <Form.Item name="argsText" label="Аргументы">
                            <Input placeholder="dist/main.js --transport=stdio" />
                        </Form.Item>
                        <Form.Item
                            name="cwd"
                            label="Рабочий каталог"
                            extra="Оттуда сервер читает свой .env."
                        >
                            <Input placeholder="C:/…/mcps/yougile" />
                        </Form.Item>
                    </>
                )}
            </Form>
        </Modal>
    );
}

/**
 * Отбор подмножества инструментов.
 *
 * Нужен потому, что сервер на несколько десятков инструментов заполняет собой набор целиком,
 * а модель тем хуже выбирает инструмент, чем длиннее перечень. Отбор выполняется по снимку и
 * к серверу не обращается.
 *
 * Отметки ставятся отдельными флажками, а не группой: группа флажков оставляет в значении
 * только имена, для которых есть флажок, и при первой правке теряла бы имена инструментов,
 * исчезнувших с сервера.
 */
function ToolPicker({
    connection,
    onClose,
}: {
    readonly connection: McpConnection;
    readonly onClose: () => void;
}) {
    const { token } = theme.useToken();
    const tools = connection.snapshot?.tools ?? [];
    const present = tools.map((tool) => tool.name);
    const [mode, setMode] = useState<McpToolMode>(connection.toolMode);
    const [enabled, setEnabled] = useState<string[]>(connection.enabledTools);
    const [excluded, setExcluded] = useState<string[]>(connection.excludedTools);
    // Строки отсутствующих инструментов берутся из перечней на момент открытия: снятая
    // отметка не убирает строку, иначе она исчезала бы из-под указателя.
    const [remembered] = useState(() => ({
        selected: connection.enabledTools.filter((name) => !present.includes(name)),
        except: connection.excludedTools.filter((name) => !present.includes(name)),
    }));
    const update = useUpdateMcpConnection();
    const { message } = App.useApp();

    const selection: McpToolSelection = { mode, enabled, excluded };
    const missing =
        mode === 'selected' ? remembered.selected : mode === 'except' ? remembered.except : [];
    const usedCount = present.filter((name) => isMcpToolUsed(selection, name)).length;

    const changeMode = (next: McpToolMode): void => {
        setMode(next);
        if (next === 'selected' && enabled.length === 0) setEnabled(present);
    };

    const setUsed = (name: string, used: boolean): void => {
        const without = (list: string[]) => list.filter((item) => item !== name);
        if (mode === 'selected') setEnabled((list) => (used ? union(list, [name]) : without(list)));
        if (mode === 'except') setExcluded((list) => (used ? without(list) : union(list, [name])));
    };

    // Кнопки действуют только на текущий состав: отсутствующие инструменты убираются из
    // перечня только снятием отметки в своей строке.
    const markAll = (): void => {
        if (mode === 'selected') setEnabled((list) => union(list, present));
        if (mode === 'except') setExcluded((list) => list.filter((name) => !present.includes(name)));
    };
    const markNone = (): void => {
        if (mode === 'selected') setEnabled((list) => list.filter((name) => !present.includes(name)));
        if (mode === 'except') setExcluded((list) => union(list, present));
    };

    const submit = (): void => {
        update.mutate(
            {
                id: connection.id,
                body: { toolMode: mode, enabledTools: enabled, excludedTools: excluded },
            },
            {
                onSuccess: onClose,
                onError: (error: unknown) =>
                    message.error(error instanceof Error ? error.message : 'Не удалось сохранить'),
            },
        );
    };

    return (
        <Modal
            open
            title={`Инструменты подключения «${connection.name}»`}
            okText="Сохранить"
            cancelText="Отмена"
            confirmLoading={update.isPending}
            onOk={submit}
            onCancel={onClose}
            width={720}
        >
            <Flex vertical gap={token.marginXS} style={{ marginBlockStart: token.margin }}>
                <Segmented<McpToolMode> value={mode} options={modeOptions} onChange={changeMode} />
                <Typography.Text type="secondary">{modeHint[mode]}</Typography.Text>
                <Flex align="center" gap={token.marginXS}>
                    <Typography.Text type="secondary" style={{ flex: 1 }}>
                        Используется {usedCount} из {present.length}.
                    </Typography.Text>
                    {mode === 'all' ? null : (
                        <>
                            <Button size="small" onClick={markAll}>
                                Все
                            </Button>
                            <Button size="small" onClick={markNone}>
                                Ни одного
                            </Button>
                        </>
                    )}
                </Flex>
                <Flex
                    vertical
                    gap={token.marginXXS}
                    style={{ maxHeight: 420, overflowY: 'auto' }}
                >
                    {tools.map((tool) => (
                        <Checkbox
                            key={tool.name}
                            checked={isMcpToolUsed(selection, tool.name)}
                            disabled={mode === 'all'}
                            onChange={(event) => setUsed(tool.name, event.target.checked)}
                        >
                            <Typography.Text code>
                                {connection.name}_{tool.name}
                            </Typography.Text>{' '}
                            <Typography.Text type="secondary">
                                {tool.description.slice(0, 120)}
                            </Typography.Text>
                        </Checkbox>
                    ))}
                    {missing.length === 0 ? null : (
                        <>
                            <Typography.Text
                                type="secondary"
                                style={{ marginBlockStart: token.marginXS }}
                            >
                                {mode === 'selected'
                                    ? 'Нет в текущем составе сервера. Отмеченные останутся в ' +
                                      'перечне и снова будут переданы агенту, если сервер их ' +
                                      'вернёт; снимите отметку, чтобы убрать инструмент из перечня.'
                                    : 'Нет в текущем составе сервера. Инструменты без отметки ' +
                                      'остаются исключёнными и не будут переданы агенту, если ' +
                                      'сервер их вернёт; отметьте, чтобы убрать исключение.'}
                            </Typography.Text>
                            {missing.map((name) => (
                                <Tooltip key={`missing:${name}`} title={MISSING_HINT}>
                                    <Checkbox
                                        checked={isMcpToolUsed(selection, name)}
                                        onChange={(event) => setUsed(name, event.target.checked)}
                                    >
                                        <Typography.Text
                                            code
                                            style={{ color: token.colorTextDisabled }}
                                        >
                                            {connection.name}_{name}
                                        </Typography.Text>
                                    </Checkbox>
                                </Tooltip>
                            ))}
                        </>
                    )}
                </Flex>
            </Flex>
        </Modal>
    );
}
