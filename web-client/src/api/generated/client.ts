// Файл порождается автоматически: npm run generate:client
// Правки будут потеряны при следующей генерации.

import type { AcceptedResponse, BackfillModelsResponse, CreateMcpConnectionRequest, CreateModelProfileRequest, CreateSessionRequest, CreateWorkflowRequest, ImportMcpConnectionsRequest, McpConnection, McpConnectionListResponse, McpImportResponse, ModelListResponse, ModelProfile, ProviderModelsResponse, RenameSessionRequest, RequestSnapshot, SelectModelRequest, SendMessageRequest, Session, SessionContextResponse, SessionEventsResponse, SessionListResponse, StartWorkflowRunRequest, ToggleMcpConnectionRequest, ToolListResponse, UpdateMcpConnectionRequest, UpdateModelProfileRequest, UpdateWorkflowRequest, Workflow, WorkflowListResponse, WorkflowResultReport, WorkflowStepReport } from '@weragen/types';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3100';

/** Собирает строку запроса, пропуская незаданные значения. */
function toQuery(values: Record<string, string>): string {
    const search = new URLSearchParams(values).toString();
    return search === '' ? '' : `?${search}`;
}

async function request<Result>(
    method: string,
    path: string,
    body?: unknown,
): Promise<Result> {
    const response = await fetch(`${API_URL}${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
        // Тело ответа Nest содержит поле message с причиной; она информативнее кода.
        const detail = await response.json().catch(() => null);
        const message =
            detail !== null && typeof detail === 'object' && 'message' in detail
                ? String((detail as { message: unknown }).message)
                : `HTTP ${response.status}`;
        throw new Error(message);
    }

    if (response.status === 204) return undefined as Result;
    return (await response.json()) as Result;
}

export const api = {
    mcp: {
        list: (): Promise<McpConnectionListResponse> =>
            request('GET', `/api/mcp`),
        create: (body: CreateMcpConnectionRequest): Promise<McpConnection> =>
            request('POST', `/api/mcp`, body),
        import: (body: ImportMcpConnectionsRequest): Promise<McpImportResponse> =>
            request('POST', `/api/mcp/import`, body),
        get: (id: string): Promise<McpConnection> =>
            request('GET', `/api/mcp/${id}`),
        update: (id: string, body: UpdateMcpConnectionRequest): Promise<McpConnection> =>
            request('PATCH', `/api/mcp/${id}`, body),
        remove: (id: string): Promise<AcceptedResponse> =>
            request('DELETE', `/api/mcp/${id}`),
        check: (id: string): Promise<McpConnection> =>
            request('POST', `/api/mcp/${id}/check`),
        toggle: (id: string, body: ToggleMcpConnectionRequest): Promise<McpConnection> =>
            request('POST', `/api/mcp/${id}/toggle`, body),
    },
    models: {
        list: (): Promise<ModelListResponse> =>
            request('GET', `/api/models`),
        create: (body: CreateModelProfileRequest): Promise<ModelProfile> =>
            request('POST', `/api/models`, body),
        update: (id: string, body: UpdateModelProfileRequest): Promise<ModelProfile> =>
            request('PATCH', `/api/models/${id}`, body),
        remove: (id: string): Promise<AcceptedResponse> =>
            request('DELETE', `/api/models/${id}`),
    },
    sessions: {
        list: (kind?: string): Promise<SessionListResponse> =>
            request('GET', `/api/sessions` + toQuery({ ...(kind === undefined ? {} : { kind: String(kind) }) })),
        create: (body: CreateSessionRequest): Promise<Session> =>
            request('POST', `/api/sessions`, body),
        backfillModels: (): Promise<BackfillModelsResponse> =>
            request('POST', `/api/sessions/models/backfill`),
        listTools: (): Promise<ToolListResponse> =>
            request('GET', `/api/sessions/tools`),
        snapshot: (snapshotId: string): Promise<RequestSnapshot> =>
            request('GET', `/api/sessions/snapshots/${snapshotId}`),
        get: (id: string): Promise<Session> =>
            request('GET', `/api/sessions/${id}`),
        rename: (id: string, body: RenameSessionRequest): Promise<Session> =>
            request('PATCH', `/api/sessions/${id}`, body),
        remove: (id: string): Promise<AcceptedResponse> =>
            request('DELETE', `/api/sessions/${id}`),
        events: (id: string, after?: string): Promise<SessionEventsResponse> =>
            request('GET', `/api/sessions/${id}/events` + toQuery({ ...(after === undefined ? {} : { after: String(after) }) })),
        send: (id: string, body: SendMessageRequest): Promise<AcceptedResponse> =>
            request('POST', `/api/sessions/${id}/messages`, body),
        context: (id: string): Promise<SessionContextResponse> =>
            request('GET', `/api/sessions/${id}/context`),
        selectModel: (id: string, body: SelectModelRequest): Promise<Session> =>
            request('POST', `/api/sessions/${id}/model`, body),
        interrupt: (id: string): Promise<AcceptedResponse> =>
            request('POST', `/api/sessions/${id}/interrupt`),
    },
    workflows: {
        list: (): Promise<WorkflowListResponse> =>
            request('GET', `/api/workflows`),
        create: (body: CreateWorkflowRequest): Promise<Workflow> =>
            request('POST', `/api/workflows`, body),
        start: (body: StartWorkflowRunRequest): Promise<Session> =>
            request('POST', `/api/workflows/runs`, body),
        report: (sessionId: string, body: WorkflowStepReport): Promise<AcceptedResponse> =>
            request('POST', `/api/workflows/runs/${sessionId}/steps`, body),
        finish: (sessionId: string, body: WorkflowResultReport): Promise<AcceptedResponse> =>
            request('POST', `/api/workflows/runs/${sessionId}/result`, body),
        get: (id: string): Promise<Workflow> =>
            request('GET', `/api/workflows/${id}`),
        update: (id: string, body: UpdateWorkflowRequest): Promise<Workflow> =>
            request('PATCH', `/api/workflows/${id}`, body),
        remove: (id: string): Promise<AcceptedResponse> =>
            request('DELETE', `/api/workflows/${id}`),
        check: (id: string): Promise<Workflow> =>
            request('POST', `/api/workflows/${id}/check`),
    },
    yandexModels: {
        list: (): Promise<ProviderModelsResponse> =>
            request('GET', `/api/yandex/models`),
        check: (): Promise<AcceptedResponse> =>
            request('POST', `/api/yandex/models/check`),
    },
};
