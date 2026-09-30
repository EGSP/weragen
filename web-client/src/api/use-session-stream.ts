import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionEvent } from '@weragen/types';
import { API_URL } from './generated/client.js';
import { sessionKeys } from './queries.js';

/** События, после которых состояние записи сессии отличается от прочитанного. */
const TERMINAL = new Set<SessionEvent['type']>([
    'turn_finished',
    'turn_failed',
    'session_completed',
    'session_failed',
]);

/**
 * Подписка на поток событий сессии.
 *
 * Ход агента не привязан к времени жизни соединения: он выполняется на сервере фоном, а
 * поток лишь показывает происходящее. Поэтому при переподключении клиент передаёт номер
 * последнего полученного события и догружает пропущенное, а повторы отбрасывает по номеру —
 * догрузка и живые события могут пересечься.
 */
export function useSessionStream(sessionId: string, initial: readonly SessionEvent[] | undefined) {
    const [events, setEvents] = useState<SessionEvent[]>([]);
    const seenRef = useRef<Set<number>>(new Set());
    const queryClient = useQueryClient();

    useEffect(() => {
        setEvents(initial === undefined ? [] : [...initial]);
        seenRef.current = new Set((initial ?? []).map((event) => event.seq));
    }, [sessionId, initial]);

    useEffect(() => {
        const lastSeq = Math.max(0, ...Array.from(seenRef.current));
        const source = new EventSource(
            `${API_URL}/api/sessions/${sessionId}/stream?after=${lastSeq}`,
        );

        source.addEventListener('event', (message) => {
            const event = JSON.parse((message as MessageEvent<string>).data) as SessionEvent;
            if (seenRef.current.has(event.seq)) return;
            seenRef.current.add(event.seq);
            setEvents((previous) => [...previous, event]);

            // Завершение хода либо сессии меняет состояние записи и порядок в списке, а
            // запись читается отдельным запросом, который сам о происходящем не узнаёт.
            //
            // Событий исхода здесь недоставало, и это было заметно именно на воркфлоу:
            // ходов у такой сессии нет вовсе, заканчивается она только исходом, и без него
            // состояние в заголовке оставалось «Выполняется» до перезагрузки страницы. У
            // агентской сессии исход сопровождается завершением хода, поэтому там состояние
            // обновлялось — но по событию соседней природы, а не по собственному.
            if (TERMINAL.has(event.type)) {
                void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
                void queryClient.invalidateQueries({ queryKey: sessionKeys.one(sessionId) });
            }
        });

        return () => source.close();
    }, [sessionId, queryClient]);

    return events;
}
