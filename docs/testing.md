# Тестирование

Как проверить изменения, ничего не задев на ферме.

**Главное правило: тесты никогда не должны видеть реальную ферму.** На этом
хосте рядом с кодом лежат настоящий сид принтеров
(`apps/print-orchestrator/config/printers.json` — адреса, серийный номер и код
доступа Bambu) и локальное dev-состояние (`apps/print-orchestrator/data/`).
Оркестратор без явных переменных окружения берёт именно их. Рабочая БД фермы
живёт в Docker-томе `orchestrator-data` и тестам недоступна, но реальные адреса
принтеров — доступны. Поэтому полный прогон запускается только командой из
раздела ниже, а не голым `pnpm test`.

## Окружение

- Node ≥ 22; SQLite встроенный (`--experimental-sqlite`).
- pnpm 10 через corepack: `corepack enable` или `corepack pnpm …`, если `pnpm`
  нет в `PATH`. Зависимости ставятся только в `apps/print-orchestrator`
  (`corepack pnpm install --frozen-lockfile`); в корне репозитория workspace-файла
  нет, установка там лишь создаст ненужный `pnpm-lock.yaml`.
- Дашборду установка не нужна: его тесты — обычный `node --test` без
  зависимостей.

## Оркестратор (`apps/print-orchestrator`)

Проверка типов (исходники и тесты):

```bash
cd apps/print-orchestrator
node_modules/.bin/tsc -p tsconfig.json --noEmit      # то же, что pnpm run typecheck
```

Полный прогон — **только изолированно**:

```bash
cd apps/print-orchestrator
D=$(mktemp -d)
TZ=UTC PRINTERS_CONFIG_PATH="$D/no-printers.json" PRINTERS_CONFIG_JSON='[]' \
  STATE_FILE_PATH="$D/state.json" ORCA_SLICER_CMD= \
  node --experimental-sqlite --disable-warning=ExperimentalWarning --import tsx \
  --test "src/**/*.test.ts"
rm -rf "$D"
```

| Переменная | Зачем |
|---|---|
| `PRINTERS_CONFIG_PATH` → несуществующий файл, `PRINTERS_CONFIG_JSON='[]'` | иначе сидом станет реальный `config/printers.json` |
| `STATE_FILE_PATH` → свежий каталог на каждый прогон | из него выводятся `queue.db` и хранилище артефактов; остатки прошлого прогона попадают в тесты синглтона |
| `ORCA_SLICER_CMD=` (пусто) | нарезка — фейковым раннером, а не настоящим OrcaSlicer |
| `TZ=UTC` | тесты времени и окон написаны в UTC (как и `pnpm test`) |

Чего не делать:

- **не задавать** `QUEUE_DB_PATH` / `ARTIFACT_STORAGE_ROOT` снаружи: тесты
  маршрутов изолируют себя собственным `STATE_FILE_PATH`, а внешний
  `QUEUE_DB_PATH` перебивает это и сводит тесты синглтона в одну БД (ложное
  падение «slicing endpoints never expose the legacy queue»);
- **не править `.ts`-исходники во время прогона**: воркер анализа загружает их с
  диска при каждом запуске, и правка посреди прогона даёт ложные падения в
  тестах, которые идут позже;
- **не запускать голые** `pnpm test`, `pnpm run test:unit`,
  `pnpm run test:integration` на хосте фермы — эти скрипты изоляцию не задают.
  В CI они безопасны: в чистом checkout нет `config/printers.json`. Переменные
  из таблицы можно поставить перед ними — они наследуются.

**Ожидаемый результат — 0 падений** (с 2026-10-15). Любое падение — сигнал, а не
«окружение»: прежние «4 падения каталога Orca» оказались устаревшим тестом.
Полный прогон занимает около 15–20 минут. Два теста чувствительны к нагрузке
машины (`fetchWithTimeout` «resolves within the deadline» и нарезка пакета в
`bambuPackage`) — перед выводами перезапустите их отдельно.

Отдельный файл — та же команда с путём вместо маски, например
`--test src/app/launch/executablePath.test.ts`.

Прочее:

- `pnpm run test:unit` / `test:integration` — деление набора как в CI
  (`scripts/select-tests.mjs`, по содержимому файла); вместе это весь набор.
- `pnpm run lint:complexity` — отчёт о сложности и размере файлов, CI не валит.
- `pnpm run build` — сборка `dist/`; тесты и `testkit/` в неё не попадают
  (`tsconfig.build.json`).
- Контракты с fulfillment (`contracts/*.json`) перегенерируются тем же
  изолированным прогоном с `UPDATE_CONTRACT=1` — только после намеренного
  изменения DTO; затем копия уходит в fulfillment
  ([operations.md](operations.md#wire-contracts)).
- Сравнить поведение со старым коммитом: `git worktree add --detach <tmp>/base <sha>`
  и симлинк на `apps/print-orchestrator/node_modules`. Не `git stash`: среда
  автоматически коммитит рабочее дерево (коммиты `123`).

## Дашборд (`apps/print-dashboard`)

```bash
cd apps/print-dashboard
node --test "tests/**/*.test.mjs"        # секунды, без установки
```

Браузерные smoke-тесты (`smoke/*.smoke.mjs`) открывают настоящий дашборд в
headless Chrome против mock-сервера (`smoke/mockServer.mjs`) — к настоящему API
и принтерам не обращаются. Без браузера на `CHROME_CDP_URL` (по умолчанию
`http://127.0.0.1:9222`) они **пропускаются**, а не падают. Локального Chrome на
хосте нет, браузер — в Docker:

```bash
docker run -d --name atelier-chrome --network host --shm-size=1g chromedp/headless-shell:latest
node --test smoke/layout.smoke.mjs       # по одному файлу на свежий контейнер
docker rm -f atelier-chrome
```

Особенности стенда:

- контейнеру не передавать `--remote-debugging-port` — его entrypoint уже
  пробрасывает 9222;
- браузер обычно не переживает больше одного файла — пересоздавайте контейнер
  между файлами; свежий контейнер иногда «зависает» на подключении CDP (тест не
  доходит до первой проверки) — пересоздать и повторить;
- цель, оставшаяся от убитого прогона, блокирует следующий: `/json/list` →
  `/json/close/<id>`;
- `SMOKE_SCREENSHOTS_DIR=<каталог>` — `layout.smoke.mjs` дополнительно сохраняет
  снимки всех экранов на четырёх ширинах;
- сценариям с непустой доской нужен расширенный `MOCK_DASHBOARD` (экспорт
  `smoke/mockServer.mjs`, опция `api`).

## Скрипт развёртывания

```bash
./scripts/tests/deploy.test.sh             # все сценарии
./scripts/tests/deploy.test.sh <шаблон>    # только подходящие
```

Гоняет настоящий `scripts/deploy.sh` (копия без изменений во временном checkout)
против фейковых `docker` и `curl` (`scripts/tests/fake-docker`, `fake-curl`):
определение изменений, gate `restart-safety`, применение по сервисам, откат,
коды выхода. Без демона, без сборки, без принтеров. Обязателен после любой правки
`deploy.sh` или `compose.yml`.

## Перед релизом: настоящий образ

Юнит-тесты собирают сервисы частично; полный рантайм находил дефекты, которых они
не видят. Перед деплоем, меняющим оркестратор, — сквозные сценарии на
кандидатном образе (изолированная сеть, симуляторы Moonraker, настоящий
OrcaSlicer) и проверка миграций на копии рабочей БД:
[ops/verify/README.md](../ops/verify/README.md). Кандидат собирается с тегом
`:verify`, никогда не `:latest`.

## CI (`.github/workflows/ci.yml`)

| Задача | Что проверяет |
|---|---|
| `secret-scan` | закоммиченные приватные ключи (по содержимому) |
| `print-orchestrator` | typecheck, `test:unit`, `test:integration`, `lint:complexity` (не валит), build, `pnpm audit --prod` |
| `print-dashboard` | юнит-тесты, smoke в headless-shell, `nginx -t` на закреплённом образе, сборка образа, Trivy |
| `deploy-script` | `bash -n`, shellcheck (рекомендательно), `deploy.test.sh` |
| `orchestrator-image` | сборка образа, Trivy |

## Что прогонять после изменений

| Изменено | Минимум проверок |
|---|---|
| только Markdown вне `apps/print-orchestrator/config/` | ссылки; прогоны не нужны |
| код или тесты оркестратора | typecheck + изолированный полный прогон |
| дашборд | юнит-тесты; smoke — если менялись разметка или поведение |
| `scripts/deploy.sh`, `compose.yml` | `deploy.test.sh` |
| миграции, Dockerfile, `config/` оркестратора, крупный релиз | всё выше + `ops/verify` (`run.sh` и `migration-check.sh`) |
