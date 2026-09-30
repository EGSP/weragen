import { Data } from 'effect';

/** Отказ на стороне провайдера модели. Повтор осмыслен, исправление — нет. */
export class ModelFailure extends Data.TaggedError('ModelFailure')<{
    readonly message: string;
}> {}

/**
 * Сработало ограничение числа шагов. Означает, что задача слишком велика для одного хода
 * либо модель зациклилась на одном инструменте.
 */
export class StepLimitReached extends Data.TaggedError('StepLimitReached')<{
    readonly limit: number;
}> {}

/**
 * Модель израсходовала выходной бюджет, не сформировав ответ. У рассуждающих моделей это
 * типичный исход: размышление занимает выход целиком. Чинится настройками, а не повтором.
 */
export class OutputBudgetExhausted extends Data.TaggedError('OutputBudgetExhausted')<{
    readonly completionTokens: number;
    readonly hadReasoning: boolean;
}> {}

export type TurnError = ModelFailure | StepLimitReached | OutputBudgetExhausted;

/** Читаемое сообщение об исходе для журнала и интерфейса. */
export function describeTurnError(error: TurnError): string {
    switch (error._tag) {
        case 'ModelFailure':
            return error.message;
        case 'StepLimitReached':
            return (
                `Ход остановлен: превышен предел в ${error.limit} шагов. Задача, вероятно, ` +
                'слишком велика для одного хода, либо модель зациклилась на одном инструменте.'
            );
        case 'OutputBudgetExhausted':
            return (
                `Модель исчерпала бюджет выходных токенов (${error.completionTokens}), ` +
                (error.hadReasoning ? 'не сформировав ответ: весь выход занял текст рассуждения.' : 'не сформировав ответ.') +
                ' Увеличьте AGENT_MAX_TOKENS, упростите запрос либо возьмите модель без режима рассуждения.'
            );
    }
}
