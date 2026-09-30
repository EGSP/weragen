import { Effect } from 'effect';
import { z } from 'zod';
import { defineWorkflow, serve, WorkflowContext, WorkflowFailure } from '@weragen/workflow';

/**
 * Разбор обращений по категориям.
 *
 * Показывает основной способ применения платформы воркфлоу: формальную часть работы —
 * перебор, порядок, сбор итога, разбор ответа — ведёт программа, а там, где формальных
 * правил недостаточно, она запрашивает у платформы агентскую сессию. Цикл исполняет
 * платформа; воркфлоу передаёт постановку и дожидается текста итога.
 *
 * Инструменты агенту здесь не нужны вовсе, и перечень задан пустым намеренно: набор
 * платформы сужается до ничего, и модель отвечает, опираясь только на постановку. Это
 * заметно сокращает и число шагов, и расход токенов.
 */

const CATEGORIES = ['оплата', 'доставка', 'качество', 'возврат', 'прочее'] as const;

const input = z.object({
    tickets: z
        .array(z.string().min(1).max(2000))
        .min(1)
        .max(20)
        .describe('Тексты обращений, каждое отдельной строкой'),
});

/** Разбор ответа агента. Модель отвечает текстом, поэтому категория извлекается сверкой. */
function categoryOf(answer: string): string {
    const lowered = answer.toLowerCase();
    return CATEGORIES.find((category) => lowered.includes(category)) ?? 'прочее';
}

const workflow = defineWorkflow({
    name: 'triage',
    version: '1.0.0',
    title: 'Разбор обращений',
    description:
        'Относит каждое обращение к одной из категорий: оплата, доставка, качество, ' +
        'возврат, прочее. Каждое обращение разбирается отдельной агентской сессией.',
    input,
    requires: { tools: [], mcp: [], models: [] },

    run: ({ tickets }) =>
        Effect.gen(function* () {
            const platform = yield* WorkflowContext;

            // Обращения разбираются последовательно, а не одновременно: каждая сессия —
            // это обращение к модели, и одновременный запуск двадцати упёрся бы в квоту
            // провайдера. Порядок здесь дешевле параллельности.
            const classified = yield* Effect.forEach(
                tickets,
                (ticket, index) =>
                    platform.step(
                        `ticket-${index + 1}`,
                        `Обращение ${index + 1} из ${tickets.length}`,
                        platform
                            .agent(
                                'Определи категорию обращения клиента. Ответь одним словом — ' +
                                    `названием категории из перечня: ${CATEGORIES.join(', ')}. ` +
                                    `Обращение: «${ticket}»`,
                                { tools: [], title: `Категория обращения ${index + 1}` },
                            )
                            .pipe(
                                Effect.map((answer) => ({
                                    ticket,
                                    category: categoryOf(answer),
                                    answer,
                                })),
                            ),
                        { summary: (item) => `категория: ${item.category}` },
                    ),
                { concurrency: 1 },
            );

            const counts = yield* platform.step(
                'summarize',
                'Сводка по категориям',
                Effect.sync(() => {
                    const result: Record<string, number> = {};
                    for (const item of classified) {
                        result[item.category] = (result[item.category] ?? 0) + 1;
                    }
                    return result;
                }),
            );

            if (classified.length === 0) {
                return yield* new WorkflowFailure({ message: 'Ни одно обращение не разобрано.' });
            }

            return {
                total: classified.length,
                counts,
                items: classified.map(({ ticket, category }) => ({ ticket, category })),
            };
        }),
});

void serve(workflow);
