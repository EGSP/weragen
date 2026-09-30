import { Injectable } from '@nestjs/common';
import { ROOT_CONTEXT, trace, TraceFlags, type Context, type Span } from '@opentelemetry/api';

/**
 * Контексты трассировки работающих сессий.
 *
 * Дерево спанов строится из дерева сессий, а не передачей контекста между процессами.
 * Платформа и так знает, какая сессия какую породила: `parentId` заполняется при создании
 * любой дочерней сессии. Поэтому достаточно помнить контекст каждой работающей сессии, и
 * дочерняя привязывается к родительской без единой строки на стороне воркфлоу.
 *
 * Полагаться на неявное распространение контекста нельзя: волокна Effect продолжаются в
 * микрозадачах, а исполнение воркфлоу вообще идёт в другом процессе. Контекст поэтому
 * хранится явно и передаётся параметром.
 *
 * Запись живёт ровно столько, сколько идёт работа. У чат-сессии это один ход: между
 * ходами активного спана нет, и дочерняя сессия, созданная позже, привязалась бы к уже
 * закрытому.
 */
@Injectable()
export class SessionTraceRegistry {
    private readonly contexts = new Map<string, Context>();

    /** Запоминает контекст на время работы сессии. */
    open(sessionId: string, span: Span, parent: Context = ROOT_CONTEXT): Context {
        const context = trace.setSpan(parent, span);
        this.contexts.set(sessionId, context);
        return context;
    }

    close(sessionId: string): void {
        this.contexts.delete(sessionId);
    }

    contextOf(sessionId: string): Context {
        return this.contexts.get(sessionId) ?? ROOT_CONTEXT;
    }

    /**
     * Контекст родителя. Пусто означает, что родителя нет либо его работа уже завершена —
     * и то и другое даёт корневой спан, что верно: привязывать к закрытому спану нечего.
     */
    parentOf(parentId: string | null | undefined): Context {
        if (parentId === null || parentId === undefined) return ROOT_CONTEXT;
        return this.contextOf(parentId);
    }

    /**
     * Контекст родителя с учётом явно переданного `traceparent`.
     *
     * Переданное значение имеет приоритет над деревом сессий: оно точнее. Дерево сессий
     * привязывает потомка к исполнению целиком, а `traceparent` — к тому месту работы, где
     * потомок действительно создан.
     */
    parentFor(parentId: string | null | undefined, traceparent: string | undefined): Context {
        const explicit = contextFromTraceparent(traceparent);
        return explicit ?? this.parentOf(parentId);
    }

    /**
     * Заголовок `traceparent` для контекста сессии в формате W3C Trace Context.
     *
     * Собирается вручную, а не через глобальный распространитель: значение нужно передать
     * процессу воркфлоу в теле запроса, а не в заголовках исходящего обращения, и заводить
     * ради этого носитель заголовков незачем.
     */
    traceparentOf(sessionId: string): string | undefined {
        const context = this.contexts.get(sessionId);
        if (context === undefined) return undefined;
        const spanContext = trace.getSpanContext(context);
        if (spanContext === undefined) return undefined;
        const flags = (spanContext.traceFlags & 0x1).toString(16).padStart(2, '0');
        return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
    }
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Разбор заголовка W3C. Неразобранное значение равносильно отсутствующему. */
function contextFromTraceparent(traceparent: string | undefined): Context | undefined {
    if (traceparent === undefined) return undefined;
    const parts = TRACEPARENT.exec(traceparent.trim());
    if (parts === null) return undefined;
    return trace.setSpanContext(ROOT_CONTEXT, {
        traceId: parts[1]!,
        spanId: parts[2]!,
        traceFlags: Number.parseInt(parts[3]!, 16) & TraceFlags.SAMPLED,
        isRemote: true,
    });
}
