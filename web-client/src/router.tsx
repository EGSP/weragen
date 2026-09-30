import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { Layout } from './components/Layout.js';
import { EmptyState } from './components/EmptyState.js';
import { SessionView } from './components/SessionView.js';
import { McpPage } from './components/McpPage.js';
import { ModelsPage } from './components/ModelsPage.js';
import { WorkflowsPage } from './components/WorkflowsPage.js';
import { WorkflowRunView } from './components/WorkflowRunView.js';

const rootRoute = createRootRoute({
    component: () => (
        <Layout>
            <Outlet />
        </Layout>
    ),
});

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: EmptyState,
});

const sessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/$sessionId',
    component: SessionView,
});

/**
 * Раздел воркфлоу: реестр карточек и исполнения. Исполнение показывается отдельным
 * маршрутом, а не общим маршрутом сессии, потому что список справа в этом разделе отбирает
 * исполнения, а не чаты.
 */
const workflowsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflows',
    component: WorkflowsPage,
});

const workflowRunRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflows/runs/$sessionId',
    component: WorkflowRunView,
});

const mcpRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mcp',
    component: McpPage,
});

const modelsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/models',
    component: ModelsPage,
});

const routeTree = rootRoute.addChildren([
    indexRoute,
    sessionRoute,
    workflowsRoute,
    workflowRunRoute,
    mcpRoute,
    modelsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}
