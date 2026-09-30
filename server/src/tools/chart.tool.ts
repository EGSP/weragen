import { Effect } from 'effect';
import { z } from 'zod';
import { chartArgumentsSchema, chartSeries, MAX_CHART_POINTS, type ChartArguments } from '@weragen/types';
import { ToolFailure, zodInput, type AgentTool } from '@weragen/ai';

/**
 * Построение графика и порождение данных для проверки.
 *
 * Сервер график не рисует и изображения не порождает: он проверяет аргументы и подтверждает
 * построение. Рисует клиент, читая аргументы вызова из журнала. Отсюда следует, что тяжёлых
 * данных в результате быть не должно — они уже переданы в аргументах, и повтор их в ответе
 * удвоил бы объём в контексте модели.
 */

/**
 * Правила применения вынесены в описание инструмента, а не в проверки.
 *
 * Различить «здесь график уместен» и «здесь достаточно числа» может только тот, кто видит
 * вопрос пользователя, то есть модель. Проверка на стороне сервера отклоняла бы правомерные
 * вызовы: ряд из трёх точек бессмыслен в отчёте о продажах и осмыслен при сравнении трёх
 * вариантов. Поэтому сервер проверяет строение данных, а уместность оставляет модели.
 */
const description =
    'Строит график в переписке. График показывает уже полученные данные и дополняет ответ, ' +
    'а не заменяет его.\n' +
    'Строить, когда задача состоит в сравнении, динамике или структуре целого, данные ' +
    'получены другим инструментом, а точек не меньше пяти (для pie — трёх).\n' +
    'Не строить, когда просят кратко или одно число, когда значения почти равны и когда ' +
    'точек меньше порога: таблица или фраза читаются лучше.\n' +
    'Выбор типа: bar — сравнение категорий; line и area — изменение во времени; ' +
    'stacked_bar — состав целого по периодам; pie — доли целого, не больше семи категорий.\n' +
    `Не больше ${MAX_CHART_POINTS} точек: более крупные данные нужно агрегировать до вызова.\n` +
    'После вызова график показывается пользователю платформой. Не вставляй в ответ разметку ' +
    'изображения и не ссылайся на файл: файла не существует. В тексте достаточно назвать, ' +
    'что показано на графике.';

export const renderChart: AgentTool<ChartArguments> = {
    name: 'render_chart',
    description,
    input: zodInput(chartArgumentsSchema),
    execute: (input) =>
        Effect.gen(function* () {
            const series = chartSeries(input.points);
            if (series.length === 0) {
                return yield* Effect.fail(
                    new ToolFailure(
                        'Ни в одной точке нет числовых полей, строить нечего.',
                        'Кроме label каждая точка должна содержать хотя бы одно числовое поле, ' +
                            'например {"label":"Янв","Продажи":120}. Числа передаются без кавычек.',
                    ),
                );
            }
            if (input.chartType === 'pie' && series.length > 1) {
                return yield* Effect.fail(
                    new ToolFailure(
                        `Круговая диаграмма показывает один ряд, а в точках их ${series.length}: ${series.join(', ')}.`,
                        'Оставь в точках одно числовое поле либо выбери bar или stacked_bar.',
                    ),
                );
            }

            // Точка без части рядов допустима: разрыв в линии — это данные, а не ошибка. Но
            // точка, где нет ни одного ряда, ничего не изображает и означает ошибку сборки.
            const empty = input.points.findIndex(
                (point) => series.every((name) => typeof (point as Record<string, unknown>)[name] !== 'number'),
            );
            if (empty >= 0) {
                return yield* Effect.fail(
                    new ToolFailure(
                        `В точке номер ${empty + 1} («${input.points[empty]?.label ?? ''}») нет ни одного числового поля.`,
                        `Добавь в неё значение хотя бы одного из рядов: ${series.join(', ')}.`,
                    ),
                );
            }

            return {
                rendered: true,
                chartType: input.chartType,
                points: input.points.length,
                series,
            };
        }),
};

const MAX_SAMPLE_POINTS = 20;
const MAX_SAMPLE_SERIES = 3;

/** Подписи точек: месяцы, пока их хватает, дальше — порядковые периоды. */
const MONTHS = [
    'Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн',
    'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек',
];

/**
 * Порождение ряда для проверки построения графиков.
 *
 * Пределы намеренно жёсткие: двадцать точек и три ряда. Инструмент нужен, чтобы пройти путь
 * «получить данные — построить график» целиком, а не чтобы проверить работу с крупными
 * выборками, поэтому результат должен занимать в контексте единицы сотен знаков.
 */
export const sampleSeries: AgentTool<{ points: number; series: string[] }> = {
    name: 'sample_series',
    description:
        'Порождает вымышленный числовой ряд для проверки построения графиков. Значения ' +
        'случайны, их нужно получить вызовом, а не придумать. Поле points из результата ' +
        `передаётся в render_chart без изменений. Не больше ${MAX_SAMPLE_POINTS} точек и ` +
        `${MAX_SAMPLE_SERIES} рядов.`,
    input: zodInput(
        z.object({
            points: z
                .number()
                .int()
                .min(3)
                .max(MAX_SAMPLE_POINTS)
                .default(12)
                .describe(`Сколько точек породить, не больше ${MAX_SAMPLE_POINTS}`),
            series: z
                .array(z.string().min(1))
                .min(1)
                .max(MAX_SAMPLE_SERIES)
                .default(['Значение'])
                .describe(`Названия рядов на русском языке, не больше ${MAX_SAMPLE_SERIES}`),
        }),
    ),
    execute: ({ points, series }) =>
        Effect.sync(() => {
            const rows = Array.from({ length: points }, (_, index) => ({
                label: index < MONTHS.length ? MONTHS[index]! : `П${index + 1}`,
            })) as Record<string, string | number>[];

            for (const name of series) {
                let value = 100 + Math.floor(Math.random() * 200);
                for (const row of rows) {
                    value = Math.max(10, Math.round(value * (0.85 + Math.random() * 0.35)));
                    row[name] = value;
                }
            }

            return { points: rows, series, count: rows.length };
        }),
};
