/**
 * Разрешение команды при порождении дочернего процесса.
 *
 * Процессами распоряжаются два домена — воркфлоу и подключения MCP по транспорту stdio, — и
 * распоряжаются они по-разному: у воркфлоу порождение включает выбор порта, ожидание
 * готовности, передачу переменных `WERAGEN_*`, обмен по HTTP и двухступенчатое прекращение,
 * тогда как у подключения MCP нет ни порта, ни HTTP, а сам процесс порождает транспорт из
 * SDK. Общего между ними ровно одно — разрешение команды в Windows, — и оно собрано здесь.
 */

/**
 * Команда `node` заменяется путём к текущему исполняемому файлу Node. Так дочерний процесс
 * исполняется той же версией, что и платформа, и не зависит от того, есть ли `node` в PATH
 * у службы: в Windows поиск исполняемого файла при порождении процесса не учитывает
 * PATHEXT, и короткое имя там разрешается не всегда.
 */
export function resolveCommand(command: string): string {
    return command === 'node' ? process.execPath : command;
}

const SHELL_ONLY = /\.(cmd|bat|ps1)$/i;

/** Команды пакетных менеджеров в Windows существуют только командными файлами. */
const BATCH_COMMANDS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno']);

/**
 * Требуется ли оболочка для исполнения команды. Пригодно тем, кто порождает процесс сам и
 * может передать `shell` в параметрах.
 */
export function needsShell(command: string): boolean {
    if (process.platform !== 'win32') return false;
    return SHELL_ONLY.test(command) || BATCH_COMMANDS.has(command);
}

/**
 * Разрешает команду для того, кто передать `shell` не может.
 *
 * `StdioClientTransport` из SDK порождает процесс с `shell: false` жёстко, а командный файл
 * в Windows напрямую не исполняется — начиная с Node 20 такое порождение отвергается. Здесь
 * команда переписывается в явный вызов интерпретатора команд, что даёт тот же результат, не
 * требуя `shell` от вызывающей стороны.
 *
 * Кавычки вокруг аргументов не ставятся: `cmd.exe /c` получает их отдельными элементами
 * массива, и Node экранирует их сам.
 */
export function resolveShellFreeCommand(
    command: string,
    args: readonly string[],
): { readonly command: string; readonly args: string[] } {
    if (!needsShell(command)) return { command: resolveCommand(command), args: [...args] };
    const comspec = process.env['ComSpec'] ?? 'cmd.exe';
    return { command: comspec, args: ['/c', command, ...args] };
}
