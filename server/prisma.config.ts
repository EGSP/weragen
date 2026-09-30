import { defineConfig, env } from 'prisma/config';

// Файл читается Prisma CLI напрямую. Команды запускаются через dotenv-cli с общим `.env`
// в корне репозитория, поэтому DATABASE_URL уже установлена к моменту чтения.
export default defineConfig({
    schema: 'prisma/schema.prisma',
    datasource: { url: env('DATABASE_URL') },
});
