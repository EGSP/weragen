import { Injectable, Logger } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { AppConfigService } from '../config/app-config.service.js';
import { needsShell, resolveCommand } from '../common/spawn.js';

/**
 * Надзор за процессами воркфлоу.
 *
 * Процесс запускается на каждое исполнение, отрабатывает и завершается; постоянно
 * работающих процессов воркфлоу нет. Отсюда три следствия, определяющие устройство этой
 * службы. Подтверждение активности не требуется — платформа держит дескриптор дочернего
 * процесса и наблюдает его состояние непосредственно. Изоляция исполнений достигается сама
 * собой, потому что параллельные исполнения суть разные процессы. Потеря связи вырождается
 * в событие выхода.
 *
 * На время исполнения процесс обслуживает HTTP: вход передаётся вызовом, а не командной
 * строкой, и прерывание идёт двумя ступенями — сначала запрос на прекращение работы, затем
 * принудительное завершение. Первая ступень существенна именно в Windows, где набор
 * сигналов ограничен и корректное завершение по сигналу не гарантируется.
 */

/** Описание запуска: то, что хранится в карточке реестра. */
export type ProcessLaunch = {
    readonly name: string;
    readonly packagePath: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
};

export class ProcessFailure extends Error {
    constructor(
        message: string,
        readonly output: string,
    ) {
        super(message);
        this.name = 'ProcessFailure';
    }
}

/** Запущенный процесс воркфлоу. */
export type WorkflowProcess = {
    readonly port: number;
    /** Разрешается кодом выхода; `null`, если процесс завершён сигналом. */
    readonly exited: Promise<number | null>;
    readonly output: () => string;
    readonly call: <Result>(method: string, path: string, body?: unknown) => Promise<Result>;
    /** Двухступенчатое прекращение: запрос, затем принудительное завершение. */
    readonly stop: (runId?: string) => Promise<void>;
};

/** Хвост вывода процесса, сохраняемый для диагностики. Больше в сообщение об отказе не влезет. */
const OUTPUT_TAIL_CHARS = 4000;

@Injectable()
export class WorkflowProcessService {
    private readonly logger = new Logger(WorkflowProcessService.name);
    /** Порты, выданные работающим исполнениям. Выбор порта — за платформой, а не за процессом. */
    private readonly allocated = new Set<number>();
    private running = 0;

    constructor(private readonly config: AppConfigService) {}

    get activeCount(): number {
        return this.running;
    }

    /**
     * Порождает процесс и дожидается готовности. Процесс, не ответивший за отведённое
     * время, завершается принудительно, а запуск считается неудавшимся: держать процесс,
     * о готовности которого ничего не известно, значит держать занятый порт без пользы.
     */
    async launch(launch: ProcessLaunch): Promise<WorkflowProcess> {
        const limit = this.config.workflows.maxProcesses;
        if (this.running >= limit) {
            throw new ProcessFailure(
                `Достигнут предел одновременно работающих процессов воркфлоу (${limit}). ` +
                    'Дождитесь завершения текущих исполнений либо увеличьте WORKFLOW_MAX_PROCESSES.',
                '',
            );
        }

        const port = await this.takePort();
        this.running += 1;

        let child: ChildProcess;
        try {
            child = spawn(resolveCommand(launch.command), [...launch.args], {
                cwd: launch.packagePath,
                env: {
                    ...process.env,
                    ...launch.env,
                    WERAGEN_PORT: String(port),
                    WERAGEN_PLATFORM_URL: this.config.publicUrl,
                    WERAGEN_WORKFLOW_NAME: launch.name,
                    // Адрес приёмника трасс — свойство развёртывания, а не исполнения,
                    // поэтому передаётся окружением. Пустое значение означает, что
                    // трассировка выключена, и процесс не создаёт экспортёр вовсе.
                    WERAGEN_OTEL_ENDPOINT: this.config.tracing.enabled
                        ? this.config.tracing.endpoint
                        : '',
                    WERAGEN_OTEL_SERVICE_NAME: this.config.tracing.serviceName,
                    WERAGEN_OTEL_CAPTURE_CONTENT: String(this.config.tracing.captureContent),
                },
                // Оболочка нужна только командным файлам: `npx` и `npm` в Windows
                // существуют лишь в этом виде и напрямую не исполняются. Включать её
                // всегда нельзя — cmd.exe не справляется с рабочим каталогом, в пути
                // которого есть символы вне текущей кодовой страницы.
                shell: needsShell(launch.command),
                // Консольное окно процессу не выделяется. В Windows приложение с консольным
                // интерфейсом получает собственное окно, если у породившего его процесса
                // консоли нет, а у платформы под управлением pm2 её нет; без этого параметра
                // каждое исполнение воркфлоу сопровождалось бы появлением окна.
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (cause) {
            this.release(port);
            throw new ProcessFailure(`Не удалось запустить процесс: ${describe(cause)}`, '');
        }

        let tail = '';
        const collect = (chunk: Buffer): void => {
            const text = chunk.toString('utf8');
            tail = (tail + text).slice(-OUTPUT_TAIL_CHARS);
            for (const line of text.split(/\r?\n/)) {
                if (line.trim() !== '') this.logger.debug(`[${launch.name}] ${line}`);
            }
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);

        let released = false;
        const exited = new Promise<number | null>((resolve) => {
            child.once('exit', (code) => {
                if (!released) {
                    released = true;
                    this.release(port);
                }
                resolve(code);
            });
            child.once('error', (error) => {
                tail = (tail + `\n${error.message}`).slice(-OUTPUT_TAIL_CHARS);
                if (!released) {
                    released = true;
                    this.release(port);
                }
                resolve(null);
            });
        });

        const base = `http://127.0.0.1:${port}`;
        const call = async <Result>(method: string, path: string, body?: unknown): Promise<Result> =>
            request<Result>(base, method, path, body);

        const stop = async (runId?: string): Promise<void> => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            if (runId !== undefined) {
                // Первая ступень: процесс получает возможность прекратить работу сам и
                // освободить занятое. Отказ обращения здесь не важен — за ним идёт вторая.
                await call('POST', `/runs/${encodeURIComponent(runId)}/cancel`).catch(
                    () => undefined,
                );
                const finished = await Promise.race([
                    exited.then(() => true),
                    delay(this.config.workflows.cancelTimeoutMs).then(() => false),
                ]);
                if (finished) return;
            }
            child.kill();
            await Promise.race([exited, delay(2000)]);
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await exited;
        };

        const process_: WorkflowProcess = { port, exited, output: () => tail, call, stop };

        try {
            await this.waitReady(process_, launch.name);
        } catch (error) {
            await stop();
            throw error;
        }

        return process_;
    }

    /**
     * Ожидание готовности опросом `GET /health`. Опрос, а не одна попытка: процесс поднимает
     * сервер не мгновенно, и отказ соединения в первые сотни миллисекунд — обычное дело,
     * а не признак неисправности.
     */
    private async waitReady(target: WorkflowProcess, name: string): Promise<void> {
        const deadline = Date.now() + this.config.workflows.readyTimeoutMs;
        let lastError = 'ответа нет';

        while (Date.now() < deadline) {
            const exitedAlready = await Promise.race([
                target.exited.then(() => true),
                delay(0).then(() => false),
            ]);
            if (exitedAlready) {
                throw new ProcessFailure(
                    `Процесс воркфлоу "${name}" завершился, не начав обслуживать запросы.`,
                    target.output(),
                );
            }

            try {
                await target.call('GET', '/health');
                return;
            } catch (cause) {
                lastError = describe(cause);
            }
            await delay(200);
        }

        throw new ProcessFailure(
            `Процесс воркфлоу "${name}" не ответил на /health за ` +
                `${this.config.workflows.readyTimeoutMs} мс: ${lastError}.`,
            target.output(),
        );
    }

    /**
     * Выбор порта. Свободность проверяется попыткой занять порт, а не только перечнем уже
     * выданных: в диапазоне может оказаться посторонняя служба, и тогда запуск провалился
     * бы на ожидании готовности, а причина осталась бы неочевидной.
     */
    private async takePort(): Promise<number> {
        const { portRangeStart, portRangeSize } = this.config.workflows;
        for (let offset = 0; offset < portRangeSize; offset++) {
            const port = portRangeStart + offset;
            if (this.allocated.has(port)) continue;
            if (!(await isFree(port))) continue;
            this.allocated.add(port);
            return port;
        }
        throw new ProcessFailure(
            `Свободного порта в диапазоне ${portRangeStart}–${portRangeStart + portRangeSize - 1} ` +
                'не нашлось. Расширьте WORKFLOW_PORT_RANGE_SIZE.',
            '',
        );
    }

    private release(port: number): void {
        this.allocated.delete(port);
        this.running = Math.max(0, this.running - 1);
    }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function isFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = createServer();
        probe.once('error', () => resolve(false));
        probe.once('listening', () => probe.close(() => resolve(true)));
        probe.listen(port, '127.0.0.1');
    });
}

async function request<Result>(
    base: string,
    method: string,
    path: string,
    body?: unknown,
): Promise<Result> {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} на ${method} ${path}: ${detail.slice(0, 500)}`);
    }
    if (response.status === 204) return undefined as Result;
    return (await response.json()) as Result;
}

function describe(cause: unknown): string {
    if (!(cause instanceof Error)) return String(cause);
    const inner = cause.cause;
    const detail =
        inner instanceof Error
            ? ` (${(inner as NodeJS.ErrnoException).code ?? inner.name}: ${inner.message})`
            : '';
    return `${cause.message}${detail}`;
}
