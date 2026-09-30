import { useState, type ReactNode } from 'react';
import {
    BulbOutlined,
    ClusterOutlined,
    CloseCircleOutlined,
    LoadingOutlined,
    RobotOutlined,
    ToolOutlined,
    UserOutlined,
} from '@ant-design/icons';
import { Bubble } from '@ant-design/x';
import { Alert, Avatar, Collapse, Flex, Spin, Typography, theme } from 'antd';
import type { TurnFailureReason } from '@weragen/types';
import type { TurnBlock as Turn, WorkGroup, WorkItem } from '../turns.js';
import { ChartView } from './ChartView.js';
import { ChildSessionCard } from './ChildSessionCard.js';
import { MarkdownText } from './MarkdownText.js';

const failureLabel: Record<TurnFailureReason, string> = {
    model_error: 'ошибка модели',
    step_limit: 'превышен предел шагов',
    output_limit: 'исчерпан бюджет вывода',
    aborted: 'прервано пользователем',
    internal: 'внутренняя ошибка',
};

/**
 * Оформление блока данных: моноширинный шрифт и предел высоты. Результат бывает в тысячи
 * знаков, и без предела один вызов вытеснял бы собой всю переписку.
 */
const preStyle = (token: ReturnType<typeof theme.useToken>['token']) =>
    ({
        margin: 0,
        padding: token.paddingXS,
        maxHeight: 320,
        overflow: 'auto',
        background: token.colorFillQuaternary,
        borderRadius: token.borderRadiusSM,
        fontFamily: token.fontFamilyCode,
        fontSize: token.fontSizeSM,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
    }) as const;

const duration = (ms: number): string => (ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`);

const shorten = (value: string, limit: number): string =>
    value.length > limit ? `${value.slice(0, limit)}…` : value;

/** Подписи интерфейса начинаются с заглавной буквы. */
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Аргументы в компактной форме: без внешних скобок и кавычек у имён полей. */
function compactArgs(rawArguments: string): string {
    const flat = rawArguments.replace(/\s+/g, ' ').trim();
    if (flat === '' || flat === '{}') return '';
    const inner = flat.startsWith('{') && flat.endsWith('}') ? flat.slice(1, -1) : flat;
    // Предел велик намеренно: по ширине строку обрезает разметка, а этот предел лишь
    // не даёт положить в неё килобайты аргументов.
    return shorten(inner.replace(/"([A-Za-z_][\w]*)":/g, '$1: '), 200);
}

/**
 * Результат вызова в читаемом виде.
 *
 * В журнале он лежит строкой JSON — той, что получила модель. Показанная как есть, она
 * читается плохо: данные идут одной строкой с экранированными кавычками и переводами строк.
 * Поэтому объект и массив выводятся с отступами, а строка, закодированная в JSON,
 * разворачивается обратно — перевод строки должен остаться переводом строки, а не парой
 * символов. Усечённый результат не разбирается: оборванный JSON и не должен разбираться.
 *
 * Отказ инструмента разбирается отдельно: модели он приходит структурой из сообщения и
 * подсказки, а человеку нужен смысл, а не её устройство.
 */
function resultText(result: string, ok: boolean | undefined): string {
    if (ok === false) {
        try {
            const parsed = JSON.parse(result) as { message?: unknown; hint?: unknown };
            const parts = [parsed.message, parsed.hint].filter(
                (part): part is string => typeof part === 'string',
            );
            if (parts.length > 0) return parts.join('\n\n');
        } catch {
            // Отказ пришёл не в ожидаемом виде — показывается как есть.
        }
    }
    return readable(result);
}

/** Разворачивает JSON в читаемый вид; всё прочее оставляет без изменений. */
function readable(value: string): string {
    const trimmed = value.trim();
    const first = trimmed[0];
    if (first !== '{' && first !== '[' && first !== '"') return value;
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
    } catch {
        return value;
    }
}

type ToolWork = Extract<WorkItem, { kind: 'tool' }>;
type ReasoningWork = Extract<WorkItem, { kind: 'reasoning' }>;

/**
 * Строка ряда фонового элемента: вид, имя, приметы аргументов и величина у правого края.
 *
 * Оформление у вызова и размышления одно, иначе перечень действий читается как набор
 * разнородных карточек. Строка одна: имя не переносится и не обрезается, а место под него
 * освобождают аргументы — они приглушены и обрезаются, поскольку в свёрнутом виде служат лишь
 * приметой вызова. Величина у правого края не сжимается вовсе.
 *
 * Исход вызова передаётся цветом имени, а не отдельным значком: значок перед именем удлинял
 * строку и дублировал то, что и так читается по имени.
 */
function RowLine({
    outcome,
    icon,
    name,
    detail,
    meta,
}: {
    /** Исход вызова. У размышления и у незавершённого вызова отсутствует. */
    readonly outcome?: 'success' | 'danger';
    readonly icon: ReactNode;
    readonly name: string;
    /** Аргументы вызова в сокращённой записи. */
    readonly detail?: string;
    /** Длительность либо расход токенов. */
    readonly meta?: string;
}) {
    const { token } = theme.useToken();

    return (
        <Flex align="center" gap={token.marginXS} style={{ minWidth: 0, overflow: 'hidden' }}>
            {icon}
            {/* Имя не сжимается: сокращать следует приметы, а не то, по чему вызов опознают. */}
            <Typography.Text
                strong
                {...(outcome === undefined ? {} : { type: outcome })}
                style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            >
                {name}
            </Typography.Text>
            {detail === undefined || detail === '' ? null : (
                <Typography.Text
                    type="secondary"
                    style={{
                        flex: 1,
                        minWidth: 0,
                        fontFamily: token.fontFamilyCode,
                        fontSize: token.fontSizeSM,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    {detail}
                </Typography.Text>
            )}
            {meta === undefined ? null : (
                <Typography.Text
                    type="secondary"
                    style={{
                        flexShrink: 0,
                        whiteSpace: 'nowrap',
                        fontSize: token.fontSizeSM,
                        marginInlineStart: 'auto',
                    }}
                >
                    {meta}
                </Typography.Text>
            )}
        </Flex>
    );
}

/**
 * Вызов инструмента в свёрнутом виде: имя, окрашенное по исходу, приметы аргументов и
 * длительность.
 *
 * Пока вызов выполняется, на месте значка инструмента стоит указатель выполнения. Место
 * у них общее, поэтому по завершении строка не сдвигается.
 */
function ToolLine({ item }: { readonly item: ToolWork }) {
    const { token } = theme.useToken();
    const pending = item.result === undefined;

    return (
        <RowLine
            {...(pending ? {} : { outcome: item.ok === false ? 'danger' : 'success' })}
            icon={
                pending ? (
                    <LoadingOutlined />
                ) : (
                    <ToolOutlined style={{ color: token.colorTextTertiary }} />
                )
            }
            name={item.name}
            detail={compactArgs(item.rawArguments)}
            {...(item.durationMs === undefined ? {} : { meta: duration(item.durationMs) })}
        />
    );
}

/**
 * Вызов инструмента в раскрытом виде: аргументы и результат целиком. В обычном чтении они не
 * нужны, а при разборе раскрываются.
 */
function ToolDetails({ item }: { readonly item: ToolWork }) {
    const { token } = theme.useToken();

    return (
        <Flex vertical gap={token.marginXS}>
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                Аргументы
            </Typography.Text>
            <pre style={preStyle(token)}>
                {item.rawArguments === '' ? '{}' : readable(item.rawArguments)}
            </pre>

            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                Результат
            </Typography.Text>
            <pre
                style={{
                    ...preStyle(token),
                    ...(item.ok === false ? { color: token.colorError } : {}),
                }}
            >
                {item.result === undefined ? 'Выполняется…' : resultText(item.result, item.ok)}
            </pre>
        </Flex>
    );
}

/** Размышление модели: та же строка, что у вызова. Читается редко и бывает длинным. */
function ReasoningLine({ item }: { readonly item: ReasoningWork }) {
    const { token } = theme.useToken();

    return (
        <RowLine
            icon={<BulbOutlined style={{ color: token.colorTextTertiary }} />}
            name="Размышление"
            meta={`${item.tokens} ток.`}
        />
    );
}

/**
 * Перечень фоновых элементов: вызовов инструментов и размышлений.
 *
 * Ряды — панели одного Collapse, разделённые линией, а не отдельные блоки с промежутком между
 * ними: линия отделяет ряд от соседнего и при малом промежутке, и перечень читается как список.
 * Высота ряда равна высоте стандартного элемента управления.
 *
 * Блоку подписи в заголовке (`title`) задан `minWidth: 0`. Ant Design назначает ему `flex: auto`,
 * но автоматический минимум ширины не снимает, и блок не сжимается уже своего содержимого. Без
 * этого обрезка аргументов многоточием не срабатывала, а длинные аргументы выталкивали строку
 * за правый край вместе с длительностью.
 */
function WorkRows({ items }: { readonly items: readonly WorkItem[] }) {
    const { token } = theme.useToken();
    const divider = `${token.lineWidth}px ${token.lineType} ${token.colorBorderSecondary}`;

    return (
        <Collapse
            ghost
            size="small"
            styles={{
                header: {
                    alignItems: 'center',
                    minHeight: token.controlHeight,
                    paddingBlock: token.paddingXXS,
                },
                title: { minWidth: 0 },
                body: { padding: `0 ${token.paddingSM}px ${token.paddingSM}px` },
            }}
            items={items.map((item, index) => ({
                key: item.key,
                ...(index === 0 ? {} : { style: { borderTop: divider } }),
                label:
                    item.kind === 'tool' ? (
                        <ToolLine item={item} />
                    ) : (
                        <ReasoningLine item={item} />
                    ),
                children:
                    item.kind === 'tool' ? (
                        <ToolDetails item={item} />
                    ) : (
                        <Typography.Paragraph
                            type="secondary"
                            style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}
                        >
                            {item.text}
                        </Typography.Paragraph>
                    ),
            }))}
        />
    );
}

/**
 * Заголовок контейнера: сколько чего было сделано.
 *
 * Имена инструментов сюда не выносятся: в ходе их бывает десяток, перечень не помещается и
 * обрывается многоточием, ничего не сообщая. Имя видно в самом ряду, для того ряд и нужен.
 *
 * Подпись начинается со слова — «Вызовов: 4», а не «4 вызова»: подписи интерфейса начинаются
 * с заглавной буквы, а у подписи, начатой числом, её нет. Такая запись к тому же не требует
 * согласовывать слово с числом.
 */
function groupLabel(items: readonly WorkItem[]): string {
    const reasoning = items.filter((item) => item.kind === 'reasoning').length;
    const tools = items.filter((item) => item.kind === 'tool').length;

    const parts: string[] = [];
    if (reasoning > 0) parts.push(`размышлений: ${reasoning}`);
    if (tools > 0) parts.push(`вызовов: ${tools}`);
    return capitalize(parts.join(', '));
}

/**
 * Контейнер действий агента.
 *
 * Раскрытием распоряжается только пользователь. Прежде контейнер раскрывался сам, пока
 * что-то выполнялось, и сворачивался по завершении — то есть на каждой пачке вызовов
 * менял высоту дважды, смещая всё, что ниже, и сбивая прокрутку. Ход работы виден и по
 * заголовку: он несёт указатель выполнения и счётчики, которые пополняются без раскрытия.
 *
 * Изначально контейнер свёрнут: в обычном чтении важен ответ, а не перечень шагов. Поле
 * раскрытого контейнера лишено отступов, чтобы линии между рядами доходили до его рамки.
 */
function WorkGroupItem({ group }: { readonly group: WorkGroup }) {
    const { token } = theme.useToken();
    const [open, setOpen] = useState(false);

    const pending = group.items.some((item) => item.kind === 'tool' && item.result === undefined);
    const failed = group.items.some((item) => item.kind === 'tool' && item.ok === false);
    const total = group.items.reduce(
        (sum, item) => sum + (item.kind === 'tool' ? (item.durationMs ?? 0) : 0),
        0,
    );

    return (
        <Collapse
            size="small"
            activeKey={open ? [group.key] : []}
            onChange={(keys) => setOpen((Array.isArray(keys) ? keys : [keys]).includes(group.key))}
            styles={{ title: { minWidth: 0 }, body: { padding: 0 } }}
            items={[
                {
                    key: group.key,
                    label: (
                        <Flex align="center" gap={token.marginXS} style={{ minWidth: 0 }}>
                            {pending ? (
                                <LoadingOutlined />
                            ) : failed ? (
                                <CloseCircleOutlined style={{ color: token.colorError }} />
                            ) : (
                                <ClusterOutlined style={{ color: token.colorTextTertiary }} />
                            )}
                            <Typography.Text type="secondary" ellipsis>
                                {groupLabel(group.items)}
                            </Typography.Text>
                            {total === 0 ? null : (
                                <Typography.Text
                                    type="secondary"
                                    style={{
                                        flexShrink: 0,
                                        whiteSpace: 'nowrap',
                                        fontSize: token.fontSizeSM,
                                        marginInlineStart: 'auto',
                                    }}
                                >
                                    {duration(total)}
                                </Typography.Text>
                            )}
                        </Flex>
                    ),
                    children: <WorkRows items={group.items} />,
                },
            ]}
        />
    );
}

/**
 * Один ход: вопрос пользователя, работа агента и ответ.
 *
 * Текст модели показывается на общем уровне независимо от того, пришёл он вместе с вызовами
 * инструментов или отдельным итоговым сообщением: и то и другое адресовано человеку.
 */
export function TurnBlockView({ turn }: { readonly turn: Turn }) {
    const { token } = theme.useToken();
    const hasContent = turn.items.length > 0 || turn.failure !== undefined;

    // Сводка показывается у завершённого хода любым исходом: неудачный ход тоже обращался к
    // модели и расходовал токены. Токены — сумма входных и выходных по всем ответам хода.
    // Подпись начинается со слова, а не с числа — по той же причине, что и заголовок
    // контейнера действий (см. groupLabel).
    const facts = turn.running
        ? []
        : [
              turn.durationMs === undefined ? null : `время: ${duration(turn.durationMs)}`,
              turn.usage === undefined
                  ? null
                  : `токенов: ${(turn.usage.prompt + turn.usage.completion).toLocaleString('ru')}`,
          ].filter((fact): fact is string => fact !== null);
    const summary =
        facts.length === 0 ? null : (
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                {capitalize(facts.join(' · '))}
            </Typography.Text>
        );

    return (
        <Flex vertical gap={token.margin}>
            {/* Сообщение пользователя ограничено по ширине: короткая реплика во всю строку
                читается хуже, а различие в ширине само по себе отделяет вопрос от ответа.
                Предел назначен блоку целиком, а не его содержимому: содержимое размещается
                внутри блока от начала, поэтому ограничение изнутри оставило бы пустое место
                справа и отодвинуло реплику от края. */}
            <Bubble
                placement="end"
                content={turn.question}
                avatar={<Avatar icon={<UserOutlined />} />}
                variant="filled"
                style={{ maxWidth: '66%' }}
            />

            {/* Ответ агента занимает всю ширину колонки независимо от объёма: он содержит
                таблицы, графики и сворачиваемые блоки, ширина которых не должна зависеть от
                длины текста, а переменная ширина ответов делает переписку неровной. */}
            <Bubble
                placement="start"
                avatar={<Avatar icon={<RobotOutlined />} style={{ background: token.colorPrimary }} />}
                variant="outlined"
                loading={!hasContent && turn.running}
                footer={summary}
                className="weragen-bubble-wide"
                style={{ width: '100%' }}
                styles={{ content: { flex: 1, minWidth: 0 } }}
                content={
                    <Flex vertical gap={token.marginSM} style={{ minWidth: 0 }}>
                        {turn.items.map((item) =>
                            item.kind === 'text' ? (
                                <MarkdownText key={item.key} text={item.text} />
                            ) : item.kind === 'chart' ? (
                                <ChartView key={item.key} chart={item.chart} />
                            ) : item.kind === 'child' ? (
                                <ChildSessionCard
                                    key={item.key}
                                    childId={item.childId}
                                    childKind={item.childKind}
                                    title={item.title}
                                />
                            ) : item.kind === 'group' ? (
                                <WorkGroupItem key={item.key} group={item} />
                            ) : (
                                <WorkRows key={item.key} items={[item]} />
                            ),
                        )}

                        {/* Ожидание ответа модели показывается указателем, а не отдельной записью. */}
                        {turn.awaitingModel && hasContent ? (
                            <Spin size="small" style={{ alignSelf: 'flex-start' }} />
                        ) : null}

                        {turn.failure !== undefined ? (
                            <Alert
                                type={turn.failure.reason === 'aborted' ? 'warning' : 'error'}
                                showIcon
                                message={`Ход не завершён — ${failureLabel[turn.failure.reason]}`}
                                description={turn.failure.message}
                            />
                        ) : null}
                    </Flex>
                }
            />
        </Flex>
    );
}
