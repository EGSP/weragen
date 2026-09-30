/**
 * Нечёткое сопоставление строк для подсказок при вводе.
 *
 * Точное вхождение подстроки не годится: имена моделей содержат разделители и версии
 * (`qwen3.6-35b-a3b/latest`), и запрос «qwen 35» по строгому правилу не найдёт ничего.
 * Поэтому сравнение идёт по двум правилам подряд.
 *
 * Первое — вхождение подпоследовательности: все символы запроса встречаются в кандидате в
 * том же порядке, но не обязательно подряд. Оценка тем выше, чем ближе совпавшие символы
 * друг к другу и чем раньше начинается совпадение; так «qwen35» находит `qwen3.6-35b-a3b`.
 *
 * Второе — расстояние редактирования, применяемое, когда подпоследовательность не найдена.
 * Оно покрывает опечатки: «qwne» отличается от «qwen» одной перестановкой.
 */

/** Приводит строку к виду, в котором разделители и регистр не мешают сравнению. */
function normalise(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');
}

/** Оценка вхождения подпоследовательности: 0 — не найдена, иначе от 0 до 1. */
function subsequenceScore(query: string, candidate: string): number {
    let position = 0;
    let firstMatch = -1;
    let gaps = 0;
    let previous = -1;

    for (const symbol of query) {
        const found = candidate.indexOf(symbol, position);
        if (found < 0) return 0;
        if (firstMatch < 0) firstMatch = found;
        if (previous >= 0) gaps += found - previous - 1;
        previous = found;
        position = found + 1;
    }

    // Слитность совпадения и его близость к началу — два признака того, что кандидат
    // действительно похож на запрос, а не просто содержит его буквы вразброс.
    const density = query.length / (query.length + gaps);
    const head = 1 / (1 + firstMatch / 4);
    return 0.5 + 0.35 * density + 0.15 * head;
}

/** Расстояние Левенштейна. Для строк такой длины достаточно двух строк матрицы. */
function levenshtein(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(
                current[j - 1]! + 1,
                previous[j]! + 1,
                previous[j - 1]! + cost,
            );
        }
        previous = current;
    }
    return previous[b.length]!;
}

/** Похожесть запроса на кандидата: 0 — не похоже, 1 — совпадает. */
export function similarity(query: string, candidate: string): number {
    const q = normalise(query);
    const c = normalise(candidate);
    if (q === '') return 1;
    if (c === '') return 0;
    if (c.startsWith(q)) return 1;

    const subsequence = subsequenceScore(q, c);
    if (subsequence > 0) return subsequence;

    // Опечатки: сравнение с лучшим окном кандидата длиной с запрос, чтобы длина кандидата
    // сама по себе не занижала оценку.
    const window = c.slice(0, Math.max(q.length, 1));
    const distance = levenshtein(q, window);
    const closeness = 1 - distance / Math.max(q.length, window.length);
    return closeness >= 0.6 ? closeness * 0.5 : 0;
}

/** Отбирает и упорядочивает кандидатов по похожести на запрос. */
export function rank<T>(query: string, items: readonly T[], key: (item: T) => string): T[] {
    if (query.trim() === '') return [...items];
    return items
        .map((item) => ({ item, score: similarity(query, key(item)) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.item);
}
