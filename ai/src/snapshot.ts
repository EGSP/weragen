import type { RequestSnapshotContent, ToolSource } from '@weragen/types';
import { systemPrompt, withSections } from './system-prompt.js';
import { terminalSpecs, type CompletionMode } from './terminal.js';
import type { AnyAgentTool, ToolSpec } from './tool.js';

/**
 * Снимок постоянной части запроса к модели: указаний платформы, секций, дописанных к ним, и
 * описаний инструментов.
 *
 * Цикл строит запрос из снимка, а не рядом с ним: промпт и перечень инструментов для
 * обращения к модели берутся из того же объекта, который сохраняется. Поэтому снимок, на
 * который ссылается журнал, совпадает с отправленным по построению, а не по соглашению.
 * Оценка контекста строит постоянную часть той же функцией, когда снимка ещё нет.
 */

/** Инструмент набора вместе с происхождением: от него зависит, к какой части контекста он отнесён. */
export type SourcedTool = { readonly spec: ToolSpec; readonly source: ToolSource };

export type SnapshotInput = {
    readonly completion: CompletionMode;
    /** Указания платформы. Отсутствие означает промпт по умолчанию для дисциплины. */
    readonly systemPrompt?: string;
    /** Секции, дописываемые к указаниям: инструкции серверов MCP. */
    readonly sections: readonly string[];
    /** Набор реестра. Терминальные инструменты добавляются здесь. */
    readonly tools: readonly SourcedTool[];
};

export function requestSnapshot(input: SnapshotInput): RequestSnapshotContent {
    // Терминальные инструменты добавляются к набору здесь, а не берутся из реестра: реестр
    // предоставляет действия, а эти два — способ объявить, чем ход закончен, и исполняются
    // они самим циклом.
    const tools: SourcedTool[] = [
        ...input.tools,
        ...terminalSpecs(input.completion).map((spec) => ({ spec, source: 'builtin' as const })),
    ];
    return {
        prompt: input.systemPrompt ?? systemPrompt(input.completion),
        // Пустая секция к промпту не дописывается, поэтому и в снимок она не попадает.
        sections: input.sections.filter((section) => section.trim() !== ''),
        tools: tools.map(({ spec, source }) => ({
            name: spec.name,
            description: spec.description,
            parameters: spec.parameters,
            source,
        })),
    };
}

/** Набор реестра с происхождением инструментов. Инструмент без отметки — встроенный. */
export function sourcedTools(registry: {
    readonly specs: readonly ToolSpec[];
    readonly find: (name: string) => AnyAgentTool | undefined;
}): SourcedTool[] {
    return registry.specs.map((spec) => ({
        spec,
        source: registry.find(spec.name)?.source ?? 'builtin',
    }));
}

/** Системный промпт в том виде, в каком он уходит модели. */
export function snapshotPrompt(snapshot: RequestSnapshotContent): string {
    return withSections(snapshot.prompt, snapshot.sections);
}

/** Описания инструментов в том виде, в каком они уходят модели: без отметки происхождения. */
export function snapshotSpecs(snapshot: RequestSnapshotContent): ToolSpec[] {
    return snapshot.tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
    }));
}
