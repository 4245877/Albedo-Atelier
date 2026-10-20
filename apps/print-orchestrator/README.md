# Atelier — print-orchestrator

Fastify-сервис управления фермой. Он опрашивает принтеры, хранит оборудование,
очередь и историю, анализирует файлы, вызывает OrcaSlicer, доставляет артефакты
и отправляет разрешённые команды. Dashboard получает готовые решения и причины
отказа. Неизвестные сведения возвращаются как `null` / пустые списки.

## Архитектура

| Каталог | Ответственность |
|---|---|
| `src/domain/` | Состояния заданий и столов, совместимость, единая политика допуска, профили, расписание оператора; без SQLite и сетевого I/O |
| `src/app/` | `FarmStore` и composition root, `PrinterPoller`, command/camera/light services, launch/dispatch, очередь, планировщик, анализ и нарезка |
| `src/infra/` | SQLite/repositories/migrations, адаптеры принтеров, Orca CLI, файловое хранилище, HTTP-клиент fulfillment |
| `src/modules/` | HTTP-маршруты |
| `src/http/security.ts` | Token, Origin/Host и защитные заголовки |
| `src/shared/config/` | Реестр переменных окружения; пример настроек — [`.env.example`](../../.env.example) |

`DashboardReadModel` (`farmStore.reads`) синхронно читает runtime/cache;
загрузка доски не запускает запрос к складу. Медленные устройства не должны
блокировать остальные: Bambu и Anycubic имеют по одной общей MQTT-сессии на
принтер, Moonraker работает HTTP-запросами, Creality — WebSocket.

## Принтеры и возможности адаптеров

Протоколы — закрытый список: `moonraker`, `bambu`, `creality`, `anycubic-lan`.
Неизвестный протокол не превращается в Moonraker. Источник возможностей —
[`capabilities.ts`](src/infra/printers/capabilities.ts); физические команды
дополнительно проверяют readiness и policy адаптера.

| Адаптер | Jobs | Просмотр файлов | Upload / remote start / delete | Управление печатью / свет |
|---|---|---|---|---|
| Moonraker (K2 :4408) | Да | Да | Да / да / да | Да / да |
| Bambu LAN (A1 Combo) | Да | Да, FTPS :990 | Да / да / да | Да, MQTT / да |
| Creality WS (Ender-3 V3 KE) | Ручной перенос | Нет | Нет / нет / нет | Нет / нет |
| Anycubic LAN (Kobra X) | Нет | Да, память/USB | Нет / нет / нет | Подготовлено, закрыто / подготовлено, закрыто |

Для Moonraker/Bambu проверка доставки — **имя и размер**, а не удалённый SHA-256.
Creality WS требует именного подтверждения ручного переноса; печать запускают
на экране. Kobra X допускает чтение файлов независимо от `supportsJobs=false`;
просмотр не создаёт task/assignment/DeviceArtifact. Не обходите capability отказ
новой веткой dispatch.

Moonraker запускает `.gcode` / `.gco` / `.g`; Bambu — `.gcode.3mf` / `.3mf` /
`.gcode`, подготовленный пакет имеет расширение `.gcode.3mf`.
FTPS-пакет и факт его наличия не доказывают, что принтер начал печать.

### Anycubic LAN

Мониторинг аппаратно проверен на Kobra X `modelId=20030`, firmware `2.0.2.2`.
Код просмотра памяти и пассивной камеры тоже проверен на устройстве; эти части
пока не развёрнуты. Срез production и протокол —
[ANYCUBIC_KOBRA_X_STAGE2.md](../../docs/ANYCUBIC_KOBRA_X_STAGE2.md).

LAN handshake получает broker login в память, затем MQTT/TLS подключается
только к сертификату с подтверждённым SHA-256 fingerprint. Без pin адаптер
не обращается к устройству; при несовпадении credentials не отправляются.
`allowInsecureTls` и `BAMBU_ALLOW_INSECURE_TLS` не ослабляют Anycubic TLS.
Сертификат подтверждает оператор через штатную форму.

Файлы, камера и телеметрия используют общую сессию. Физические light/print
категории закрыты [`controlPolicy.ts`](src/infra/printers/anycubic/controlPolicy.ts)
даже при старых env allowlists. Upload/start — транспортные заготовки, ещё
не принятая цепочка dispatch. Их тесты и обезличенные captures сохраняются.
Выпуск чтения файлов и камеры — [отдельная процедура](../../docs/ANYCUBIC_KOBRA_X_RELEASE.md).

## Оборудование, характеристики и секреты

Настройки редактируются в «Оборудование фермы» (`/api/printers/config`) и живут
в таблице `printers`. Изменение пересобирает runtime-конфиг и закрывает старую
сессию устройства; применяется без redeploy. `id` неизменяем: он связан с
историей, API и каталогами снимков. Удаление оборудования не удаляет историю.

`config/printers.json` / `PRINTERS_CONFIG_JSON` — только seed первого старта.
Импорт защищён транзакционным `app_meta` marker, включая пустой seed; файл
не перезаписывает изменения из панели. `${ENV_VAR}` сохраняется как ссылка.
Обычная форма валидируется строго; lenient loader предназначен лишь для seed.

`apiKey`, `serial`, `accessCode` принимаются на запись, но API отдаёт только
статус `secrets: { set, source, envVar, resolved }`. Пропущенное поле сохраняет
секрет, явный `null` очищает. Audit хранит имена изменённых полей без значений.
`queue.db` содержит device credentials: права `600`, вне образов и публичных отчётов.

### Hardware discovery

[`resolvePrinterSpecs`](src/domain/printers/specs.ts) выбирает источник:
`printer → manual → catalog → unknown`. Противоречащий ручной ввод возвращается
как `overriddenManual`; характеристика без источника остаётся неизвестной.

- Bambu: firmware, настройки сопла, AMS/AMS Lite, active tray / внешняя катушка;
  модель определяется по устройству, build volume — из каталога.
- Moonraker: firmware, bed size и сопло из конфигурации, доступные датчики из
  списка объектов. Материал K2 — metadata **текущего нарезанного файла**, не RFID.
  В простое он может быть неизвестен; CFS `box` / `filament_rack` с `-1`
  и без active slot не используются как источник материала.
- Creality WS: только факты, присутствующие в heartbeat, без выдуманных полей.
- Anycubic: identity из `/info`, firmware из MQTT `info`; volume 260³ мм из
  каталога только для `modelId=20030`. Сопло, материал, ACE и расход неизвестны.

Discovery хранится отдельно от printer row (`printer_discovery`), не меняет
optimistic version формы на каждом опросе. Фоновый интервал —
`PRINTER_DISCOVERY_INTERVAL_MS` (по умолчанию 300000); неудача оставляет прежние
факты с признаком ошибки. Неизменившийся ответ не переписывает БД.
Bambu/Anycubic читают cache без дополнительного I/O.

Диаметр сопла — настройка устройства, а не физический датчик. Bambu faults
и `sdcard` проверяются отдельно от `idle`: аппаратно наблюдавшийся `0500-C010`
может блокировать старт при недоступной MicroSD; неизвестным кодам смысл
не приписывается. Диагностика — [operations](../../docs/operations.md#printer-diagnostics).

## SQLite, очередь и жизненный цикл

`QUEUE_DB_PATH` по умолчанию находится рядом с `STATE_FILE_PATH`. В Docker это
`/app/data/queue.db` на томе `orchestrator-data`. WAL, foreign keys, транзакции,
optimistic `version` и `AuditEvent` защищают согласованность модели.

```text
PrintTask → Assignment → DispatchAttempt → PrintRun
BedCycle: CLEAR → RESERVED → RUNNING → AWAITING_CLEARANCE → CLEAR
                                                     ↘ UNKNOWN при потере фактов
```

Task — намерение оператора; assignment — назначение; run — фактическая печать.
История запущенного задания сохраняется. Завершение открывает ручную операцию
снятия детали; `idle` сам по себе не означает свободный стол.

Очередь одна: основной вид `/api/queue` и планировщик `/api/print/scheduler`
читают те же строки через `PrintQueueService`. Старый JSON queue импортируется
один раз, транзакционно; marker ставится только при commit. До успешного импорта
JSON сохраняется, после — queue в нём пуст. Поздно появившиеся legacy-задания
попадают в `NEEDS_REVIEW`, не становятся вторым исполняемым источником.

`state.json` сохраняет feed, счётчики, автоматизации, snapshot metadata,
отложенные списания и долги; запись temp-file + atomic rename. Телеметрия,
ручной light override и складской cache не сохраняются. История обслуживания
и дальний план (`/api/maintenance`, `/api/plan`) пока пусты, секции скрыты в UI.

Миграции `001`–`019` выполняются до приёма трафика и сохраняются в репозитории.
Образ отказывается читать БД новее известной ему схемы (`SchemaTooNewError`).
Миграции только вперёд; [откат и восстановление](../../docs/operations.md#schema-compatibility)
требуют совместимых образа и данных.

### Запуск и безопасность команд

Единая `evaluateDispatchEligibility` работает на preflight и внутри reserve
транзакции dispatch. Preview, manual, night и auto используют одну политику.

- `auto` не мягче `night`: любой review, неизвестный материал, неподтверждённый
  стол, отсутствие `unattendedAllowed` блокируют. Автоочередь выключена через
  `AUTO_QUEUE_ENABLED=false` и persisted rule; неясный исход её старта разоружает правило.
- `accepted` — команда принята, run ещё `PENDING`, bed `RESERVED`, guard удержан.
  `started` подтверждается устройством/наблюдением. Нет печати после окна
  подтверждения — `UNKNOWN`, printer hold, **без автоматического повтора**.
- Idempotency key и durable start guard предотвращают повторный dispatch,
  включая restart и отмену во время отправки.
- Логическая отмена ожидающего задания не останавливает устройство. Физическая
  остановка проверяет текущий run и имя файла; отмена не освобождает стол.
- AMS feed plan закрепляется на run и перепроверяется по свежей телеметрии;
  неоднозначный tray нельзя угадать. Аппаратная приёмка AMS и `plate_2` отдельно.
- Повтор завершённой работы создаёт новое задание тех же проверенных байт,
  без новой нарезки, с дедупликацией по `requestId`. FAILED имеет свой retry.
- `day_night_preference` и его проекция `night` согласованы; разрешение печати
  без человека не означает разрешения автоматического продолжения очереди.

Расписание оператора хранит IANA timezone, локальные weekly windows, exceptions
и UTC absences; приоритет `absence → sleep → availability`. Неизвестное расписание
блокирует автоматику. Восемь типов manual operations имеют собственные длительности,
actor и audit. Открытая blocking operation запрещает dispatch даже в manual;
свободный стол подтверждает человек.

## Файлы, анализ и нарезка

`/api/print/artifacts` принимает один файл multipart. SHA-256 считается потоково;
blob атомарно фиксируется в `artifacts/sha256/<prefix>/<hash>` **до** записи ссылки
в SQLite. Artifact, DRAFT task, pending analysis и audit создаются транзакционно;
загрузка сама не ставит задание в очередь.

Анализ выполняется ограниченным worker pool, переживает restart pending/running
работ и разделяет состояние выполнения и verdict (`needs_preparation`,
`schedulable`, `needs_input`, `review`, `blocked`). `schedulable` не разрешает автозапуск.

- Формат определяется содержимым. STL не имеет единиц: их подтверждает оператор.
  Подтверждение связано с хешем, масштаб входит в cache key и SliceVariant metadata;
  проверяется именно тот вариант, который будет отправлен.
- 3MF разбирается как недоверенный ZIP с ограничениями размера/сжатия/числа записей,
  запретом traversal, symlink и duplicates. XML — без DTD/entities. Учитываются
  transforms, пластины и реальный встроенный G-code.
- G-code только анализируется, команды не исполняются. Неизвестный target,
  опасные команды (`M500`, `M502`, `M302`) или ненадёжные bounds требуют review/block.
- Утверждённая ревизия профиля неизменяема. Новые resolved bytes дают новую
  revision; старый approved set продолжает использовать согласованные настройки.
- Без рабочего `ORCA_SLICER_CMD` нарезка честно BLOCKED. Проверенный runtime
  подключается через `compose.orca.yml`; каталог и provenance —
  [config/slicers/orca/README.md](config/slicers/orca/README.md).

Вендорский start G-code KE содержит `BED_MESH_CALIBRATE`: output gate требует
`schedulable`, поэтому внутренняя нарезка может блокироваться как
`output_not_schedulable`. Не ослабляйте политику ради успешного примера;
внешний G-code с review и ручным переносом — отдельный путь.

## Мониторинг, свет и камеры

`PrinterPoller` сериализует наблюдения, включая чтения после команд. `unknown`
не завершает печать; после reconnect canonical run восстанавливается из SQLite
с прежним id, `startedAt` и AMS baseline. Необъяснимое окончание остаётся
`UNKNOWN` до решения оператора.

Политика света: manual override (5 минут, в памяти) → отключённая автоматика
(не вмешиваться) → lease видимой вкладки (~90 секунд, renewal ~30 секунд) →
solar/fixed schedule → выключено. Солнечный расчёт локальный, ошибки дают
`LIGHT_FALLBACK_WINDOW` и warning. `NIGHT_PRINT_WINDOW` отдельно управляет
ночной печатью и темой панели. `lights[]` различает desired, actual и reason;
решение политики не доказывает физическое переключение.

После трёх неуспешных scheduled light-команд — пауза 5 минут и одно предупреждение.
Moonraker использует `SET_PIN` и status object (K2: `LED`), Bambu — `system.ledctrl`.
Creality WS не управляет светом, Anycubic закрыт policy.

Камеры доступны через `camera.jpg` / `camera.mp4`, приватные URL не возвращаются
клиентам. K2 и кандидат Kobra X используют существующий go2rtc; браузеру открыт
только signalling WebSocket с точной allowlist. Снимок с `ensureLight=1` имеет
побочный эффект и требует token; dashboard nginx блокирует такой GET.

## Filament warehouse (fulfillment)

[`inventoryClient.ts`](src/infra/fulfillment/inventoryClient.ts) — единственный
клиент соседнего склада. `FULFILLMENT_API_URL` пуст — интеграция выключена.
`ATELIER_FULFILLMENT_TOKEN` передаётся как `x-service-token`.

- Summary и loaded bindings читаются фоном (`FILAMENT_STOCK_REFRESH_MS`, 60 с).
  Недоступный склад сохраняет последний cache с error/stale, не становится пустым.
  Пороги остатков принадлежат fulfillment; очередь считает только известный расход.
- Live material/colour синхронизируются в loaded-reel binding; отсутствие hint
  не стирает прежнюю привязку. AMS учитывается по slot. Склад разрешает hint
  в существующую позицию, не создаёт вымышленную катушку.
- По окончании completed/cancelled/failed списывается измеренное потребление:
  Moonraker — extruded length, Bambu — падение AMS remain × nominal weight.
  Прогноз слайсера автоматически не списывается. Квантование remain и неизвестный
  baseline дают ограничение точности либо долг, а не выдуманные граммы.
- Стабильный idempotency key на run/tray защищает повторную доставку. Сетевые
  ошибки/5xx сохраняются в retry queue `state.json`; бизнес-отказ не ретраится
  автоматически и остаётся долгом. Внешняя печать без canonical run и
  непроверенный расход Anycubic также требуют ручной сверки.
- `/api/monitoring/filament-debts`: settle повторяет исходный payload/key;
  acknowledge отмечает внешнее урегулирование. Для неизмеренного долга граммы
  явно задаёт оператор.

Fulfillment читает `/api/printers/inventory` (включая disabled, без connection
параметров), `/api/printers` и снимки. DTO закреплены в `contracts/*.json`;
[процедура синхронизации](../../docs/operations.md#wire-contracts).
Telegram/outbox принадлежат fulfillment, не оркестратору.

## Разработка и тесты

Установка и безопасный dev-запуск — [корневой README](../../README.md#локальная-разработка).
`corepack pnpm run typecheck`, `test`, `test:unit`, `test:integration`, `build`
запускаются из этого каталога. Тестовый runner изолирует inventory, состояние
и внешние настройки; подробности и прямой Node-запуск —
[docs/testing.md](../../docs/testing.md). `dist/` не содержит tests/testkit.
Production обновляется штатным `scripts/deploy.sh`; [operations](../../docs/operations.md).

## API

JSON ошибки имеют `{ error: { code, message, details } }`. Точный список маршрутов
и DTO — в `src/modules/`; таблица ниже — карта, не отдельная спецификация.
Через dashboard добавляется префикс `/api/print-orchestrator`.

| Группа | Основные пути |
|---|---|
| Observability | `GET /health`, `/ready`, `/metrics`, `/version`, `/restart-safety?window=<s>` |
| Доска | `GET /api/dashboard`, `/api/printers`, `/api/printers/inventory` |
| Оборудование | `/api/printers/config`, `/options`, `/:id`, `/:id/enabled`, `/:id/test`, `/:id/discover`, `/:id/tls-certificate` |
| Устройство | `/api/printers/:id/{pause,resume,cancel,light,snapshot}`, `camera.jpg`, `camera.mp4`, файловые маршруты |
| Задания и очередь | `/api/print/tasks`, `/api/print/queue`, `/api/queue`, `/api/queue/night`, `/api/print/launch/:taskId` |
| История | `/api/print/history`, повтор через reprint; task detail содержит chain/audit |
| Анализ и нарезка | `/api/print/artifacts`, `/api/print/slicing/...` |
| План и оператор | `/api/print/scheduler/...`, `/api/print/schedule`, `/api/print/operations` |
| Автоматика и учёт | `/api/automations/auto-queue`, `/api/monitoring/lease`, `/api/monitoring/filament-debts` |

`/health` — liveness; `/ready` даёт 503 до первого poll, при stale loop или
недоступной БД, но не из-за одного offline-принтера. `/version` показывает
identity образа; `/restart-safety` — риск перезапуска текущих наблюдаемых печатей.

Мутации требуют `Authorization: Bearer` / `X-Api-Token`; без настроенного token
возвращается 503, кроме явного isolated opt-in. Origin/Host проверяются отдельно;
чтение `camera.jpg?ensureLight=1` также защищено. [Модель безопасности](../../SECURITY.md).
