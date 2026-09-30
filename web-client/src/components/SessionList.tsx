import {
    DeleteOutlined,
    EditOutlined,
    LoadingOutlined,
    PlusOutlined,
    SettingOutlined,
} from '@ant-design/icons';
import { Conversations, type ConversationsProps } from '@ant-design/x';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { App, Button, Empty, Flex, Form, Input, Modal, Skeleton, theme } from 'antd';
import {
    CheckCircleOutlined,
    CloseCircleOutlined,
} from '@ant-design/icons';
import {
    useCreateSession,
    useDeleteSession,
    useRenameSession,
    useSessions,
} from '../api/queries.js';

/**
 * Список сессий раздела. Используется компонент `Conversations` — штатный для перечня
 * диалогов: он берёт на себя выделение активного, усечение длинных названий и меню действий.
 *
 * Один компонент обслуживает оба раздела, потому что запись сессии одна на все виды, а
 * различаются лишь отбор по виду, адрес перехода и то, чем начинается новая сессия: чат
 * создаётся здесь же, исполнение воркфлоу — запуском на странице реестра.
 */
export function SessionList({ kind = 'chat' }: { readonly kind?: 'chat' | 'workflow' }) {
    const { token } = theme.useToken();
    const { data: sessions, isLoading } = useSessions(kind);
    const createSession = useCreateSession();
    const deleteSession = useDeleteSession();
    const navigate = useNavigate();
    const { modal } = App.useApp();

    const [renaming, setRenaming] = useState<{ id: string; title: string } | undefined>(undefined);

    // Параметр маршрута существует только внутри маршрута сессии, поэтому читается мягко.
    const params = useParams({ strict: false }) as { sessionId?: string };
    const toSession = (sessionId: string): void => {
        void (kind === 'workflow'
            ? navigate({ to: '/workflows/runs/$sessionId', params: { sessionId } })
            : navigate({ to: '/sessions/$sessionId', params: { sessionId } }));
    };

    const confirmDelete = (id: string): void => {
        modal.confirm({
            title: kind === 'workflow' ? 'Удалить исполнение?' : 'Удалить сессию?',
            content:
                'Журнал событий будет удалён без возможности восстановления. ' +
                'Дочерние сессии удаляются вместе с ним.',
            okText: 'Удалить',
            okButtonProps: { danger: true },
            cancelText: 'Отмена',
            onOk: () =>
                deleteSession.mutateAsync(id).then(() => {
                    if (params.sessionId === id) {
                        void navigate({ to: kind === 'workflow' ? '/workflows' : '/' });
                    }
                }),
        });
    };

    const openRename = (id: string): void => {
        const session = (sessions ?? []).find((item) => item.id === id);
        if (session !== undefined) setRenaming({ id: session.id, title: session.title });
    };

    const items: ConversationsProps['items'] = (sessions ?? []).map((session) => ({
        key: session.id,
        label: session.title,
        icon:
            session.status === 'running' ? (
                <LoadingOutlined />
            ) : session.status === 'completed' ? (
                <CheckCircleOutlined style={{ color: token.colorSuccess }} />
            ) : session.status === 'failed' ? (
                <CloseCircleOutlined style={{ color: token.colorError }} />
            ) : undefined,
    }));

    return (
        <Flex vertical gap={token.marginSM} style={{ height: '100%', padding: token.padding }}>
            {kind === 'chat' ? (
                <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    block
                    loading={createSession.isPending}
                    onClick={() =>
                        createSession.mutate(undefined, {
                            onSuccess: (session) => toSession(session.id),
                        })
                    }
                >
                    Новый чат
                </Button>
            ) : (
                <Button
                    icon={<SettingOutlined />}
                    block
                    onClick={() => void navigate({ to: '/workflows' })}
                >
                    Реестр воркфлоу
                </Button>
            )}

            <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
                {isLoading ? <Skeleton active paragraph={{ rows: 4 }} /> : null}

                {!isLoading && items.length === 0 ? (
                    <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={kind === 'workflow' ? 'Исполнений пока нет' : 'Сессий пока нет'}
                        style={{ marginBlockStart: token.marginXL }}
                    />
                ) : null}

                {items.length > 0 ? (
                    <Conversations
                        items={items}
                        activeKey={params.sessionId}
                        onActiveChange={(key) => toSession(String(key))}
                        menu={(conversation) => ({
                            items: [
                                {
                                    key: 'rename',
                                    label: 'Переименовать',
                                    icon: <EditOutlined />,
                                },
                                {
                                    key: 'delete',
                                    label: 'Удалить',
                                    icon: <DeleteOutlined />,
                                    danger: true,
                                },
                            ],
                            onClick: ({ key }) => {
                                const id = String(conversation.key);
                                if (key === 'rename') openRename(id);
                                else confirmDelete(id);
                            },
                        })}
                    />
                ) : null}
            </div>

            {renaming === undefined ? null : (
                <RenameDialog session={renaming} onClose={() => setRenaming(undefined)} />
            )}
        </Flex>
    );
}

/**
 * Переименование сессии.
 *
 * Название есть свойство карточки в списке и на исполнение не влияет, поэтому переименование
 * разрешено в любом состоянии, включая идущий ход.
 */
function RenameDialog({
    session,
    onClose,
}: {
    readonly session: { readonly id: string; readonly title: string };
    readonly onClose: () => void;
}) {
    const [title, setTitle] = useState(session.title);
    const rename = useRenameSession();
    const { message } = App.useApp();

    const submit = (): void => {
        const next = title.trim();
        if (next === '') {
            message.error('Название не может быть пустым');
            return;
        }
        rename.mutate(
            { id: session.id, title: next },
            {
                onSuccess: onClose,
                onError: (error: unknown) =>
                    message.error(
                        error instanceof Error ? error.message : 'Не удалось переименовать',
                    ),
            },
        );
    };

    return (
        <Modal
            open
            title="Переименовать сессию"
            okText="Сохранить"
            cancelText="Отмена"
            confirmLoading={rename.isPending}
            onOk={submit}
            onCancel={onClose}
        >
            <Form layout="vertical">
                <Form.Item label="Название">
                    <Input
                        value={title}
                        maxLength={200}
                        autoFocus
                        onChange={(event) => setTitle(event.target.value)}
                        onPressEnter={submit}
                    />
                </Form.Item>
            </Form>
        </Modal>
    );
}
