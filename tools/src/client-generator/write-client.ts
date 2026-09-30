import type { ControllerGroup, Route } from './types.js';

/** Имена типов, встречающиеся в сигнатурах; все они объявлены в общем пакете типов. */
function collectTypeNames(groups: readonly ControllerGroup[]): string[] {
    const names = new Set<string>();
    const add = (typeText: string): void => {
        for (const match of typeText.matchAll(/[A-Z][A-Za-z0-9_]*/g)) {
            names.add(match[0]);
        }
    };
    for (const group of groups) {
        for (const route of group.routes) {
            add(route.returnTypeText);
            for (const param of route.params) if (param.kind === 'body') add(param.typeText);
        }
    }
    return [...names].sort();
}

/** Путь с подстановкой аргументов: `/api/sessions/:id` → шаблонная строка. */
function pathExpression(route: Route): string {
    const withParams = route.path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => `\${${name}}`);
    const query = route.params.filter((param) => param.kind === 'query');
    if (query.length === 0) return `\`${withParams}\``;
    const pairs = query
        .map((param) => `...(${param.argName} === undefined ? {} : { ${param.wireName}: String(${param.argName}) })`)
        .join(', ');
    return `\`${withParams}\` + toQuery({ ${pairs} })`;
}

function signature(route: Route): string {
    const args = route.params
        .filter((param) => param.kind !== 'query' || true)
        .map((param) => `${param.argName}${param.optional ? '?' : ''}: ${param.typeText}`)
        .join(', ');
    return args;
}

function callArguments(route: Route): string {
    const body = route.params.find((param) => param.kind === 'body');
    return body === undefined ? '' : `, ${body.argName}`;
}

/**
 * Цель генерации.
 *
 * Клиент один, а сред две: веб-клиент собирается Vite и берёт адрес из `import.meta.env`,
 * процесс воркфлоу исполняется в Node и получает адрес платформы переменной окружения при
 * запуске. Различие сводится к одному выражению, поэтому целей две, а генератор один —
 * второй разошёлся бы с контроллерами при первой же правке.
 */
export type ClientTarget = {
    /** Выражение, дающее базовый адрес. Подставляется в объявление `API_URL`. */
    readonly baseUrl: string;
};

export function writeClient(
    groups: readonly ControllerGroup[],
    target: ClientTarget = { baseUrl: "import.meta.env.VITE_API_URL ?? 'http://localhost:3100'" },
): string {
    const typeNames = collectTypeNames(groups);

    const lines: string[] = [
        '// Файл порождается автоматически: npm run generate:client',
        '// Правки будут потеряны при следующей генерации.',
        '',
        `import type { ${typeNames.join(', ')} } from '@weragen/types';`,
        '',
        `export const API_URL = ${target.baseUrl};`,
        '',
        '/** Собирает строку запроса, пропуская незаданные значения. */',
        'function toQuery(values: Record<string, string>): string {',
        '    const search = new URLSearchParams(values).toString();',
        "    return search === '' ? '' : `?${search}`;",
        '}',
        '',
        'async function request<Result>(',
        '    method: string,',
        '    path: string,',
        '    body?: unknown,',
        '): Promise<Result> {',
        '    const response = await fetch(`${API_URL}${path}`, {',
        '        method,',
        "        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },",
        '        ...(body === undefined ? {} : { body: JSON.stringify(body) }),',
        '    });',
        '',
        '    if (!response.ok) {',
        '        // Тело ответа Nest содержит поле message с причиной; она информативнее кода.',
        '        const detail = await response.json().catch(() => null);',
        '        const message =',
        "            detail !== null && typeof detail === 'object' && 'message' in detail",
        '                ? String((detail as { message: unknown }).message)',
        '                : `HTTP ${response.status}`;',
        '        throw new Error(message);',
        '    }',
        '',
        "    if (response.status === 204) return undefined as Result;",
        '    return (await response.json()) as Result;',
        '}',
        '',
        'export const api = {',
    ];

    for (const group of groups) {
        lines.push(`    ${group.name}: {`);
        for (const route of group.routes) {
            const args = signature(route);
            lines.push(
                `        ${route.methodName}: (${args}): Promise<${route.returnTypeText}> =>`,
                `            request('${route.httpMethod}', ${pathExpression(route)}${callArguments(route)}),`,
            );
        }
        lines.push('    },');
    }

    lines.push('};', '');
    return lines.join('\n');
}
