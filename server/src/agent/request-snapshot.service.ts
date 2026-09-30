import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Effect } from 'effect';
import {
    requestSnapshotSchema,
    type RequestSnapshot,
    type RequestSnapshotContent,
} from '@weragen/types';
import { PrismaService } from '../database/prisma.service.js';

/**
 * Хранилище снимков постоянной части запроса к модели: реализация одноимённой зависимости
 * ядра и чтение снимка по идентификатору.
 *
 * Идентификатор снимка — хеш его содержимого. Набор инструментов меняется редко, и все ходы
 * с одинаковым промптом и набором ссылаются на одну запись: описания инструментов занимают
 * десятки килобайт, и повторять их на каждом шаге значило бы раздувать базу без пользы.
 */
@Injectable()
export class RequestSnapshotService {
    constructor(private readonly prisma: PrismaService) {}

    /** Реализация зависимости ядра. */
    readonly forCore = {
        save: (snapshot: RequestSnapshotContent): Effect.Effect<string> =>
            Effect.promise(() => this.save(snapshot)),
    };

    async save(snapshot: RequestSnapshotContent): Promise<string> {
        const id = createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
        // Вставка без отказа при совпадении: два хода с одинаковым набором могут сохранять
        // снимок одновременно, и второй должен получить тот же идентификатор, а не ошибку.
        await this.prisma.requestSnapshot.createMany({
            data: [
                {
                    id,
                    prompt: snapshot.prompt,
                    sections: snapshot.sections,
                    tools: snapshot.tools as object,
                },
            ],
            skipDuplicates: true,
        });
        return id;
    }

    async find(id: string): Promise<RequestSnapshot | undefined> {
        const row = await this.prisma.requestSnapshot.findUnique({ where: { id } });
        if (row === null) return undefined;
        // Содержимое проверяется схемой: поля JSON база не типизирует, а снимок уходит в
        // оценку контекста и клиенту.
        return requestSnapshotSchema.parse({
            id: row.id,
            prompt: row.prompt,
            sections: row.sections,
            tools: row.tools,
            createdAt: row.createdAt.toISOString(),
        });
    }
}

/**
 * JSON с упорядоченными ключами. Порядок ключей в описаниях инструментов зависит от того,
 * откуда описание получено, а хеш должен зависеть только от содержимого.
 */
function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(
                  Object.entries(item).sort(([left], [right]) =>
                      left < right ? -1 : left > right ? 1 : 0,
                  ),
              )
            : item,
    );
}
