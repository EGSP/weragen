import { useMemo, useState } from 'react';
import { ApartmentOutlined, RobotOutlined } from '@ant-design/icons';
import { Collapse, Flex, Skeleton, Tag, Typography, theme } from 'antd';
import type { SessionKind } from '@weragen/types';
import { useSession, useSessionEvents } from '../api/queries.js';
import { useSessionStream } from '../api/use-session-stream.js';
import { groupTurns } from '../turns.js';
import { groupRun } from '../runs.js';
import { TurnBlockView } from './TurnBlock.js';
import { RunItems } from './RunItems.js';

/**
 * Дочерняя сессия внутри журнала родителя.
 *
 * Содержимое подгружается только при раскрытии: журнал и поток дочерней сессии читаются
 * теми же запросами, что и у любой другой, и открывать соединение на каждую упомянутую
 * сессию заранее означало бы держать их по числу шагов.
 */
export function ChildSessionCard({
    childId,
    childKind,
    title,
}: {
    readonly childId: string;
    readonly childKind: SessionKind;
    readonly title: string;
}) {
    const { token } = theme.useToken();
    const [open, setOpen] = useState(false);
    const { data: session } = useSession(childId);

    const status = session?.status ?? 'running';
    const color =
        status === 'completed'
            ? 'success'
            : status === 'failed'
              ? 'error'
              : status === 'running'
                ? 'processing'
                : 'default';
    const label =
        status === 'completed'
            ? 'Завершено'
            : status === 'failed'
              ? 'Отказ'
              : status === 'running'
                ? 'Выполняется'
                : 'Ожидает';

    return (
        <Collapse
            size="small"
            activeKey={open ? [childId] : []}
            onChange={(keys) => setOpen((Array.isArray(keys) ? keys : [keys]).length > 0)}
            // Без minWidth блок подписи не сжимается уже своего содержимого, и длинное название
            // выталкивает метку состояния за край ряда (подробнее — у WorkRows в TurnBlock).
            styles={{ title: { minWidth: 0 } }}
            items={[
                {
                    key: childId,
                    label: (
                        <Flex align="center" gap={token.marginXS} style={{ minWidth: 0 }}>
                            {childKind === 'workflow' ? (
                                <ApartmentOutlined style={{ color: token.colorTextTertiary }} />
                            ) : (
                                <RobotOutlined style={{ color: token.colorTextTertiary }} />
                            )}
                            <Typography.Text type="secondary">
                                {childKind === 'workflow' ? 'Воркфлоу' : 'Агент'}
                            </Typography.Text>
                            <Typography.Text ellipsis>{title}</Typography.Text>
                            <Tag color={color} style={{ marginInlineStart: 'auto' }}>
                                {label}
                            </Tag>
                        </Flex>
                    ),
                    children: open ? (
                        <ChildSessionBody
                            id={childId}
                            kind={childKind}
                            running={status === 'running'}
                        />
                    ) : null,
                },
            ]}
        />
    );
}

/**
 * Содержимое дочерней сессии. Вынесено отдельным компонентом намеренно: подписка на поток
 * начинается при его создании, поэтому свёрнутая карточка не должна его порождать.
 */
function ChildSessionBody({
    id,
    kind,
    running,
}: {
    readonly id: string;
    readonly kind: SessionKind;
    readonly running: boolean;
}) {
    const { token } = theme.useToken();
    const { data: history, isLoading } = useSessionEvents(id);
    const events = useSessionStream(id, history);

    const turns = useMemo(() => groupTurns(events), [events]);
    const run = useMemo(() => groupRun(events), [events]);

    if (isLoading) return <Skeleton active paragraph={{ rows: 2 }} />;

    return (
        <Flex vertical gap={token.margin} style={{ minWidth: 0 }}>
            {kind === 'workflow' ? (
                <RunItems items={run.items} running={running} />
            ) : (
                turns.map((turn) => <TurnBlockView key={turn.key} turn={turn} />)
            )}
        </Flex>
    );
}
