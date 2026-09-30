import { diag, DiagLogLevel, trace, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { TracingConfig } from '../config/app-config.service.js';

/**
 * Трассировка через OpenTelemetry.
 *
 * Экспорт выключен, пока не задан адрес приёмника: при пустом адресе провайдер не
 * регистрируется, и вызовы `@opentelemetry/api` из остального кода становятся пустыми
 * операциями. Кодировка — protobuf: OTLP по HTTP допускает и JSON, но принимают его не все.
 */

let provider: NodeTracerProvider | undefined;

export function initTracing(config: TracingConfig): void {
    if (!config.enabled) return;

    diag.setLogger(
        {
            error: (message) => process.stderr.write(`[otel] ${message}\n`),
            warn: () => {},
            info: () => {},
            debug: () => {},
            verbose: () => {},
        },
        DiagLogLevel.ERROR,
    );

    provider = new NodeTracerProvider({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: config.serviceName,
            [ATTR_SERVICE_VERSION]: '0.1.0',
        }),
        spanProcessors: [
            new BatchSpanProcessor(new OTLPTraceExporter({ url: `${config.endpoint}/v1/traces` })),
        ],
    });
    provider.register();
}

export async function shutdownTracing(): Promise<void> {
    if (provider === undefined) return;
    try {
        await provider.shutdown();
    } catch {
        // Недоступный приёмник не должен мешать остановке сервера.
    }
}

export function tracer(): Tracer {
    return trace.getTracer('weragen-server');
}
