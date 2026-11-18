# Тестирование

Обычные проверки изолированы от фермы. Backend runner создаёт свежий временный
каталог, задаёт пустой inventory, временный `STATE_FILE_PATH`, отключает Orca
и передаёт дочернему Node только служебное окружение. Настройки production,
`QUEUE_DB_PATH`, `ARTIFACT_STORAGE_ROOT`, credentials и `NODE_OPTIONS` не наследуются.
По окончании runner удаляет только свой каталог. Каждый интеграционный тест
дополнительно использует собственные временные fixtures / in-memory SQLite.

## Окружение

Нужны Node.js ≥22 (встроенный SQLite) и pnpm 10.34.9 через corepack.
`corepack pnpm` работает и без `pnpm` в PATH. Устанавливайте зависимости только
в `apps/print-orchestrator`: в корне нет pnpm workspace. Dashboard не требует install.

```bash
cd apps/print-orchestrator
corepack pnpm install --frozen-lockfile
```

## Оркестратор

Из `apps/print-orchestrator`:

```bash
corepack pnpm run typecheck        # исходники и тесты
corepack pnpm test                 # весь набор, изолирован автоматически
corepack pnpm run test:unit
corepack pnpm run test:integration
corepack pnpm run build            # dist/, без tests и testkit
corepack pnpm audit --prod --audit-level moderate
corepack pnpm run lint:complexity   # информационный отчёт, не gate
```

Тот же полный прогон без pnpm, с ограничением параллелизма:

```bash
node scripts/run-tests.mjs all --test-concurrency=2
node_modules/.bin/tsc -p tsconfig.json --noEmit
node_modules/.bin/tsc -p tsconfig.build.json
```

`select-tests.mjs` делит набор **по содержимому**, не по каталогу: SQLite store,
Fastify, runtime и настоящий каталог Orca относятся к integration. Это разделение
по масштабу проверки, а не гарантия отсутствия loopback I/O в unit: Anycubic TLS
и handshake поднимают локальные HTTP/TLS/MQTT-серверы, Bambu FTPS — fake server.
Ни один штатный набор не должен подключаться к реальному принтеру или fulfillment.

Для одного файла допустим прямой Node-запуск, но изоляцию тогда задают вручную:

```bash
atelier_test_dir=$(mktemp -d)
env -i PATH="$PATH" TZ=UTC PRINTERS_CONFIG_JSON='[]' \
  PRINTERS_CONFIG_PATH="$atelier_test_dir/no-printers.json" \
  STATE_FILE_PATH="$atelier_test_dir/state.json" ORCA_SLICER_CMD= \
  node --experimental-sqlite --disable-warning=ExperimentalWarning --import tsx \
  --test src/infra/printers/anycubic/reports.test.ts
# После завершения удалить только созданный выше каталог:
rm -r -- "$atelier_test_dir"
```

Не запускайте сырой `node --test` без изоляции на хосте фермы: runtime по умолчанию
читает настоящий `config/printers.json` и локальный `data/`. Не правьте `.ts`
во время прогона: worker анализа загружает исходники с диска. При нагрузочных
таймаутах изучайте ошибку и повторяйте затронутый файл отдельно; ожидаемый результат
полного прогона — ноль failures/cancellations. Ограничение параллелизма снижает
конкуренцию за CPU в TLS, ZIP и worker-тестах.

Сохраняйте регрессии повторного старта, отмены, PrintRun/BedCycle, auto queue,
совместимости, миграций, сохранности данных, pinning и запретов команд. Реальные
обезличенные Anycubic captures находятся в
`src/infra/printers/anycubic/testkit/kobraXCaptures.ts`.
`launch/budget.ts` используется тестом межсервисного deadline и не является
заброшенным runtime-кодом.

Контракты fulfillment обновляются намеренно, с `UPDATE_CONTRACT=1` перед runner,
только при изменении DTO; затем сверяются в обоих проектах.
[Процедура](operations.md#wire-contracts).

## Dashboard

```bash
cd apps/print-dashboard
node --test 'tests/**/*.test.mjs'    # без браузера и зависимостей
npm run test:smoke                 # при запущенном Chrome CDP
```

Dashboard — ES-модули без TypeScript и bundler; отдельного typecheck/build JS
нет. Проверки чистых view/model helpers, структуры nginx и browser smoke дополняют
друг друга. Контейнер собирается из его Dockerfile.

Browser smoke открывает статику против `smoke/mockServer.mjs`. Если
`CHROME_CDP_URL` задан, недоступность Chrome завершает тест с ошибкой. Без явно
указанного URL discovery на `127.0.0.1:9222` допускает skip для локальной
разработки. Передавайте адрес уже запущенного тестового браузера.

```bash
CHROME_CDP_URL=http://127.0.0.1:9222 npm run test:smoke
```

CI использует закреплённый Chrome for Testing и выполняет smoke-файлы
последовательно. `SMOKE_SCREENSHOTS_DIR` сохраняет layout-снимки вне Git,
если указать временный каталог.

## Deploy script

```bash
./scripts/tests/deploy.test.sh
./scripts/tests/deploy.test.sh <шаблон>
```

Скрипт запускает настоящий deploy в отдельном checkout с fake Docker/curl:
change detection, restart-safety, deferral, config-only recreate, rollback,
сигналы и exit codes. Docker-демон, production и принтеры не используются.
Обязателен после изменений deploy/compose.

## Кандидатный образ и миграции

[ops/verify/README.md](../ops/verify/README.md) описывает два отдельных инструмента:

- `run.sh`: свежие данные, только fake Moonraker, Docker-сеть `--internal`,
  проверка отсутствия внешнего маршрута, настоящий Orca с read-only mount.
  Автоочередь включается **только внутри стенда**.
- `migration-check.sh`: читает production volume **только на чтение** для
  согласованной копии; кандидат работает на scratch-копии с `--network none`.
  Это инструмент с доступом к production-источнику, не обычный unit test.

Перед запуском проверьте текущий скрипт, выделенные имена/пути и image ID;
не передавайте живой volume как scratch. Сборка только под отдельным тегом
(`:verify` или уникальным), без подмены `:latest` и rollback-тегов.
При изменениях документации и удалении неиспользуемых helpers такой стенд
обычно не нужен; для runtime/миграций/каталога — нужен.

## CI

[Проверки GitHub Actions и сопровождение runner](ci.md).
Перед отправкой проверяйте `git diff --check`, состав Git diff и ссылки Markdown.
