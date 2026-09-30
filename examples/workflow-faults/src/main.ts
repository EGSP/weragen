import { Duration, Effect, Either } from 'effect';
import { z } from 'zod';
import { defineWorkflow, serve, WorkflowContext, WorkflowFailure } from '@weragen/workflow';

/**
 * Воркфлоу, отказывающий по разным причинам.
 *
 * Существует ради проверки путей отказа: в обычной работе каждый из них встречается редко,
 * а различаются они и обработкой, и тем, что попадает в журнал и в трассировку. Причина
 * выбирается самим воркфлоу случайно при запуске, поэтому повторные запуски проходят разными
 * путями без участия вызывающей стороны. Для повторяемой проверки причина задаётся во входе
 * прямо.
 *
 * Причины различаются уровнем, на котором возникает отказ:
 *
 * - `declared` — объявленный отказ воркфлоу: платформа получает сообщённую причину;
 * - `defect` — необъявленное исключение в коде воркфлоу;
 * - `rejected_promise` — отклонённое обещание, объявленное через `Effect.promise`, отчего
 *   отказ становится дефектом, а не ошибкой;
 * - `tool_failure` — штатный отказ инструмента в дочерней агентской сессии: предел заметок
 *   исчерпан, и модель получает отказ с предписанием;
 * - `unknown_tool` — вызов инструмента, которого нет в суженном наборе сессии;
 * - `child_workflow` — отказ дочернего исполнения другого воркфлоу;
 * - `none` — исполнение без отказа; нужно, чтобы отличать отказ от неработоспособности.
 */

const CAUSES = [
    'declared',
    'defect',
    'rejected_promise',
    'tool_failure',
    'unknown_tool',
    'child_workflow',
    'none',
] as const;

type Cause = (typeof CAUSES)[number];

const input = z.object({
    cause: z
        .enum(['random', ...CAUSES])
        .default('random')
        .describe('Причина отказа; «random» — воркфлоу выбирает её сам при запуске'),
    delayMs: z
        .number()
        .int()
        .min(0)
        .max(60_000)
        .default(0)
        .describe('Пауза перед отказом, миллисекунды'),
});

/** Пояснение причины для журнала и итога. */
const EXPLANATION: Record<Cause, string> = {
    declared: 'объявленный отказ воркфлоу',
    defect: 'необъявленное исключение в коде воркфлоу',
    rejected_promise: 'отклонённое обещание, объявленное неотклоняемым',
    tool_failure: 'штатный отказ инструмента в дочерней агентской сессии',
    unknown_tool: 'вызов инструмента вне набора дочерней агентской сессии',
    child_workflow: 'отказ дочернего исполнения воркфлоу',
    none: 'отказа нет',
};

/**
 * Выбор причины. Случайность намеренно оставлена в самом воркфлоу: платформа о ней не
 * осведомлена, и повторный запуск с тем же входом идёт другим путём.
 */
function chooseCause(requested: 'random' | Cause): Cause {
    if (requested !== 'random') return requested;
    return CAUSES[Math.floor(Math.random() * CAUSES.length)]!;
}

const workflow = defineWorkflow({
    name: 'faults',
    version: '1.0.0',
    title: 'Отказы',
    description:
        'Отказывает по одной из причин: объявленный отказ, исключение, отклонённое ' +
        'обещание, отказ инструмента, вызов несуществующего инструмента, отказ дочернего ' +
        'воркфлоу. Причина выбирается случайно при запуске, если не задана во входе. ' +
        'Служит проверкой путей отказа платформы.',
    input,
    // Инструменты заметок нужны причинам, работающим через агентскую сессию: предел их
    // объёма — единственный отказ инструмента, воспроизводимый без внешних систем.
    requires: { tools: ['read_notes', 'write_note', 'clear_notes'], mcp: [], models: [] },

    run: ({ cause, delayMs }) =>
        Effect.gen(function* () {
            const platform = yield* WorkflowContext;
            const chosen = chooseCause(cause);

            // Выбранная причина записывается пометкой до того, как отказ произойдёт: иначе
            // по журналу отказавшего исполнения было бы не понять, какой путь проверялся.
            yield* platform.note(
                `Причина выбрана: ${chosen}`,
                `${EXPLANATION[chosen]}${cause === 'random' ? ' (выбор случайный)' : ' (задана во входе)'}`,
            );

            yield* platform.step(
                'prepare',
                'Подготовка',
                Effect.sleep(Duration.millis(delayMs)),
                { attributes: { 'weragen.faults.cause': chosen } },
            );

            switch (chosen) {
                case 'declared':
                    return yield* platform.step(
                        'declared',
                        'Объявленный отказ',
                        Effect.gen(function* () {
                            return yield* new WorkflowFailure({
                                message:
                                    'Отказ объявлен воркфлоу: причина сообщена платформе, ' +
                                    'а не выведена из кода выхода процесса.',
                            });
                        }),
                    );

                case 'defect':
                    return yield* platform.step(
                        'defect',
                        'Исключение в коде воркфлоу',
                        Effect.sync((): never => {
                            throw new Error(
                                'Обращение к несуществующему источнику данных faults-source-1.',
                            );
                        }),
                    );

                case 'rejected_promise':
                    return yield* platform.step(
                        'rejected-promise',
                        'Отклонённое обещание',
                        // `Effect.promise` объявляет обещание неотклоняемым, поэтому отказ
                        // становится дефектом: типом он не выражен и обработке не подлежит.
                        Effect.promise(() =>
                            Promise.reject(
                                new Error('Соединение с внешней службой faults-api закрыто.'),
                            ),
                        ),
                    );

                case 'tool_failure': {
                    const answer = yield* platform.step(
                        'tool-failure',
                        'Отказ инструмента в агентской сессии',
                        platform.agent(
                            'Запиши в заметки сессии четыре строки подряд, по одной вызовом ' +
                                'write_note: «первая», «вторая», «третья», «четвёртая». ' +
                                'Предел заметок меньше четырёх, поэтому один из вызовов будет ' +
                                'отклонён. Не очищай заметки и не повторяй отклонённый вызов: ' +
                                'сообщи текст отказа дословно и укажи, сколько строк записано.',
                            { tools: ['read_notes', 'write_note'], title: 'Предел заметок' },
                        ),
                        { summary: () => 'агентская сессия завершена' },
                    );
                    return yield* new WorkflowFailure({
                        message: `Инструмент отказал штатно, агент об этом сообщил: ${answer}`,
                    });
                }

                case 'unknown_tool': {
                    const answer = yield* platform.step(
                        'unknown-tool',
                        'Вызов инструмента вне набора',
                        // Набор сужен до одного инструмента, а задача требует другого:
                        // платформа отклонит вызов, назвав доступные имена.
                        platform.agent(
                            'Очисти заметки сессии вызовом инструмента clear_notes, затем ' +
                                'прочитай их вызовом read_notes. Если какой-то из вызовов ' +
                                'отклонён, сообщи текст отказа дословно и не подбирай замену.',
                            { tools: ['read_notes'], title: 'Инструмент вне набора' },
                        ),
                        { summary: () => 'агентская сессия завершена' },
                    );
                    return yield* new WorkflowFailure({
                        message: `Вызов отклонён платформой, агент об этом сообщил: ${answer}`,
                    });
                }

                case 'child_workflow': {
                    // Исход дочернего исполнения принимается обоими вариантами: отказ здесь
                    // ожидаем, но успех означал бы неисправность проверки, и различить их
                    // нужно сообщением, а не молчанием.
                    const outcome = yield* platform
                        .step(
                            'child-workflow',
                            'Отказ дочернего исполнения',
                            // Дочернему воркфлоу отказ задан прямо: собственная случайность
                            // здесь помешала бы — проверяется передача отказа наверх.
                            platform.workflow('echo', { text: 'проверка', delayMs: 0, fail: true }),
                        )
                        .pipe(Effect.either);
                    return yield* new WorkflowFailure({
                        message: Either.isLeft(outcome)
                            ? `Дочернее исполнение отказало: ${outcome.left.message}`
                            : 'Дочернее исполнение завершилось без отказа, хотя отказ ему задан.',
                    });
                }

                case 'none':
                    return yield* platform.step(
                        'none',
                        'Исполнение без отказа',
                        Effect.succeed({ cause: chosen, failed: false }),
                    );
            }
        }),
});

void serve(workflow);
