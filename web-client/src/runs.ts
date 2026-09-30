import type { SessionEvent, SessionKind, WorkflowStepState } from '@weragen/types';

/**
 * Исполнение воркфлоу в форме, удобной для отрисовки.
 *
 * У сессии воркфлоу нет ходов: агентского цикла в ней не происходит вовсе. Есть вход,
 * последовательность шагов, порождённые дочерние сессии и итог. Поэтому и модель другая,
 * чем у чата, хотя журнал и поток событий у них общие.
 *
 * Шаг собирается из двух событий — начала и завершения — в одну запись: в журнале они
 * лежат порознь, но читаются как одно, и разнесённые по списку они разрывали бы порядок
 * работы.
 */

export type RunItem =
    | {
          readonly kind: 'started';
          readonly key: string;
          readonly workflowName: string;
          readonly version: string | null;
          readonly input: unknown;
      }
    | {
          readonly kind: 'step';
          readonly key: string;
          readonly stepId: string;
          readonly name: string;
          readonly parentStepId?: string;
          state: WorkflowStepState;
          detail?: string;
          /** Длительность по часам воркфлоу; приходит с завершающим сообщением. */
          durationMs?: number;
      }
    | {
          readonly kind: 'child';
          readonly key: string;
          readonly childId: string;
          readonly childKind: SessionKind;
          readonly title: string;
      }
    | { readonly kind: 'completed'; readonly key: string; readonly result: unknown }
    | { readonly kind: 'failed'; readonly key: string; readonly message: string };

export type RunView = {
    readonly items: RunItem[];
    /** Исполнение ещё идёт: итогового события не было. */
    readonly running: boolean;
};

export function groupRun(events: readonly SessionEvent[]): RunView {
    const items: RunItem[] = [];
    const steps = new Map<string, Extract<RunItem, { kind: 'step' }>>();
    let settled = false;

    for (const event of events) {
        switch (event.type) {
            case 'workflow_started':
                items.push({
                    kind: 'started',
                    key: `s-${event.seq}`,
                    workflowName: event.workflowName,
                    version: event.version,
                    input: event.input,
                });
                break;

            case 'workflow_step': {
                const existing = steps.get(event.stepId);
                if (existing === undefined) {
                    const step: Extract<RunItem, { kind: 'step' }> = {
                        kind: 'step',
                        key: `w-${event.seq}`,
                        stepId: event.stepId,
                        name: event.name,
                        state: event.state,
                        ...(event.parentStepId === undefined
                            ? {}
                            : { parentStepId: event.parentStepId }),
                        ...(event.detail === undefined ? {} : { detail: event.detail }),
                        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
                    };
                    steps.set(event.stepId, step);
                    items.push(step);
                    break;
                }
                existing.state = event.state;
                if (event.detail !== undefined) existing.detail = event.detail;
                if (event.durationMs !== undefined) existing.durationMs = event.durationMs;
                break;
            }

            case 'child_session_started':
                items.push({
                    kind: 'child',
                    key: `c-${event.seq}`,
                    childId: event.childId,
                    childKind: event.kind,
                    title: event.title,
                });
                break;

            case 'session_completed':
                items.push({ kind: 'completed', key: `f-${event.seq}`, result: event.result });
                settled = true;
                break;

            case 'session_failed':
                items.push({ kind: 'failed', key: `f-${event.seq}`, message: event.message });
                settled = true;
                break;

            default:
                break;
        }
    }

    return { items, running: !settled };
}
