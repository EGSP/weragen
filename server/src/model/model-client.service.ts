import { Injectable } from '@nestjs/common';
import { SpanStatusCode, type Context as OtelContext } from '@opentelemetry/api';
import { Effect } from 'effect';
import OpenAI from 'openai';
import type {
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { ModelFailure, type AgentMessage, type ModelReply, type ToolSpec } from '@weragen/ai';
import { AppConfigService } from '../config/app-config.service.js';
import { withRetry } from '../common/retry.js';
import { YandexAuthService } from '../yandex/yandex-auth.service.js';
import { tracer } from '../telemetry/tracing.js';
import {
    chatRequestAttributes,
    chatResponseAttributes,
    sessionAttributes,
} from '../telemetry/span-attributes.js';

/**
 * Клиент OpenAI-совместимого API Yandex AI Studio: реализация одноимённой зависимости ядра.
 *
 * Ядро объявляет собственные типы сообщений и не знает о формате провайдера; преобразование
 * выполняется здесь. Благодаря этому второй транспорт добавляется без правок в цикле.
 *
 * IAM-токен короткоживущий, поэтому в конструктор клиента он не зашивается: `apiKey` —
 * обязательный плейсхолдер, а авторизация подставляется заголовком на каждый запрос.
 */
@Injectable()
export class ModelClientService {
    private readonly client: OpenAI;

    constructor(
        private readonly config: AppConfigService,
        private readonly auth: YandexAuthService,
    ) {
        this.client = new OpenAI({
            apiKey: 'iam-bearer-per-request',
            baseURL: config.baseUrl,
            ...(config.folderId === '' ? {} : { project: config.folderId }),
        });
    }

    /**
     * Реализация, замкнутая на сессию и её модель. Идентификатор модели приходит
     * параметром: модель выбирается для каждой сессии из справочника.
     */
    forSession(sessionId: string, userId: string, model: string, parent: OtelContext) {
        return {
            complete: (messages: readonly AgentMessage[], tools: readonly ToolSpec[]) =>
                this.complete(messages, tools, sessionId, userId, model, parent),
        };
    }

    /** Приводит короткое имя модели к форме gpt://<каталог>/<модель>. */
    resolveUri(model: string): string {
        return model.startsWith('gpt://') ? model : `gpt://${this.config.folderId}/${model}`;
    }

    private complete(
        messages: readonly AgentMessage[],
        tools: readonly ToolSpec[],
        sessionId: string,
        userId: string,
        model: string,
        parent: OtelContext,
    ): Effect.Effect<ModelReply, ModelFailure> {
        const config = this.config;
        const self = this;

        return Effect.gen(function* () {
            const span = tracer().startSpan(
                `chat ${model}`,
                {
                    attributes: {
                        ...sessionAttributes(sessionId, userId),
                        ...chatRequestAttributes(
                            model,
                            self.resolveUri(model),
                            config.temperature,
                            messages,
                            tools.length,
                            config.tracing.captureContent,
                        ),
                    },
                },
                parent,
            );

            return yield* Effect.tryPromise({
                // Сигнал приходит от Effect: при прерывании волокна запрос к модели
                // отменяется, иначе провайдер продолжил бы генерацию и списал токены.
                try: (signal) => self.request(messages, tools, model, signal),
                catch: (cause) => new ModelFailure({ message: describeFailure(cause) }),
            }).pipe(
                Effect.tap((reply) =>
                    Effect.sync(() => {
                        span.setAttributes(
                            chatResponseAttributes(reply, config.tracing.captureContent),
                        );
                        span.setStatus({ code: SpanStatusCode.OK });
                    }),
                ),
                Effect.tapError((error) =>
                    Effect.sync(() =>
                        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message }),
                    ),
                ),
                // `ensuring` срабатывает и при прерывании, поэтому спан закрывается всегда.
                Effect.ensuring(Effect.sync(() => span.end())),
            );
        });
    }

    private async request(
        messages: readonly AgentMessage[],
        tools: readonly ToolSpec[],
        model: string,
        signal: AbortSignal,
    ): Promise<ModelReply> {
        const token = await this.auth.getToken();

        const response = await withRetry(
            () =>
                this.client.chat.completions.create(
                    {
                        model: this.resolveUri(model),
                        messages: messages.map(toProviderMessage),
                        temperature: this.config.temperature,
                        ...(this.config.maxTokens === undefined
                            ? {}
                            : { max_tokens: this.config.maxTokens }),
                        ...(tools.length > 0 ? { tools: tools.map(toProviderTool) } : {}),
                    },
                    { headers: { Authorization: `Bearer ${token}` }, signal },
                ),
            { signal },
        );

        const choice = response.choices[0];
        if (choice === undefined) {
            throw new Error('Модель вернула ответ без вариантов (choices пуст)');
        }

        // Поле `reasoning_content` не описано стандартом OpenAI, но его возвращают
        // Yandex AI Studio, DeepSeek и развёртывания Qwen.
        const reasoning = (choice.message as { reasoning_content?: unknown }).reasoning_content;

        return {
            content: choice.message.content ?? '',
            toolCalls: (choice.message.tool_calls ?? [])
                .filter((call) => call.type === 'function')
                .map((call) => ({
                    id: call.id,
                    name: call.function.name,
                    rawArguments: call.function.arguments,
                })),
            reasoning: typeof reasoning === 'string' && reasoning !== '' ? reasoning : undefined,
            finishReason: choice.finish_reason ?? undefined,
            usage: {
                prompt: response.usage?.prompt_tokens ?? 0,
                completion: response.usage?.completion_tokens ?? 0,
            },
        };
    }
}

function toProviderMessage(message: AgentMessage): ChatCompletionMessageParam {
    switch (message.role) {
        case 'system':
            return { role: 'system', content: message.content };
        case 'user':
            return { role: 'user', content: message.content };
        case 'tool':
            return { role: 'tool', tool_call_id: message.callId, content: message.content };
        case 'assistant':
            return message.toolCalls.length === 0
                ? { role: 'assistant', content: message.content }
                : {
                      role: 'assistant',
                      content: message.content === '' ? null : message.content,
                      tool_calls: message.toolCalls.map((call) => ({
                          id: call.id,
                          type: 'function',
                          function: { name: call.name, arguments: call.rawArguments },
                      })),
                  };
    }
}

function toProviderTool(spec: ToolSpec): ChatCompletionTool {
    return {
        type: 'function',
        function: {
            name: spec.name,
            description: spec.description,
            parameters: spec.parameters,
        },
    };
}

/** Ответы провайдера на неверную модель или недостаточные права содержательны, но теряются внутри объекта ошибки. */
function describeFailure(cause: unknown): string {
    if (cause instanceof OpenAI.APIError) {
        const details =
            typeof cause.error === 'object' && cause.error !== null
                ? JSON.stringify(cause.error)
                : cause.message;
        const hint =
            cause.status === 401 || cause.status === 403
                ? ' Проверьте IAM-токен и роль ai.languageModels.user у сервисного аккаунта.'
                : cause.status === 404
                  ? ' Проверьте идентификатор модели в справочнике и YANDEX_FOLDER_ID: URI модели должен существовать в каталоге.'
                  : '';
        return `Обращение к модели отклонено: HTTP ${cause.status ?? '—'}. ${details}${hint}`;
    }
    if (cause instanceof Error) {
        const inner = cause.cause;
        const detail =
            inner instanceof Error
                ? ` (${(inner as NodeJS.ErrnoException).code ?? inner.name}: ${inner.message})`
                : '';
        return `Обращение к модели не удалось: ${cause.message}${detail}`;
    }
    return `Обращение к модели не удалось: ${String(cause)}`;
}
