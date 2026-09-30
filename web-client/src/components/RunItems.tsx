import {
    CheckCircleOutlined,
    CloseCircleOutlined,
    LoadingOutlined,
    MinusCircleOutlined,
    PlayCircleOutlined,
} from '@ant-design/icons';
import { Alert, Card, Flex, Typography, theme } from 'antd';
import type { RunItem } from '../runs.js';
import { ChildSessionCard } from './ChildSessionCard.js';

/**
 * Отрисовка исполнения воркфлоу: вход, шаги, дочерние сессии, итог — в том порядке, в
 * каком они записаны в журнале.
 *
 * Шаги показываются строками, а не сворачиваемыми блоками: у шага нет содержимого, кроме
 * названия и состояния, и обёртка добавила бы уровень вложенности впустую.
 */

const json = (value: unknown): string =>
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);

const duration = (ms: number): string => (ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`);

function StepRow({
    item,
    running,
}: {
    readonly item: Extract<RunItem, { kind: 'step' }>;
    /** Идёт ли исполнение. Шаг сам по себе о том, продолжается ли работа, не свидетельствует. */
    readonly running: boolean;
}) {
    const { token } = theme.useToken();

    // Шаг, оставшийся начатым у завершившегося исполнения, не идёт: исполнение на нём
    // остановилось — прерыванием либо отказом, не закрывшим шаг. Указатель ожидания здесь
    // сообщал бы о работе, которой нет, и исполнение выглядело бы незаканчивающимся.
    const unfinished = item.state === 'started' && !running;
    const icon = unfinished ? (
        <MinusCircleOutlined style={{ color: token.colorTextTertiary }} />
    ) : item.state === 'started' ? (
        <LoadingOutlined />
    ) : item.state === 'failed' ? (
        <CloseCircleOutlined style={{ color: token.colorError }} />
    ) : (
        <CheckCircleOutlined style={{ color: token.colorSuccess }} />
    );

    return (
        <Flex
            vertical
            gap={token.marginXXS}
            // Вложенный шаг сдвигается: дерево шагов иначе выглядело бы плоским списком.
            style={{ minWidth: 0, marginInlineStart: item.parentStepId === undefined ? 0 : token.margin }}
        >
            <Flex align="center" gap={token.marginXS} style={{ minWidth: 0 }}>
                {icon}
                <Typography.Text>{item.name}</Typography.Text>
                {unfinished ? (
                    <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                        не завершён
                    </Typography.Text>
                ) : null}
                {item.durationMs === undefined ? null : (
                    <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                        {duration(item.durationMs)}
                    </Typography.Text>
                )}
                <Typography.Text
                    type="secondary"
                    style={{ fontSize: token.fontSizeSM, marginInlineStart: 'auto' }}
                >
                    {item.stepId}
                </Typography.Text>
            </Flex>
            {item.detail === undefined ? null : (
                <Typography.Text
                    type={item.state === 'failed' ? 'danger' : 'secondary'}
                    style={{ fontSize: token.fontSizeSM, whiteSpace: 'pre-wrap' }}
                >
                    {item.detail}
                </Typography.Text>
            )}
        </Flex>
    );
}

export function RunItems({
    items,
    running,
}: {
    readonly items: readonly RunItem[];
    /** Идёт ли исполнение: от этого зависит, как читается шаг, оставшийся начатым. */
    readonly running: boolean;
}) {
    const { token } = theme.useToken();

    return (
        <Flex vertical gap={token.marginSM} style={{ minWidth: 0 }}>
            {items.map((item) => {
                if (item.kind === 'started') {
                    return (
                        <Card key={item.key} size="small" variant="outlined">
                            <Flex align="center" gap={token.marginXS}>
                                <PlayCircleOutlined style={{ color: token.colorTextTertiary }} />
                                <Typography.Text strong>{item.workflowName}</Typography.Text>
                                {item.version === null ? null : (
                                    <Typography.Text type="secondary">{item.version}</Typography.Text>
                                )}
                            </Flex>
                            <Typography.Paragraph
                                type="secondary"
                                style={{
                                    whiteSpace: 'pre-wrap',
                                    marginBottom: 0,
                                    marginBlockStart: token.marginXS,
                                    fontSize: token.fontSizeSM,
                                }}
                            >
                                {json(item.input)}
                            </Typography.Paragraph>
                        </Card>
                    );
                }

                if (item.kind === 'step')
                    return <StepRow key={item.key} item={item} running={running} />;

                if (item.kind === 'child') {
                    return (
                        <ChildSessionCard
                            key={item.key}
                            childId={item.childId}
                            childKind={item.childKind}
                            title={item.title}
                        />
                    );
                }

                if (item.kind === 'completed') {
                    return (
                        <Card key={item.key} size="small" title="Итог" variant="outlined">
                            <Typography.Paragraph
                                style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}
                            >
                                {json(item.result)}
                            </Typography.Paragraph>
                        </Card>
                    );
                }

                return (
                    <Alert
                        key={item.key}
                        type="error"
                        showIcon
                        message="Исполнение завершилось отказом"
                        description={
                            <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>
                                {item.message}
                            </Typography.Text>
                        }
                    />
                );
            })}
        </Flex>
    );
}
