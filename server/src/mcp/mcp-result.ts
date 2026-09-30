/**
 * Приведение результата вызова внешнего инструмента к виду, в каком результат возвращают
 * собственные инструменты.
 *
 * Без приведения внешний инструмент выпал бы из механизмов, опирающихся на форму
 * результата. После приведения цикл не различает происхождение инструмента
 * ни при усечении, ни при записи в журнал, ни при отказе.
 */

/** Блок содержимого ответа. Описан по протоколу, а не импортирован: нужны четыре поля. */
type ContentBlock = {
    readonly type: string;
    readonly text?: unknown;
    readonly data?: unknown;
    readonly mimeType?: unknown;
    readonly resource?: unknown;
};

export type McpCallOutcome =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly message: string };

/**
 * Приводит ответ `tools/call`.
 *
 * Порядок предпочтения содержателен. `structuredContent` есть заявленный сервером
 * машиночитаемый результат, и если он есть, текстовые блоки его дублируют. Признак
 * `isError` даёт отказ инструмента, а не успешный результат: различие между ошибкой
 * протокола и ошибкой инструмента сохраняется — первая означает недоступность сервера,
 * вторая описывает неверный вызов, который модель может исправить.
 */
export function normalizeCallResult(raw: unknown): McpCallOutcome {
    if (raw === null || typeof raw !== 'object') {
        return { ok: true, value: raw };
    }

    const result = raw as {
        content?: unknown;
        structuredContent?: unknown;
        isError?: unknown;
    };

    const isError = result.isError === true;
    const blocks = Array.isArray(result.content) ? (result.content as ContentBlock[]) : [];
    const text = renderBlocks(blocks);

    if (isError) {
        return {
            ok: false,
            message: text === '' ? 'Инструмент вернул ошибку без пояснения' : text,
        };
    }

    if (result.structuredContent !== undefined && result.structuredContent !== null) {
        return { ok: true, value: result.structuredContent };
    }

    return { ok: true, value: text === '' ? { ok: true } : asData(text) };
}

/**
 * Разворачивает данные, присланные текстом.
 *
 * Значительная часть серверов MCP возвращает JSON внутри текстового блока: поле
 * `structuredContent` необязательно, и объявляют его не все. Оставленный строкой, такой
 * ответ кодируется в JSON второй раз, когда цикл сериализует результат вызова, и модель
 * получает содержимое с экранированными кавычками и переводами строк — читать его труднее,
 * а расход токенов выше. Человек в журнале видит то же самое.
 *
 * Разворачиваются только объект и массив: они означают данные однозначно. Число, логическое
 * значение и строка в кавычках оставляются как есть — там разбор менял бы тип без надобности.
 */
function asData(text: string): unknown {
    const trimmed = text.trim();
    const first = trimmed[0];
    if (first !== '{' && first !== '[') return text;
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return typeof parsed === 'object' && parsed !== null ? parsed : text;
    } catch {
        return text;
    }
}

/**
 * Сводит блоки содержимого в текст.
 *
 * Изображения и двоичные ресурсы заменяются описанием типа и объёма: поместить содержимое
 * некуда, пока у платформы нет файлового хранилища, а проведение его через контекст модели
 * означает расход токенов без пользы. Заменяющая строка при этом сообщает модели, что
 * данные существуют, — иначе она сочтёт вызов безрезультатным и повторит его.
 */
function renderBlocks(blocks: readonly ContentBlock[]): string {
    const parts: string[] = [];

    for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
            continue;
        }

        if (block.type === 'image' || block.type === 'audio') {
            const mime = typeof block.mimeType === 'string' ? block.mimeType : 'неизвестный тип';
            const size = typeof block.data === 'string' ? approximateBytes(block.data) : 0;
            parts.push(
                `[${block.type === 'image' ? 'изображение' : 'звук'} ${mime}, ~${size} байт: ` +
                    'содержимое в ответ не включено, платформа не передаёт двоичные данные модели]',
            );
            continue;
        }

        if (block.type === 'resource' || block.type === 'resource_link') {
            const resource = block.resource;
            if (resource !== null && typeof resource === 'object') {
                const inner = resource as { uri?: unknown; text?: unknown; mimeType?: unknown };
                if (typeof inner.text === 'string') {
                    parts.push(inner.text);
                    continue;
                }
                const uri = typeof inner.uri === 'string' ? inner.uri : 'без адреса';
                parts.push(`[ресурс ${uri}: содержимое в ответ не включено]`);
                continue;
            }
            parts.push('[ресурс без описания]');
            continue;
        }

        parts.push(`[блок типа "${block.type}" платформой не отображается]`);
    }

    return parts.join('\n').trim();
}

/** Объём двоичных данных по длине их представления в base64. */
function approximateBytes(base64: string): number {
    return Math.floor((base64.length * 3) / 4);
}
