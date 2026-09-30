import type { ModuleRef } from '@nestjs/core';
import { Duration, Effect } from 'effect';
import { z } from 'zod';
import { ToolFailure, toolFailure, zodInput, type AgentTool, type AnyAgentTool } from '@weragen/ai';
import type { WorkflowRunnerService } from '../workflows/workflow-runner.service.js';
import type { WorkflowsService } from '../workflows/workflows.service.js';
import { WORKFLOW_REGISTRY, WORKFLOW_RUNNER } from '../workflows/tokens.js';

/**
 * Инструменты запуска воркфлоу из сессии с агентским циклом.
 *
 * Службы воркфлоу разрешаются через `ModuleRef` по строковому токену в момент вызова, а не
 * внедряются в конструктор. Причина в направлении зависимостей: реестр воркфлоу обращается
 * к набору инструментов, чтобы сверить требования, а набор инструментов — к реестру, чтобы
 * запустить исполнение. Ссылка на класс в обоих направлениях замыкает модули в цикл, из-за
 * которого приложение не загружается вовсе; токен и импорт типа цикла не образуют.
 */

/** Приведение конкретного инструмента к типу реестра. */
const defineTool = <Input>(tool: AgentTool<Input>): AnyAgentTool =>
    tool as unknown as AnyAgentTool;

/**
 * Схемы объявлены на уровне модуля, а не внутри функций: сами инструменты создаются заново
 * на каждый ход, поскольку замыкаются на сессию, тогда как схема от неё не зависит.
 */
const LIST_WORKFLOWS_INPUT = zodInput(z.object({}));
const RUN_WORKFLOW_INPUT = zodInput(
    z.object({
        name: z.string().min(1).describe('Имя воркфлоу из list_workflows'),
        input: z
            .unknown()
            .describe('Входной объект по схеме, объявленной воркфлоу в list_workflows'),
    }),
);

/** Как часто опрашивается состояние дочерней сессии, пока воркфлоу работает. */
const POLL_INTERVAL_MS = 700;

/**
 * Предел ожидания. Он существует не ради воркфлоу, а ради хода агента: держать ход
 * открытым неограниченно значит расходовать окно контекста и не давать пользователю
 * получить ответ. По истечении предела исполнение продолжается, а агент об этом извещается.
 */
const WAIT_LIMIT_MS = 10 * 60 * 1000;

/**
 * Подсказка при недоступности реестра воркфлоу. Отказ обращения к нему вызовом не
 * исправляется, поэтому модель направляется в обход, а не к повтору.
 */
const REGISTRY_HINT =
    'Реестр воркфлоу сейчас недоступен, и повтор того же вызова даст тот же результат. ' +
    'Продолжай без воркфлоу либо сообщи о недоступности.';

export function listWorkflows(moduleRef: ModuleRef): AnyAgentTool {
    return defineTool({
        name: 'list_workflows',
        description:
            'Перечисляет воркфлоу, зарегистрированные на платформе: имя, назначение и схему ' +
            'входного объекта. Вызывай перед run_workflow, чтобы узнать имя и состав входа.',
        input: LIST_WORKFLOWS_INPUT,
        // Обращение к реестру объявлено способным отказать: `Effect.promise` обратил бы
        // недоступность базы в дефект, и модель получила бы текст исключения без указания,
        // что делать дальше.
        execute: () =>
            Effect.tryPromise({
                try: async () => {
                    const workflows = moduleRef.get<WorkflowsService>(WORKFLOW_REGISTRY, {
                        strict: false,
                    });
                    const all = await workflows.list();
                    return {
                        workflows: all.map((workflow) => ({
                            name: workflow.name,
                            title: workflow.title,
                            description: workflow.description,
                            version: workflow.version,
                            runnable: workflow.checkStatus === 'ok',
                            input: workflow.inputSchema,
                        })),
                    };
                },
                catch: toolFailure('Перечень воркфлоу не получен', REGISTRY_HINT),
            }),
    });
}

export function runWorkflow(moduleRef: ModuleRef, sessionId: string): AnyAgentTool {
    return defineTool({
        name: 'run_workflow',
        description:
            'Запускает воркфлоу и дожидается его завершения. Воркфлоу — отдельная программа ' +
            'со своей логикой; она может занять минуты. Имя и состав входного объекта узнай ' +
            'вызовом list_workflows.',
        input: RUN_WORKFLOW_INPUT,
        execute: ({ name, input }) =>
            Effect.gen(function* () {
                const runner = moduleRef.get<WorkflowRunnerService>(WORKFLOW_RUNNER, { strict: false });

                const started = yield* Effect.tryPromise({
                    try: () => runner.start(name, input, sessionId),
                    catch: toolFailure(
                        `Воркфлоу "${name}" не запущен`,
                        'Проверь имя вызовом list_workflows и признак runnable у записи.',
                    ),
                });

                const deadline = Date.now() + WAIT_LIMIT_MS;
                while (Date.now() < deadline) {
                    // Ожидание прерываемо: отмена волокна хода останавливает и его.
                    yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
                    const outcome = yield* Effect.tryPromise({
                        try: () => runner.outcome(started.id),
                        catch: toolFailure(
                            `Состояние исполнения ${started.id} не прочитано`,
                            'Исполнение запущено и, вероятно, продолжается. Не запускай ' +
                                `воркфлоу «${name}» повторно: появится второе исполнение.`,
                        ),
                    });

                    if (outcome.status === 'completed') {
                        return { workflow: name, sessionId: started.id, result: outcome.result };
                    }
                    if (outcome.status === 'failed') {
                        return yield* Effect.fail(
                            new ToolFailure(
                                `Воркфлоу "${name}" завершился отказом: ${outcome.failureMessage ?? 'причина не сообщена'}`,
                                'Исправить это вызовом нельзя. Сообщи об отказе в ответе.',
                            ),
                        );
                    }
                }

                return yield* Effect.fail(
                    new ToolFailure(
                        `Воркфлоу "${name}" не завершился за отведённое время; исполнение ${started.id} продолжается.`,
                        'Не повторяй запуск: он породит второе исполнение. Сообщи, что работа идёт.',
                    ),
                );
            }),
    });
}

