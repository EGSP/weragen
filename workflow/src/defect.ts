import { Cause, Chunk, Option } from 'effect';

/**
 * Описание дефекта — необъявленного исключения в коде воркфлоу.
 *
 * `Cause.pretty` для этого не годится: он печатает сообщение вместе со стеком как есть, а
 * стек содержит кадры внутренних модулей Effect и пути в виде URL с процентным
 * кодированием, из-за чего кириллица в пути превращается в неразборчивую строку. Читающий
 * видит длинный текст, по которому не понять ни причины, ни места.
 *
 * Здесь же сообщение отделяется от места, пути приводятся к обычному виду, а кадры чужих
 * модулей отбрасываются: дефект произошёл в коде воркфлоу, и показывать нужно его строки.
 */

/** Сколько кадров стека показывать. Первые кадры и есть место отказа; остальное — путь до него. */
const FRAME_LIMIT = 5;

export function describeDefect(cause: Cause.Cause<unknown>): string {
    const defect = Chunk.head(Cause.defects(cause));
    if (Option.isNone(defect)) return Cause.pretty(cause);

    const value = defect.value;
    const message = value instanceof Error ? value.message : String(value);
    const frames = value instanceof Error ? framesOf(value.stack) : [];

    const head =
        `Дефект в коде воркфлоу: ${message}\n` +
        'Это необъявленное исключение, а не отказ, объявленный воркфлоу: причина находится ' +
        'в его коде.';
    if (frames.length === 0) return head;
    return `${head}\nМесто:\n${frames.map((frame) => `  ${frame}`).join('\n')}`;
}

/**
 * Кадры стека, относящиеся к воркфлоу. Чужие модули отбрасываются, но если после отбора не
 * осталось ничего — показываются первые кадры как есть: пустое место хуже чужого.
 */
function framesOf(stack: string | undefined): string[] {
    if (stack === undefined) return [];
    const all = stack
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('at '))
        .map(readablePaths);
    const own = all.filter((line) => !line.includes('node_modules') && !line.includes('node:'));
    return (own.length === 0 ? all : own).slice(0, FRAME_LIMIT);
}

/**
 * Путь файла вместо его адреса. Node печатает кадры модулей ES адресами `file://`, где
 * непечатаемые в URL символы закодированы процентами, а кириллица в пути к проекту
 * встречается постоянно.
 */
function readablePaths(frame: string): string {
    return frame.replace(/file:\/{2,3}([^\s)]+)/g, (_match, path: string) => {
        try {
            return decodeURIComponent(path);
        } catch {
            return path;
        }
    });
}
