import { Effect } from 'effect';
import { z } from 'zod';
import type { ToolOutcome, ToolSource } from '@weragen/types';

/**
 * Инструмент агента: единое описание для модели плюс функция исполнения.
 *
 * Схема аргументов служит двум целям сразу — проверке входа и порождению JSON Schema для
 * модели. У собственного инструмента она задаётся zod, и одно объявление заменяет два
 * рассогласовывающихся. У инструмента внешнего сервера схема уже является JSON Schema, и
 * обратного преобразования в zod не существует, поэтому обе формы приводятся к общему типу
 * `ToolInput` — `zodInput` для первой, `rawInput` для второй.
 *
 * Приведение выполняется в объявлении инструмента, а не при использовании. Порождение
 * JSON Schema обходит схему целиком, тогда как набор инструментов собирается на каждый ход,
 * а `check` требуется на каждый вызов: приведение при использовании вычисляло бы схему
 * заново там, где нужна только проверка, и на каждый ход заново там, где схема неизменна.
 */
export type AgentTool<Input = unknown> = {
    readonly name: string;
    /** Текст, который видит модель. От его точности прямо зависит доля неверных вызовов. */
    readonly description: string;
    readonly input: ToolInput<Input>;
    /**
     * Откуда инструмент взялся. Нужен журналу, интерфейсу и трассировке. Отсутствие
     * означает встроенный инструмент: их большинство, и помечать каждый незачем.
     */
    readonly source?: ToolSource;
    readonly execute: (input: Input) => Effect.Effect<unknown, ToolFailure>;
};

/** Инструмент с произвольным типом входа — для реестров и обобщённых функций. */
export type AnyAgentTool = AgentTool<never>;

/**
 * Схема аргументов в форме, пригодной обеим целям.
 *
 * `jsonSchema` уходит модели, `check` проверяет пришедшее от неё. Разделение позволяет
 * инструменту внешнего сервера предъявить полученную схему, ничего о ней не зная.
 */
export type ToolInput<Input = unknown> = {
    readonly jsonSchema: Record<string, unknown>;
    readonly check: (raw: unknown) => ToolInputCheck<Input>;
};

export type ToolInputCheck<Input> =
    | { readonly ok: true; readonly value: Input }
    | { readonly ok: false; readonly problems: string };

/**
 * Схема собственного инструмента. Проверка схемой даёт структурное описание несоответствия
 * — путь до поля, ожидаемый тип, полученное значение, — которое переводится в подсказку
 * модели почти без обработки.
 */
export function zodInput<Input>(schema: z.ZodType<Input>): ToolInput<Input> {
    return {
        jsonSchema: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>,
        check: (raw) => {
            const parsed = schema.safeParse(raw);
            if (parsed.success) return { ok: true, value: parsed.data };
            return {
                ok: false,
                problems: parsed.error.issues
                    .map((issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`)
                    .join('; '),
            };
        },
    };
}

/**
 * Схема, полученная извне готовой JSON Schema.
 *
 * Проверка сводится к требованию объекта. Разбор произвольной JSON Schema потребовал бы
 * отдельной библиотеки, а внешний сервер проверяет вход сам и возвращает описание
 * несоответствия — оно и попадёт модели отказом инструмента. Лишний обмен на неверном
 * вызове здесь дешевле постоянной поддержки второго средства проверки.
 */
export function rawInput(jsonSchema: Record<string, unknown>): ToolInput<unknown> {
    return {
        jsonSchema,
        check: (raw) => {
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
                return { ok: false, problems: '(корень): ожидается объект аргументов' };
            }
            return { ok: true, value: raw };
        },
    };
}

/**
 * Отказ инструмента. Это штатный исход, а не дефект: он возвращается модели результатом
 * вызова, чтобы та исправилась на следующем шаге. Поэтому текст пишется для модели как для
 * адресата и содержит предписание, а не только констатацию.
 */
export class ToolFailure {
    readonly _tag = 'ToolFailure';
    constructor(
        readonly message: string,
        readonly hint?: string,
    ) {}
}

/**
 * Текст произвольной причины отказа.
 *
 * Объявлен здесь, а не повторён в каждом месте перехвата: причина приходит типом `unknown`,
 * и приведение её к тексту одинаково у собственного инструмента, у инструмента внешнего
 * сервера и у дефекта.
 */
export function describeCause(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Преобразователь причины в отказ инструмента — для поля `catch` в `Effect.tryPromise`.
 *
 * Нужен потому, что `Effect.promise` объявляет обещание неотклоняемым, и отказ обращения к
 * базе данных либо к внешней службе становится дефектом: модель получает текст исключения
 * без указания, что делать дальше, а платформа записывает его как ошибку в своём коде.
 * Обращение, способное отказать, объявляется через `tryPromise` с этим преобразователем, и
 * тогда отказ доходит до модели штатным исходом с подсказкой.
 */
export function toolFailure(
    summary: string,
    hint?: string,
): (cause: unknown) => ToolFailure {
    return (cause) => new ToolFailure(`${summary}: ${describeCause(cause)}`, hint);
}

/**
 * Результат вызова инструмента — единый тип для всех классов исхода.
 *
 * Класс исхода задаётся полем `kind` обязательно: отказ до исполнения (несуществующее имя,
 * неразобранные аргументы, несоответствие схеме), штатный отказ инструмента и дефект
 * требуют разной реакции и наблюдаются по-разному, а сведённые в двоичный признак
 * различимы только разбором текста.
 */
export type ToolResult = {
    readonly kind: ToolOutcome;
    /**
     * Текст, уходящий модели сообщением роли `tool` и в журнал сессии. У отказа это объект
     * с полями `error`, `message` и `hint`, построенный `formatToolError`.
     */
    readonly content: string;
    /**
     * Подробность исхода для наблюдения: текст отказа без обрамления, а у дефекта — текст
     * исключения. Ни модели, ни в журнал сессии не уходит: исключение адресовано
     * разработчику и содержит подробности устройства платформы.
     */
    readonly detail?: string;
};

/** Описание инструмента в форме, которую принимает OpenAI-совместимый API. */
export type ToolSpec = {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
};

export function toolSpec(tool: AgentTool<never>): ToolSpec {
    return {
        name: tool.name,
        description: tool.description,
        parameters: tool.input.jsonSchema,
    };
}

/** Единый вид ошибки, возвращаемой модели результатом вызова. */
export function formatToolError(message: string, hint?: string): string {
    return JSON.stringify({ error: true, message, ...(hint === undefined ? {} : { hint }) });
}
