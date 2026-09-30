import { Injectable } from '@nestjs/common';
import { Effect } from 'effect';
import type { SessionEvent, SessionEventInput } from '@weragen/types';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { SessionEventBus } from './session-event-bus.service.js';

/** Событие исхода: им завершаются сессии видов `workflow` и `agent`. */
export type SessionOutcome = Extract<
    SessionEventInput,
    { type: 'session_completed' } | { type: 'session_failed' }
>;

/**
 * Журнал сессии: запись событий и рассылка их подписчикам.
 *
 * Порядковый номер берётся из счётчика событий сессии, увеличиваемого в той же транзакции,
 * что и вставка записи. Это даёт монотонную нумерацию без отдельной последовательности и
 * без гонки между параллельными записями.
 */
@Injectable()
export class SessionJournalService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly bus: SessionEventBus,
    ) {}

    /** Журнал для ядра, замкнутый на одну сессию. */
    forSession(sessionId: string) {
        return {
            append: (event: SessionEventInput): Effect.Effect<SessionEvent> =>
                Effect.promise(() => this.append(sessionId, event)),
        };
    }

    async append(sessionId: string, input: SessionEventInput): Promise<SessionEvent> {
        const row = await this.prisma.$transaction((tx) => insert(tx, sessionId, input));
        return this.publish(sessionId, row);
    }

    /**
     * Исход сессии: событие журнала и итоговое состояние записи.
     *
     * Записываются одной транзакцией, иначе могли бы разойтись: остановка сервера между двумя
     * записями оставила бы исход в журнале, а в записи — состояние `running`.
     *
     * Исход записывается один раз, и признаком служит само состояние записи: пока оно не
     * терминальное, исхода нет. Исход может прийти из нескольких мест, не упорядоченных между
     * собой, — у воркфлоу это сообщение процесса и наблюдение за его выходом, а после
     * перезапуска к ним добавляется сверка при запуске, — и повторный вызов ничего не делает.
     *
     * Возвращает, записан ли исход этим вызовом.
     */
    async settle(sessionId: string, outcome: SessionOutcome): Promise<boolean> {
        const row = await this.prisma.$transaction(async (tx) => {
            const { count } = await tx.session.updateMany({
                where: { id: sessionId, status: { in: ['idle', 'running'] } },
                data:
                    outcome.type === 'session_completed'
                        ? { status: 'completed', result: toJson(outcome.result), failureMessage: null }
                        : { status: 'failed', failureMessage: outcome.message },
            });
            return count === 0 ? null : insert(tx, sessionId, outcome);
        });
        if (row === null) return false;
        this.publish(sessionId, row);
        return true;
    }

    async read(sessionId: string, afterSeq = 0): Promise<SessionEvent[]> {
        const rows = await this.prisma.sessionEvent.findMany({
            where: { sessionId, seq: { gt: afterSeq } },
            orderBy: { seq: 'asc' },
        });
        return rows.map(toEvent);
    }

    private publish(sessionId: string, row: EventRow): SessionEvent {
        const event = toEvent(row);
        this.bus.publish(sessionId, event);
        return event;
    }
}

type EventRow = { type: string; seq: number; payload: unknown; createdAt: Date };

/** Вставка события с очередным порядковым номером. Выполняется внутри транзакции. */
async function insert(
    tx: Prisma.TransactionClient,
    sessionId: string,
    input: SessionEventInput,
): Promise<EventRow> {
    const { type, ...payload } = input;
    const session = await tx.session.update({
        where: { id: sessionId },
        // Отметка о последнем событии ставится здесь же: список сессий упорядочен по
        // ней, и вычислять её запросом по журналу пришлось бы на каждое чтение списка.
        data: { eventCount: { increment: 1 }, lastEventAt: new Date() },
        select: { eventCount: true },
    });
    return tx.sessionEvent.create({
        data: {
            sessionId,
            seq: session.eventCount,
            type,
            payload: payload as object,
        },
    });
}

const toEvent = (row: EventRow): SessionEvent =>
    ({
        ...(row.payload as object),
        type: row.type,
        seq: row.seq,
        at: row.createdAt.toISOString(),
    }) as SessionEvent;

/** Итог сессии для поля JSON. Отсутствие итога хранится пустым значением столбца. */
const toJson = (value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
    value === undefined || value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
