import {
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    type OnApplicationBootstrap,
} from '@nestjs/common';
import type {
    CreateModelProfileRequest,
    ModelAvailability,
    ModelInUseError,
    ModelProfile,
    ModelSession,
    UpdateModelProfileRequest,
} from '@weragen/types';
import { PrismaService } from '../database/prisma.service.js';
import { ModelAvailabilityService } from '../yandex/model-availability.service.js';

/** Модель, выбранная для сессии или хода: запись справочника и идентификатор её модели. */
export type ModelChoice = { readonly id: string; readonly identifier: string };

/** Отказ хода и агентской сессии при пустом справочнике. */
const NO_MODELS = 'В справочнике нет ни одной модели. Добавьте модель в разделе «Модели».';

const CHOICE = { id: true, identifier: true } as const;

/**
 * Справочник моделей платформы — единственный источник модели.
 *
 * Список один на всю установку, как и пометка модели по умолчанию. В конфигурации модель не
 * задаётся: пока справочник пуст, ход агента не запускается, и отказ получает то действие,
 * которое ход запускает. Непустой справочник всегда содержит модель по умолчанию: первая
 * запись получает пометку сама, а снять её можно только назначением другой записи.
 *
 * Идентификатор записи задаётся при создании и не меняется. Поэтому запись и модель
 * соответствуют друг другу однозначно, а сессия, закреплённая за записью, не может перейти на
 * другую модель без явного выбора.
 */
@Injectable()
export class ModelsService implements OnApplicationBootstrap {
    private readonly logger = new Logger(ModelsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly availability: ModelAvailabilityService,
    ) {}

    /**
     * Связь сессий со справочником восстанавливается при запуске: у сессий, начатых на модели
     * из конфигурации, когда справочника ещё не было, её нет, хотя та же модель могла быть
     * заведена в справочник позже.
     */
    async onApplicationBootstrap(): Promise<void> {
        await this.relink().catch((cause: unknown) => {
            this.logger.warn(
                `связь сессий со справочником не восстановлена: ${
                    cause instanceof Error ? cause.message : String(cause)
                }`,
            );
        });
    }

    async list(): Promise<ModelProfile[]> {
        const rows = await this.prisma.llmModel.findMany({
            orderBy: [{ isDefault: 'desc' }, { identifier: 'asc' }],
        });
        const active = await this.activeSessions();
        return rows.map((row) => toDto(row, active.get(row.id) ?? []));
    }

    async create(request: CreateModelProfileRequest): Promise<ModelProfile> {
        const identifier = request.identifier.trim();
        const existing = await this.prisma.llmModel.findUnique({ where: { identifier } });
        if (existing !== null) {
            throw new ConflictException(`Модель "${identifier}" уже добавлена`);
        }

        const count = await this.prisma.llmModel.count();
        // Первая добавленная модель становится используемой по умолчанию: иначе платформа
        // осталась бы без модели, пока пометку не проставят вручную.
        const isDefault = request.isDefault === true || count === 0;

        const created = await this.prisma.$transaction(async (tx) => {
            if (isDefault) {
                await tx.llmModel.updateMany({
                    where: { isDefault: true },
                    data: { isDefault: false },
                });
            }
            return tx.llmModel.create({
                data: {
                    identifier,
                    isDefault,
                    supportsTools: request.supportsTools ?? false,
                    supportsReasoning: request.supportsReasoning ?? false,
                },
            });
        });

        // Сессии, чья запись с тем же идентификатором была удалена, снова получают модель.
        await this.relink(identifier);
        // Доступность выясняется сразу: карточка не должна оставаться в состоянии
        // «не проверялась» до срабатывания таймера.
        await this.availability.refresh();
        return this.require(created.id);
    }

    /**
     * Правка признаков и пометки по умолчанию. Идентификатор в правку не входит: он задаётся
     * при создании и не меняется.
     *
     * Снять пометку по умолчанию можно только назначением другой записи. Иначе справочник с
     * записями остался бы без модели по умолчанию, и новый чат не получил бы модели.
     */
    async update(id: string, request: UpdateModelProfileRequest): Promise<ModelProfile> {
        const current = await this.require(id);
        if (request.isDefault === false && current.isDefault) {
            throw new ConflictException(
                'Нельзя снять пометку с модели по умолчанию. Назначьте моделью по умолчанию другую.',
            );
        }

        await this.prisma.$transaction(async (tx) => {
            if (request.isDefault === true) {
                await tx.llmModel.updateMany({
                    where: { isDefault: true },
                    data: { isDefault: false },
                });
            }
            await tx.llmModel.update({
                where: { id },
                data: {
                    ...(request.isDefault === undefined ? {} : { isDefault: request.isDefault }),
                    ...(request.supportsTools === undefined
                        ? {}
                        : { supportsTools: request.supportsTools }),
                    ...(request.supportsReasoning === undefined
                        ? {}
                        : { supportsReasoning: request.supportsReasoning }),
                },
            });
        });

        return this.require(id);
    }

    /**
     * Удаление записи.
     *
     * Пока моделью исполняется ход, запись не удаляется, и отказ перечисляет эти сессии. После
     * удаления сессии, закреплённые за записью, сохраняются вместе с историей, но ход в них
     * отклоняется, пока не выбрана другая модель: подставлять модель по умолчанию вместо
     * назначенной нельзя.
     */
    async remove(id: string): Promise<void> {
        const model = await this.require(id);
        if (model.activeSessions.length > 0) {
            const titles = model.activeSessions.map((session) => `«${session.title}»`).join(', ');
            throw new ConflictException({
                statusCode: 409,
                error: 'Conflict',
                message:
                    `Модель используется сессиями, в которых идёт ход: ${titles}. ` +
                    'Дождитесь завершения ходов или прервите их.',
                sessions: model.activeSessions,
            } satisfies ModelInUseError);
        }
        if (model.isDefault && (await this.prisma.llmModel.count()) > 1) {
            throw new ConflictException(
                'Нельзя удалить модель по умолчанию. Сначала назначьте другую.',
            );
        }
        await this.prisma.llmModel.delete({ where: { id } });
    }

    async require(id: string): Promise<ModelProfile> {
        const row = await this.prisma.llmModel.findUnique({ where: { id } });
        if (row === null) throw new NotFoundException(`Модель ${id} не найдена`);
        const active = await this.activeSessions(id);
        return toDto(row, active.get(id) ?? []);
    }

    /** Модель по умолчанию. Пусто, если справочник пуст. */
    async defaultModel(): Promise<ModelChoice | null> {
        return this.prisma.llmModel.findFirst({ where: { isDefault: true }, select: CHOICE });
    }

    /** Модель по умолчанию либо отказ, если справочник пуст. */
    async requireDefault(): Promise<ModelChoice> {
        const model = await this.defaultModel();
        if (model === null) throw new ConflictException(NO_MODELS);
        return model;
    }

    /**
     * Модель хода.
     *
     * Модель, назначенная сессии, берётся из её записи. Если связи с записью нет, модель
     * ищется по запомненному идентификатору: запись могла быть удалена и заведена заново, а
     * идентификатор неизменяем, поэтому совпадение означает ту же модель. Если модели сессии в
     * справочнике нет, ход отклоняется: сессии нужна другая модель, и подставлять её без
     * ведома пользователя нельзя. Модель по умолчанию достаётся только сессии, которой модель
     * ещё не назначалась.
     */
    async forTurn(session: {
        readonly modelId: string | null;
        readonly modelIdentifier: string | null;
    }): Promise<ModelChoice> {
        if (session.modelId === null && session.modelIdentifier === null) {
            return this.requireDefault();
        }

        const own =
            (session.modelId === null
                ? null
                : await this.prisma.llmModel.findUnique({
                      where: { id: session.modelId },
                      select: CHOICE,
                  })) ??
            (session.modelIdentifier === null
                ? null
                : await this.prisma.llmModel.findUnique({
                      where: { identifier: session.modelIdentifier },
                      select: CHOICE,
                  }));
        if (own !== null) return own;

        throw new ConflictException(
            session.modelIdentifier === null
                ? 'Модель сессии удалена из справочника. Выберите для сессии другую модель.'
                : `Модели "${session.modelIdentifier}" нет в справочнике. Выберите для сессии другую модель.`,
        );
    }

    /**
     * Сессии с идущим ходом по записям справочника.
     *
     * Ход определяется по состоянию записи сессии. Сессии, оставшиеся в `running` после
     * остановки сервера, закрываются сверкой при его запуске раньше, чем начинают приниматься
     * запросы, поэтому устаревших значений здесь нет.
     */
    private async activeSessions(modelId?: string): Promise<Map<string, ModelSession[]>> {
        const byModel = new Map<string, ModelSession[]>();
        const rows = await this.prisma.session.findMany({
            where: { status: 'running', modelId: modelId ?? { not: null } },
            orderBy: { lastEventAt: 'desc' },
            select: { id: true, title: true, kind: true, modelId: true },
        });
        for (const row of rows) {
            if (row.modelId === null) continue;
            const sessions = byModel.get(row.modelId) ?? [];
            sessions.push({ id: row.id, title: row.title, kind: row.kind });
            byModel.set(row.modelId, sessions);
        }
        return byModel;
    }

    /**
     * Восстанавливает связь сессий с записью по идентификатору модели.
     *
     * Связи нет у сессий, чья запись удалена, и у сессий, начатых на модели из конфигурации,
     * когда справочника ещё не было. Идентификатор записи неизменяем, поэтому совпадение
     * идентификаторов означает ту же модель, и восстановление связи не подменяет модель.
     */
    private async relink(identifier?: string): Promise<void> {
        const models = await this.prisma.llmModel.findMany({
            where: identifier === undefined ? {} : { identifier },
            select: CHOICE,
        });
        for (const model of models) {
            await this.prisma.session.updateMany({
                where: { modelId: null, modelIdentifier: model.identifier },
                data: { modelId: model.id },
            });
        }
    }
}

type ModelRow = {
    id: string;
    identifier: string;
    isDefault: boolean;
    supportsTools: boolean;
    supportsReasoning: boolean;
    availability: string;
    lastCheckAt: Date | null;
    lastCheckMessage: string | null;
    createdAt: Date;
};

const availabilityOf = (value: string): ModelAvailability =>
    value === 'available' || value === 'not_listed' || value === 'unreachable'
        ? value
        : 'unknown';

function toDto(row: ModelRow, activeSessions: ModelSession[]): ModelProfile {
    return {
        id: row.id,
        identifier: row.identifier,
        isDefault: row.isDefault,
        supportsTools: row.supportsTools,
        supportsReasoning: row.supportsReasoning,
        availability: availabilityOf(row.availability),
        lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
        lastCheckMessage: row.lastCheckMessage,
        createdAt: row.createdAt.toISOString(),
        activeSessions,
    };
}
