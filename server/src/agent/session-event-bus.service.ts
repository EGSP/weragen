import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import type { SessionEvent } from '@weragen/types';

/**
 * Рассылка событий сессии подписчикам.
 *
 * Живёт в памяти процесса и намеренно не является хранилищем: источник истины — журнал в
 * базе. Клиент, переподключившийся после обрыва, догружает пропущенное по порядковому
 * номеру, а шина отдаёт только то, что происходит сейчас.
 */
@Injectable()
export class SessionEventBus {
    private readonly subjects = new Map<string, Subject<SessionEvent>>();

    publish(sessionId: string, event: SessionEvent): void {
        this.subjects.get(sessionId)?.next(event);
    }

    stream(sessionId: string): Observable<SessionEvent> {
        let subject = this.subjects.get(sessionId);
        if (subject === undefined) {
            subject = new Subject<SessionEvent>();
            this.subjects.set(sessionId, subject);
        }
        return subject.asObservable();
    }

    close(sessionId: string): void {
        this.subjects.get(sessionId)?.complete();
        this.subjects.delete(sessionId);
    }
}
