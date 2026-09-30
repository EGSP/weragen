# Инструкция для агентов

## Effect

- Используется Effect 4 (пакет `effect`, версия `4.0.0-rc.118`). Сервисы объявляются через `Context.Service`, значения, наследуемые волокнами, — через `Context.Reference`; API Effect 3 (`Context.Tag`, `FiberRef`, `Effect.catchAll`, `Either` и т. п.) в проекте не используются.
- Effect применяется в ядре (`ai`), в пакете воркфлоу (`workflow`) и в бизнес-логике сервера. Роутинг, контроллеры и внедрение зависимостей остаются на NestJS; `Layer` не используется.

## Проверка после изменений

Команда `tsc` в проекте заменена на `effect-tsgo` из пакета `@effect/tsgo`: это TypeScript 7 со встроенным Effect Language Service. Замену выполняет скрипт `prepare` при `npm install`, поэтому обычная проверка типов выдаёт и диагностики Effect. Ошибки и предупреждения Effect нужно исправлять, а не подавлять.

```bash
npm run typecheck
```

Подробный отчёт диагностик Effect, включая подсказки:

```bash
npm run diagnostics
```

## Исходники внешних библиотек

Исходники внешних библиотек подключены в каталог @repos/ через `git subtree`.

- Используй их как справочник только для чтения, когда работаешь с соответствующими библиотеками.
- Опирайся на примеры и приёмы из этих исходников, а не на догадки или результаты веб-поиска.
- Не редактируй файлы в @repos/ без явной просьбы.
- Не импортируй код из @repos/: код приложения импортирует библиотеки из установленных пакетов.

В `repos/effect` лежат исходники Effect 4. Перед использованием API Effect сверяйся с `repos/effect/packages/effect/src`, `repos/effect/LLMS.md` и `repos/effect/ai-docs`; переход с Effect 3 описан в `repos/effect/MIGRATION.md` и `repos/effect/migration`.

Обновление исходников:

```bash
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git main --squash
```
