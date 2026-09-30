import { useEffect, useMemo, useRef, useState } from 'react';
import { Sender } from '@ant-design/x';
import { useParams } from '@tanstack/react-router';
import { App, Flex, Select, Skeleton, Tag, Tooltip, Typography, theme } from 'antd';
import {
    useInterrupt,
    useModels,
    useSelectSessionModel,
    useSendMessage,
    useSession,
    useSessionEvents,
} from '../api/queries.js';
import { useSessionStream } from '../api/use-session-stream.js';
import { completedCount, groupTurns, isRunning, totalUsage } from '../turns.js';
import { ContextIndicator } from './ContextIndicator.js';
import { SessionIdLabel } from './SessionIdLabel.js';
import { TurnBlockView } from './TurnBlock.js';

export function SessionView() {
    const { token } = theme.useToken();
    const { sessionId } = useParams({ strict: false }) as { sessionId: string };
    const { data: session } = useSession(sessionId);
    const { data: history, isLoading } = useSessionEvents(sessionId);
    const events = useSessionStream(sessionId, history);

    const sendMessage = useSendMessage(sessionId);
    const interrupt = useInterrupt(sessionId);
    const { data: models } = useModels();
    const selectModel = useSelectSessionModel(sessionId);
    const { message } = App.useApp();

    const [draft, setDraft] = useState('');

    /** Варианты пикера — записи справочника; модель по умолчанию помечена. */
    const modelOptions = useMemo(
        () =>
            (models ?? []).map((model) => ({
                value: model.id,
                label: model.isDefault ? `${model.identifier} · по умолчанию` : model.identifier,
            })),
        [models],
    );
    const bottomRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    /** Держался ли пользователь у нижнего края к моменту прихода события. */
    const atBottomRef = useRef(true);

    const turns = useMemo(() => groupTurns(events), [events]);
    const running = isRunning(turns);
    const usage = useMemo(() => totalUsage(turns), [turns]);

    /**
     * Прокрутка к последнему событию — но только если пользователь и так находится внизу.
     *
     * Ход добавляет события десятками, и безусловная прокрутка возвращала бы к нижнему краю
     * того, кто отлистал вверх, чтобы прочитать написанное. Плавная прокрутка при этом
     * заменена мгновенной: анимации накладывались одна на другую, и вместо перемещения
     * получалось дрожание.
     *
     * Запас в 120 пикселей нужен потому, что «внизу» редко бывает точным: содержимое
     * дорисовывается, и положение смещается на несколько пикселей само собой.
     */
    useEffect(() => {
        if (!atBottomRef.current) return;
        bottomRef.current?.scrollIntoView({ block: 'end' });
    }, [events.length]);

    const onScroll = (): void => {
        const box = scrollRef.current;
        if (box === null) return;
        atBottomRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    };

    const send = (value: string): void => {
        const text = value.trim();
        if (text === '' || running) return;
        setDraft('');
        sendMessage.mutate(text, {
            onError: (error: unknown) => {
                // Поле очищается, не дожидаясь ответа. При отказе текст возвращается в него,
                // если пользователь не начал набирать новый: иначе сообщение было бы потеряно.
                setDraft((current) => (current === '' ? value : current));
                message.error(error instanceof Error ? error.message : 'Не удалось отправить');
            },
        });
    };

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

                {running ? <Tag color="processing">Выполняется</Tag> : null}

                <SessionIdLabel sessionId={sessionId} />
            </Flex>

            {/*
             * Место под полосу прокрутки зарезервировано всегда, а не с её появлением: иначе
             * при первом переполнении ширина колонки уменьшалась на ширину полосы и всё
             * содержимое смещалось. Резерв симметричен, чтобы колонка ленты оставалась
             * на одной оси с полем ввода, у которого прокрутки нет.
             */}
            <div
                ref={scrollRef}
                onScroll={onScroll}
                style={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: 'auto',
                    scrollbarGutter: 'stable both-edges',
                    paddingInline: token.paddingLG,
                    paddingBlock: token.padding,
                }}
            >
                <Flex
                    vertical
                    gap={token.marginLG}
                    style={{ maxWidth: 880, marginInline: 'auto' }}
                >
                    {isLoading ? <Skeleton active paragraph={{ rows: 3 }} /> : null}
                    {turns.map((turn) => (
                        <TurnBlockView key={turn.key} turn={turn} />
                    ))}
                    <div ref={bottomRef} />
                </Flex>
            </div>

            <div
                style={{
                    paddingInline: token.paddingLG,
                    paddingBlock: token.padding,
                    borderBlockStart: `1px solid ${token.colorBorderSecondary}`,
                }}
            >
                <div style={{ maxWidth: 880, marginInline: 'auto' }}>
                    <Sender
                        value={draft}
                        onChange={setDraft}
                        onSubmit={send}
                        loading={running}
                        onCancel={() => interrupt.mutate()}
                        placeholder="Сообщение агенту. Enter — отправить, Shift+Enter — перенос строки"
                        autoSize={{ minRows: 1, maxRows: 6 }}
                    />

                    {/*
                     * Строка опций: одна строка по ширине поля ввода, без переноса. Лишнее
                     * сжимается, а не переносится: перенос сдвигал бы поле ввода по высоте.
                     */}
                    <Flex
                        align="center"
                        gap={token.marginXXS}
                        style={{ marginBlockStart: token.marginXXS, minWidth: 0, whiteSpace: 'nowrap' }}
                    >
                        <div style={{ flex: 1 }} />

                        {/*
                         * Смена модели разрешена и при непустой истории: массив сообщений
                         * собирается из журнала заново на каждый ход, поэтому новая модель
                         * получает весь прежний диалог. Запрещена только во время хода — иначе
                         * часть шагов выполнилась бы одной моделью, часть другой, причём
                         * незаметно.
                         */}
                        <Tooltip
                            title={running ? 'Смена модели недоступна во время хода' : 'Модель сессии'}
                        >
                            <Select
                                size="small"
                                variant="borderless"
                                placement="topRight"
                                popupMatchSelectWidth={false}
                                style={{ minWidth: 0, maxWidth: 320 }}
                                placeholder="Модель не выбрана"
                                disabled={running || selectModel.isPending}
                                loading={selectModel.isPending}
                                value={session?.modelId ?? undefined}
                                onChange={(value: string) =>
                                    selectModel.mutate(value, {
                                        onError: (error: unknown) =>
                                            message.error(
                                                error instanceof Error
                                                    ? error.message
                                                    : 'Не удалось сменить модель',
                                            ),
                                    })
                                }
                                options={modelOptions}
                            />
                        </Tooltip>

                        <ContextIndicator
                            sessionId={sessionId}
                            modelName={session?.modelName ?? null}
                            completedTurns={completedCount(turns)}
                            usage={usage}
                        />
                    </Flex>
                </div>
            </div>
        </Flex>
    );
}
