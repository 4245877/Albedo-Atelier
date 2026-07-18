import { VideoRTC } from "./video-rtc.js";
import { FrameFreshness } from "./render/cameraFreshness.js";

/*
 * Живой видеоэлемент дашборда, построенный на go2rtc VideoRTC (см. video-rtc.js).
 * Камере Creality K2 keyframe удаётся получить только по её родному WebRTC
 * (HTTP/MP4 и MSE из go2rtc её не отдают), поэтому этот компонент намеренно
 * не запускает MSE/MP4 fallback.
 *
 * VideoRTC сам ведёт переговоры, переподключается при обрыве и ставит поток на
 * паузу, когда вкладка скрыта. Важно: при отсоединении от DOM он держит поток
 * ещё 5 c (DISCONNECT_TIMEOUT), поэтому периодическая пересборка доски, которая
 * переносит этот элемент в новое крепление, трансляцию не прерывает.
 *
 * Наследование от go2rtc video-stream.js (пример кастомного плеера).
 */
class CameraStream extends VideoRTC {
  constructor() {
    super();
    // K2 отдаёт живой кадр только через WebRTC. MSE здесь создаёт лишний
    // consumer в go2rtc и оставляет UI ждать кадр от нерабочего транспорта.
    this.mode = "webrtc";
    // У камеры принтера нет звука — не запрашиваем аудио-трек.
    this.media = "video";
    // Не держим параллельную сессию для превью, которое сейчас вне экрана.
    this.visibilityThreshold = 0.1;
  }

  oninit() {
    super.oninit();
    // Дашбордная камера: без штатных контролов, без звука, кадр по размеру.
    this.video.controls = false;
    this.video.muted = true;
    this.video.style.objectFit = "cover";

    this.overlay = document.createElement("div");
    this.overlay.className = "cam-state";
    this.overlay.textContent = "подключение…";
    this.appendChild(this.overlay);

    // Значок LIVE поверх видео — виден только когда картинка реально идёт
    // (класс is-live на элементе, см. styles.css).
    this.tag = document.createElement("span");
    this.tag.className = "cam-tag live";
    this.tag.innerHTML = `<i class="dot"></i>LIVE`;
    this.appendChild(this.tag);

    // Признак «идёт картинка» берём с самого <video>. В Firefox WebRTC может
    // получить первый кадр до события playing, поэтому loadeddata/canplay тоже
    // считаем живым кадром.
    this.video.addEventListener("loadeddata", () => this.setLive(true));
    this.video.addEventListener("canplay", () => this.setLive(true));
    this.video.addEventListener("playing", () => this.setLive(true));
    this.video.addEventListener("resize", () => this.setLive(true));
    this.video.addEventListener("timeupdate", () => this.setLive(true));
    this.video.addEventListener("waiting", () => this.setMaybeWaiting("подключение…"));
    this.video.addEventListener("stalled", () => this.setMaybeWaiting("ждём кадр…"));
    this.video.addEventListener("emptied", () => this.setLive(false, "подключение…"));
    this.video.addEventListener("error", () => this.setLive(false, "ошибка видео"));

    // Вачдог свежести кадров: события выше умеют только ЗАЖЕЧЬ значок, а
    // замёрзший WebRTC-track не эмитит ничего — LIVE горел бы вечно. Раз в
    // секунду сверяем счётчик реально декодированных кадров: track есть, но
    // кадры стоят дольше порога → честный STALE вместо LIVE.
    this.freshness = new FrameFreshness();
    this.freshTimer = setInterval(() => this.checkFreshness(), 1000);
  }

  /** Счётчик декодированных кадров, где браузер его отдаёт (иначе null). */
  decodedFrames() {
    const v = this.video;
    if (!v) return null;
    if (typeof v.getVideoPlaybackQuality === "function") {
      const q = v.getVideoPlaybackQuality();
      if (q && typeof q.totalVideoFrames === "number") return q.totalVideoFrames;
    }
    if (typeof v.webkitDecodedFrameCount === "number") return v.webkitDecodedFrameCount;
    return null;
  }

  checkFreshness() {
    if (!this.overlay) return;
    const now = Date.now();
    const frames = this.decodedFrames();
    if (frames !== null) this.freshness.sample(now, frames);
    const hasTrack = Boolean(this.video?.srcObject?.getVideoTracks?.().length);
    // Без счётчика кадров вачдог молчит — событийная логика остаётся.
    if (frames === null) return;
    const state = this.freshness.classify(now, hasTrack);
    if (state === "live") {
      this.setLive(true);
    } else if (state === "stale") {
      this.setLive(false, "кадры не обновляются…");
    } else {
      this.setLive(false, "нет сигнала");
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    if (this.freshTimer) {
      clearInterval(this.freshTimer);
      this.freshTimer = null;
    }
  }

  setLive(live, text) {
    if (!this.overlay) return;
    this.classList.toggle("is-live", live);
    this.overlay.textContent = live ? "" : text || this.overlay.textContent;
  }

  setMaybeWaiting(text) {
    if (this.video?.srcObject) return;
    this.setLive(false, text);
  }

  onpcvideo(video2) {
    const stream = video2.srcObject;
    const hasVideo = Boolean(stream?.getVideoTracks?.().length);
    const result = super.onpcvideo(video2);
    if (hasVideo && this.video?.srcObject) this.setLive(true);
    return result;
  }

  onconnect() {
    const result = super.onconnect();
    if (result) this.setLive(false, "подключение…");
    return result;
  }

  onclose() {
    const result = super.onclose();
    if (result) this.setLive(false, "переподключение…");
    return result;
  }

  ondisconnect() {
    super.ondisconnect();
    this.setLive(false, "нет сигнала");
  }
}

customElements.define("camera-stream", CameraStream);
