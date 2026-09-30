/** Разобранный параметр метода контроллера. */
export type RouteParam = {
    readonly kind: 'param' | 'query' | 'body';
    /** Имя в маршруте или строке запроса; для тела не используется. */
    readonly wireName: string;
    /** Имя аргумента в порождаемой функции. */
    readonly argName: string;
    readonly typeText: string;
    readonly optional: boolean;
};

/** Разобранный маршрут контроллера. */
export type Route = {
    readonly methodName: string;
    readonly httpMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** Полный путь с сегментами вида `:id`. */
    readonly path: string;
    readonly params: readonly RouteParam[];
    /** Тип результата без обёртки Promise. */
    readonly returnTypeText: string;
};

export type ControllerGroup = {
    /** Имя группы в клиенте: `SessionsController` → `sessions`. */
    readonly name: string;
    readonly routes: readonly Route[];
};
