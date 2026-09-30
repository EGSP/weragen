import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Legend,
    Line,
    LineChart,
    Pie,
    PieChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';
import { Card, theme } from 'antd';
import { chartSeries, type ChartArguments } from '@weragen/types';

/**
 * Отрисовка графика по аргументам вызова инструмента.
 *
 * Сервер график не порождает: он подтверждает, что построение допустимо, а изображение
 * строится здесь. Из этого следует, что представление можно менять, не трогая ни ядро, ни
 * журнал, а канал, отрисовать график не способный, покажет вместо него заголовок.
 */

/**
 * Цвета рядов — основные оттенки палитры Ant Design. Тема их не задаёт: токены описывают
 * назначение цвета (основной, успех, предупреждение), а рядам графика назначение не
 * соответствует, различать их нужно только между собой.
 */
const PALETTE = ['#1677ff', '#13c2c2', '#52c41a', '#faad14', '#722ed1', '#fa541c'];

/**
 * Появление графика не анимируется (`isAnimationActive={false}` у всех рядов).
 *
 * Список ходов перестраивается на каждое событие журнала, поэтому анимация начиналась бы
 * заново при каждой перестройке. Кроме того, при изменении размера полотна во время анимации
 * она останавливается на промежуточном положении: круговая диаграмма в этом случае остаётся
 * узким сектором вместо круга.
 */
const PLOT_HEIGHT = 260;

/**
 * Ширина задана числом, а не долей.
 *
 * График находится внутри блока сообщения, ширина которого определяется содержимым.
 * Доля от такой ширины вычислялась бы по кругу, и полотно осталось бы нулевой ширины,
 * поэтому ширина назначается явно и ограничивается сверху размером блока.
 */
const PLOT_WIDTH = 560;

export function ChartView({ chart }: { readonly chart: ChartArguments }) {
    const { token } = theme.useToken();
    const series = chartSeries(chart.points);
    const color = (index: number): string => PALETTE[index % PALETTE.length]!;

    const axis = { stroke: token.colorTextTertiary, fontSize: token.fontSizeSM };
    const grid = <CartesianGrid strokeDasharray="3 3" stroke={token.colorBorderSecondary} />;
    const hint = (
        <Tooltip
            contentStyle={{
                background: token.colorBgElevated,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: token.borderRadius,
                fontSize: token.fontSizeSM,
            }}
        />
    );
    // Перечень рядов помещён сверху: снизу он оказался бы под подписью горизонтальной оси
    // и накладывался бы на неё.
    const legend =
        series.length > 1 ? (
            <Legend
                verticalAlign="top"
                align="right"
                height={24}
                wrapperStyle={{ fontSize: token.fontSizeSM }}
            />
        ) : null;

    const caption = (value: string, angle?: number) => ({
        value,
        angle,
        position: angle === undefined ? ('insideBottom' as const) : ('insideLeft' as const),
        offset: angle === undefined ? -4 : 0,
        fontSize: token.fontSizeSM,
        fill: token.colorTextTertiary,
    });

    const horizontal = (
        <XAxis
            dataKey="label"
            {...axis}
            height={chart.xLabel === undefined ? 30 : 46}
            label={chart.xLabel === undefined ? undefined : caption(chart.xLabel)}
        />
    );
    const vertical = (
        <YAxis
            {...axis}
            width={chart.yLabel === undefined ? 48 : 64}
            label={chart.yLabel === undefined ? undefined : caption(chart.yLabel, -90)}
        />
    );

    return (
        <Card
            size="small"
            title={chart.title}
            style={{ width: PLOT_WIDTH, maxWidth: '100%' }}
            styles={{ body: { paddingInline: token.paddingXS } }}
        >
            <ResponsiveContainer width="100%" height={PLOT_HEIGHT}>
                {chart.chartType === 'pie' ? (
                    <PieChart>
                        <Pie
                            data={chart.points.map((point) => ({
                                name: point.label,
                                value: Number((point as Record<string, unknown>)[series[0] ?? ''] ?? 0),
                            }))}
                            dataKey="value"
                            isAnimationActive={false}
                            nameKey="name"
                            outerRadius={PLOT_HEIGHT / 2 - 44}
                            label={{ fontSize: token.fontSizeSM, fill: token.colorText }}
                        >
                            {chart.points.map((point, index) => (
                                <Cell key={point.label} fill={color(index)} />
                            ))}
                        </Pie>
                        {/* У круговой диаграммы ряд один, а секторов много: перечень
                            сопоставляет им подписи, которые на самих секторах не поместятся. */}
                        <Legend
                            verticalAlign="bottom"
                            height={24}
                            wrapperStyle={{ fontSize: token.fontSizeSM }}
                        />
                        {hint}
                    </PieChart>
                ) : chart.chartType === 'line' ? (
                    <LineChart data={chart.points as object[]}>
                        {grid}
                        {horizontal}
                        {vertical}
                        {hint}
                        {legend}
                        {series.map((name, index) => (
                            <Line
                                key={name}
                                type="monotone"
                                dataKey={name}
                                isAnimationActive={false}
                                stroke={color(index)}
                                strokeWidth={2}
                                dot={false}
                            />
                        ))}
                    </LineChart>
                ) : chart.chartType === 'area' ? (
                    <AreaChart data={chart.points as object[]}>
                        {grid}
                        {horizontal}
                        {vertical}
                        {hint}
                        {legend}
                        {series.map((name, index) => (
                            <Area
                                key={name}
                                type="monotone"
                                dataKey={name}
                                isAnimationActive={false}
                                stroke={color(index)}
                                fill={color(index)}
                                fillOpacity={0.2}
                            />
                        ))}
                    </AreaChart>
                ) : (
                    <BarChart data={chart.points as object[]}>
                        {grid}
                        {horizontal}
                        {vertical}
                        {hint}
                        {legend}
                        {series.map((name, index) => (
                            <Bar
                                key={name}
                                dataKey={name}
                                isAnimationActive={false}
                                fill={color(index)}
                                stackId={chart.chartType === 'stacked_bar' ? 'total' : undefined}
                                radius={[2, 2, 0, 0]}
                            />
                        ))}
                    </BarChart>
                )}
            </ResponsiveContainer>
        </Card>
    );
}
