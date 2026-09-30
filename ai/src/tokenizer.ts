/**
 * Оценка числа токенов без токенизатора модели.
 *
 * Точный подсчёт требует словаря конкретной модели, а у провайдера модели разные и словари
 * к ним не публикуются вместе с API. Для показа заполненности контекста точность до токена
 * не нужна: достаточно порядка величины, поэтому число оценивается по составу текста.
 *
 * Соотношения взяты из документации Yandex AI Studio, где один и тот же текст прогнан через
 * токенизаторы нескольких моделей (aistudio.yandex.ru/docs/ru/ai-studio/concepts/generation/tokens):
 * русский текст — 5,2 символа на токен у YandexGPT, 3,6 у Qwen3, 4,6 у gpt-oss; английский —
 * 5,36 у Alice AI и 5,48 у Qwen3 и gpt-oss. Измерены они на связном тексте вместе с
 * пробелами и знаками препинания, поэтому применяются к той же смеси, а не к одним буквам.
 *
 * Отдельно считается то, чего в связном тексте мало: цифры, скопления знаков — разметка
 * JSON и кода — и символы прочих письменностей. Токенизаторы дробят их мельче слов, и
 * общее соотношение занизило бы оценку результатов инструментов, где JSON преобладает.
 */

export type TokenizerProfile = {
    /** Имя семейства для показа: по нему видно, какими соотношениями получена оценка. */
    readonly name: string;
    /** Символов на токен в русском связном тексте. */
    readonly cyrillic: number;
    /** Символов на токен в английском связном тексте. */
    readonly latin: number;
    /** Цифр на токен: Qwen делит числа поцифренно, словарь o200k — группами по три. */
    readonly digits: number;
    /**
     * Множитель к оценке, выведенный сверкой с числом токенов, которое сообщил провайдер.
     * Соотношения из документации измерены на связном тексте, а запрос агента состоит в
     * основном из JSON — схем инструментов и их результатов, — и дробится мельче.
     */
    readonly correction: number;
};

const YANDEX: TokenizerProfile = {
    name: 'yandex',
    cyrillic: 5.2,
    latin: 5.36,
    digits: 2,
    correction: 1,
};

/**
 * Поправка Qwen получена на 16 ходах `qwen3.6-35b-a3b` с журналами от 11 до 106 тысяч
 * токенов: без неё оценка составляла 0,82–0,85 от `prompt_tokens` провайдера, причём
 * равномерно — и для схем инструментов, и для переписки.
 */
const QWEN: TokenizerProfile = { name: 'qwen', cyrillic: 3.6, latin: 5.48, digits: 1, correction: 1.17 };

const GPT_OSS: TokenizerProfile = {
    name: 'gpt-oss',
    cyrillic: 4.6,
    latin: 5.48,
    digits: 3,
    correction: 1,
};

/**
 * Профиль для модели неизвестного семейства. Взяты соотношения Qwen — наименьшие из
 * измеренных: завышенная оценка заполненности безопаснее заниженной, после которой
 * переполнение контекста оказывается неожиданным.
 */
const GENERIC: TokenizerProfile = { ...QWEN, name: 'generic' };

/** Символов на токен в скоплениях знаков: `{"`, `":"`, `},` обычно занимают токен каждое. */
const SYMBOL_CHARS_PER_TOKEN = 2;

/**
 * Доля знаков препинания, свойственная связному тексту. Знаки сверх неё считаются
 * разметкой и оцениваются отдельно.
 */
const PROSE_PUNCTUATION_SHARE = 0.08;

/** Профиль по идентификатору модели: короткому имени или полному URI. */
export function tokenizerFor(model: string): TokenizerProfile {
    const name = model.toLowerCase();
    if (name.includes('yandexgpt') || name.includes('aliceai')) return YANDEX;
    if (name.includes('qwen')) return QWEN;
    if (name.includes('gpt-oss')) return GPT_OSS;
    return GENERIC;
}

/** Оценка числа токенов в тексте. Пустой текст токенов не занимает. */
export function estimateTokens(text: string, profile: TokenizerProfile = GENERIC): number {
    if (text === '') return 0;

    let cyrillic = 0;
    let latin = 0;
    let digits = 0;
    let spaces = 0;
    let punctuation = 0;
    let other = 0;

    // Разбор по кодам символов, а не регулярными выражениями: оценивается весь журнал
    // сессии на каждый запрос, и проверка класса символа выражением обходилась бы дороже.
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if ((code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a)) latin += 1;
        else if (code >= 0x0400 && code <= 0x04ff) cyrillic += 1;
        else if (code >= 0x30 && code <= 0x39) digits += 1;
        else if (code === 0x20 || code === 0x0a || code === 0x09 || code === 0x0d) spaces += 1;
        else if (isPunctuation(code)) punctuation += 1;
        else if (code >= 0xc0 && code <= 0x024f) latin += 1;
        else other += 1;
    }

    const letters = cyrillic + latin;
    const prosePunctuation = Math.min(punctuation, letters * PROSE_PUNCTUATION_SHARE);
    const prose = letters + spaces + prosePunctuation;
    // Смешанный текст оценивается средним гармоническим по долям письменностей: токены
    // русской части и английской складываются, а не усредняются соотношения.
    const tokensPerChar =
        letters === 0
            ? 1 / profile.latin
            : cyrillic / letters / profile.cyrillic + latin / letters / profile.latin;

    const tokens =
        prose * tokensPerChar +
        digits / profile.digits +
        (punctuation - prosePunctuation) / SYMBOL_CHARS_PER_TOKEN +
        // Иероглифы, эмодзи и прочие письменности занимают не меньше токена на символ.
        other;

    return Math.ceil(tokens * profile.correction);
}

/** Знаки ASCII, типографские кавычки, тире и прочая общая пунктуация. */
function isPunctuation(code: number): boolean {
    return (
        (code >= 0x21 && code <= 0x2f) ||
        (code >= 0x3a && code <= 0x40) ||
        (code >= 0x5b && code <= 0x60) ||
        (code >= 0x7b && code <= 0x7e) ||
        code === 0xab ||
        code === 0xbb ||
        (code >= 0x2010 && code <= 0x2027)
    );
}
