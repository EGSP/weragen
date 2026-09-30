import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpTransport } from '@weragen/types';
import { resolveShellFreeCommand } from '../common/spawn.js';

/**
 * Создание транспорта подключения.
 *
 * Поддерживаются два: stdio, где соединением служит дочерний процесс, и Streamable HTTP,
 * где соединением служит сессия протокола, а постоянного сокета нет вовсе. Различие это не
 * настроечное, а существенное: у первого отказ выражается выходом процесса, у второго —
 * истечением сессии на стороне сервера.
 */

/**
 * Отказ, различающий две причины. `unreachable` означает, что внешняя сторона не отвечает и
 * исправление находится там; `unsatisfied` — что подключение непригодно по причине,
 * устранимой настройкой платформы либо карточки. Сведение их в одно «не работает»
 * заставляло бы выяснять причину каждый раз заново.
 */
export class McpFailure extends Error {
    constructor(
        readonly kind: 'unreachable' | 'unsatisfied',
        message: string,
    ) {
        super(message);
        this.name = 'McpFailure';
    }
}

export function createTransport(transport: McpTransport): Transport {
    if (transport.type === 'sse') {
        throw new McpFailure(
            'unsatisfied',
            'Транспорт sse объявлен устаревшим в пользу Streamable HTTP и не поддерживается. ' +
                'Укажите "type": "http", если сервер его умеет.',
        );
    }

    if (transport.type === 'http') {
        let url: URL;
        try {
            url = new URL(transport.url);
        } catch {
            throw new McpFailure('unsatisfied', `Адрес "${transport.url}" не разобран как URL`);
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new McpFailure(
                'unsatisfied',
                `Схема адреса должна быть http или https, получена "${url.protocol}"`,
            );
        }
        return new StreamableHTTPClientTransport(url, {
            ...(Object.keys(transport.headers).length === 0
                ? {}
                : { requestInit: { headers: { ...transport.headers } } }),
        });
    }

    // Команда разрешается до передачи в SDK: транспорт порождает процесс с `shell: false`
    // жёстко, а `npx` и подобные команды в Windows существуют только командными файлами.
    const resolved = resolveShellFreeCommand(transport.command, transport.args);

    return new StdioClientTransport({
        command: resolved.command,
        args: resolved.args,
        // Наследуется только то, что SDK считает безопасным; настройки карточки поверх.
        env: { ...getDefaultEnvironment(), ...transport.env },
        ...(transport.cwd === null || transport.cwd === '' ? {} : { cwd: transport.cwd }),
        // Вывод в stderr отдаётся журналу платформы: у сервера, не сумевшего запуститься,
        // это единственное объяснение причины.
        stderr: 'pipe',
    });
}

/** Краткое описание подключения для журнала и сообщений об отказе. */
export function describeTransport(transport: McpTransport): string {
    return transport.type === 'stdio'
        ? `${transport.command} ${transport.args.join(' ')}`.trim()
        : transport.url;
}
