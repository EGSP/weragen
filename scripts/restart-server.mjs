import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * Перезапуск серверного процесса. Скрипт вызывается процессом сборки по записи файлов.
 *
 * Перезапуск делается одной командой pm2. Прежде здесь была последовательность «остановить —
 * дождаться освобождения порта — запустить»: она понадобилась потому, что процесс прекращался
 * сигналом и не успевал закрыть слушающий сокет, отчего следующий запуск получал EADDRINUSE.
 * Теперь приложение завершается добровольно по сообщению «shutdown» (`shutdown_with_message`
 * в ecosystem.config.cjs), pm2 дожидается выхода процесса, и разделять остановку и запуск
 * незачем.
 *
 * pm2 вызывается не через `npx`, а прямым обращением к его файлу запуска, и без оболочки.
 * Причина в том, что `npx` в Windows существует только командным файлом: его вызов требует
 * `shell`, то есть порождает cmd.exe и ещё один процесс Node сверх самого pm2, и каждому из
 * них, поскольку у демона pm2 нет консоли, система выделяет отдельное консольное окно.
 * Параметр `windowsHide` закрывает оставшийся случай.
 */

const APP = 'weragen-server';
const PORT = Number(process.env.PORT ?? 3100);
const READY_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

const PM2 = fileURLToPath(new URL('../node_modules/pm2/bin/pm2', import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Порт считается занятым, когда соединение с ним устанавливается. */
function isPortTaken(port) {
    return new Promise((resolve) => {
        const socket = createConnection({ port, host: '127.0.0.1' });
        const finish = (taken) => {
            socket.destroy();
            resolve(taken);
        };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.setTimeout(1000, () => finish(false));
    });
}

async function waitForReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await isPortTaken(PORT)) return true;
        await sleep(POLL_INTERVAL_MS);
    }
    return false;
}

execFileSync(process.execPath, [PM2, 'restart', APP], {
    stdio: 'inherit',
    windowsHide: true,
});

// Ожидание готовности не влияет на сам перезапуск и нужно ради журнала: молчаливо
// не поднявшийся сервер иначе обнаруживается только со стороны браузера.
if (!(await waitForReady())) {
    console.error(
        `Сервер не занял порт ${PORT} за ${READY_TIMEOUT_MS / 1000} с после перезапуска. ` +
            'Причина видна в журнале приложения: npm run logs:server.',
    );
    process.exit(1);
}
