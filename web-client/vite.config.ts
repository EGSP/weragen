import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Переменные читаются из общего `.env` в корне репозитория: конфигурация всей платформы
// хранится в одном месте, а не размножается по пакетам.
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, resolve(process.cwd(), '..'), '');
    return {
        plugins: [react()],
        envDir: resolve(process.cwd(), '..'),
        server: {
            // Явная привязка к IPv4: по умолчанию Vite слушает только [::1], и обращения
            // к 127.0.0.1 из инструментов, не поддерживающих IPv6, не проходят.
            host: '127.0.0.1',
            port: Number(env.VITE_PORT ?? 5273),
            strictPort: true,
        },
    };
});
