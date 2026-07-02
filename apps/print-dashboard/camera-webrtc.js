import { VideoRTC } from "./video-rtc.js";

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
    this.video.addEventListener("waiting", () => this.setLive(false, "подключение…"));
    this.video.addEventListener("stalled", () => this.setLive(false, "ждём кадр…"));
    this.video.addEventListener("emptied", () => this.setLive(false, "подключение…"));
    this.video.addEventListener("error", () => this.setLive(false, "ошибка видео"));
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
