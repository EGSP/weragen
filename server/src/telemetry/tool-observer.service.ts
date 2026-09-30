import { Injectable, Logger } from '@nestjs/common';
import { SpanStatusCode, type Context as OtelContext } from '@opentelemetry/api';
import { Context, Effect } from 'effect';
import type { ObservedToolCall, ToolObserver, ToolResult } from '@weragen/ai';
import { AppConfigService } from '../config/app-config.service.js';
import { sessionAttributes, toolCallAttributes, toolResultAttributes } from './span-attributes.js';
import { tracer } from './tracing.js';

/**
 * Наблюдение за вызовами инструментов спанами трассировки.
 *
 * Служба удовлетворяет требование ядра `ToolObserver`: ядро сообщает, что вызов начался и
 * чем кончился, а здесь это переводится в спан. Направление зависимости обратно обычному —
 * интерфейс объявлен в ядре, поэтому OpenTelemetry в ядро не проникает.
 *
 * Спан охватывает вызов целиком, включая сверку имени с набором и разбор аргументов. Прежде
 * спан открывался вокруг исполнения инструмента, и неверный вызов — несуществующее имя,
 * неразобранные аргументы, несоответствие схеме — не порождал спана вовсе: в трассе его не
 * было видно, хотя именно этот класс отказов говорит о качестве описаний инструментов.
 *
 * Родительский контекст передаётся параметром, а не берётся из текущего: волокна Effect
 * продолжаются в микрозадачах, где активный спан теряется.
 */
@Injectable()
export class ToolObserverService {
    private readonly logger = new Logger(ToolObserverService.name);

    constructor(private readonly config: AppConfigService) {}

    /** Наблюдатель, замкнутый на сессию и на спан её хода. */
    forSession(
        sessionId: string,
        userId: string,
        parent: OtelContext,
    ): Context.Service.Shape<typeof ToolObserver> {
        const capture = this.config.tracing.captureContent;
        const logger = this.logger;

        return {
            observe: (call: ObservedToolCall, run: Effect.Effect<ToolResult>) =>
                Effect.suspend(() => {
                    const span = tracer().startSpan(
                        `execute_tool ${call.name}`,
                        {
                            attributes: {
                                ...sessionAttributes(sessionId, userId),
                                ...toolCallAttributes(call, capture),
                            },
                        },
                        parent,
                    );

                    return run.pipe(
                        Effect.tap((result) =>
                            Effect.sync(() => {
                                span.setAttributes(toolResultAttributes(result, capture));
                                if (result.kind === 'ok') {
                                    span.setStatus({ code: SpanStatusCode.OK });
                                    return;
                                }

                                // Дефект — тоже ошибка, поэтому состояние спана одно для всех
                                // отказов, а различает их атрибут исхода. Текст исключения
                                // модели не уходит, и спан вместе с журналом сервера остаётся
                                // единственным местом, где он доступен.
                                const message = result.detail ?? result.content;
                                span.setStatus({ code: SpanStatusCode.ERROR, message });
                                if (result.kind === 'defect') {
                                    span.recordException({ name: 'ToolDefect', message });
                                    logger.error(
                                        `сессия ${sessionId}: дефект при вызове ${call.name} ` +
                                            `(шаг ${call.step}, вызов ${call.callId}): ${message}`,
                                    );
                                }
                            }),
                        ),
                        // Прерывание хода не является отказом вызова, но оставленный без
                        // пометки спан неотличим от спана, закрытого без исхода. Значение
                        // намеренно лежит вне перечня исходов вызова: вызов не завершился.
                        Effect.onInterrupt(() =>
                            Effect.sync(() => span.setAttribute('weragen.tool.outcome', 'interrupted')),
                        ),
                        Effect.ensuring(Effect.sync(() => span.end())),
                    );
                }),
        };
    }
}
