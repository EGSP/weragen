import { useMemo, useState } from 'react';
import {
    CheckCircleOutlined,
    CloseCircleOutlined,
    DeleteOutlined,
    DisconnectOutlined,
    EditOutlined,
    MessageOutlined,
    PlusOutlined,
    QuestionCircleOutlined,
    ReloadOutlined,
    RobotOutlined,
} from '@ant-design/icons';
import { Link } from '@tanstack/react-router';
import {
    App,
    Alert,
    AutoComplete,
    Button,
    Card,
    Empty,
    Flex,
    Form,
    Modal,
    Skeleton,
    Switch,
    Tag,
    Tooltip,
    Typography,
    theme,
} from 'antd';
import type { ModelAvailability, ModelProfile, ModelSession } from '@weragen/types';
import {
    useCheckAvailability,
    useCreateModel,
    useDeleteModel,
    useModelRegistry,
    useProviderModels,
    useUpdateModel,
} from '../api/queries.js';
import { rank } from '../fuzzy.js';

type FormValues = {
    identifier: string;
    isDefault: boolean;
    supportsTools: boolean;
    supportsReasoning: boolean;
};

/**
 * Период опроса справочника. Перечень активных сессий меняется без участия страницы: ход
 * начинается и завершается в других разделах.
 */
const REFRESH_MS = 5000;

const availabilityView: Record<
    ModelAvailability,
    { color: string; label: string; icon: React.ReactNode }
> = {
    available: { color: 'success', label: 'Есть в каталоге', icon: <CheckCircleOutlined /> },
    not_listed: { color: 'error', label: 'Нет в каталоге', icon: <CloseCircleOutlined /> },
    unreachable: { color: 'warning', label: 'Провайдер недоступен', icon: <DisconnectOutlined /> },
    unknown: { color: 'default', label: 'Не проверялась', icon: <QuestionCircleOutlined /> },
};

/**
 * Справочник моделей платформы.
 *
 * Доступность определяется наличием модели в перечне провайдера и обновляется по таймеру на
 * сервере; здесь показывается последнее известное состояние. Признаки возможностей
 * проставляются вручную: перечень провайдера таких сведений не содержит.
 */
export function ModelsPage() {
    const { token } = theme.useToken();
    const { data: registry, isLoading } = useModelRegistry(REFRESH_MS);
    const models = registry?.models;
    const { data: provider } = useProviderModels();
    const createModel = useCreateModel();
    const updateModel = useUpdateModel();
    const deleteModel = useDeleteModel();
    const checkAvailability = useCheckAvailability();
    const { modal, message } = App.useApp();

    const [editing, setEditing] = useState<ModelProfile | null>(null);
    const [formOpen, setFormOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [form] = Form.useForm<FormValues>();

    const added = useMemo(
        () => new Set((models ?? []).map((model) => model.identifier)),
        [models],
    );

    /**
     * Варианты для ввода. Поле остаётся текстовым: подсказки не заменяют ручной ввод, а
     * дополняют его — дообученной модели или модели из чужого каталога в перечне не будет.
     * Отбор нечёткий, поэтому «qwen 35» находит `qwen3.6-35b-a3b/latest`.
     */
    const options = useMemo(() => {
        const candidates = (provider?.models ?? []).filter((model) => !added.has(model.identifier));
        const ordered = rank(query, candidates, (model) => `${model.vendor} ${model.identifier}`);

        const byVendor = new Map<string, typeof ordered>();
        for (const model of ordered) {
            byVendor.set(model.vendor, [...(byVendor.get(model.vendor) ?? []), model]);
        }

        return [...byVendor.entries()].map(([vendor, items]) => ({
            label: <Typography.Text type="secondary">{vendor}</Typography.Text>,
            options: items.map((model) => ({ value: model.identifier, label: model.identifier })),
        }));
    }, [provider, added, query]);

    const openForm = (model: ModelProfile | null): void => {
        setEditing(model);
        setQuery(model?.identifier ?? '');
        form.setFieldsValue(
            model === null
                ? { identifier: '', isDefault: false, supportsTools: false, supportsReasoning: false }
                : {
                      identifier: model.identifier,
                      isDefault: model.isDefault,
                      supportsTools: model.supportsTools,
                      supportsReasoning: model.supportsReasoning,
                  },
        );
        setFormOpen(true);
    };

    const submit = async (): Promise<void> => {
        const values = await form.validateFields();
        const onError = (error: unknown): void => {
            message.error(error instanceof Error ? error.message : 'Не удалось сохранить');
        };
        const onSuccess = (): void => setFormOpen(false);

        if (editing === null) {
            createModel.mutate(values, { onSuccess, onError });
        } else {
            // Идентификатор в правку не входит: он задаётся при создании и не меняется.
            const { isDefault, supportsTools, supportsReasoning } = values;
            updateModel.mutate(
                { id: editing.id, body: { isDefault, supportsTools, supportsReasoning } },
                { onSuccess, onError },
            );
        }
    };

    const confirmDelete = (model: ModelProfile): void => {
        modal.confirm({
            title: `Удалить модель «${model.identifier}»?`,
            content:
                'Сессии с этой моделью сохранятся, но продолжить работу в них можно будет ' +
                'только после выбора другой модели.',
            okText: 'Удалить',
            okButtonProps: { danger: true },
            cancelText: 'Отмена',
            onOk: () =>
                deleteModel.mutateAsync(model.id).catch((error: unknown) => {
                    message.error(error instanceof Error ? error.message : 'Не удалось удалить');
                }),
        });
    };

    return (
        <Flex vertical style={{ height: '100%', minHeight: 0 }}>
            <Flex
                align="center"
                justify="space-between"
                gap={token.marginXS}
                style={{
                    paddingInline: token.paddingLG,
                    paddingBlock: token.paddingSM,
                    borderBlockEnd: `1px solid ${token.colorBorderSecondary}`,
                }}
            >
                <Typography.Text strong>Модели</Typography.Text>
                <Flex gap={token.marginXS}>
                    <Tooltip title="Перепроверить наличие моделей в каталоге провайдера">
                        <Button
                            icon={<ReloadOutlined />}
                            loading={checkAvailability.isPending}
                            onClick={() => checkAvailability.mutate()}
                        >
                            Проверить
                        </Button>
                    </Tooltip>
                    <Button type="primary" icon={<PlusOutlined />} onClick={() => openForm(null)}>
                        Добавить модель
                    </Button>
                </Flex>
            </Flex>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: token.paddingLG }}>
                {provider?.error !== null && provider !== undefined ? (
                    <Alert
                        type="warning"
                        showIcon
                        style={{ marginBlockEnd: token.margin }}
                        message="Перечень моделей провайдера недоступен"
                        description={provider.error}
                    />
                ) : null}

                {isLoading ? <Skeleton active /> : null}

                {!isLoading && (models ?? []).length === 0 ? (
                    <Empty description="Моделей пока нет. Добавьте первую — она станет моделью по умолчанию." />
                ) : null}

                <Flex wrap gap={token.margin} align="stretch">
                    {(models ?? []).map((model) => {
                        const view = availabilityView[model.availability];
                        return (
                            <Card
                                key={model.id}
                                // Карточка растягивается по высоте ряда, а тело занимает всё
                                // свободное место, поэтому кнопки стоят у нижнего края при любом
                                // объёме содержимого соседних карточек.
                                style={{ width: 340, display: 'flex', flexDirection: 'column' }}
                                styles={{ body: { flex: 1 } }}
                                title={
                                    <Flex align="center" gap={token.marginXS}>
                                        <Typography.Text strong ellipsis title={model.identifier}>
                                            {model.identifier}
                                        </Typography.Text>
                                        {model.isDefault ? (
                                            <Tag color="blue" variant="filled">
                                                По умолчанию
                                            </Tag>
                                        ) : null}
                                    </Flex>
                                }
                                actions={[
                                    <Button
                                        key="edit"
                                        type="text"
                                        icon={<EditOutlined />}
                                        onClick={() => openForm(model)}
                                    >
                                        Изменить
                                    </Button>,
                                    <Button
                                        key="delete"
                                        type="text"
                                        danger
                                        icon={<DeleteOutlined />}
                                        onClick={() => confirmDelete(model)}
                                    />,
                                ]}
                            >
                                <Flex vertical gap={token.marginSM}>
                                    <Flex wrap gap={token.marginXXS}>
                                        <Tag color={view.color} icon={view.icon} variant="filled">
                                            {view.label}
                                        </Tag>
                                        {model.supportsTools ? (
                                            <Tag variant="filled">Вызывает инструменты</Tag>
                                        ) : null}
                                        {model.supportsReasoning ? (
                                            <Tag variant="filled">Размышляет</Tag>
                                        ) : null}
                                    </Flex>

                                    <Typography.Text
                                        type="secondary"
                                        style={{ fontSize: token.fontSizeSM }}
                                        ellipsis={{ tooltip: model.lastCheckMessage ?? '' }}
                                    >
                                        {model.lastCheckMessage ?? 'Проверка ещё не выполнялась'}
                                    </Typography.Text>

                                    {model.lastCheckAt === null ? null : (
                                        <Typography.Text
                                            type="secondary"
                                            style={{ fontSize: token.fontSizeSM }}
                                        >
                                            Проверено{' '}
                                            {new Date(model.lastCheckAt).toLocaleTimeString('ru')}
                                        </Typography.Text>
                                    )}

                                    <ActiveSessions sessions={model.activeSessions} />
                                </Flex>
                            </Card>
                        );
                    })}
                </Flex>
            </div>

            <Modal
                open={formOpen}
                title={editing === null ? 'Добавить модель' : 'Изменить модель'}
                okText="Сохранить"
                cancelText="Отмена"
                confirmLoading={createModel.isPending || updateModel.isPending}
                onOk={() => void submit()}
                onCancel={() => setFormOpen(false)}
                destroyOnHidden
            >
                <Form form={form} layout="vertical" style={{ marginBlockStart: 16 }}>
                    <Form.Item
                        name="identifier"
                        label="Модель"
                        rules={[{ required: true, message: 'Укажите модель' }]}
                        extra={
                            editing === null
                                ? 'Начните вводить — подсказки отбираются по схожести, а не по точному совпадению. Значения нет в списке: дообученную модель или модель из другого каталога впишите полным URI.'
                                : 'Модель карточки задаётся при создании и не меняется. Для другой модели добавьте новую карточку.'
                        }
                    >
                        <AutoComplete
                            options={options}
                            onSearch={setQuery}
                            onSelect={(value: string) => setQuery(value)}
                            placeholder="qwen3.6-35b-a3b/latest"
                            allowClear
                            disabled={editing !== null}
                        />
                    </Form.Item>

                    <Form.Item
                        name="supportsTools"
                        label="Вызывает инструменты"
                        valuePropName="checked"
                        extra="Перечень моделей провайдера сведений о возможностях не содержит, поэтому признак проставляется вручную."
                    >
                        <Switch />
                    </Form.Item>

                    <Form.Item name="supportsReasoning" label="Размышляет" valuePropName="checked">
                        <Switch />
                    </Form.Item>

                    <Form.Item name="isDefault" label="Использовать по умолчанию" valuePropName="checked">
                        <Switch />
                    </Form.Item>
                </Form>
            </Modal>
        </Flex>
    );
}

/**
 * Сессии, в которых прямо сейчас идёт ход на модели. Пока перечень не пуст, модель нельзя
 * удалить: сервер отклоняет удаление и перечисляет те же сессии.
 */
function ActiveSessions({ sessions }: { readonly sessions: readonly ModelSession[] }) {
    const { token } = theme.useToken();
    return (
        <Flex vertical gap={token.marginXXS} style={{ minWidth: 0 }}>
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                Активных сессий: {sessions.length}
            </Typography.Text>
            {sessions.map((session) => (
                <Link
                    key={session.id}
                    to="/sessions/$sessionId"
                    params={{ sessionId: session.id }}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: token.marginXS,
                        minWidth: 0,
                        color: token.colorLink,
                    }}
                >
                    {session.kind === 'agent' ? <RobotOutlined /> : <MessageOutlined />}
                    <Typography.Text ellipsis style={{ minWidth: 0, color: 'inherit' }}>
                        {session.title}
                    </Typography.Text>
                </Link>
            ))}
        </Flex>
    );
}
