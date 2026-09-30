import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
    CreateMcpConnectionRequest,
    CreateModelProfileRequest,
    CreateWorkflowRequest,
    Session,
    StartWorkflowRunRequest,
    UpdateMcpConnectionRequest,
    UpdateModelProfileRequest,
    UpdateWorkflowRequest,
} from '@weragen/types';
import { api } from './generated/client.js';

export const sessionKeys = {
    all: ['sessions'] as const,
    ofKind: (kind: string) => ['sessions', 'kind', kind] as const,
    one: (id: string) => ['sessions', id] as const,
    events: (id: string) => ['sessions', id, 'events'] as const,
};

/**
 * Перечень сессий заданного вида. Отбор по виду разделяет разделы интерфейса: чаты и
 * исполнения воркфлоу показываются раздельно, хотя запись у них одна.
 */
export function useSessions(kind: 'chat' | 'workflow' = 'chat') {
    return useQuery({
        queryKey: sessionKeys.ofKind(kind),
        queryFn: async () => (await api.sessions.list(kind)).sessions,
    });
}

export function useSession(id: string) {
    return useQuery({
        queryKey: sessionKeys.one(id),
        queryFn: () => api.sessions.get(id),
    });
}

export function useSessionEvents(id: string) {
    return useQuery({
        queryKey: sessionKeys.events(id),
        queryFn: async () => (await api.sessions.events(id)).events,
    });
}

/**
 * Состав контекста сессии. Сервер вычисляет его на каждый запрос, поэтому версия в ключе
 * задаёт, когда спрашивать заново: по завершении хода и при смене модели. Прежний ответ
 * показывается, пока идёт новый, — иначе индикатор на время запроса оставался бы пустым.
 */
export function useSessionContext(id: string, version: string) {
    return useQuery({
        queryKey: [...sessionKeys.one(id), 'context', version],
        queryFn: () => api.sessions.context(id),
        placeholderData: keepPreviousData,
    });
}

export function useCreateSession() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (): Promise<Session> => api.sessions.create({}),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionKeys.all }),
    });
}

/**
 * Переименование сессии. Сбрасывается и запись сессии, и список: название показано в обоих
 * местах, и оставить одно из них прежним значило бы показать два разных названия сразу.
 */
export function useRenameSession() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, title }: { id: string; title: string }) =>
            api.sessions.rename(id, { title }),
        onSuccess: (session) => {
            void queryClient.invalidateQueries({ queryKey: sessionKeys.one(session.id) });
            void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
        },
    });
}

export function useDeleteSession() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => api.sessions.remove(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionKeys.all }),
    });
}

export function useSendMessage(id: string) {
    return useMutation({
        mutationFn: (text: string) => api.sessions.send(id, { text }),
    });
}

export function useInterrupt(id: string) {
    return useMutation({ mutationFn: () => api.sessions.interrupt(id) });
}

export const workflowKeys = { all: ['workflows'] as const };

export function useWorkflows() {
    return useQuery({
        queryKey: workflowKeys.all,
        queryFn: async () => (await api.workflows.list()).workflows,
    });
}

export function useCreateWorkflow() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreateWorkflowRequest) => api.workflows.create(body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: workflowKeys.all }),
    });
}

export function useUpdateWorkflow() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, body }: { id: string; body: UpdateWorkflowRequest }) =>
            api.workflows.update(id, body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: workflowKeys.all }),
    });
}

export function useDeleteWorkflow() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => api.workflows.remove(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: workflowKeys.all }),
    });
}

/** Повторная проверка требований: платформа запускает процесс и запрашивает спецификацию. */
export function useCheckWorkflow() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => api.workflows.check(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: workflowKeys.all }),
    });
}

export function useStartWorkflowRun() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: StartWorkflowRunRequest): Promise<Session> => api.workflows.start(body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionKeys.ofKind('workflow') }),
    });
}

export const mcpKeys = { all: ['mcp'] as const };

/**
 * Справочник подключений MCP. Правка любой карточки обесценивает перечень инструментов
 * платформы, поэтому мутации сбрасывают и его.
 */
export function useMcpConnections() {
    return useQuery({
        queryKey: mcpKeys.all,
        queryFn: async () => (await api.mcp.list()).connections,
    });
}

function useMcpMutation<Variables, Result>(
    mutationFn: (variables: Variables) => Promise<Result>,
) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn,
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: mcpKeys.all });
            void queryClient.invalidateQueries({ queryKey: ['tools'] });
            void queryClient.invalidateQueries({ queryKey: workflowKeys.all });
        },
    });
}

export function useCreateMcpConnection() {
    return useMcpMutation((body: CreateMcpConnectionRequest) => api.mcp.create(body));
}

/** Импорт конфигурации в сложившемся формате MCP-клиентов: одна вставка — набор карточек. */
export function useImportMcpConnections() {
    return useMcpMutation((json: string) => api.mcp.import({ json }));
}

export function useUpdateMcpConnection() {
    return useMcpMutation(({ id, body }: { id: string; body: UpdateMcpConnectionRequest }) =>
        api.mcp.update(id, body),
    );
}

export function useDeleteMcpConnection() {
    return useMcpMutation((id: string) => api.mcp.remove(id));
}

/** Повторное обнаружение: платформа подключается к серверу и запрашивает перечень. */
export function useCheckMcpConnection() {
    return useMcpMutation((id: string) => api.mcp.check(id));
}

export function useToggleMcpConnection() {
    return useMcpMutation(({ id, enabled }: { id: string; enabled: boolean }) =>
        api.mcp.toggle(id, { enabled }),
    );
}

export const modelKeys = { all: ['models'] as const };

/**
 * Справочник моделей: записи вместе с сессиями, в которых сейчас идёт ход на каждой из них.
 *
 * @param refetchInterval Период опроса. Задаёт его страница справочника: перечень активных
 * сессий меняется без её участия.
 */
export function useModelRegistry(refetchInterval?: number) {
    return useQuery({
        queryKey: modelKeys.all,
        queryFn: () => api.models.list(),
        refetchInterval,
    });
}

export function useModels() {
    const registry = useModelRegistry();
    return { ...registry, data: registry.data?.models };
}

export function useCreateModel() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreateModelProfileRequest) => api.models.create(body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: modelKeys.all }),
    });
}

export function useUpdateModel() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, body }: { id: string; body: UpdateModelProfileRequest }) =>
            api.models.update(id, body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: modelKeys.all }),
    });
}

export function useDeleteModel() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => api.models.remove(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: modelKeys.all }),
    });
}

/**
 * Перечень моделей провайдера — источник вариантов при добавлении в справочник.
 * Обновляется нечасто: состав каталога меняется редко.
 */
export function useProviderModels() {
    return useQuery({
        queryKey: ['provider-models'],
        queryFn: () => api.yandexModels.list(),
        staleTime: 5 * 60 * 1000,
    });
}

/** Немедленная перепроверка доступности всех записей справочника. */
export function useCheckAvailability() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => api.yandexModels.check(),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: modelKeys.all }),
    });
}

/** Смена модели сессии. Сервер отклонит её, если ход идёт. */
export function useSelectSessionModel(sessionId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (modelId: string) => api.sessions.selectModel(sessionId, { modelId }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: sessionKeys.one(sessionId) });
            void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
        },
    });
}

export function useTools() {
    return useQuery({
        queryKey: ['tools'],
        queryFn: async () => (await api.sessions.listTools()).tools,
        staleTime: Infinity,
    });
}
