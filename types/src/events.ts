import { z } from 'zod';
import { sessionKindSchema } from './session.js';
import { spanAttributesSchema, workflowStepStateSchema } from './workflow.js';

/**
 * События сессии — перечень того, что фактически произошло, записями с порядковым номером.
 *
 * Это не то же самое, что массив сообщений, отправляемый модели. Массив подчиняется формату
 * API и со временем перестаёт соответствовать происходившему: история сжимается, старые
 * результаты сворачиваются, крупные заменяются ссылками. Журнал остаётся полным, и массив
 * сообщений строится из него, а не наоборот.
 */

/** Исходы неудачного хода. Различаются потому, что требуют разной реакции. */
export const turnFailureReasonSchema = z.enum([
    /** Отказ на стороне провайдера модели. */
    'model_error',
    /** Сработало ограничение числа шагов: задача слишком велика для одного хода. */
    'step_limit',
    /** Модель израсходовала выходной бюджет, не сформировав ответ. */
    'output_limit',
    /** Прерывание по команде пользователя. */
    'aborted',
    /** Дефект платформы либо остановка сервера посреди хода. */
    'internal',
]);
export type TurnFailureReason = z.infer<typeof turnFailureReasonSchema>;

/**
 * Исход вызова инструмента.
 *
 * Заменяет двоичный признак успеха: сведённые в него отказы требуют разной реакции и
 * разбираются по-разному. Несуществующее имя и несоответствие аргументов схеме означают
 * неверный вызов, который модель способна исправить; отказ инструмента описан им самим;
 * дефект есть ошибка платформы, исправить которую вызовом нельзя.
 */
export const toolOutcomeSchema = z.enum([
    /** Вызов исполнен, результат возвращён модели. */
    'ok',
    /** Инструмента с таким именем в наборе хода нет. */
    'unknown_tool',
    /** Аргументы вызова не разобраны как JSON. */
    'bad_arguments',
    /** Аргументы разобраны, но не соответствуют схеме инструмента. */
    'schema_mismatch',
    /** Инструмент отказал штатно и объяснил причину. */
    'tool_failure',
    /** Дефект платформы: необъявленное исключение при исполнении вызова. */
    'defect',
]);
export type ToolOutcome = z.infer<typeof toolOutcomeSchema>;

const base = { seq: z.number().int().positive(), at: z.string() };

export const sessionEventSchema = z.discriminatedUnion('type', [
    z.object({ ...base, type: z.literal('user_message'), text: z.string() }),
    /**
     * Начало шага. Записывается до обращения к модели, поэтому по журналу видно, что ход
     * идёт, ещё до того как модель ответит: обращение к модели занимает почти всё время
     * хода, а исполнение инструментов — единицы миллисекунд.
     *
     * Событие одно на шаг, а не пара вокруг каждого обращения: обращение к модели идёт
     * первым действием шага, поэтому начало шага совпадает с началом обращения.
     */
    z.object({
        ...base,
        type: z.literal('step_started'),
        step: z.number().int().positive(),
        maxSteps: z.number().int().positive(),
        /**
         * Модель, к которой обращается этот шаг. Записывается в каждый шаг, а не только в
         * сессию: модель сессии можно сменить между ходами, и без отметки на шаге стало бы
         * невозможно понять, какой моделью получен конкретный ответ.
         */
        model: z.string(),
        /**
         * Снимок постоянной части запроса — системного промпта и описаний инструментов, — с
         * которой шаг обращается к модели. Сами описания хранятся отдельно, одной записью на
         * одинаковое содержимое: в журнале они повторялись бы на каждом шаге. Отсутствует в
         * журналах, записанных до появления снимков.
         */
        snapshotId: z.string().optional(),
    }),
    /**
     * Ответ модели на обращение шага. Записывается после каждого обращения, чем бы оно ни
     * закончилось — вызовами, текстом или исчерпанием выходного бюджета, — поэтому расход
     * сохраняется и у хода, завершившегося неудачей.
     *
     * Единственный источник сведений о расходе токенов: суммы по ходу и по сессии
     * складываются из этих событий. Текст ответа и вызовы сюда не входят — их несут
     * `assistant_note`, `tool_call` и `assistant_message`.
     */
    z.object({
        ...base,
        type: z.literal('model_reply'),
        step: z.number().int().positive(),
        /** Входные токены по данным провайдера: размер запроса целиком. */
        promptTokens: z.number().int().nonnegative(),
        /** Выходные токены по данным провайдера, включая рассуждение. */
        completionTokens: z.number().int().nonnegative(),
        /** Причина остановки генерации по данным провайдера: `stop`, `tool_calls`, `length`. */
        finishReason: z.string().optional(),
        /** Рассуждение модели. В диалог не возвращается: модель не ждёт его обратно. */
        reasoning: z.string().optional(),
    }),
    /**
     * Рассуждение модели.
     *
     * @deprecated Рассуждение и расход записываются событием `model_reply`. Событие
     * читается только в журналах, записанных до его появления.
     */
    z.object({
        ...base,
        type: z.literal('assistant_reasoning'),
        step: z.number().int().positive(),
        text: z.string(),
        tokens: z.number().int().nonnegative(),
    }),
    z.object({
        ...base,
        type: z.literal('assistant_note'),
        step: z.number().int().positive(),
        text: z.string(),
    }),
    z.object({
        ...base,
        type: z.literal('tool_call'),
        callId: z.string(),
        name: z.string(),
        rawArguments: z.string(),
        step: z.number().int().positive(),
        batchSize: z.number().int().positive(),
        batchIndex: z.number().int().positive(),
    }),
    z.object({
        ...base,
        type: z.literal('tool_result'),
        callId: z.string(),
        name: z.string(),
        /**
         * Исход вызова. Отсутствует в журналах, записанных до его появления: там исход
         * выражен признаком `ok`, и различить в них класс отказа нельзя.
         */
        kind: toolOutcomeSchema.optional(),
        /**
         * @deprecated Заменён полем `kind`, различающим классы отказа. Заполнен только в
         * журналах, записанных до его появления. Для проверки исхода следует применять
         * `toolResultFailed`: она читает журналы обоих поколений.
         */
        ok: z.boolean().optional(),
        content: z.string(),
        durationMs: z.number().int().nonnegative(),
        step: z.number().int().positive(),
        batchSize: z.number().int().positive(),
        batchIndex: z.number().int().positive(),
    }),
    z.object({ ...base, type: z.literal('assistant_message'), text: z.string() }),
    z.object({
        ...base,
        type: z.literal('turn_finished'),
        steps: z.number().int().nonnegative(),
        toolCalls: z.number().int().nonnegative(),
        /**
         * @deprecated Расход хода складывается из событий `model_reply`. Поле заполнено
         * только в журналах, записанных до их появления.
         */
        promptTokens: z.number().int().nonnegative().optional(),
        /** @deprecated См. `promptTokens`. */
        completionTokens: z.number().int().nonnegative().optional(),
        durationMs: z.number().int().nonnegative(),
    }),
    z.object({
        ...base,
        type: z.literal('turn_failed'),
        reason: turnFailureReasonSchema,
        message: z.string(),
        /**
         * Длительность хода до отказа. Отсутствует в журналах, записанных до её появления, и у
         * хода, прерванного остановкой сервера: момент остановки неизвестен.
         */
        durationMs: z.number().int().nonnegative().optional(),
    }),

    /**
     * Порождена дочерняя сессия. Событие записывается в журнал родителя и несёт только
     * идентификатор: содержимое дочерней сессии читается её собственным журналом теми же
     * запросами, что и любая другая. Вложенность существует в отрисовке, а не в хранении.
     */
    z.object({
        ...base,
        type: z.literal('child_session_started'),
        childId: z.string(),
        kind: sessionKindSchema,
        title: z.string(),
    }),

    /**
     * Начало исполнения воркфлоу с входным объектом. Записывается платформой до порождения
     * процесса, поэтому по журналу видно, с чем исполнение было запущено, даже если процесс
     * не поднялся вовсе.
     */
    z.object({
        ...base,
        type: z.literal('workflow_started'),
        workflowName: z.string(),
        version: z.string().nullable(),
        input: z.unknown(),
    }),

    /**
     * Шаг воркфлоу. Приходит от внешнего процесса и служит наблюдению: платформа по этим
     * событиям состояние воркфлоу не восстанавливает, поэтому пропуск сообщения не делает
     * журнал недействительным.
     */
    z.object({
        ...base,
        type: z.literal('workflow_step'),
        stepId: z.string(),
        name: z.string(),
        state: workflowStepStateSchema,
        parentStepId: z.string().optional(),
        /**
         * Время по часам воркфлоу. Отличается от `at`, где записан момент получения
         * сообщения: по нему считается длительность спана, и задержка сети в неё не входит.
         */
        startedAt: z.string(),
        durationMs: z.number().int().nonnegative().optional(),
        detail: z.string().optional(),
        attributes: spanAttributesSchema.optional(),
    }),

    /** Завершение сессии видов `workflow` и `agent`. Чат-сессия его не достигает. */
    z.object({ ...base, type: z.literal('session_completed'), result: z.unknown() }),
    z.object({ ...base, type: z.literal('session_failed'), message: z.string() }),
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventType = SessionEvent['type'];

/**
 * Событие без порядкового номера и времени — их проставляет журнал при записи.
 * `Omit` применяется к каждому члену объединения по отдельности, иначе оно схлопнулось бы
 * до общих полей.
 */
/**
 * Отказал ли вызов инструмента.
 *
 * Читает оба поколения журналов: в записанных до появления `kind` исход выражен признаком
 * `ok`. Отсутствие обоих полей считается успехом — событие результата записывается только
 * после того, как исход известен.
 */
export function toolResultFailed(result: {
    readonly kind?: ToolOutcome;
    readonly ok?: boolean;
}): boolean {
    if (result.kind !== undefined) return result.kind !== 'ok';
    return result.ok === false;
}

export type SessionEventInput = SessionEvent extends infer T
    ? T extends SessionEvent
        ? Omit<T, 'seq' | 'at'>
        : never
    : never;
