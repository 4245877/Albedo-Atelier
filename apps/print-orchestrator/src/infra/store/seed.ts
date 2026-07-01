import type {
  Automation,
  CriticalEvent,
  FeedEvent,
  MaintenanceRow,
  MaterialsSection,
  NightPrint,
  PerformanceSection,
  PlanSection,
  QueueJob,
  SystemComponent,
  TodaySection,
  Warning
} from "../../domain/dashboard/types";
import type { PrinterRecord } from "../../domain/printers/types";

/**
 * The full in-memory dataset backing the dashboard. This is the seam a real
 * datasource replaces later: swap {@link seedFarmData} for a DB read + live
 * printer telemetry (see apps/fulfillment for driver patterns) and the rest of
 * the service layer is unchanged.
 */
export interface FarmData {
  version: string;
  /** Epoch ms the farm "came up"; drives `service.startedHoursAgo`. */
  startedAt: number;
  printers: PrinterRecord[];
  queue: QueueJob[];
  night: NightPrint;
  critical: CriticalEvent[];
  materials: MaterialsSection;
  today: TodaySection;
  perf: PerformanceSection;
  automations: Automation[];
  automationLastRun: string;
  system: SystemComponent[];
  feed: FeedEvent[];
  warnings: Warning[];
  plan: PlanSection;
  maintenance: MaintenanceRow[];
}

export function seedFarmData(): FarmData {
  return {
    version: "v0.4.2",
    // ~86h ago, matching the seed dashboard's "3 дн 14 ч назад".
    startedAt: Date.now() - 86 * 60 * 60 * 1000,

    printers: [
      {
        id: "aurora",
        name: "Aurora",
        model: "Bambu Lab X1 Carbon",
        type: "FDM",
        status: "printing",
        job: "Кронштейн купольной камеры",
        progress: 64,
        nozzle: [218, 220],
        bed: [60, 60],
        chamber: 38,
        minutesLeft: 154,
        material: "PLA · Слоновая кость",
        swatch: "#efe8d8",
        camera: "online",
        light: true,
        snapshotAt: "12:41",
        connection: { driver: "bambu", protocol: "mqtt", host: "192.168.1.21", port: 8883 },
        capabilities: {
          heatedBed: true,
          chamberHeating: true,
          camera: true,
          remoteStart: true,
          materialSlots: 4
        }
      },
      {
        id: "kreide",
        name: "Kreide",
        model: "Prusa MK4",
        type: "FDM",
        status: "printing",
        job: "Шестерня экструдера ×4",
        progress: 27,
        nozzle: [239, 240],
        bed: [85, 85],
        chamber: null,
        minutesLeft: 318,
        material: "PETG · Графит",
        swatch: "#4c4f55",
        camera: "online",
        light: false,
        snapshotAt: "12:38",
        connection: { driver: "prusalink", protocol: "http", host: "192.168.1.22", port: 80 },
        capabilities: {
          heatedBed: true,
          chamberHeating: false,
          camera: true,
          remoteStart: true,
          materialSlots: 1
        }
      },
      {
        id: "terra",
        name: "Terra",
        model: "Voron 2.4 R2",
        type: "FDM",
        status: "idle",
        job: null,
        progress: 0,
        nozzle: [24, 0],
        bed: [23, 0],
        chamber: 26,
        minutesLeft: 0,
        material: "ABS · Терракота",
        swatch: "#b0603f",
        camera: "none",
        light: false,
        snapshotAt: null,
        connection: { driver: "moonraker", protocol: "moonraker", host: "192.168.1.23", port: 7125 },
        capabilities: {
          heatedBed: true,
          chamberHeating: true,
          camera: false,
          remoteStart: true,
          materialSlots: 1
        }
      },
      {
        id: "cecilia",
        name: "Cecilia",
        model: "Elegoo Saturn 3 Ultra",
        type: "Resin",
        status: "printing",
        job: "Маска витража — мастер-модель",
        progress: 82,
        nozzle: null,
        bed: null,
        chamber: 24,
        minutesLeft: 47,
        material: "Смола · Standard Grey",
        swatch: "#9aa0aa",
        camera: "online",
        light: true,
        snapshotAt: "12:42",
        connection: { driver: "elegoo", protocol: "http", host: "192.168.1.24", port: 3030 },
        capabilities: {
          heatedBed: false,
          chamberHeating: false,
          camera: true,
          remoteStart: true,
          materialSlots: 1
        }
      },
      {
        id: "calx",
        name: "Calx",
        model: "Ender-3 S1 Pro",
        type: "FDM",
        status: "error",
        job: "Кейс электроники",
        progress: 41,
        nozzle: [17, 220],
        bed: [22, 60],
        chamber: null,
        minutesLeft: 0,
        material: "PLA · Небесный",
        swatch: "#7fb3d8",
        camera: "online",
        light: false,
        snapshotAt: "11:57",
        error: "Ошибка термистора сопла — печать остановлена",
        connection: { driver: "moonraker", protocol: "moonraker", host: "192.168.1.25", port: 7125 },
        capabilities: {
          heatedBed: true,
          chamberHeating: false,
          camera: true,
          remoteStart: true,
          materialSlots: 1
        }
      },
      {
        id: "opal",
        name: "Opal",
        model: "Anycubic Photon M3 Max",
        type: "Resin",
        status: "offline",
        job: null,
        progress: 0,
        nozzle: null,
        bed: null,
        chamber: null,
        minutesLeft: 0,
        material: "Смола · ABS-like",
        swatch: "#6f7d8c",
        camera: "offline",
        light: false,
        snapshotAt: "09:12",
        connection: { driver: "anycubic", protocol: "mqtt", host: "192.168.1.26", port: 8883 },
        capabilities: {
          heatedBed: false,
          chamberHeating: false,
          camera: true,
          remoteStart: false,
          materialSlots: 1
        }
      },
      {
        id: "golem",
        name: "Golem",
        model: "Prusa MK3S+",
        type: "FDM",
        status: "maintenance",
        job: null,
        progress: 0,
        nozzle: [21, 0],
        bed: [21, 0],
        chamber: null,
        minutesLeft: 0,
        material: "не заправлен",
        swatch: "#d8d4c8",
        camera: "offline",
        light: false,
        snapshotAt: "08:03",
        note: "Замена сопла 0.4 → 0.6, готов к вечеру",
        connection: { driver: "octoprint", protocol: "http", host: "192.168.1.27", port: 80 },
        capabilities: {
          heatedBed: true,
          chamberHeating: false,
          camera: false,
          remoteStart: true,
          materialSlots: 1
        }
      }
    ],

    queue: [
      { id: "q1", title: "Корпус датчика влажности", printer: "Terra", material: "ABS · Терракота", eta: "3 ч 40 м", status: "ready", at: "14:30" },
      { id: "q2", title: "Кронштейны рейки ×6", printer: "Kreide", material: "PETG · Графит", eta: "5 ч 10 м", status: "ready", at: "18:05" },
      { id: "q3", title: "Статуэтка «Цецилия»", printer: "Cecilia", material: "Смола · Standard Grey", eta: "6 ч 20 м", status: "ready", at: "ночь", night: true },
      { id: "q4", title: "Маска витража — литьевая форма", printer: "—", material: "Смола · ABS-like", eta: "8 ч 05 м", status: "review", reason: "не задан профиль печати" },
      { id: "q5", title: "Кейс электроники", printer: "Calx", material: "ABS (требуется)", eta: "4 ч 30 м", status: "error", reason: "несоответствие материала: в принтере PLA" }
    ],

    night: {
      window: "23:00 – 07:30",
      candidates: [
        { title: "Статуэтка «Цецилия»", printer: "Cecilia", eta: "6 ч 20 м", risk: 18, riskLabel: "низкий" },
        { title: "Корпус датчика влажности", printer: "Terra", eta: "3 ч 40 м", risk: 24, riskLabel: "низкий" },
        { title: "Кронштейны рейки ×6", printer: "Kreide", eta: "5 ч 10 м", risk: 43, riskLabel: "средний" }
      ],
      pick: 0
    },

    critical: [
      { icon: "🌡", text: "Calx: ошибка термистора сопла — печать остановлена", time: "11:57", level: "err" },
      { icon: "⛓", text: "Opal потерял связь (MQTT timeout), 3 попытки переподключения", time: "09:12", level: "err" },
      { icon: "🧑‍🔧", text: "Кейс электроники: нужен оператор — сменить материал на ABS", time: "11:58", level: "warn" },
      { icon: "🧵", text: "Kreide: катушка PETG на исходе (~0.8 кг при потребности 1.1 кг)", time: "10:24", level: "warn" },
      { icon: "◉", text: "Камера Golem не отвечает (go2rtc: stream unavailable)", time: "08:03", level: "warn" }
    ],

    materials: {
      filament: [
        { name: "PLA · Слоновая кость", swatch: "#efe8d8", have: 2.4, unit: "кг", full: 3 },
        { name: "PETG · Графит", swatch: "#4c4f55", have: 0.8, unit: "кг", full: 3, low: true, need: 1.1 },
        { name: "ABS · Терракота", swatch: "#b0603f", have: 1.6, unit: "кг", full: 3 },
        { name: "TPU · Янтарь", swatch: "#d9a441", have: 0.3, unit: "кг", full: 1, low: true }
      ],
      resin: [
        { name: "Standard Grey", swatch: "#9aa0aa", have: 1.2, unit: "л", full: 2 },
        { name: "ABS-like Ivory", swatch: "#e8e0cc", have: 0.4, unit: "л", full: 1, low: true, need: 0.6 }
      ],
      mismatch: [{ job: "Кейс электроники", needs: "ABS", printer: "Calx", loaded: "PLA" }],
      queueNeeds: [
        { text: "PETG · Графит — ещё 0.3 кг", status: "warn" },
        { text: "ABS-like — ещё 0.2 л", status: "warn" },
        { text: "Standard Grey — хватает", status: "ok" }
      ]
    },

    today: { done: 7, active: 3, failed: 1, hoursUsed: 26.4, hoursQueued: 18.2 },

    perf: { load: 72, free: 1, busy: 3, maintenance: 1, avgPrint: "4 ч 12 м", successRate: 93.4 },

    automations: [
      { id: "night", name: "Ночная печать", desc: "подбор и запуск безопасных заданий в окно 23:00–07:30", on: true },
      { id: "light", name: "Подсветка по событиям", desc: "включать при старте печати и на время снимка", on: true },
      { id: "snap", name: "Авто-снимки", desc: "каждые 10 минут во время активной печати", on: true },
      { id: "notify", name: "Уведомления об ошибках", desc: "Telegram + e-mail при критических событиях", on: true },
      { id: "runout", name: "Автопауза при обрыве филамента", desc: "по датчику filament runout", on: false }
    ],
    automationLastRun: "Авто-снимки · 6 минут назад · успешно",

    system: [
      { name: "Версия сервиса", val: "v0.4.2 · сборка 28.06", ok: "ok" },
      { name: "Запуск сервиса", val: "3 дн 14 ч назад", ok: "ok" },
      { name: "База данных", val: "PostgreSQL · 4 мс", ok: "ok" },
      { name: "MQTT", val: "подключено · 6/7 клиентов", ok: "warn" },
      { name: "go2rtc", val: "5 потоков · 2 offline", ok: "warn" },
      { name: "Очередь", val: "5 заданий · работает", ok: "ok" },
      { name: "Scheduler", val: "след. тик через 40 с", ok: "ok" },
      { name: "Automation worker", val: "активен · 5 правил", ok: "ok" }
    ],

    feed: [
      { icon: "▶", text: "<b>Cecilia</b> начала печать «Маска витража — мастер-модель»", time: "12:02", kind: "ok" },
      { icon: "⚠", text: "<b>Calx</b>: печать остановлена — ошибка термистора", time: "11:57", kind: "err" },
      { icon: "＋", text: "Задание «Кронштейны рейки ×6» добавлено в очередь", time: "11:31", kind: "info" },
      { icon: "⚗", text: "Автоматизация «Авто-снимки» выполнена для 3 принтеров", time: "11:30", kind: "info" },
      { icon: "✔", text: "<b>Aurora</b> завершила печать «Крышка корпуса» (успех)", time: "10:48", kind: "ok" },
      { icon: "⛓", text: "<b>Opal</b> ушёл offline", time: "09:12", kind: "err" },
      { icon: "🧑‍🔧", text: "Оператор перевёл <b>Golem</b> в режим обслуживания", time: "08:03", kind: "info" },
      { icon: "↺", text: "<b>Kreide</b> вернулся online после перезагрузки", time: "07:44", kind: "ok" }
    ],

    warnings: [
      { icon: "⛓", text: "Нет связи с принтером Opal", hint: "проверить питание и сеть", level: "err" },
      { icon: "◉", text: "У Terra не настроена камера", hint: "ночная печать на нём недоступна", level: "warn" },
      { icon: "🧵", text: "PETG · Графит заканчивается", hint: "для очереди нужно ещё 0.3 кг", level: "warn" },
      { icon: "▦", text: "«Маска витража — литьевая форма»: не задан профиль печати", hint: "задание ждёт проверки", level: "warn" },
      { icon: "⬡", text: "«Кейс электроники»: материал не совпадает с заправленным", hint: "нужен ABS, заправлен PLA", level: "warn" },
      { icon: "⚙", text: "У Golem не настроены capabilities", hint: "автоподбор заданий пропускает его", level: "info" }
    ],

    plan: {
      next: { title: "Корпус датчика влажности", printer: "Terra", at: "14:30" },
      upcoming: [
        { title: "Кронштейны рейки ×6", printer: "Kreide", at: "18:05" },
        { title: "Статуэтка «Цецилия»", printer: "Cecilia", at: "23:00 · ночь" },
        { title: "Маска витража — литьевая форма", printer: "—", at: "после проверки" }
      ],
      queueEta: "завтра · 09:40",
      nightReady: "Статуэтка «Цецилия» — риск 18%, камера и авто-снимки активны",
      manual: [
        "«Маска витража — литьевая форма» — задать профиль печати",
        "«Кейс электроники» — заправить ABS в Calx после ремонта"
      ]
    },

    maintenance: [
      { p: "Aurora", clean: "3 дн", nozzle: "12 дн", fep: "—", calib: "3 дн", success: "сегодня 10:48", due: false },
      { p: "Kreide", clean: "6 дн", nozzle: "24 дн", fep: "—", calib: "6 дн", success: "вчера 22:10", due: false },
      { p: "Terra", clean: "1 дн", nozzle: "8 дн", fep: "—", calib: "1 дн", success: "вчера 18:32", due: false },
      { p: "Cecilia", clean: "2 дн", nozzle: "—", fep: "9 дн", calib: "9 дн", success: "сегодня 07:15", due: false },
      { p: "Calx", clean: "19 дн", nozzle: "41 дн", fep: "—", calib: "19 дн", success: "28.06", due: true },
      { p: "Opal", clean: "11 дн", nozzle: "—", fep: "34 дн", calib: "34 дн", success: "24.06", due: true },
      { p: "Golem", clean: "сейчас", nozzle: "сейчас", fep: "—", calib: "после ремонта", success: "27.06", due: false }
    ]
  };
}
