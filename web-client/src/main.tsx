import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { App as AntApp, ConfigProvider } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import { router } from './router.js';
import './index.css';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            // Данные приходят событиями через поток, поэтому опрос по таймеру не нужен.
            refetchOnWindowFocus: false,
            retry: 1,
        },
    },
});

const root = document.getElementById('root');
if (root === null) throw new Error('Элемент #root не найден');

createRoot(root).render(
    <StrictMode>
        <ConfigProvider locale={ruRU}>
            <AntApp>
                <QueryClientProvider client={queryClient}>
                    <RouterProvider router={router} />
                </QueryClientProvider>
            </AntApp>
        </ConfigProvider>
    </StrictMode>,
);
