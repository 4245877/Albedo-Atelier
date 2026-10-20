# Atelier

Atelier (Albedo) — система управления фермой FDM-принтеров: загрузка
STL / 3MF / G-code, анализ, нарезка OrcaSlicer, очередь, планировщик, запуск
с проверкой допуска, мониторинг, камеры и история. Склад филамента и
Telegram-уведомления находятся в отдельном проекте fulfillment.

## Компоненты и оборудование

- **print-orchestrator** — Node.js 22 / TypeScript / Fastify. Единственный сервис,
  работающий с принтерами; SQLite хранит оборудование, задания, очередь и историю.
- **print-dashboard** — статические ES-модули за nginx, без сборщика.
- **OrcaSlicer** — необязательный runtime нарезки, закреплённая версия 2.3.0.
- **go2rtc** — мост камер к WebRTC в браузере.
- **fulfillment** — соседний репозиторий `/home/miha/apps/fulfillment`, HTTP-интеграция
  через общую Docker-сеть `print-farm`.

| Оборудование | Протокол | Возможности текущего кода |
|---|---|---|
| Creality K2 | Moonraker HTTP :4408 | Файлы, удалённый старт, управление печатью, свет, телеметрия, камера через go2rtc |
| Bambu Lab A1 Combo | LAN MQTT + FTPS | Файлы, удалённый старт, управление печатью, свет, телеметрия; AMS требует отдельной аппаратной приёмки |
| Creality Ender-3 V3 KE | Creality WebSocket | Телеметрия; задания через ручной перенос файла и запуск на экране принтера |
| Anycubic Kobra X | LAN HTTP :18910 + MQTT/TLS :9883 | Мониторинг, просмотр файлов и пассивная камера; jobs/upload/start/delete и физические команды закрыты |

**Срез production на 20 октября 2026:** метки работающих backend и dashboard —
`72dfde5`, SQLite — схема **19**, go2rtc использует прежний `config/go2rtc.yaml`.
Файлы и камера Kobra X подготовлены в `e19e81a` / `7eca5c4`, но ещё не развёрнуты.
Аппаратно подтверждены мониторинг, чтение памяти и пассивный видеопоток;
production WebRTC ещё требует приёмки. Подробности и границы проверки —
[документ Anycubic](docs/ANYCUBIC_KOBRA_X_STAGE2.md),
[порядок выпуска](docs/ANYCUBIC_KOBRA_X_RELEASE.md).
Фактическую ревизию перед эксплуатационными действиями проверяют заново.

## Структура

```text
apps/print-orchestrator/
  src/domain/       модели, совместимость, допуск, очередь, профили
  src/app/          сервисы, poller, dispatch, нарезка и планировщик
  src/infra/        SQLite и миграции, адаптеры устройств, файлы, fulfillment
  src/modules/      HTTP-маршруты
  config/           профили Orca, примеры оборудования и конфиги go2rtc
  contracts/        обезличенные межсервисные DTO для fulfillment
  scripts/          тестовый runner и инструменты каталога Orca
apps/print-dashboard/  features/, render/, shared/, styles/, tests/, smoke/
docs/                 эксплуатация, тесты, Anycubic LAN
ops/backup/           резервное копирование и восстановление
ops/verify/           изолированная проверка образов и миграций
scripts/deploy.sh     штатное обновление production
scripts/tests/        проверка deploy на fake Docker/curl
compose.yml           базовый стек
compose.orca.yml      runtime OrcaSlicer с хоста
.env.example          настройки с пояснениями
```

## Локальная разработка

Нужны Node.js ≥22 и pnpm 10.33.1 через corepack. Зависимости устанавливаются
в backend; у dashboard внешних зависимостей нет. В корне нет pnpm workspace.

```bash
cd apps/print-orchestrator
corepack pnpm install --frozen-lockfile
atelier_dev_dir=$(mktemp -d)
env -u QUEUE_DB_PATH -u ARTIFACT_STORAGE_ROOT -u SNAPSHOTS_DIR \
  PRINTERS_CONFIG_PATH="$atelier_dev_dir/no-printers.json" PRINTERS_CONFIG_JSON='[]' \
  STATE_FILE_PATH="$atelier_dev_dir/state.json" FULFILLMENT_API_URL= ORCA_SLICER_CMD= \
  corepack pnpm run dev
```

На хосте фермы `config/printers.json` и `data/` могут содержать настоящие адреса
и локальное состояние. Явно задавайте пустой inventory и отдельные пути, не
наследуйте `QUEUE_DB_PATH`, `ARTIFACT_STORAGE_ROOT` или `SNAPSHOTS_DIR` production.
Для безопасного UI-стенда используется mock-сервер browser smoke, см.
[testing.md](docs/testing.md).

Из корня репозитория:

```bash
corepack pnpm run typecheck
corepack pnpm run test                    # backend, с автоматической изоляцией
node --test 'apps/print-dashboard/tests/**/*.test.mjs'
corepack pnpm run build
./scripts/tests/deploy.test.sh            # без Docker-демона и принтеров
```

Полные команды, browser smoke, CI и ограничения `ops/verify` —
[docs/testing.md](docs/testing.md). Dashboard раздаётся nginx без компиляции;
его контейнер собирается из [Dockerfile](apps/print-dashboard/Dockerfile).

## Развёртывание и данные

На новом хосте заполните `.env` по `.env.example`, подготовьте seed по
`config/printers.example.json`, общую сеть (`ops/ensure-print-farm-network.sh`)
и таймеры backup (`ops/backup/install-timers.sh`). Оборудование затем редактируется
через панель и хранится в SQLite; seed импортируется один раз.

Для обновления используйте `./scripts/deploy.sh`: сначала preflight, сборка,
`restart-safety`, затем применение, health/ready и проверка ревизий. Релиз с
изменением API разворачивают на простаивающей ферме. После миграции старый образ
может отказаться стартовать: откат кода и восстановление данных — разные операции.
Порядок подготовки, перезапуска, проверки и отката — в
[docs/operations.md](docs/operations.md).

`queue.db`, `state.json`, артефакты и снимки находятся на томе
`orchestrator-data` (`/app/data`). `.env`, настоящий seed, `.deploy/`, локальные
данные и backup-конфигурация игнорируются Git. Они не являются мусором.
Не удаляйте WAL/SHM, backup-наборы, rollback-образы или Docker volumes.
Не ставьте `docker compose down` перед сборкой и не используйте `down -v` / volume prune.

Панель по умолчанию слушает `127.0.0.1:8090`, API go2rtc — `127.0.0.1:1985`,
WebRTC — `8555/tcp+udp`. API оркестратора не публикуется на хост. Dashboard
подставляет API-токен в прокси-запросы и собственного логина не имеет: доступ
к панели даёт управление фермой. Модель доступа — [SECURITY.md](SECURITY.md).

## Документация

| Инструкция | Где |
|---|---|
| Архитектура backend, адаптеры, задания, материалы, API | [print-orchestrator/README.md](apps/print-orchestrator/README.md) |
| Интерфейс, данные, камеры, настройки | [print-dashboard/README.md](apps/print-dashboard/README.md) |
| Deploy, restart-safety, SQLite rollback, диагностика, приёмка | [operations.md](docs/operations.md) |
| Тесты, сборка, browser smoke, CI | [testing.md](docs/testing.md) |
| Backup и restore | [ops/backup/README.md](ops/backup/README.md) |
| Проверка кандидатного образа | [ops/verify/README.md](ops/verify/README.md) |
| Anycubic LAN: протокол и проверенные возможности | [ANYCUBIC_KOBRA_X_STAGE2.md](docs/ANYCUBIC_KOBRA_X_STAGE2.md) |
| Отложенный выпуск файлов и камеры Kobra X | [ANYCUBIC_KOBRA_X_RELEASE.md](docs/ANYCUBIC_KOBRA_X_RELEASE.md) |
| Каталог и происхождение профилей Orca | [config/slicers/orca/README.md](apps/print-orchestrator/config/slicers/orca/README.md) |
| Правила текстов панели | [VOICE.md](apps/print-dashboard/VOICE.md) |
