/**
 * Сообщения диалога в собственных типах ядра.
 *
 * Типы SDK провайдера сюда не проникают намеренно: цикл не должен меняться при добавлении
 * второго транспорта. Преобразование в формат конкретного API выполняет адаптер клиента
 * модели на границе.
 */

/** Вызов инструмента, затребованный моделью. Аргументы приходят строкой JSON. */
export type AgentToolCall = {
    readonly id: string;
    readonly name: string;
    readonly rawArguments: string;
};

export type AgentMessage =
    | { readonly role: 'system'; readonly content: string }
    | { readonly role: 'user'; readonly content: string }
    | {
          readonly role: 'assistant';
          readonly content: string;
          readonly toolCalls: readonly AgentToolCall[];
      }
    | { readonly role: 'tool'; readonly callId: string; readonly content: string };

/** Расход токенов на одно обращение к модели. */
export type TokenUsage = { readonly prompt: number; readonly completion: number };

/** Ответ модели на одно обращение. */
export type ModelReply = {
    readonly content: string;
    readonly toolCalls: readonly AgentToolCall[];
    /**
     * Текст рассуждения. Рассуждающие модели тратят на него часть выходного бюджета и
     * возвращают отдельным полем; в историю диалога он не возвращается.
     */
    readonly reasoning: string | undefined;
    /** `length` означает, что модель упёрлась в предел выходных токенов. */
    readonly finishReason: string | undefined;
    readonly usage: TokenUsage;
};
