import { ROOT_CONTEXT, trace, TraceFlags, type Context, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/**
 * Трассировка процесса воркфлоу.
 *
 * Интерфейс берётся из `@opentelemetry/api` — собственных определений для того, что уже
 * описано стандартом, здесь нет. Пакет `api` содержит только интерфейсы: без
 * зарегистрированного провайдера все обращения к нему становятся пустыми операциями.
 * Поэтому код воркфлоу одинаков независимо от того, настроен экспортёр или нет.
 *
 * Адрес приёмника передаёт платформа переменной окружения при запуске: он относится к
 * развёртыванию, а не к исполнению. Пустое значение означает, что трассировка выключена, и
 * провайдер не создаётся вовсе.
 */

let provider: NodeTracerProvider | undefined;

export type TracingSettings = {
    readonly enabled: boolean;
    /** Записывать ли содержимое — входы, итоги, тексты — в атрибуты спанов. */
    readonly captureContent: boolean;
};

export function initTracing(workflowName: string, version: string): TracingSettings {
    const endpoint = (process.env['WERAGEN_OTEL_ENDPOINT'] ?? '').trim().replace(/\/+$/, '');
    const captureContent = (process.env['WERAGEN_OTEL_CAPTURE_CONTENT'] ?? 'true').toLowerCase();
    const settings: TracingSettings = {
        enabled: endpoint !== '',
        captureContent: captureContent !== 'false' && captureContent !== '0',
    };
    if (!settings.enabled) return settings;

    const base = (process.env['WERAGEN_OTEL_SERVICE_NAME'] ?? 'weragen').trim();
    provider = new NodeTracerProvider({
        // Имя службы включает имя воркфлоу: в приёмнике исполнения разных воркфлоу
        // различимы по нему, не раскрывая трассу.
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: `${base}-workflow-${workflowName}`,
            [ATTR_SERVICE_VERSION]: version,
        }),
        spanProcessors: [
            new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
        ],
    });
    provider.register();
    return settings;
}

/**
 * Сброс буфера перед выходом процесса.
 *
 * Обязателен и легко упускается. Процесс воркфлоу живёт одно исполнение и завершается сам,
 * а спаны отправляются пачками — при обычном выходе не ушло бы ни одного, и трасса
 * оказалась бы пустой при полностью исправной настройке.
 */
export async function flushTracing(): Promise<void> {
    if (provider === undefined) return;
    try {
        await provider.shutdown();
    } catch {
        // Недоступный приёмник не должен мешать завершению процесса.
    }
    provider = undefined;
}

export function tracer(): Tracer {
    return trace.getTracer('weragen-workflow');
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Родительский контекст из заголовка W3C Trace Context, полученного вместе с входом.
 *
 * Разбирается вручную, а не глобальным распространителем: значение приходит полем тела
 * запроса, и заводить ради одного поля носитель заголовков незачем. Неразобранное значение
 * даёт корневой контекст — исполнение всё равно трассируется, просто отдельной трассой.
 */
export function contextFromTraceparent(traceparent: string | undefined): Context {
    if (traceparent === undefined) return ROOT_CONTEXT;
    const parts = TRACEPARENT.exec(traceparent.trim());
    if (parts === null) return ROOT_CONTEXT;
    return trace.setSpanContext(ROOT_CONTEXT, {
        traceId: parts[1]!,
        spanId: parts[2]!,
        traceFlags: Number.parseInt(parts[3]!, 16) & TraceFlags.SAMPLED,
        isRemote: true,
    });
}
