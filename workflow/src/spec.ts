import { Data, type Effect } from 'effect';
import { z } from 'zod';
import type { WorkflowRequirements, WorkflowSpec } from '@weragen/types';
import type { WorkflowContext } from './context.js';

/**
 * Объявление воркфлоу.
 *
 * Воркфлоу — отдельная программа с собственной предметной логикой и собственным
 * состоянием. Платформа предоставляет ей исполнение агентских сессий, единую точку
 * обращения к моделям и наблюдаемость; сама она агентских циклов не ведёт и инструментов
 * не предоставляет, а лишь заявляет, какие ей требуются.
 *
 * Точка входа — функция `run`. Точка выхода — её результат: значение означает успех,
 * отказ `WorkflowFailure` — неудачу. Возвращать управление иначе не нужно: об исходе
 * платформе сообщает сам пакет.
 */

/**
 * Отказ исполнения. Это объявленный исход, а не дефект: он доходит до платформы причиной
 * отказа и до вызывающей стороны — текстом. Непойманное исключение тоже завершит
 * исполнение отказом, но с менее внятным сообщением.
 */
export class WorkflowFailure extends Data.TaggedError('WorkflowFailure')<{
    readonly message: string;
}> {}

export type WorkflowDefinition<Input = unknown, Result = unknown> = {
    /** Имя, по которому воркфлоу запускается. Должно совпадать с именем карточки реестра. */
    readonly name: string;
    readonly version: string;
    /** Название для интерфейса. */
    readonly title: string;
    readonly description?: string;
    /**
     * Схема входного объекта. Служит и проверкой входа, и описанием для платформы:
     * по ней строится форма ручного запуска и описание инструмента, которым воркфлоу
     * запускается из агентской сессии.
     */
    readonly input: z.ZodType<Input>;
    /** Что требуется от платформы. Сверяется при регистрации по совпадению имён. */
    readonly requires?: Partial<WorkflowRequirements>;
    readonly run: (
        input: Input,
    ) => Effect.Effect<Result, WorkflowFailure, WorkflowContext>;
};

/**
 * Объявляет воркфлоу. Функция ничего не делает, кроме придания типам определённости:
 * без неё вывод типа входа из схемы в теле `run` не работает.
 */
export function defineWorkflow<Input, Result>(
    definition: WorkflowDefinition<Input, Result>,
): WorkflowDefinition<Input, Result> {
    return definition;
}

/** Спецификация в том виде, в каком её запрашивает платформа. */
export function specOf<Input, Result>(definition: WorkflowDefinition<Input, Result>): WorkflowSpec {
    return {
        name: definition.name,
        version: definition.version,
        title: definition.title,
        description: definition.description ?? '',
        input: z.toJSONSchema(definition.input, { io: 'input' }) as Record<string, unknown>,
        requires: {
            tools: definition.requires?.tools ?? [],
            mcp: definition.requires?.mcp ?? [],
            models: definition.requires?.models ?? [],
        },
    };
}
