import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractControllers } from './extract.js';
import { writeClient, type ClientTarget } from './write-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const SERVER_TSCONFIG = resolve(repoRoot, 'server/tsconfig.json');

/**
 * Цели генерации: веб-клиент и пакет воркфлоу. Оба получают один и тот же клиент,
 * различаясь только тем, откуда берётся базовый адрес.
 */
const TARGETS: ReadonlyArray<{ output: string; target: ClientTarget }> = [
    {
        output: resolve(repoRoot, 'web-client/src/api/generated/client.ts'),
        target: { baseUrl: "import.meta.env.VITE_API_URL ?? 'http://localhost:3100'" },
    },
    {
        output: resolve(repoRoot, 'workflow/src/api/generated/client.ts'),
        target: {
            baseUrl:
                "process.env['WERAGEN_PLATFORM_URL'] ?? 'http://127.0.0.1:3100'",
        },
    },
];

/**
 * Порождение клиента API из контроллеров сервера.
 *
 * Источник истины — код контроллеров: маршруты и типы берутся оттуда, поэтому расхождение
 * между сервером и клиентом обнаруживается проверкой типов, а не в работающем приложении.
 */
export async function generateClient(): Promise<void> {
    const groups = extractControllers(SERVER_TSCONFIG);
    const routeCount = groups.reduce((total, group) => total + group.routes.length, 0);

    for (const { output, target } of TARGETS) {
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, writeClient(groups, target), 'utf8');
        console.log(`клиент записан: ${output}`);
    }

    console.log(`групп: ${groups.length}, маршрутов: ${routeCount}`);
}
