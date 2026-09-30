import {
    chartArgumentsSchema,
    toolResultFailed,
    type ChartArguments,
    type SessionEvent,
    type SessionKind,
    type TurnFailureReason,
} from '@weragen/types';

/**
 * Ход в форме, удобной для отрисовки.
 *
 * Журнал — плоская последовательность событий, а интерфейс показывает переписку. Порядок
 * элементов внутри хода сохраняется журнальным: текст модели, вызовы инструментов и
 * размышление идут так, как происходили.
 *
 * Обращение к модели отдельным элементом не показывается. Само по себе оно ничего не
 * сообщает: пока ответа нет, достаточно указателя ожидания, а когда ответ пришёл — важен
 * он сам, а не факт обращения.
 */

/** Элемент работы агента: размышление либо вызов инструмента. Текста человеку не несёт. */
export type WorkItem =
    | { readonly kind: 'reasoning'; readonly key: string; readonly text: string; readonly tokens: number }
    | {
          readonly kind: 'tool';
          readonly key: string;
          readonly name: string;
          readonly rawArguments: string;
          result?: string;
          ok?: boolean;
          durationMs?: number;
      };

/**
 * Группа подряд идущих элементов работы — контейнер действий агента.
 *
 * Образуется с первого же элемента, а не со второго. Иначе при появлении второго элемента
 * одиночный блок заменялся бы группой, то есть другим типом узла: React разбирал бы старый
 * узел и строил новый, теряя раскрытие, сделанное пользователем, и смещая содержимое.
 * Контейнер должен только пополняться, поэтому он один и тот же с самого начала.
 */
export type WorkGroup = { readonly kind: 'group'; readonly key: string; readonly items: WorkItem[] };

/** Текст модели, адресованный человеку. */
export type TextItem = { readonly kind: 'text'; readonly key: string; readonly text: string };

/** Построенный график. Появляется вместо записи о вызове, когда вызов удался. */
export type ChartItem = { readonly kind: 'chart'; readonly key: string; readonly chart: ChartArguments };

/**
 * Порождённая дочерняя сессия. Показывается ссылкой, раскрывающей её журнал: вложенность
 * существует только в отрисовке, а читается дочерняя сессия теми же запросами, что и любая
 * другая.
 */
export type ChildItem = {
    readonly kind: 'child';
    readonly key: string;
    readonly childId: string;
    readonly childKind: SessionKind;
    readonly title: string;
};

export type TurnItem = WorkItem | WorkGroup | TextItem | ChartItem | ChildItem;

/**
 * Содержательный элемент несёт ответ и читается сам по себе; фоновый показывает, каким путём
 * агент к ответу пришёл.
 *
 * Различение нужно свёртке: фоновые элементы прячутся под общий заголовок, а содержательный
 * внутри свёрнутой группы оказался бы не показан вовсе. Признак определяется видом элемента,
 * а не именем инструмента: инструментов со временем станет много, и перечень имён здесь
 * пришлось бы править при добавлении каждого.
 */
export function isSubstantive(item: TurnItem): item is TextItem | ChartItem | ChildItem {
    return item.kind === 'text' || item.kind === 'chart' || item.kind === 'child';
}

/**
 * Расход токенов по данным провайдера. Входные — запросы к модели: каждый несёт переписку
 * целиком, поэтому их сумма растёт быстрее контекста. Выходные — ответы вместе с рассуждением.
 */
export type TokenUsage = { readonly prompt: number; readonly completion: number };

export type TurnBlock = {
    readonly key: number;
    readonly question: string;
    readonly items: TurnItem[];
    /**
     * Расход хода — сумма по ответам модели. Отсутствует, пока ни одного ответа не пришло:
     * нулевой расход утверждал бы, что обращение ничего не стоило, а это неизвестно.
     */
    usage?: TokenUsage;
    /** Длительность хода. Известна по завершении; у неудачных ходов старых журналов её нет. */
    durationMs?: number;
    failure?: { readonly reason: TurnFailureReason; readonly message: string };
    /** Ход ещё идёт: итогового события не было. */
    running: boolean;
    /** Ожидается ответ модели: шаг начат, но от модели ещё ничего не пришло. */
    awaitingModel: boolean;
};

/**
 * Ключ вызова инструмента.
 *
 * Одного `callId` недостаточно: часть моделей возвращает вместо идентификатора имя
 * инструмента, и тогда все вызовы одного инструмента в ходе получают одинаковый ключ. Шаг
 * и порядковый номер в пачке делают ключ различимым при любом поведении провайдера.
 */
const callKey = (step: number, batchIndex: number, callId: string): string =>
    `${step}:${batchIndex}:${callId}`;

/** Инструмент, удавшийся вызов которого показывается графиком, а не записью о вызове. */
const CHART_TOOL = 'render_chart';

/**
 * Разбор аргументов графика.
 *
 * Аргументы разбираются повторно, хотя сервер их уже принял: журнал хранит строку, которую
 * прислала модель, и восстановление переписки идёт только из журнала. Если разбор не удался,
 * элемент остаётся обычной записью о вызове — показать нечего, но и потерять его нельзя.
 */
function parseChart(rawArguments: string): ChartArguments | undefined {
    try {
        const parsed = chartArgumentsSchema.safeParse(JSON.parse(rawArguments));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

export function groupTurns(events: readonly SessionEvent[]): TurnBlock[] {
    const turns: TurnBlock[] = [];
    let current: TurnBlock | undefined;

    for (const event of events) {
        if (event.type === 'user_message') {
            current = {
                key: event.seq,
                question: event.text,
                items: [],
                running: true,
                awaitingModel: false,
            };
            turns.push(current);
            continue;
        }
        if (current === undefined) continue;

        switch (event.type) {
            case 'step_started':
                // Ответ модели ещё не получен: до его прихода показывается только ожидание.
                current.awaitingModel = true;
                break;

            case 'model_reply':
                current.awaitingModel = false;
                current.usage = {
                    prompt: (current.usage?.prompt ?? 0) + event.promptTokens,
                    completion: (current.usage?.completion ?? 0) + event.completionTokens,
                };
                if (event.reasoning !== undefined) {
                    current.items.push({
                        kind: 'reasoning',
                        key: `r-${event.seq}`,
                        text: event.reasoning,
                        tokens: event.completionTokens,
                    });
                }
                break;

            // Устаревшее событие: читается в журналах, записанных до появления `model_reply`.
            case 'assistant_reasoning':
                current.awaitingModel = false;
                current.items.push({
                    kind: 'reasoning',
                    key: `r-${event.seq}`,
                    text: event.text,
                    tokens: event.tokens,
                });
                break;

            // Текст, пришедший вместе с вызовами, и итоговый ответ — одно и то же с точки
            // зрения чтения: и то и другое модель адресует человеку.
            case 'assistant_note':
            case 'assistant_message':
                current.awaitingModel = false;
                if (event.text !== '') {
                    current.items.push({ kind: 'text', key: `t-${event.seq}`, text: event.text });
                }
                break;

            case 'tool_call':
                current.awaitingModel = false;
                current.items.push({
                    kind: 'tool',
                    key: callKey(event.step, event.batchIndex, event.callId),
                    name: event.name,
                    rawArguments: event.rawArguments,
                });
                break;

            case 'tool_result': {
                const key = callKey(event.step, event.batchIndex, event.callId);
                const index = current.items.findIndex(
                    (candidate) => candidate.kind === 'tool' && candidate.key === key,
                );
                const item = current.items[index] as Extract<TurnItem, { kind: 'tool' }> | undefined;
                if (item === undefined) break;

                item.result = event.content;
                // Исход читается помощником, а не полем события: в журналах, записанных до
                // появления поля `kind`, он выражен признаком `ok`.
                item.ok = !toolResultFailed(event);
                item.durationMs = event.durationMs;

                // Удавшееся построение графика замещает запись о вызове: данные целиком
                // находятся в аргументах, а результат сообщает лишь о том, что они приняты.
                if (item.ok && event.name === CHART_TOOL) {
                    const chart = parseChart(item.rawArguments);
                    if (chart !== undefined) current.items[index] = { kind: 'chart', key, chart };
                }
                break;
            }

            case 'child_session_started':
                current.awaitingModel = false;
                current.items.push({
                    kind: 'child',
                    key: `c-${event.seq}`,
                    childId: event.childId,
                    childKind: event.kind,
                    title: event.title,
                });
                break;

            case 'turn_finished':
                // Суммы в самом событии устарели: они есть только в журналах, записанных до
                // появления `model_reply`, и берутся лишь тогда, когда ответов в ходе нет.
                if (current.usage === undefined && event.promptTokens !== undefined) {
                    current.usage = {
                        prompt: event.promptTokens,
                        completion: event.completionTokens ?? 0,
                    };
                }
                current.durationMs = event.durationMs;
                current.running = false;
                current.awaitingModel = false;
                break;

            case 'turn_failed':
                current.failure = { reason: event.reason, message: event.message };
                if (event.durationMs !== undefined) current.durationMs = event.durationMs;
                current.running = false;
                current.awaitingModel = false;
                break;
        }
    }

    return turns.map((turn) => ({ ...turn, items: groupWork(turn.items) }));
}

/**
 * Сводит подряд идущие элементы работы в контейнер действий.
 *
 * Содержательный элемент последовательность разрывает: он адресован человеку и разделяет
 * этапы работы по смыслу.
 *
 * Ключ контейнера строится по первому его элементу и потому не меняется, сколько бы
 * элементов ни добавилось следом. Это существенно: ход отрисовывается заново на каждое
 * событие журнала, и только неизменный ключ позволяет React считать контейнер тем же
 * узлом — иначе раскрытие, сделанное пользователем, терялось бы при каждом новом действии.
 */
function groupWork(items: readonly TurnItem[]): TurnItem[] {
    const result: TurnItem[] = [];
    let run: WorkItem[] = [];

    const flush = (): void => {
        if (run.length === 0) return;
        result.push({ kind: 'group', key: `g-${run[0]!.key}`, items: run });
        run = [];
    };

    for (const item of items) {
        if (item.kind === 'group' || isSubstantive(item)) {
            flush();
            result.push(item);
        } else {
            run.push(item);
        }
    }

    flush();
    return result;
}

/** Идёт ли сейчас ход. Признак берётся из журнала: он приходит раньше обновления списка. */
export function isRunning(turns: readonly TurnBlock[]): boolean {
    return turns.at(-1)?.running ?? false;
}

/** Число завершённых ходов, каким бы ни был исход. */
export function completedCount(turns: readonly TurnBlock[]): number {
    return turns.filter((turn) => !turn.running).length;
}

/** Расход за сессию: сумма по ходам. */
export function totalUsage(turns: readonly TurnBlock[]): TokenUsage {
    let prompt = 0;
    let completion = 0;
    for (const turn of turns) {
        prompt += turn.usage?.prompt ?? 0;
        completion += turn.usage?.completion ?? 0;
    }
    return { prompt, completion };
}
