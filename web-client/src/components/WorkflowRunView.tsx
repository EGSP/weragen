import { useMemo } from 'react';
import { useParams } from '@tanstack/react-router';
import { App, Button, Flex, Skeleton, Tag, Typography, theme } from 'antd';
import { StopOutlined } from '@ant-design/icons';
import { useInterrupt, useSession, useSessionEvents } from '../api/queries.js';
import { useSessionStream } from '../api/use-session-stream.js';
import { groupRun } from '../runs.js';
import { RunItems } from './RunItems.js';
import { SessionIdLabel } from './SessionIdLabel.js';

/**
 * Исполнение воркфлоу.
 *
 * Показывается той же страницей, что и чат, и по тому же журналу: вложенность и различие
 * видов существуют в отрисовке, а не в хранении. Поля ввода здесь нет — вход исполнение
 * получает при запуске, и следующего сообщения не будет.
 */
export function WorkflowRunView() {
    const { token } = theme.useToken();
    const { sessionId } = useParams({ strict: false }) as { sessionId: string };
    const { data: session } = useSession(sessionId);
    const { data: history, isLoading } = useSessionEvents(sessionId);
    const events = useSessionStream(sessionId, history);
    const interrupt = useInterrupt(sessionId);
    const { message } = App.useApp();

    const run = useMemo(() => groupRun(events), [events]);
    const running = session?.status === 'running' && run.running;

    return (
        <Flex vertical style={{ height: '100%', minHeight: 0 }}>
            <Flex
                align="center"
                gap={token.marginXS}
                style={{
                    paddingInline: token.paddingLG,
                    paddingBlock: token.paddingSM,
                    borderBlockEnd: `1px solid ${token.colorBorderSecondary}`,
                }}
            >
                <Typography.Text strong ellipsis style={{ flex: 1 }}>
                    {session?.title ?? '…'}
                </Typography.Text>

                {session?.workflowName === null || session?.workflowName === undefined ? null : (
                    <Tag>{session.workflowName}</Tag>
                )}

                {session?.status === 'running' ? <Tag color="processing">Выполняется</Tag> : null}
                {session?.status === 'completed' ? <Tag color="success">Завершено</Tag> : null}
                {session?.status === 'failed' ? <Tag color="error">Отказ</Tag> : null}

                {running ? (
                    <Button
                        size="small"
                        danger
                        icon={<StopOutlined />}
                        loading={interrupt.isPending}
                        onClick={() =>
                            interrupt.mutate(undefined, {
                                onError: (error: unknown) =>
                                    message.error(
                                        error instanceof Error
                                            ? error.message
                                            : 'Не удалось прервать',
                                    ),
                            })
                        }
                    >
                        Прервать
                    </Button>
                ) : null}

                <SessionIdLabel sessionId={sessionId} />
            </Flex>

            {/* Место под полосу прокрутки зарезервировано всегда — по той же причине, что и
                в ленте чата: иначе с её появлением содержимое смещается. */}
            <div
                style={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: 'auto',
                    scrollbarGutter: 'stable both-edges',
                    paddingInline: token.paddingLG,
                    paddingBlock: token.padding,
                }}
            >
                <div style={{ maxWidth: 880, marginInline: 'auto' }}>
                    {isLoading ? <Skeleton active paragraph={{ rows: 3 }} /> : null}
                    <RunItems items={run.items} running={running} />
                </div>
            </div>
        </Flex>
    );
}
