import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Чтение общего `.env` из корня репозитория. Выполняется до сборки модулей Nest, поэтому
 * файл импортируется первым в `main.ts`: конфигурация должна быть готова к моменту, когда
 * начнут создаваться сервисы.
 */
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../.env'), quiet: true });
