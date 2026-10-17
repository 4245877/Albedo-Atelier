/**
 * Captures from a real Anycubic Kobra X — `modelId` 20030, firmware 2.0.2.2 —
 * taken read-only over LAN mode on 2026-10-17, during and at the end of a print
 * started on the printer's own screen (PETG, 15 layers, about 2 h 10 min).
 *
 * Anonymized, nothing else changed: the address is a documentation address
 * (192.0.2.10), the MAC a documentation MAC, and the token, serial, message ids,
 * local task id, upload/stream tokens and the file name are replaced. Every key,
 * every other value and every JSON type is as the printer sent it — that is the
 * point: `task_id` really is the string "-1", temperatures really are integers,
 * a mid-print `print` push really says `action: "start"`.
 */

/** `GET :18910/info` in LAN mode. */
export const KOBRA_X_HTTP_INFO = {
  cn: "TESTSERIAL000000000",
  ctrlInfoUrl: "http://192.0.2.10:18910/ctrl",
  ctrlType: "lan",
  deviceName: "Anycubic Kobra X",
  deviceType: "fdm",
  env: "prod",
  ip: "192.0.2.10",
  modelId: "20030",
  modelName: "Anycubic Kobra X",
  token: "0123456789abcdefFEDCBA9876543210",
  usn: "uuid:fdm:00:00:5e:00:53:01",
  zone: "global"
};

/**
 * The keys of the decrypted `/ctrl` bundle, in the printer's order. Values were
 * not recorded (it is the broker login) and are synthetic here; the lengths of
 * the real ones are noted where they say something about the shape.
 */
export const KOBRA_X_CTRL_BUNDLE_SHAPE = {
  broker: "mqtts://192.0.2.10:9883",
  deviceId: "0123456789abcdef0123456789abcdef", // 32 characters on the device
  deviceType: "fdm",
  devicecrt: "-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----", // ~1 KB on the device
  devicepk: "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----", // ~1.7 KB on the device
  ip: "192.0.2.10",
  modeId: "20030",
  modelId: "20030",
  modelName: "Anycubic Kobra X",
  password: "synthetic-pass1", // 15 characters on the device
  username: "synthetic-us" // 12 characters on the device
};

/** `…/info/report`, the answer to an `info` query, mid-print. */
export const KOBRA_X_INFO_PRINTING = {
  action: "report",
  code: 200,
  data: {
    aux_fan_speed_pct: 0,
    fan_speed_pct: 30,
    features: {
      auto_leveling_support: true,
      calibration_support: true,
      camera_timelapse_support: true,
      custom_colors_support: true,
      delete_batch_support: true,
      drying_first_support: false,
      factory_reset_support: true,
      file_rename_support: true,
      flow_calibration_support: true,
      fod_support: true,
      gcode_3mf_support: true,
      keep_print_head_temp_support: true,
      material_remove_support: true,
      one_click_update_support: true,
      pre_cancel_support: true,
      preheating_support: true,
      screen_sleep_support: true,
      shengwang_rdt_support: true,
      shengwang_rtc_support: true,
      vibration_compensation_support: true
    },
    ip: "192.0.2.10",
    last_project: {
      curr_layer: 0,
      file_root_path: "",
      filename: "",
      filetype: 0,
      print_time: 0,
      progress: 0,
      remain_time: 0,
      state: "",
      supplies_usage: 0,
      task_id: 0,
      total_layers: 0
    },
    model: "Anycubic Kobra X",
    print_speed_mode: 2,
    printerName: "Anycubic Kobra X",
    project: {
      curr_layer: 12,
      filename: "Sample+Part+Set_plate(07)_PETG_0.2_2h10m.gcode",
      pause: 0,
      print_speed_mode: 0,
      print_time: 96,
      progress: 74,
      project_type: 1,
      remain_time: 33,
      state: "printing",
      supplies_usage: 17162,
      task_id: "-1",
      task_settings: { camera_timelapse: 0 },
      total_layers: 15
    },
    state: "busy",
    temp: { curr_hotbed_temp: 75, curr_nozzle_temp: 240, target_hotbed_temp: 75, target_nozzle_temp: 240 },
    urls: {
      fileUploadurl: "http://192.0.2.10:18910/gcode_upload?s=REDACTED",
      rtspUrl: "http://192.0.2.10:18088/live/REDACTED"
    },
    version: "2.0.2.2"
  },
  msg: "done",
  msgid: "00000000-0000-4000-8000-000000000001",
  state: "done",
  timestamp: 1792227919733,
  type: "info"
};

/**
 * `…/print/report`, pushed unprompted every few seconds to a minute while
 * printing — with `action: "start"` on every one of them, mid-print.
 */
export const KOBRA_X_PRINT_PUSH = {
  action: "start",
  code: 200,
  data: {
    curr_layer: 12,
    file_root_path: "Sample+Part+Set_plate(07)_PETG_0.2_2h10m.gcode",
    filename: "Sample+Part+Set_plate(07)_PETG_0.2_2h10m.gcode",
    filetype: 1,
    localtask: "00000000-0000-4000-8000-0000000000aa",
    print_time: 97,
    progress: 74,
    remain_time: 32,
    supplies_usage: 17419,
    taskid: "-1",
    total_layers: 15
  },
  msg: "done",
  msgid: "00000000-0000-4000-8000-000000000002",
  state: "printing",
  timestamp: 1792227932116,
  type: "print"
};

/** `…/{deviceId}/response` — the bare acknowledgement every query also gets. */
export const KOBRA_X_RESPONSE_ACK = {
  action: "",
  code: 0,
  data: null,
  msg: "",
  msgid: "00000000-0000-4000-8000-000000000001",
  state: "",
  timestamp: 0,
  type: ""
};

// ── The end of that print, in the order it arrived ───────────────────────────
//
// Heaters off → `print` pushes naming the cool-down → `info` still `busy`, the
// project now `nozzle_cooling_off` → a `print` push resetting progress to 0 →
// lifetime statistics on the info topic → `status` `free` (three times) → the
// `print` push saying `finished` → the next `info`: `free`, no project, and
// `last_project` STILL EMPTY. That last push is the only place the ending is
// named on this firmware.

const FILE = KOBRA_X_INFO_PRINTING.data.project.filename;

/** One of the two cool-down pushes (`hotbed_cooling_off` came 12 ms before it): no progress. */
export const KOBRA_X_PRINT_COOLING = {
  action: "start",
  code: 200,
  data: { localtask: "00000000-0000-4000-8000-0000000000aa", taskid: "-1" },
  msg: "done",
  msgid: "00000000-0000-4000-8000-000000000003",
  state: "nozzle_cooling_off",
  timestamp: 1792229905429,
  type: "print"
};

/** `…/tempature/report`, pushed every 1–2 s once the heaters are off. */
export const KOBRA_X_TEMPERATURE_PUSH = {
  action: "auto",
  code: 200,
  data: { curr_hotbed_temp: 75, curr_nozzle_temp: 240, target_hotbed_temp: 0, target_nozzle_temp: 0, taskid: "" },
  msg: "done",
  msgid: "00000000-0000-4000-8000-000000000004",
  state: "done",
  timestamp: 1792229906683,
  type: "tempature"
};

/** The `info` answer during the cool-down: the print is over, the machine not yet free. */
export const KOBRA_X_INFO_COOLING = {
  ...KOBRA_X_INFO_PRINTING,
  data: {
    ...KOBRA_X_INFO_PRINTING.data,
    fan_speed_pct: 0,
    project: {
      curr_layer: 0,
      filename: FILE,
      pause: 0,
      print_speed_mode: 0,
      print_time: 0,
      progress: 99,
      project_type: 1,
      remain_time: 0,
      state: "nozzle_cooling_off",
      supplies_usage: 0,
      task_id: "-1",
      task_settings: { camera_timelapse: 0 },
      total_layers: 0
    },
    temp: { curr_hotbed_temp: 75, curr_nozzle_temp: 208, target_hotbed_temp: 0, target_nozzle_temp: 0 }
  },
  timestamp: 1792229922955
};

/** A `print` push after the cool-down `info`: "printing", progress 0. */
export const KOBRA_X_PRINT_RESET = {
  action: "start",
  code: 200,
  data: {
    file_root_path: FILE,
    filename: FILE,
    filetype: 1,
    localtask: "00000000-0000-4000-8000-0000000000aa",
    progress: 0,
    taskid: "-1"
  },
  msg: "done",
  msgid: "00000000-0000-4000-8000-000000000005",
  state: "printing",
  timestamp: 1792229924611,
  type: "print"
};

/** Unprompted, on the `info` topic: lifetime counters, no machine state. */
export const KOBRA_X_INFO_STATISTICS = {
  action: "statistic-reported",
  code: 200,
  data: {
    last_taskid: "",
    material_used_gram_value: 1759.2,
    material_used_value: 594619.5387789529,
    print_count: 9,
    print_total_minutes: 4833
  },
  msg: "done",
  msgid: "00000000-0000-4000-8000-000000000006",
  state: "done",
  timestamp: 1792229925514,
  type: "info"
};

/** `…/status/report` — the coarse flip to free. */
export const KOBRA_X_STATUS_FREE = {
  action: "workReport",
  code: 200,
  data: null,
  msg: "",
  msgid: "00000000-0000-4000-8000-000000000007",
  state: "free",
  timestamp: 1792229925530,
  type: "status"
};

/** The `print` push that names the ending, 3 ms after the `free` flip. */
export const KOBRA_X_PRINT_FINISHED = {
  action: "start",
  code: 200,
  data: {
    file_root_path: FILE,
    filename: FILE,
    filetype: 1,
    localtask: "00000000-0000-4000-8000-0000000000aa",
    progress: 100,
    remain_time: 0,
    taskid: "-1"
  },
  msg: "done",
  msgid: "00000000-0000-4000-8000-000000000008",
  state: "finished",
  timestamp: 1792229925533,
  type: "print"
};

/** The next `info` answer: free, no project, `last_project` still empty. */
export const KOBRA_X_INFO_FREE_AFTER_PRINT = {
  ...KOBRA_X_INFO_PRINTING,
  data: {
    ...KOBRA_X_INFO_PRINTING.data,
    fan_speed_pct: 0,
    project: null,
    state: "free",
    temp: { curr_hotbed_temp: 73, curr_nozzle_temp: 171, target_hotbed_temp: 0, target_nozzle_temp: 0 }
  },
  timestamp: 1792229942963
};
