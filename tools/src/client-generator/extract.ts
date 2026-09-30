import { Project, SyntaxKind, type ClassDeclaration, type MethodDeclaration } from 'ts-morph';
import type { ControllerGroup, Route, RouteParam } from './types.js';

/** Декораторы, обозначающие маршрут. Поток событий (`Sse`) не порождается: клиент читает его через EventSource. */
const HTTP_DECORATORS = new Map<string, Route['httpMethod']>([
    ['Get', 'GET'],
    ['Post', 'POST'],
    ['Put', 'PUT'],
    ['Patch', 'PATCH'],
    ['Delete', 'DELETE'],
]);

/** Первый строковый аргумент декоратора: `@Controller('api/sessions')` → `api/sessions`. */
function firstStringArgument(decoratorArguments: readonly { getText(): string }[]): string {
    const first = decoratorArguments[0];
    if (first === undefined) return '';
    return first.getText().replace(/^['"`]|['"`]$/g, '');
}

function joinPath(base: string, tail: string): string {
    const parts = [base, tail].filter((part) => part !== '');
    return `/${parts.join('/')}`.replace(/\/+/g, '/');
}

/** Разворачивает `Promise<T>` до `T`; синхронные методы остаются как есть. */
function unwrapPromise(typeText: string): string {
    const match = /^Promise<([\s\S]+)>$/.exec(typeText.trim());
    return match === null ? typeText.trim() : match[1]!.trim();
}

function extractParams(method: MethodDeclaration): RouteParam[] {
    const params: RouteParam[] = [];

    for (const parameter of method.getParameters()) {
        for (const decorator of parameter.getDecorators()) {
            const name = decorator.getName();
            if (name !== 'Param' && name !== 'Query' && name !== 'Body') continue;

            const wireName = firstStringArgument(decorator.getArguments());
            const argName = parameter.getName();
            const typeNode = parameter.getTypeNode();

            params.push({
                kind: name === 'Param' ? 'param' : name === 'Query' ? 'query' : 'body',
                wireName: wireName === '' ? argName : wireName,
                argName,
                typeText: typeNode?.getText() ?? 'unknown',
                optional: parameter.hasQuestionToken(),
            });
        }
    }

    return params;
}

function extractRoutes(controller: ClassDeclaration, base: string): Route[] {
    const routes: Route[] = [];

    for (const method of controller.getMethods()) {
        for (const decorator of method.getDecorators()) {
            const httpMethod = HTTP_DECORATORS.get(decorator.getName());
            if (httpMethod === undefined) continue;

            routes.push({
                // Завершающее подчёркивание ставят, когда имя метода конфликтует с полем класса.
                methodName: method.getName().replace(/_+$/, ''),
                httpMethod,
                path: joinPath(base, firstStringArgument(decorator.getArguments())),
                params: extractParams(method),
                returnTypeText: unwrapPromise(
                    method.getReturnTypeNode()?.getText() ?? method.getReturnType().getText(method),
                ),
            });
        }
    }

    return routes;
}

/** Имя группы в клиенте: `SessionsController` → `sessions`. */
function groupName(controller: ClassDeclaration): string {
    const name = controller.getName() ?? 'api';
    const trimmed = name.replace(/Controller$/, '');
    return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/**
 * Читает контроллеры сервера и возвращает описание маршрутов.
 *
 * Разбор идёт по исходному коду, а не по работающему приложению: генератор не поднимает
 * сервер и не требует базы данных, поэтому его можно запускать в любой момент.
 */
export function extractControllers(tsConfigFilePath: string): ControllerGroup[] {
    const project = new Project({ tsConfigFilePath });
    const groups: ControllerGroup[] = [];

    for (const sourceFile of project.getSourceFiles()) {
        for (const controller of sourceFile.getClasses()) {
            const decorator = controller.getDecorator('Controller');
            if (decorator === undefined) continue;

            const base = firstStringArgument(decorator.getArguments());
            const routes = extractRoutes(controller, base);
            if (routes.length === 0) continue;

            groups.push({ name: groupName(controller), routes });
        }
    }

    // Порядок групп и маршрутов делается устойчивым, иначе перегенерация даёт лишние правки.
    groups.sort((a, b) => a.name.localeCompare(b.name));
    void SyntaxKind;
    return groups;
}
