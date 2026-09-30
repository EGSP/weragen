import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SpanStatusCode, trace, type Context as OtelContext } from '@opentelemetry/api';
import { Cause, Effect, Exit, Fiber } from 'effect';
import { api } from './api/generated/client.js';
import { makeContext, WorkflowContext } from './context.js';
import { describeCauseDefect } from './defect.js';
import { specOf, WorkflowFailure, type WorkflowDefinition } from './spec.js';
import { contextFromTraceparent, flushTracing, initTracing, tracer } from './tracing.js';

/**
 * Запуск процесса воркфлоу.
 *
 * Процесс запускается платформой на каждое исполнение, отрабатывает и завершается;
 * постоянно работающих процессов воркфлоу нет. На время работы он обслуживает HTTP:
 * платформа проверяет готовность, запрашивает спецификацию, передаёт вход и, при
 * необходимости, просит прекратить работу. Обратно процесс обращается к обычным
 * контроллерам платформы — отдельного шлюза нет.
 *
 * Обмен по HTTP, а не через командную строку и stdin, устраняет сразу два ограничения:
 * длину командной строки в Windows и отсутствие там надёжного завершения по сигналу.
 * Прерывание приходит обращением, и у воркфлоу есть возможность прекратить работу самому.
 */

/**
 * Сколько процесс ждёт входа, прежде чем завершиться сам. Нужен на случай, когда платформа
 * запустила процесс и не прислала ни входа, ни команды остановиться: иначе процесс остался
 * бы работать вместе с занятым портом.
 */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export async function serve<Input, Result>(
    definition: WorkflowDefinition<Input, Result>,
): Promise<void> {
    const port = Number(process.env['WERAGEN_PORT'] ?? 0);
    if (!Number.isInteger(port) || port <= 0) {
        process.stderr.write(
            'WERAGEN_PORT не задан. Процесс воркфлоу запускается платформой, которая передаёт ' +
                'порт и свой адрес переменными окружения.\n',
        );
        process.exitCode = 1;
        return;
    }

    const spec = specOf(definition);
    // Провайдер создаётся до первого спана и только если платформа передала адрес
    // приёмника. Без него обращения к `@opentelemetry/api` остаются пустыми операциями,
    // и код воркфлоу от этого не меняется.
    const tracing = initTracing(spec.name, spec.version);

    let running: { sessionId: string; fiber: Fiber.Fiber<unknown, unknown> } | undefined;

    let idleTimer: NodeJS.Timeout | undefined = setTimeout(() => {
        process.stderr.write('Вход не получен за отведённое время; процесс завершается.\n');
        process.exit(0);
    }, IDLE_TIMEOUT_MS);

    const server: Server = createServer((request, response) => {
        void route(request, response).catch((cause: unknown) =>
            send(response, 500, { error: describe(cause) }),
        );
    });

    async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

        if (request.method === 'GET' && path === '/health') {
            return send(response, 200, { ok: true, name: spec.name, version: spec.version });
        }

        if (request.method === 'GET' && path === '/requirements') {
            return send(response, 200, spec);
        }

        if (request.method === 'POST' && path === '/runs') {
            const body = (await readBody(request)) as {
                sessionId?: unknown;
                input?: unknown;
                traceparent?: unknown;
            };
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
            if (sessionId === '') return send(response, 400, { error: 'sessionId обязателен' });
            if (running !== undefined) {
                // Процесс обслуживает одно исполнение: изоляция достигается тем, что
                // параллельные исполнения суть разные процессы.
                return send(response, 409, { error: 'Исполнение уже идёт' });
            }

            if (idleTimer !== undefined) {
                clearTimeout(idleTimer);
                idleTimer = undefined;
            }
            running = launch(definition, sessionId, body.input, server, {
                traceparent: typeof body.traceparent === 'string' ? body.traceparent : undefined,
                captureContent: tracing.captureContent,
            });
            return send(response, 202, { accepted: true });
        }

        const cancel = /^\/runs\/([^/]+)\/cancel$/.exec(path);
        if (request.method === 'POST' && cancel !== null) {
            const sessionId = decodeURIComponent(cancel[1] ?? '');
            if (running !== undefined && running.sessionId === sessionId) {
                // Прекращение работы, а не сообщение об отказе: исход прерванного
                // исполнения записывает платформа — она же его и запросила.
                void Effect.runPromise(Fiber.interrupt(running.fiber));
            }
            return send(response, 202, { accepted: true });
        }

        send(response, 404, { error: `Неизвестный путь ${path}` });
    }

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    // Состояние трассировки печатается при запуске намеренно: платформа собирает вывод
    // процесса, и без этой строки выяснить, дошёл ли до воркфлоу адрес приёмника, можно
    // было бы только по отсутствию спанов в приёмнике.
    const destination = tracing.enabled ? (process.env['WERAGEN_OTEL_ENDPOINT'] ?? '') : 'выключена';
    process.stdout.write(
        `воркфлоу ${spec.name}@${spec.version} слушает порт ${port}; трассировка: ${destination}\n`,
    );
}

/**
 * Исполнение одного запуска.
 *
 * Точка входа — функция `run` объявления; точка выхода — её исход, сообщаемый платформе
 * ровно один раз, после чего процесс завершается. Прерывание исходом не считается:
 * платформа записывает его сама, а второе сообщение об итоге было бы попыткой
 * перезаписать уже принятое ею решение.
 */
function launch<Input, Result>(
    definition: WorkflowDefinition<Input, Result>,
    sessionId: string,
    input: unknown,
    server: Server,
    tracing: { traceparent: string | undefined; captureContent: boolean },
): { sessionId: string; fiber: Fiber.Fiber<unknown, unknown> } {
    // Спан исполнения подвешивается к контексту, полученному от платформы: без этого
    // трасса воркфлоу оказалась бы отдельным деревом, не связанным с трассой платформы.
    const parent: OtelContext = contextFromTraceparent(tracing.traceparent);
    const runSpan = tracer().startSpan(
        `workflow ${definition.name} run`,
        {
            attributes: {
                'openinference.span.kind': 'CHAIN',
                'session.id': sessionId,
                'weragen.session.kind': 'workflow',
                'weragen.workflow.name': definition.name,
                'weragen.workflow.version': definition.version,
                ...(tracing.captureContent
                    ? { 'input.value': JSON.stringify(input), 'input.mime_type': 'application/json' }
                    : {}),
            },
        },
        parent,
    );
    const runContext = trace.setSpan(parent, runSpan);

    const runnable = Effect.suspend(() => {
        const parsed = definition.input.safeParse(input);
        if (!parsed.success) {
            return new WorkflowFailure({
                message:
                    'Входной объект не соответствует схеме: ' +
                    parsed.error.issues
                        .map((issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`)
                        .join('; '),
            });
        }
        return definition.run(parsed.data);
    }).pipe(Effect.provideService(WorkflowContext, makeContext(sessionId, runContext)));

    const fiber = Effect.runFork(runnable);
    fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit)) {
            if (tracing.captureContent) {
                runSpan.setAttribute('output.value', JSON.stringify(exit.value));
                runSpan.setAttribute('output.mime_type', 'application/json');
            }
            runSpan.setStatus({ code: SpanStatusCode.OK });
        } else {
            // Итог записывается и при отказе: спан без него читается как оборванный, хотя
            // исполнение закончилось и причина известна.
            const message = failureMessage(exit.cause);
            runSpan.setAttribute('output.value', message.slice(0, 4000));
            runSpan.setAttribute('output.mime_type', 'text/plain');
            runSpan.setStatus({ code: SpanStatusCode.ERROR, message });
        }
        runSpan.end();
        void finish(sessionId, exit, server);
    });
    return { sessionId, fiber };
}

async function finish(
    sessionId: string,
    exit: Exit.Exit<unknown, unknown>,
    server: Server,
): Promise<void> {
    // Буфер спанов сбрасывается до выхода. Без этого при завершении процесса не ушло бы
    // ни одного спана: они отправляются пачками, и трасса оказалась бы пустой при
    // полностью исправной настройке.
    const shutdown = async (): Promise<void> => {
        await flushTracing();
        server.close();
        // Небольшая задержка даёт закрыться соединению, по которому ушёл итог.
        setTimeout(() => process.exit(0), 50);
    };

    if (Exit.isSuccess(exit)) {
        await report(sessionId, { ok: true, result: exit.value });
        await shutdown();
        return;
    }

    if (Cause.hasInterruptsOnly(exit.cause)) {
        await shutdown();
        return;
    }

    await report(sessionId, { ok: false, result: null, message: failureMessage(exit.cause) });
    await shutdown();
}

/**
 * Причина неудачи. Объявленный отказ сообщает её сам; в остальных случаях это дефект, и
 * текст для него составляется отдельно: печать причины как есть даёт стек внутренних
 * модулей и пути в виде адресов, по которым не понять ни причины, ни места.
 */
function failureMessage(cause: Cause.Cause<unknown>): string {
    const failure = Cause.findErrorOption(cause);
    return failure._tag === 'Some'
        ? (failure.value as WorkflowFailure).message
        : describeCauseDefect(cause);
}

async function report(
    sessionId: string,
    body: { ok: boolean; result: unknown; message?: string },
): Promise<void> {
    try {
        await api.workflows.finish(sessionId, body);
    } catch (cause) {
        // Сообщить об итоге не удалось. Платформа обнаружит выход процесса без итога и
        // запишет отказ сама, поэтому здесь остаётся оставить след в выводе: платформа
        // собирает его и покажет в причине отказа.
        process.stderr.write(`итог не доставлен: ${describe(cause)}\n`);
    }
}

function send(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
    });
    response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw === '' ? {} : JSON.parse(raw);
}

function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}
