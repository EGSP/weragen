import { z } from 'zod';
import type { ToolSpec } from './tool.js';

/**
 * Терминальные инструменты.
 *
 * Признак «ответ без вызовов инструментов» как условие завершения недостаточен по двум
 * противоположным причинам. Модель останавливается раньше времени, объявив словами, что
 * собирается делать дальше, — формально ход завершён, фактически задача брошена. И модель
 * не останавливается тогда, когда следовало: задаёт уточняющий вопрос обычным текстом, а
 * программа продолжает цикл, и модель отвечает сама себе.
 *
 * Оба инструмента ничего не исполняют. Они существуют затем, чтобы модель объявила, чем
 * закончила, явно. Поэтому и обрабатываются они в цикле, а не в реестре инструментов:
 * реестр предоставляет действия, а эти два — способ завершиться.
 */

export const ATTEMPT_COMPLETION = 'attempt_completion';
export const ASK_USER = 'ask_user';

/**
 * Дисциплина завершения хода.
 *
 * `chat` — доступны оба инструмента, и терминальный вызов завершает ход; сессия при этом
 * продолжается и ожидает следующего сообщения. `task` — доступен только
 * `attempt_completion`, потому что спрашивать некого, и тот же вызов завершает сессию
 * целиком. Механизм один, различается область его действия.
 */
export type CompletionMode = 'chat' | 'task';

/** Чем завершился ход. */
export type TurnFinish = 'completion' | 'question' | 'plain';

const completionArguments = z.object({
    text: z
        .string()
        .min(1)
        .describe('Итоговый ответ целиком. Это единственный текст, который увидит адресат'),
});

const questionArguments = z.object({
    text: z.string().min(1).describe('Вопрос пользователю, на который нужен ответ для продолжения'),
});

const toSchema = (schema: z.ZodType): Record<string, unknown> =>
    z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;

const attemptCompletionSpec: ToolSpec = {
    name: ATTEMPT_COMPLETION,
    description:
        'Завершает работу и передаёт итоговый ответ. Вызывай, когда задача выполнена. ' +
        'Не описывай предстоящие шаги словами вместо их выполнения.',
    parameters: toSchema(completionArguments),
};

const askUserSpec: ToolSpec = {
    name: ASK_USER,
    description:
        'Задаёт уточняющий вопрос и передаёт слово пользователю. Вызывай, когда без ответа ' +
        'продолжать нельзя. Обычным текстом вопрос не задавай — он останется без ответа.',
    parameters: toSchema(questionArguments),
};

export function terminalSpecs(mode: CompletionMode): readonly ToolSpec[] {
    return mode === 'chat' ? [attemptCompletionSpec, askUserSpec] : [attemptCompletionSpec];
}

export function isTerminal(name: string, mode: CompletionMode): boolean {
    if (name === ATTEMPT_COMPLETION) return true;
    return name === ASK_USER && mode === 'chat';
}

/**
 * Текст из аргументов терминального вызова.
 *
 * Разбор может не удаться: аргументы приходят строкой от модели. Отказ здесь не должен
 * терять ход целиком, поэтому при неудаче возвращается пустая строка, а вызывающая сторона
 * подставляет обычный текст ответа.
 */
export function terminalText(rawArguments: string): string {
    try {
        const parsed: unknown = rawArguments === '' ? {} : JSON.parse(rawArguments);
        const value = (parsed as { text?: unknown }).text;
        return typeof value === 'string' ? value.trim() : '';
    } catch {
        return '';
    }
}
