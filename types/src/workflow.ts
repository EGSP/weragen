import { z } from 'zod';

/**
 * Воркфлоу: отдельная программа с собственной предметной логикой и собственным состоянием.
 *
 * Платформа не содержит перечня реализаций. Она хранит карточку — где лежит пакет и чем он
 * запускается, — а всё остальное узнаёт у самого процесса: запускает его и запрашивает
 * спецификацию. Поэтому добавление воркфлоу не требует правок в коде платформы.
 */

/**
 * Требования воркфлоу к платформе. Сверяются по совпадению имён: воркфлоу заявляет, что
 * ему нужно, а предоставляет это платформа. Инструментов и подключений MCP воркфлоу не
 * предоставляет — это не его ответственность.
 */
export const workflowRequirementsSchema = z.object({
    tools: z.array(z.string()).default([]),
    mcp: z.array(z.string()).default([]),
    models: z.array(z.string()).default([]),
});
export type WorkflowRequirements = z.infer<typeof workflowRequirementsSchema>;

/**
 * Спецификация, которую процесс воркфлоу возвращает по `GET /requirements`.
 *
 * Схема входного объекта нужна дважды: для формы ручного запуска и для порождения описания
 * инструмента, которым воркфлоу запускается из агентской сессии. Она передаётся готовой
 * JSON Schema, потому что платформа не разбирает её сама, а передаёт дальше — модели либо
 * интерфейсу.
 */
export const workflowSpecSchema = z.object({
    name: z.string().min(1).max(100),
    version: z.string().min(1).max(40),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    input: z.record(z.string(), z.unknown()),
    requires: workflowRequirementsSchema.default({ tools: [], mcp: [], models: [] }),
});
export type WorkflowSpec = z.infer<typeof workflowSpecSchema>;

/**
 * Состояние проверки требований.
 *
 * Состояния различаются потому, что требуют разных действий. `unsatisfied` означает, что
 * недостаёт чего-то на платформе, и исправляется её настройкой. `unreachable` означает, что
 * процесс не запустился либо не вернул разбираемую спецификацию, и исправляется пакетом
 * воркфлоу или окружением. Свести их в одно «не работает» значило бы заставить
 * администратора выяснять причину каждый раз заново.
 */
export const workflowCheckStatusSchema = z.enum(['unknown', 'ok', 'unsatisfied', 'unreachable']);
export type WorkflowCheckStatus = z.infer<typeof workflowCheckStatusSchema>;

/** Карточка воркфлоу в реестре платформы. */
export const workflowSchema = z.object({
    id: z.string(),
    /** Имя, по которому воркфлоу запускается. Совпадает с именем в спецификации. */
    name: z.string(),
    /** Рабочий каталог процесса — где лежит пакет. */
    packagePath: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),

    /** Поля ниже заполняются из спецификации при проверке требований. */
    version: z.string().nullable(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    inputSchema: z.unknown(),
    requirements: workflowRequirementsSchema.nullable(),

    checkStatus: workflowCheckStatusSchema,
    /** Чего именно недостаёт при `unsatisfied`. */
    missing: z.array(z.string()),
    lastCheckAt: z.string().nullable(),
    lastCheckMessage: z.string().nullable(),

    createdAt: z.string(),
    updatedAt: z.string(),
});
export type Workflow = z.infer<typeof workflowSchema>;

export const createWorkflowRequestSchema = z.object({
    name: z.string().min(1).max(100),
    packagePath: z.string().min(1).max(500),
    command: z.string().min(1).max(200).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
});
export type CreateWorkflowRequest = z.infer<typeof createWorkflowRequestSchema>;

export const updateWorkflowRequestSchema = createWorkflowRequestSchema.partial();
export type UpdateWorkflowRequest = z.infer<typeof updateWorkflowRequestSchema>;

export const workflowListResponseSchema = z.object({ workflows: z.array(workflowSchema) });
export type WorkflowListResponse = z.infer<typeof workflowListResponseSchema>;

/** Запуск исполнения. Родитель указывается, когда запуск идёт из другой сессии. */
export const startWorkflowRunRequestSchema = z.object({
    name: z.string().min(1).max(100),
    input: z.unknown(),
    parentId: z.string().optional(),
    /** Контекст трассы порождающей стороны в формате W3C Trace Context. */
    traceparent: z.string().max(200).optional(),
});
export type StartWorkflowRunRequest = z.infer<typeof startWorkflowRunRequestSchema>;

/**
 * Состояние шага. Различаются три, а не два: шаг, начатый и не завершившийся, отличается
 * от неудавшегося — по журналу видно, на каком именно шаге исполнение прервалось.
 */
export const workflowStepStateSchema = z.enum(['started', 'finished', 'failed']);
export type WorkflowStepState = z.infer<typeof workflowStepStateSchema>;

/**
 * Значения атрибутов спана. Перечень типов взят из OpenTelemetry, где атрибут может быть
 * строкой, числом или логическим значением. Массивы намеренно не поддерживаются: в журнал
 * они попадают плохо, а в атрибутах шага не нужны.
 */
export const spanAttributesSchema = z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()]),
);
export type SpanAttributes = z.infer<typeof spanAttributesSchema>;

/**
 * Сообщение о шаге. Это запись наблюдений, а не источник восстановления: платформа по ней
 * состояние воркфлоу не воспроизводит, поэтому полнота потока сообщений не требуется, а
 * подробность выбирает автор воркфлоу.
 *
 * Сообщение несёт и данные трассировки. Время измеряется на стороне воркфлоу и передаётся
 * явно, потому что момент получения запроса включает задержку сети: спан, построенный по
 * нему, был бы длиннее действительного. Указание родительского шага даёт дерево вместо
 * плоского списка, и тогда шагами выражается вся внутренняя работа воркфлоу.
 */
export const workflowStepReportSchema = z.object({
    stepId: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    state: workflowStepStateSchema,
    /** Шаг, внутри которого исполняется этот. Пусто у шагов верхнего уровня. */
    parentStepId: z.string().max(100).optional(),
    /** Момент начала по часам воркфлоу. Приходит с обоими сообщениями шага. */
    startedAt: z.string(),
    /** Длительность работы шага. Приходит с завершающим сообщением. */
    durationMs: z.number().int().nonnegative().optional(),
    detail: z.string().max(4000).optional(),
    attributes: spanAttributesSchema.optional(),
});
export type WorkflowStepReport = z.infer<typeof workflowStepReportSchema>;

/**
 * Сообщение об итоге. Источник истины об исходе — именно оно, а не код выхода процесса:
 * процесс, завершившийся без сообщённого итога, считается отказавшим независимо от кода.
 */
export const workflowResultReportSchema = z.object({
    ok: z.boolean(),
    result: z.unknown(),
    message: z.string().max(4000).optional(),
});
export type WorkflowResultReport = z.infer<typeof workflowResultReportSchema>;
