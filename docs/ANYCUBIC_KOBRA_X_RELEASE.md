# Kobra X: выпуск файлового браузера и камеры

Кандидат от 2026-10-19, поверх принятого `e19e81a` (исследование и реализация).
Production при подготовке кандидата не обновлялся: orchestrator — `72dfde5`,
SQLite — схема 19. Аппаратные результаты и ограничения — в
[отчёте этапа 2](ANYCUBIC_KOBRA_X_STAGE2.md).

## Границы выпуска

Разрешены телеметрия, просмотр памяти/USB и пассивная камера через существующий
go2rtc. Для камеры не нужны MQTT `video/startCapture` или `stopCapture`.

`supportsJobs`, `supportsUpload`, `supportsRemoteStart`, `supportsFileDelete`
остаются `false`. Подсветка, пауза, продолжение и отмена закрыты в production
policy даже при заданных старых `ANYCUBIC_*_CONTROL_PRINTERS`. Изолированные
тесты подготовленного управляющего транспорта сохранены. Чтобы открыть категорию,
нужны отдельное аппаратное испытание и последующее проверенное изменение policy.
Light scheduler не может включить Kobra X вместе с этим выпуском.

Автоочередь остаётся выключенной; её настройки, PrintRun, BedCycle и списание
филамента не меняются. Поддержка Bambu, K2 и Ender-3 V3 KE сохраняется.

| Функция | Реализация | Изолированные тесты | Проверка Kobra X 2.0.2.2 | Осталось |
|---|---|---|---|---|
| Локальные файлы | Да | Да | Да, память/встроенный каталог/пустой USB | Приёмка UI после deploy; подключённый USB отдельно |
| Камера | Да, существующий go2rtc | Да | Да, пассивные FLV/H.264 и MP4, два зрителя/один upstream | Приёмка WebRTC в трёх представлениях после deploy |
| Подсветка | Подготовлена, закрыта | Да | Только чтение состояния | Отдельный согласованный on/off |
| Пауза/продолжение | Подготовлены, закрыты | Да | Нет | Отдельная согласованная печать |
| Отмена | Подготовлена, закрыта | Да | Нет | Отдельная согласованная печать |
| Загрузка файлов | Транспорт подготовлен, закрыт | Да | Нет | Согласованная загрузка, идентичность и dispatch |
| Удалённый запуск | Транспорт подготовлен, закрыт | Да | Нет | Полная цепочка DeviceArtifact/dispatch и аппаратная приёмка |

## Проверяемая видеоконфигурация

Полный кандидат: [`go2rtc-kobra-x.yaml`](../apps/print-orchestrator/config/go2rtc-kobra-x.yaml).
Он сохраняет `k2: ${K2_CAMERA_SOURCE}`, API `:1984`, WebRTC `:8555`, прежний
`${GO2RTC_WEBRTC_CANDIDATE}` и уровень логов. Добавляется только источник:

```yaml
anycubic-kobra-x: http://print-orchestrator:3100/api/printers/anycubic-kobra-x/camera.mp4
```

Путь передачи: принтер HTTP 206 FLV/H.264 → существующий backend proxy HTTP 200 →
один producer существующего go2rtc → WebRTC-плееры карточки, раздела «Камеры» и
увеличенного окна. Приватный URL обновляет общая MQTT-сессия с TLS pinning;
в YAML, inventory, публичный API и логи токен не попадает.

По умолчанию compose продолжает монтировать прежний `config/go2rtc.yaml`.
Его не нужно перезаписывать: после разрешения кандидат выбирается через
`GO2RTC_CONFIG_PATH` в локальном `.env`. Смена пути вызывает config-only recreate
**только go2rtc**; кратковременно прервётся также просмотр камеры K2.
Новый сервис, порт или MQTT-соединение для камеры не добавляются.

Поля **только** принтера `anycubic-kobra-x`, через существующие настройки:

```json
{
  "streamUrl": "http://go2rtc:1984/api/stream.mp4?src=anycubic-kobra-x",
  "snapshotUrl": ""
}
```

Это partial PATCH штатного `/api/printers/config/anycubic-kobra-x`, требующий
авторизации и сохраняющий остальные поля. Не менять host, protocol, pin,
light.enabled и правила автоматизации. Не подставлять нативный `/live/<token>`.
Снимки не включаются до отдельной проверки still capture.

## Последовательность redeploy — только после отдельного подтверждения

1. Проверить чистоту checkout и согласованную ревизию, состояние трёх сервисов,
   `./scripts/deploy.sh preflight --strict-active-prints` и
   `GET /api/print-orchestrator/restart-safety` через dashboard. Нужны здоровые
   сервисы, `safeToRestart: true` и отсутствие активных печатей на **всей ферме**.
   Не использовать `--allow-active-prints`, `--yes` или отключение проверок.
   При offline/unknown или спорном состоянии отложить смену backend.
2. Сохранить в закрытый acceptance-каталог исходные camera-поля Kobra X,
   текущий путь конфигурации go2rtc, `.env`, image IDs/revisions и числа
   PrintRun/BedCycle/открытых операций/недоставленных списаний. Не публиковать
   секреты из `.env` и inventory. Закрепить текущие backend/dashboard images
   отдельными rollback-тегами, например `:rollback-kobra-readonly-20261019`:
   штатный `:last-known-good` после успешного deploy уже будет новым образом.

   ```bash
   docker image tag "$(docker inspect atelier-print-orchestrator --format '{{.Image}}')" atelier-print-orchestrator:rollback-kobra-readonly-20261019
   docker image tag "$(docker inspect atelier-print-dashboard --format '{{.Image}}')" atelier-print-dashboard:rollback-kobra-readonly-20261019
   ```

   Сверить IDs закреплённых тегов с исходными; не перезаписывать ранее сохранённые
   rollback-теги, если redeploy повторяется.
3. Выполнить штатный `./ops/backup/backup.sh --full`, убедиться в успешной
   проверке целостности и схеме 19. Дополнительно deploy делает SQLite snapshot
   в `.deploy/db-snapshots/`; его неудачу здесь считать причиной остановиться.
   Схемных изменений между `72dfde5` и кандидатом нет.
4. При **прежнем** `GO2RTC_CONFIG_PATH` выполнить:

   ```bash
   ./scripts/deploy.sh --strict-active-prints --no-cleanup
   ```

   Скрипт сначала строит образы с защитой свободного места, затем применяет их
   и проверяет health/ready/identity. Не выполнять `down`, prune или изменение
   volumes. При коде 4/5 не продолжать настройку камеры: backend отложен,
   нужно дождаться безопасного окна и завершить redeploy. При ошибке остановиться
   и оценить фактически применённые сервисы. Проверить ревизии обоих образов,
   pinning, схему 19, мониторинг остальных принтеров и локальные файлы Kobra X.
5. Только после успешной проверки backend установить в `.env`:

   ```dotenv
   GO2RTC_CONFIG_PATH=./apps/print-orchestrator/config/go2rtc-kobra-x.yaml
   ```

   Сохранить прежние `COMPOSE_FILE` (включая `compose.orca.yml`), источник K2,
   ICE candidate, auth и `AUTO_QUEUE_ENABLED=false`. Проверить
   `docker compose config -q`, затем точечный dry-run:

   ```bash
   docker compose --dry-run up -d --no-deps --no-build go2rtc
   docker compose up -d --no-deps --no-build go2rtc
   ```

   План должен менять только go2rtc. Дождаться healthy; проверить наличие обоих
   stream ids через локальный API `127.0.0.1:1985/api/streams`, не публикуя ответ
   целиком. Если план затрагивает другой сервис, остановиться.
6. Сохранить приведённые camera-поля Kobra X штатным partial PATCH/формой.
   Дождаться следующего camera probe (до 30 секунд). Не нажимать snapshot с
   ensureLight и не запускать connection test, сбрасывающий MQTT, без надобности.

## Приёмка после применения

- Файлы: открыть «Память принтера», проверить шесть пользовательских файлов,
  встроенный `test_model`, имена с `+`, размеры/даты, переходы назад и повторное
  открытие. Сверить с текущим фактическим содержимым: оно могло измениться после
  исходной проверки. Без USB скрыт его корень; проверить честную обработку ошибки
  чтения. Кнопок запуска, загрузки и удаления у Kobra X быть не должно.
- Камера: получить движущееся изображение в карточке, разделе «Камеры» и
  увеличенном окне. Открыть два просмотра; должен оставаться один upstream к
  backend/принтеру. Закрыть оба и проверить освобождение upstream после grace
  go2rtc (в исходной проверке — через 7 секунд). Повторное открытие/закрытие
  вкладки восстанавливает просмотр. Не перезагружать принтер ради теста.
- Убедиться, что K2 по-прежнему показывает видео, Bambu и Ender дают актуальную
  телеметрию. Проверить отсутствие токенов в доступных клиенту данных и новых
  ошибок reconnect/FLV в логах, не копируя секретные значения в отчёт.
- У Kobra X скрыты свет/пауза/продолжение/отмена; jobs/upload/start/delete закрыты
  capabilities и backend policy. Для проверки **не отправлять** пробные write
  запросы в production: эти отказы уже проверены изолированно.
- Сверить схему, настройки автоматизации и учётные записи до/после. Допустимы
  штатные изменения фонового наблюдения, но просмотр файлов/камеры не создаёт
  PrintRun, BedCycle, отмену, DispatchAttempt или списание материала. Случайные
  фоновые изменения исследовать по журналу, не «исправлять» production SQLite.

После успешной приёмки можно отдельно провести небольшой аудит и чистку. Полезные
тесты и подготовленные заблокированные транспорты остаются до этого аудита.

## Откат

При проблеме только с камерой вернуть прежние camera-поля через тот же partial
PATCH и прежний `GO2RTC_CONFIG_PATH`, затем точечно применить **только go2rtc**
с `--no-deps --no-build`; проверить K2. Старый YAML остался неизменным.
При этом файловый браузер может продолжать работать на новом backend.

При проблеме backend/dashboard вернуть закреплённые старые image IDs через
reviewed compose override, повторно проверить restart-safety и пересоздать
только согласованные сервисы с `--no-deps --no-build`, затем health/ready/identity.
Не полагаться на `deploy.sh rollback` после уже успешного deploy: его
last-known-good теперь указывает на новую версию. Во время неудачного deploy
штатный rollback допустим лишь после проверки его целевых IDs и схемы.

Пример rollback override в закрытом acceptance-каталоге:

```yaml
services:
  print-orchestrator:
    image: atelier-print-orchestrator:rollback-kobra-readonly-20261019
    pull_policy: never
  print-dashboard:
    image: atelier-print-dashboard:rollback-kobra-readonly-20261019
    pull_policy: never
```

При подтверждённом безопасном окне и схеме 19 на этом хосте (сохраняется Orca):

```bash
COMPOSE_FILE=compose.yml:compose.orca.yml:.deploy/acceptance-kobra-readonly-20261019/rollback.yml docker compose --dry-run up -d --no-deps --no-build print-orchestrator print-dashboard
COMPOSE_FILE=compose.yml:compose.orca.yml:.deploy/acceptance-kobra-readonly-20261019/rollback.yml docker compose up -d --no-deps --no-build print-orchestrator print-dashboard
```

Это ручной аварийный путь после отдельной оценки restart-safety, а не обход gate
при работающей печати. Go2rtc откатывается отдельно восстановлением пути YAML.

Не восстанавливать старую SQLite поверх текущей истории ради отката кода:
в этом выпуске схема остаётся 19. Любое восстановление данных требует отдельного
решения с учётом появившихся после backup печатей и операций fulfillment.

## Изолированная проверка кандидата

Это не аппаратная приёмка production WebRTC: она выполняется после разрешённого
redeploy. Проверено на финальном коде:

- Целевой backend-набор: **287/287**, без skips/failures. Все Anycubic-тесты,
  файловые адаптеры Bambu/Moonraker, камера, capabilities, command service,
  monitoring-only launch, restart/recovery и printer routes. Запуск с
  `--test-concurrency=2`, фиктивными устройствами, временной/in-memory SQLite.
- Dashboard: **352/352**; nginx security guard дополнительно **4/4** после
  уточнения allowlist assertion. Это повтор поднабора, числа не суммируются.
- `tsc -p tsconfig.json --noEmit` и `tsc -p tsconfig.build.json` прошли.
- `./scripts/tests/deploy.test.sh`: **24/24**, настоящий deploy-скрипт на fake
  Docker/curl и временных checkout; проверены deferral, rollback и config-only
  изменения без единого production restart.
- `nginx -t`: тот же локальный image, одноразовый контейнер без сети, фиктивный
  API token, штатный envsubst. Проверка не использовала production volumes.
- Полный YAML загружен реальным go2rtc **1.9.14** на pinned image в одноразовом
  контейнере с `--network none`, фиктивными K2/ICE значениями и без зрителей.
  Runtime API зарегистрировал оба источника; источник из env маскируется самим
  go2rtc. Его `/api/config` возвращает исходный YAML с placeholders, поэтому
  этот endpoint не используется как доказательство runtime-подстановки.
- Effective compose без нового env-параметра совпадает с прежним; при выборе
  кандидата изменяется **только** read-only bind конфигурации go2rtc. Остальные
  сервисы, auth, `production-orca`, порты и `AUTO_QUEUE_ENABLED=false` сохранены.
- Read-only preflight прошёл: три healthy сервиса, около 34 ГБ свободно,
  persistent volume на месте. Он обнаружил текущую внешнюю печать K2
  (`untracked-print`): смена backend откладывается до безопасного окна.
  Production containers, `.env`, inventory и активный YAML не менялись.

В первом целевом прогоне исправлено устаревшее ожидание подписи формы в тесте;
также один loopback-handshake превысил свой 1.5-секундный тестовый таймаут при
параллельной сборке. Повтор этих наборов — 43/43; окончательный чистый прогон
287/287 выполнен после завершения сборки. Рабочие таймауты и TLS не менялись.
Принятый ранее полный backend-прогон 2290/2290 относится к `e19e81a`; повторного
полного прогона всех 2290 тестов в этой финализации не заявляется.

## Файлы финализации поверх e19e81a

- `.env.example`, `compose.yml`: отложенный выбор YAML без изменения текущего mount.
- `apps/print-orchestrator/config/go2rtc-kobra-x.yaml`: полный кандидат K2 + Kobra X.
- `apps/print-orchestrator/src/infra/printers/anycubic/controlPolicy.ts`, `index.ts`:
  закрытые аппаратные категории в production registry.
- `apps/print-orchestrator/src/app/monitoringOnlyCommands.test.ts`: блокировка
  backend/UI даже с заданными env allowlists.
- `apps/print-orchestrator/src/modules/printers/configRoutes.ts`, `configRoutes.test.ts`:
  актуальное описание доступных функций в штатной форме.
- `apps/print-dashboard/tests/nginx-config.test.mjs`: guard фиксированного Kobra src.
- `docs/examples/go2rtc-anycubic.yaml`, `docs/ANYCUBIC_KOBRA_X_STAGE2.md`,
  `docs/ANYCUBIC_KOBRA_X_RELEASE.md`: конфигурация, результаты и порядок выпуска.
