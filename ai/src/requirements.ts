import { Context, Effect } from 'effect';
import type { RequestSnapshotContent, SessionEvent, SessionEventInput } from '@weragen/types';
import type { AgentMessage, ModelReply } from './messages.js';
import type { AnyAgentTool, ToolResult, ToolSpec } from './tool.js';
import type { ModelFailure } from './errors.js';

/**
 * Зависимости ядра.
 *
 * Это то, чего ядру не хватает для работы: обратиться к модели, узнать доступные инструменты,
 * записать событие. Интерфейсы объявлены здесь, в ядре, а не там, где находятся реализации,
 * — направление зависимости обратно обычному: не сервер предоставляет ядру возможности,
 * а ядро выставляет требования, которые сервер удовлетворяет.
 *
 * Требования выражены сервисами контекста Effect и попадают в третий параметр типа эффекта,
 * поэтому неподставленная зависимость обнаруживается проверкой типов, а не при исполнении.
 * `Layer` не используется намеренно: граф зависимостей строит Nest, и два конкурирующих
 * механизма внедрения в одном приложении создают больше сложности, чем снимают.
 */

/** Обращение к модели. Реализация отвечает за транспорт, авторизацию и повторы. */
export class ModelClient extends Context.Service<
    ModelClient,
    {
        readonly complete: (
            messages: readonly AgentMessage[],
            tools: readonly ToolSpec[],
        ) => Effect.Effect<ModelReply, ModelFailure>;
    }
>()('weragen/ModelClient') {}

/** Реестр инструментов, доступных агенту в текущем ходе. */
export class ToolRegistry extends Context.Service<
    ToolRegistry,
    {
        readonly specs: readonly ToolSpec[];
        readonly find: (name: string) => AnyAgentTool | undefined;
        readonly names: readonly string[];
    }
>()('weragen/ToolRegistry') {}

/**
 * Журнал сессии. Запись возвращает событие с проставленным порядковым номером — по нему
 * подписчики понимают, что они пропустили при обрыве связи.
 */
export class Journal extends Context.Service<
    Journal,
    {
        readonly append: (event: SessionEventInput) => Effect.Effect<SessionEvent>;
    }
>()('weragen/Journal') {}

/**
 * Вызов инструмента в том виде, в каком он предъявляется наблюдателю: до того, как имя
 * сверено с набором, а аргументы разобраны. Отказ разбора наблюдается наравне с отказом
 * исполнения, поэтому сведения берутся из требования модели, а не из инструмента.
 */
export type ObservedToolCall = {
    readonly callId: string;
    readonly name: string;
    readonly rawArguments: string;
    readonly step: number;
    readonly batchSize: number;
    readonly batchIndex: number;
};

/**
 * Наблюдение за вызовом инструмента.
 *
 * Объявлено требованием ядра, а не встроено в цикл, потому что приёмник наблюдений — дело
 * внешней стороны: ядро не зависит от OpenTelemetry и знать о ней не должно. Реализация на
 * стороне сервера открывает спан, а ядро сообщает ей, что вызов начался и чем кончился.
 *
 * Интерфейс охватывает вызов целиком, а не только исполнение инструмента: в него передаётся
 * эффект вызова, и наблюдение начинается прежде, чем имя сверено с набором. Иначе неверный
 * вызов — несуществующее имя, неразобранные аргументы, несоответствие схеме — не порождал бы
 * наблюдения вовсе, а именно этот класс отказов важнее прочих: он говорит о качестве
 * описаний инструментов.
 *
 * Эффект вызова отказов не имеет: любой отказ выражен полем `kind` исхода. Поэтому
 * наблюдателю остаётся учесть лишь прерывание, при котором исход не возвращается.
 */
export class ToolObserver extends Context.Service<
    ToolObserver,
    {
        readonly observe: (
            call: ObservedToolCall,
            run: Effect.Effect<ToolResult>,
        ) => Effect.Effect<ToolResult>;
    }
>()('weragen/ToolObserver') {}

/** Наблюдатель, ничего не делающий. Для вызывающих сторон, которым наблюдение не нужно. */
export const noToolObserver: Context.Service.Shape<typeof ToolObserver> = {
    observe: (_call, run) => run,
};

/**
 * Хранилище снимков постоянной части запроса — промпта и описаний инструментов. Запись
 * возвращает идентификатор снимка; одинаковое содержимое получает один и тот же
 * идентификатор, поэтому ход с неизменным набором новой записи не порождает.
 */
export class RequestSnapshots extends Context.Service<
    RequestSnapshots,
    {
        readonly save: (snapshot: RequestSnapshotContent) => Effect.Effect<string>;
    }
>()('weragen/RequestSnapshots') {}
