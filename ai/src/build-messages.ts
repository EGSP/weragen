import type { SessionEvent } from '@weragen/types';
import type { AgentMessage, AgentToolCall } from './messages.js';
import { formatToolError } from './tool.js';

/**
 * Сборка массива сообщений для модели из журнала событий.
 *
 * Функция чистая: журнал и системный промпт на входе, массив сообщений на выходе, никаких
 * обращений к базе и внешним системам. Это даёт два свойства. Во-первых, вся логика
 * управления контекстом — а позже сжатие истории и свёртка результатов — тестируется на
 * зафиксированных журналах без обращения к модели. Во-вторых, по журналу восстанавливается
 * ровно тот запрос, который был отправлен.
 *
 * Сведения об ответах модели — расход и рассуждение — и итоги хода в диалог не попадают:
 * модель не ждёт их обратно.
 */
export function buildMessages(
    systemPrompt: string,
    events: readonly SessionEvent[],
): AgentMessage[] {
    const messages: AgentMessage[] = [{ role: 'system', content: systemPrompt }];

    type PendingStep = {
        step: number;
        note: string;
        calls: AgentToolCall[];
        /** Результаты в порядке поступления: сопоставление идёт по идентификатору, а при
         * его повторе — по порядку. Часть моделей возвращает вместо идентификатора имя
         * инструмента, и тогда все вызовы одного инструмента в шаге неразличимы по нему. */
        results: { callId: string; content: string; taken: boolean }[];
    };
    let pending: PendingStep | undefined;

    const flush = (): void => {
        if (pending === undefined) return;
        const { note, calls, results } = pending;
        const takeResult = (callId: string): string | undefined => {
            const byId = results.find((entry) => !entry.taken && entry.callId === callId);
            const entry = byId ?? results.find((candidate) => !candidate.taken);
            if (entry === undefined) return undefined;
            entry.taken = true;
            return entry.content;
        };
        pending = undefined;
        if (calls.length === 0) {
            if (note !== '') messages.push({ role: 'assistant', content: note, toolCalls: [] });
            return;
        }
        messages.push({ role: 'assistant', content: note, toolCalls: calls });
        for (const call of calls) {
            // Вызов без результата остаётся после прерванного хода. Отправить его модели
            // как есть нельзя: API требует ответа на каждый вызов. Подставляем явный отказ —
            // так модель узнаёт, что действие не состоялось, и не считает его выполненным.
            const result =
                takeResult(call.id) ??
                formatToolError(
                    'Вызов не был завершён: ход прерван.',
                    'Если действие всё ещё нужно, повтори вызов.',
                );
            messages.push({ role: 'tool', callId: call.id, content: result });
        }
    };

    const ensureStep = (step: number): PendingStep => {
        if (pending !== undefined && pending.step !== step) flush();
        if (pending === undefined) {
            pending = { step, note: '', calls: [], results: [] };
        }
        return pending;
    };

    for (const event of events) {
        switch (event.type) {
            case 'user_message':
                flush();
                messages.push({ role: 'user', content: event.text });
                break;
            case 'assistant_note':
                ensureStep(event.step).note = event.text;
                break;
            case 'tool_call':
                ensureStep(event.step).calls.push({
                    id: event.callId,
                    name: event.name,
                    rawArguments: event.rawArguments,
                });
                break;
            case 'tool_result':
                ensureStep(event.step).results.push({
                    callId: event.callId,
                    content: event.content,
                    taken: false,
                });
                break;
            case 'assistant_message':
                flush();
                messages.push({ role: 'assistant', content: event.text, toolCalls: [] });
                break;
            case 'step_started':
            case 'model_reply':
            case 'assistant_reasoning':
            case 'turn_finished':
            case 'turn_failed':
                break;
        }
    }

    flush();
    return messages;
}
