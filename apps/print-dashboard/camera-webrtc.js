import { VideoRTC } from "./video-rtc.js";

/*
 * Живой видеоэлемент дашборда, построенный на go2rtc VideoRTC (см. video-rtc.js).
 * Порядок транспортов — WebRTC, затем MSE: камере Creality K2 keyframe удаётся
 * получить только по её родному WebRTC (HTTP/MP4 из go2rtc её не отдаёт), поэтому
 * WebRTC здесь основной путь.
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
    // Только транспорты, которым нужен один WebSocket и никакого UDP-фолбэка,
    // ломающего низкую задержку. WebRTC — основной, MSE — запасной.
    this.mode = "webrtc,mse";
    // У камеры принтера нет звука — не запрашиваем аудио-трек.
    this.media = "video";
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

    // Признак «идёт картинка» берём с самого <video> — работает и для WebRTC,
    // и для MSE, в отличие от привязки к конкретному транспорту.
    this.video.addEventListener("playing", () => this.setLive(true));
    this.video.addEventListener("waiting", () => this.setLive(false, "подключение…"));
    this.video.addEventListener("emptied", () => this.setLive(false, "подключение…"));
  }

  setLive(live, text) {
    if (!this.overlay) return;
    this.classList.toggle("is-live", live);
    this.overlay.textContent = live ? "" : text || this.overlay.textContent;
  }

  onconnect() {
    const result = super.onconnect();
    if (result) this.setLive(false, "подключение…");
    return result;
  }

  ondisconnect() {
    super.ondisconnect();
    this.setLive(false, "нет сигнала");
  }
}

customElements.define("camera-stream", CameraStream);
