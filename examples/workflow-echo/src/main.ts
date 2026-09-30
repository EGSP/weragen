import { Duration, Effect } from 'effect';
import { z } from 'zod';
import { defineWorkflow, serve, WorkflowContext, WorkflowFailure } from '@weragen/workflow';

/**
 * Эталонный воркфлоу: проверка контракта целиком.
 *
 * Прикладной задачи не решает и существует затем, чтобы пройти путь от карточки в реестре
 * до итога, не завися ни от модели, ни от инструментов платформы. Требования у него пусты,
 * поэтому проверка требований проходит на любой установке, а отказ на этом воркфлоу
 * указывает на устройство платформы, а не на её настройку.
 *
 * Здесь же показано, чем оканчивается исполнение: возвращённое значение становится итогом,
 * отказ `WorkflowFailure` — сообщённой причиной неудачи.
 */

const input = z.object({
    text: z.string().min(1).max(2000).describe('Текст, который нужно вернуть'),
    /** Задержка нужна, чтобы успеть увидеть шаги в интерфейсе и проверить прерывание. */
    delayMs: z
        .number()
        .int()
        .min(0)
        .max(60_000)
        .default(0)
        .describe('Пауза между шагами, миллисекунды'),
    /** Отказ по требованию: без него ветвь неудачи никогда не проверяется. */
    fail: z.boolean().default(false).describe('Завершить исполнение отказом'),
});

const workflow = defineWorkflow({
    name: 'echo',
    version: '1.0.0',
    title: 'Эхо',
    description:
        'Возвращает переданный текст, отчитываясь о трёх шагах. Служит проверкой того, ' +
        'что регистрация, запуск, наблюдение и завершение работают.',
    input,
    requires: { tools: [], mcp: [], models: [] },

    run: ({ text, delayMs, fail }) =>
        Effect.gen(function* () {
            const platform = yield* WorkflowContext;
            const pause = Effect.sleep(Duration.millis(delayMs));

            const { normalized, measured } = yield* platform.step(
                'normalize',
                'Нормализация текста',
                Effect.gen(function* () {
                    yield* pause;
                    const value = text.replace(/\s+/g, ' ').trim();

                    // Вложенный шаг: родителя указывать не нужно — он определяется тем,
                    // что этот шаг вызван внутри работы предыдущего.
                    const counted = yield* platform.step(
                        'measure',
                        'Подсчёт длины',
                        Effect.gen(function* () {
                            yield* pause;
                            return { characters: value.length, words: value.split(' ').length };
                        }),
                        { summary: (result) => `${result.words} слов` },
                    );

                    return { normalized: value, measured: counted };
                }),
                // Атрибуты попадают на спан, краткое описание — и на спан, и в журнал.
                // Результат целиком не передаётся: журнал есть запись наблюдений.
                {
                    attributes: { 'weragen.echo.input_length': text.length },
                    summary: (value) => `${value.normalized.length} символов после нормализации`,
                },
            );

            // Отказ объявляется до сообщения о завершении шага, поэтому в журнале шаг
            // остаётся отклонённым, а не завершённым.
            yield* platform.step(
                'verify',
                'Проверка',
                Effect.gen(function* () {
                    yield* pause;
                    if (fail) {
                        return yield* new WorkflowFailure({
                            message: 'Отказ запрошен во входном объекте (fail: true).',
                        });
                    }
                }),
            );

            return { echoed: normalized, ...measured };
        }),
});

void serve(workflow);
