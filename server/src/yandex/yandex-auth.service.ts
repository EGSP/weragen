import { Injectable } from '@nestjs/common';
import { importPKCS8, SignJWT } from 'jose';
import { AppConfigService, type ServiceAccountKey } from '../config/app-config.service.js';
import { describeCause, withRetry } from '../common/retry.js';

const IAM_TOKENS_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';
/** Алгоритм подписи, который требует Yandex (RSASSA-PSS + SHA-256). */
const JWT_ALG = 'PS256';
const JWT_TTL = '1h';
/** Перевыпуск заранее, за этот зазор до истечения. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TTL_MS = 50 * 60 * 1000;

/**
 * В поле `private_key` файла authorized_key.json Yandex добавляет перед PEM строку
 * «PLEASE DO NOT REMOVE THIS LINE! …», которую jose не принимает.
 */
const PKCS8_PEM_RE = /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/;

export class YandexAuthError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'YandexAuthError';
    }
}

type CachedToken = { readonly token: string; readonly refreshAtMs: number };

/**
 * Получение IAM-токена. Токен короткоживущий (около двенадцати часов), поэтому он не может
 * быть зашит в клиент модели: его перевыпускают заранее и подставляют заголовком на каждый
 * запрос. Параллельные обращения при истёкшем кеше разделяют один обмен.
 */
@Injectable()
export class YandexAuthService {
    private cached: CachedToken | undefined;
    private inflight: Promise<CachedToken> | undefined;

    constructor(private readonly config: AppConfigService) {}

    async getToken(): Promise<string> {
        const auth = this.config.auth;
        if (auth.kind === 'static') return auth.token;

        if (this.cached !== undefined && Date.now() < this.cached.refreshAtMs) {
            return this.cached.token;
        }
        this.inflight ??= this.requestToken(auth.key).finally(() => {
            this.inflight = undefined;
        });
        this.cached = await this.inflight;
        return this.cached.token;
    }

    /**
     * Подписывает JWT ключом сервисного аккаунта и обменивает его на IAM-токен. Это тот же
     * поток, который выполняет `yc iam create-token`, только внутри приложения.
     */
    private async requestToken(key: ServiceAccountKey): Promise<CachedToken> {
        const pem = PKCS8_PEM_RE.exec(key.privateKey);
        if (pem === null) {
            throw new YandexAuthError(
                'YANDEX_PRIVATE_KEY: не найден блок BEGIN/END PRIVATE KEY. Скопируйте значение ' +
                    'private_key из authorized_key.json целиком, заменив переносы строк на \\n.',
            );
        }

        const signingKey = await importPKCS8(pem[0], JWT_ALG);
        const jwt = await new SignJWT({})
            .setProtectedHeader({ alg: JWT_ALG, kid: key.keyId, typ: 'JWT' })
            .setIssuer(key.serviceAccountId)
            .setAudience(IAM_TOKENS_URL)
            .setIssuedAt()
            .setExpirationTime(JWT_TTL)
            .sign(signingKey);

        const response = await withRetry(async () => {
            try {
                return await fetch(IAM_TOKENS_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jwt }),
                });
            } catch (cause) {
                throw new YandexAuthError(
                    `Не удалось обратиться к сервису IAM: ${cause instanceof Error ? cause.message : String(cause)}` +
                        describeCause(cause),
                    { cause },
                );
            }
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new YandexAuthError(
                `Обмен JWT на IAM-токен не удался: HTTP ${response.status}. ${body}`.trim(),
            );
        }

        const data = (await response.json()) as { iamToken?: string; expiresAt?: string };
        if (!data.iamToken) throw new YandexAuthError('Ответ IAM не содержит поля iamToken');

        return {
            token: data.iamToken,
            refreshAtMs:
                data.expiresAt === undefined
                    ? Date.now() + DEFAULT_TTL_MS
                    : Date.parse(data.expiresAt) - REFRESH_SKEW_MS,
        };
    }
}
