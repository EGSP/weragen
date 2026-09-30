import { Effect } from 'effect';
import { z } from 'zod';
import { defineWorkflow, serve, WorkflowContext, WorkflowFailure } from '@weragen/workflow';

/**
 * Сводка с графиком.
 *
 * Проверяет две вещи, которых нет в двух других примерах. Первое — требования к
 * инструментам платформы: агенту здесь нужны `random_number` и `render_chart`, и если их на
 * платформе не окажется, воркфлоу не пройдёт проверку требований и запускать его будет
 * нельзя. Второе — вложенность воркфлоу в воркфлоу: оформление итога передаётся дочернему
 * исполнению `echo`.
 *
 * Ветвь с недоступным дочерним воркфлоу обработана явно: отсутствие `echo` в реестре не
 * должно ронять всю сводку, потому что данные к этому моменту уже собраны.
 */

const input = z.object({
    topic: z.string().min(1).max(200).describe('Тема сводки, например «продажи по месяцам»'),
    points: z
        .number()
        .int()
        .min(3)
        .max(12)
        .default(6)
        .describe('Сколько точек показать на графике'),
});

const workflow = defineWorkflow({
    name: 'report',
    version: '1.0.0',
    title: 'Сводка с графиком',
    description:
        'Поручает агенту получить случайные значения и построить по ним график, затем ' +
        'передаёт итог дочернему воркфлоу для оформления.',
    input,
    requires: { tools: ['random_number', 'render_chart'], mcp: [], models: [] },

    run: ({ topic, points }) =>
        Effect.gen(function* () {
            const platform = yield* WorkflowContext;

            const chartAnswer = yield* platform.step(
                'chart',
                'Построение графика',
                platform.agent(
                    `Тема: «${topic}». Получи ${points} случайных целых значений в диапазоне ` +
                        'от 10 до 100, вызывая random_number по одному значению за вызов. ' +
                        'Затем построй по ним столбчатый график вызовом render_chart: подписи ' +
                        'точек — порядковые номера, ряд назови по теме. В итоге сообщи ' +
                        'полученные значения через запятую и одним предложением опиши, как они ' +
                        'распределены.',
                    { tools: ['random_number', 'render_chart'], title: `График: ${topic}` },
                ),
                { attributes: { 'weragen.report.topic': topic, 'weragen.report.points': points } },
            );

            if (chartAnswer.trim() === '') {
                return yield* new WorkflowFailure({
                    message: 'Агент вернул пустой итог: график построить не удалось.',
                });
            }

            // Оформление передаётся дочернему воркфлоу. Отказ здесь не отменяет собранного:
            // сводка возвращается и без оформления, а причина попадает в итог.
            const formatted = yield* platform
                .step(
                    'format',
                    'Оформление итога дочерним воркфлоу',
                    platform.workflow('echo', {
                        text: `Сводка «${topic}»: ${chartAnswer}`,
                        delayMs: 0,
                        fail: false,
                    }),
                )
                .pipe(
                    Effect.catch((failure) =>
                        Effect.succeed({ unavailable: failure.message }),
                    ),
                );

            return { topic, points, answer: chartAnswer, formatted };
        }),
});

void serve(workflow);
