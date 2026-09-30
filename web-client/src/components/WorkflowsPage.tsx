import { useState } from 'react';
import {
    DeleteOutlined,
    PlayCircleOutlined,
    PlusOutlined,
    ReloadOutlined,
} from '@ant-design/icons';
import { useNavigate } from '@tanstack/react-router';
import {
    Alert,
    App,
    Button,
    Card,
    Empty,
    Flex,
    Form,
    Input,
    Modal,
    Skeleton,
    Space,
    Tag,
    Tooltip,
    Typography,
    theme,
} from 'antd';
import type { CreateWorkflowRequest, Workflow, WorkflowCheckStatus } from '@weragen/types';
import {
    useCheckWorkflow,
    useCreateWorkflow,
    useDeleteWorkflow,
    useStartWorkflowRun,
    useWorkflows,
} from '../api/queries.js';

/**
 * Реестр воркфлоу.
 *
 * Платформа не содержит перечня реализаций: администратор заводит карточку, указывая, где
 * лежит пакет, а состав воркфлоу — версию, описание, схему входа и требования — платформа
 * узнаёт у самого процесса при проверке. Поэтому в карточке заполняются только путь и
 * команда, а всё остальное показывается полученным.
 */

const statusLabel: Record<WorkflowCheckStatus, string> = {
    unknown: 'Не проверялся',
    ok: 'Требования выполнены',
    unsatisfied: 'Требования не выполнены',
    unreachable: 'Процесс недоступен',
};

const statusColor: Record<WorkflowCheckStatus, string> = {
    unknown: 'default',
    ok: 'success',
    unsatisfied: 'warning',
    unreachable: 'error',
};

/** Пояснение к состоянию: что именно чинить. Различие состояний в этом и состоит. */
const statusHint: Record<WorkflowCheckStatus, string> = {
    unknown: 'Проверка ещё не выполнялась.',
    ok: 'Воркфлоу можно запускать.',
    unsatisfied: 'Недостающее добавляется настройкой платформы, а не правкой карточки.',
    unreachable: 'Причина в пакете воркфлоу или его окружении, а не в настройках платформы.',
};

export function WorkflowsPage() {
    const { token } = theme.useToken();
    const { data: workflows, isLoading } = useWorkflows();
    const createWorkflow = useCreateWorkflow();
    const checkWorkflow = useCheckWorkflow();
    const deleteWorkflow = useDeleteWorkflow();
    const { modal, message } = App.useApp();

    const [adding, setAdding] = useState(false);
    const [running, setRunning] = useState<Workflow | undefined>(undefined);
    const [form] = Form.useForm<CreateWorkflowRequest & { argsText?: string }>();

    const submit = (): void => {
        void form.validateFields().then((values) => {
            const args = (values.argsText ?? '')
                .split(/\s+/)
                .map((part) => part.trim())
                .filter((part) => part !== '');
            createWorkflow.mutate(
                {
                    name: values.name,
                    packagePath: values.packagePath,
                    ...(values.command === undefined || values.command === ''
                        ? {}
                        : { command: values.command }),
                    ...(args.length === 0 ? {} : { args }),
                },
                {
                    onSuccess: () => {
                        setAdding(false);
                        form.resetFields();
                    },
                    onError: (error: unknown) =>
                        message.error(error instanceof Error ? error.message : 'Не удалось добавить'),
                },
            );
        });
    };

    const confirmDelete = (workflow: Workflow): void => {
        modal.confirm({
            title: `Удалить воркфлоу «${workflow.name}»?`,
            content:
                'Журналы уже выполненных исполнений сохранятся: удаление карточки не уносит ' +
                'с собой историю того, что отработало.',
            okText: 'Удалить',
            okButtonProps: { danger: true },
            cancelText: 'Отмена',
            onOk: () => deleteWorkflow.mutateAsync(workflow.id),
        });
    };

    return (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: token.paddingLG }}>
            <Flex vertical gap={token.margin} style={{ maxWidth: 880, marginInline: 'auto' }}>
                <Flex align="center" gap={token.marginXS}>
                    <Typography.Title level={4} style={{ margin: 0, flex: 1 }}>
                        Воркфлоу
                    </Typography.Title>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
                        Добавить
                    </Button>
                </Flex>

                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    Воркфлоу — отдельная программа со своей логикой. Платформа запускает её
                    процесс на каждое исполнение, предоставляет агентские сессии и наблюдает за
                    ходом работы. Состав воркфлоу платформа узнаёт у процесса при проверке.
                </Typography.Paragraph>

                {isLoading ? <Skeleton active paragraph={{ rows: 4 }} /> : null}

                {!isLoading && (workflows ?? []).length === 0 ? (
                    <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="Воркфлоу пока не добавлены"
                    />
                ) : null}

                {(workflows ?? []).map((workflow) => (
                    <Card
                        key={workflow.id}
                        size="small"
                        title={
                            <Flex align="center" gap={token.marginXS} style={{ minWidth: 0 }}>
                                <Typography.Text strong>{workflow.name}</Typography.Text>
                                {workflow.version === null ? null : (
                                    <Typography.Text type="secondary">
                                        {workflow.version}
                                    </Typography.Text>
                                )}
                                <Tooltip title={statusHint[workflow.checkStatus]}>
                                    <Tag color={statusColor[workflow.checkStatus]}>
                                        {statusLabel[workflow.checkStatus]}
                                    </Tag>
                                </Tooltip>
                            </Flex>
                        }
                        extra={
                            <Space size="small">
                                <Tooltip title="Запустить исполнение">
                                    <Button
                                        size="small"
                                        type="primary"
                                        icon={<PlayCircleOutlined />}
                                        disabled={workflow.checkStatus !== 'ok'}
                                        onClick={() => setRunning(workflow)}
                                    />
                                </Tooltip>
                                <Tooltip title="Проверить требования">
                                    <Button
                                        size="small"
                                        icon={<ReloadOutlined />}
                                        loading={
                                            checkWorkflow.isPending &&
                                            checkWorkflow.variables === workflow.id
                                        }
                                        onClick={() => checkWorkflow.mutate(workflow.id)}
                                    />
                                </Tooltip>
                                <Tooltip title="Удалить карточку">
                                    <Button
                                        size="small"
                                        danger
                                        icon={<DeleteOutlined />}
                                        onClick={() => confirmDelete(workflow)}
                                    />
                                </Tooltip>
                            </Space>
                        }
                    >
                        <Flex vertical gap={token.marginXS}>
                            {workflow.description === null || workflow.description === '' ? null : (
                                <Typography.Text>{workflow.description}</Typography.Text>
                            )}

                            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                                {workflow.command} {workflow.args.join(' ')} · {workflow.packagePath}
                            </Typography.Text>

                            {workflow.requirements === null ? null : (
                                <Flex wrap gap={token.marginXXS}>
                                    {[
                                        ...workflow.requirements.tools.map((name) => `Инструмент ${name}`),
                                        ...workflow.requirements.mcp.map((name) => `MCP ${name}`),
                                        ...workflow.requirements.models.map((name) => `Модель ${name}`),
                                    ].map((requirement) => (
                                        <Tag key={requirement}>{requirement}</Tag>
                                    ))}
                                </Flex>
                            )}

                            {workflow.checkStatus === 'ok' ||
                            workflow.lastCheckMessage === null ? null : (
                                <Alert
                                    type={workflow.checkStatus === 'unknown' ? 'info' : 'warning'}
                                    showIcon
                                    message={statusHint[workflow.checkStatus]}
                                    description={
                                        <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>
                                            {workflow.lastCheckMessage}
                                        </Typography.Text>
                                    }
                                />
                            )}
                        </Flex>
                    </Card>
                ))}
            </Flex>

            <Modal
                open={adding}
                title="Добавить воркфлоу"
                okText="Добавить и проверить"
                cancelText="Отмена"
                confirmLoading={createWorkflow.isPending}
                onOk={submit}
                onCancel={() => setAdding(false)}
            >
                <Form form={form} layout="vertical" style={{ marginBlockStart: token.margin }}>
                    <Form.Item
                        name="name"
                        label="Имя"
                        rules={[{ required: true, message: 'Имя обязательно' }]}
                        extra="Должно совпадать с именем в спецификации воркфлоу: по нему он запускается."
                    >
                        <Input placeholder="echo" />
                    </Form.Item>
                    <Form.Item
                        name="packagePath"
                        label="Путь к пакету"
                        rules={[{ required: true, message: 'Путь обязателен' }]}
                        extra="Рабочий каталог процесса."
                    >
                        <Input placeholder="C:/…/examples/workflow-echo" />
                    </Form.Item>
                    <Form.Item name="command" label="Команда" extra="По умолчанию node.">
                        <Input placeholder="node" />
                    </Form.Item>
                    <Form.Item name="argsText" label="Аргументы" extra="По умолчанию dist/main.js.">
                        <Input placeholder="dist/main.js" />
                    </Form.Item>
                </Form>
            </Modal>

            {running === undefined ? null : (
                <RunDialog workflow={running} onClose={() => setRunning(undefined)} />
            )}
        </div>
    );
}

/**
 * Запуск исполнения. Вход вводится текстом JSON, а не формой по схеме: построение формы по
 * произвольной JSON Schema — отдельная задача, а схема здесь показывается рядом, чтобы
 * состав входа был виден.
 */
function RunDialog({
    workflow,
    onClose,
}: {
    readonly workflow: Workflow;
    readonly onClose: () => void;
}) {
    const { token } = theme.useToken();
    const [text, setText] = useState('{}');
    const start = useStartWorkflowRun();
    const navigate = useNavigate();
    const { message } = App.useApp();

    const submit = (): void => {
        let input: unknown;
        try {
            input = JSON.parse(text);
        } catch (error) {
            message.error(
                `Входной объект не разобран: ${error instanceof Error ? error.message : 'неверный JSON'}`,
            );
            return;
        }
        start.mutate(
            { name: workflow.name, input },
            {
                onSuccess: (session) => {
                    onClose();
                    void navigate({
                        to: '/workflows/runs/$sessionId',
                        params: { sessionId: session.id },
                    });
                },
                onError: (error: unknown) =>
                    message.error(error instanceof Error ? error.message : 'Не удалось запустить'),
            },
        );
    };

    return (
        <Modal
            open
            title={`Запуск «${workflow.title ?? workflow.name}»`}
            okText="Запустить"
            cancelText="Отмена"
            confirmLoading={start.isPending}
            onOk={submit}
            onCancel={onClose}
            width={720}
        >
            <Flex vertical gap={token.marginXS} style={{ marginBlockStart: token.margin }}>
                <Typography.Text type="secondary">Входной объект</Typography.Text>
                <Input.TextArea
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    autoSize={{ minRows: 4, maxRows: 12 }}
                    spellCheck={false}
                />
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                    Схема входа
                </Typography.Text>
                <Typography.Paragraph
                    type="secondary"
                    style={{
                        whiteSpace: 'pre-wrap',
                        fontSize: token.fontSizeSM,
                        maxHeight: 260,
                        overflowY: 'auto',
                        marginBottom: 0,
                    }}
                >
                    {JSON.stringify(workflow.inputSchema, null, 2)}
                </Typography.Paragraph>
            </Flex>
        </Modal>
    );
}
