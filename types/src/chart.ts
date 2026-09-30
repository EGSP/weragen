import { z } from 'zod';

/**
 * Описание графика.
 *
 * Схема объявлена в общем пакете, потому что у неё два потребителя: сервер проверяет по ней
 * аргументы вызова, клиент по ней же разбирает эти аргументы при отрисовке. Отрисовка идёт
 * от аргументов вызова, а не от результата: результат сообщает лишь о том, что построение
 * состоялось.
 */

export const chartTypeSchema = z.enum(['bar', 'stacked_bar', 'line', 'area', 'pie']);
export type ChartType = z.infer<typeof chartTypeSchema>;

/** Предел числа точек. Больше сотни график перестаёт читаться, а ответ модели — расти в объёме. */
export const MAX_CHART_POINTS = 100;

/**
 * Точка: подпись по горизонтали и произвольное число числовых полей. Каждое числовое поле
 * образует отдельный ряд, поэтому один и тот же вид точки годится и для одного ряда, и для
 * нескольких, и для долей целого.
 */
export const chartPointSchema = z.object({ label: z.string() }).catchall(z.number());
export type ChartPoint = z.infer<typeof chartPointSchema>;

export const chartArgumentsSchema = z.object({
    chartType: chartTypeSchema.describe(
        'Тип графика: bar, stacked_bar, line, area или pie',
    ),
    title: z.string().min(1).describe('Заголовок графика на русском языке'),
    points: z
        .array(chartPointSchema)
        .min(1)
        .max(MAX_CHART_POINTS)
        .describe(
            'Точки графика: [{"label":"Янв","Продажи":120}, ...]. Поле label обязательно, ' +
                'каждое числовое поле образует отдельный ряд. Числа без кавычек',
        ),
    xLabel: z.string().optional().describe('Подпись горизонтальной оси, для pie не нужна'),
    yLabel: z.string().optional().describe('Подпись вертикальной оси, для pie не нужна'),
});
export type ChartArguments = z.infer<typeof chartArgumentsSchema>;

/**
 * Ряды графика — числовые поля точек в порядке первого появления. Вычисляются, а не
 * задаются: список рядов выводится из данных однозначно, и отдельное поле для него означало
 * бы возможность расхождения.
 */
export function chartSeries(points: readonly ChartPoint[]): string[] {
    const names: string[] = [];
    for (const point of points) {
        for (const [key, value] of Object.entries(point as Record<string, unknown>)) {
            if (key !== 'label' && typeof value === 'number' && !names.includes(key)) {
                names.push(key);
            }
        }
    }
    return names;
}
