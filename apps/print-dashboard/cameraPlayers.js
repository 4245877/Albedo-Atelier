/* ── Камеры: живые плееры ─────────────────────────────────────
   K2 отдаёт keyframe только по родному WebRTC, поэтому живое видео берём через
   go2rtc-компонент <camera-stream>, проксируемый nginx на /go2rtc/ (см.
   camera-webrtc.js). Bambu A1 отдаёт JPEG-кадры из локального TLS liveview;
   backend превращает их в MJPEG, который браузер показывает обычным <img>.

   Элементы живут в реестре по «слоту» (id принтера + место показа) и переносятся
   в свежие крепления после каждой перерисовки доски — трансляция не рвётся при
   обновлении телеметрии. */

const CAM_PLAYERS = new Map(); // slot -> <camera-stream>
const CAM_MJPEG_PLAYERS = new Map(); // slot -> <img>
const MJPEG_RECONNECT_MS = 3000;
const MJPEG_FIRST_FRAME_MS = 12000;

function streamUrlWithToken(src) {
  const join = src.includes("?") ? "&" : "?";
  return `${src}${join}live=${Date.now()}`;
}

function setMjpegLive(img, live, text) {
  img.dataset.live = live ? "1" : "0";
  const cam = img.closest(".cam");
  if (!cam) return;

  cam.classList.toggle("is-live", live);
  const state = cam.querySelector(".cam-state");
  if (state && !live) state.textContent = text || "подключение…";
}

function scheduleMjpegReconnect(img) {
  clearTimeout(img._reconnectTid);
  img._reconnectTid = setTimeout(() => {
    if (!img.isConnected || img.dataset.closing === "1") return;
    startMjpegPlayer(img, "переподключение…");
  }, MJPEG_RECONNECT_MS);
}

function startMjpegPlayer(img, text = "подключение…") {
  clearTimeout(img._reconnectTid);
  clearTimeout(img._firstFrameTid);

  setMjpegLive(img, false, text);
  img.src = streamUrlWithToken(img.dataset.baseSrc);
  img._firstFrameTid = setTimeout(() => {
    if (img.dataset.live === "1" || img.dataset.closing === "1") return;
    startMjpegPlayer(img, "переподключение…");
  }, MJPEG_FIRST_FRAME_MS);
}

function makeMjpegPlayer(src, alt) {
  const img = document.createElement("img");
  img.className = "cam-img cam-mjpeg";
  img.alt = alt;
  img.decoding = "async";
  img.dataset.baseSrc = src;

  img.addEventListener("load", () => {
    clearTimeout(img._firstFrameTid);
    clearTimeout(img._reconnectTid);
    setMjpegLive(img, true);
  });
  img.addEventListener("error", () => {
    if (img.dataset.closing === "1") return;
    clearTimeout(img._firstFrameTid);
    setMjpegLive(img, false, "переподключение…");
    scheduleMjpegReconnect(img);
  });

  return img;
}

function stopMjpegPlayer(img) {
  img.dataset.closing = "1";
  clearTimeout(img._reconnectTid);
  clearTimeout(img._firstFrameTid);
  img.removeAttribute("src");
  img.remove();
}

function reconcileWebrtcCameras() {
  // Веб-компонент грузится отдельным модулем и может быть ещё не зарегистрирован.
  // Дождёмся определения и повторим; крепления к этому моменту уже в DOM.
  if (!("customElements" in window)) return;
  if (!customElements.get("camera-stream")) {
    customElements.whenDefined("camera-stream").then(() => reconcileCameras());
    return;
  }

  const mounts = document.querySelectorAll("[data-cam-slot]");
  const seen = new Set();

  mounts.forEach((mount) => {
    const slot = mount.dataset.camSlot;
    const src = mount.dataset.camSrc;
    if (!slot || !src) return;
    seen.add(slot);

    let el = CAM_PLAYERS.get(slot);
    if (!el) {
      el = document.createElement("camera-stream");
      el.className = "cam-live";
      CAM_PLAYERS.set(slot, el);
      mount.appendChild(el); // connectedCallback → создаёт внутренний <video>
      // src задаём после вставки в DOM: onconnect у go2rtc-компонента требует,
      // чтобы элемент уже был connected и <video> существовал. Относительный путь
      // компонент сам превращает в ws://<origin>/go2rtc/api/ws?src=…
      el.src = `/go2rtc/api/ws?src=${encodeURIComponent(src)}`;
    } else if (el.parentNode !== mount) {
      // Переносим в новое крепление; поток не прерывается (5-секундная фора
      // компонента на отсоединение, отменяется этой же вставкой).
      mount.appendChild(el);
    }
  });

  for (const [slot, el] of CAM_PLAYERS) {
    if (!seen.has(slot)) {
      el.remove(); // компонент закроет соединение по истечении своей паузы
      CAM_PLAYERS.delete(slot);
    }
  }
}

function reconcileMjpegCameras() {
  const mounts = document.querySelectorAll("[data-cam-mjpeg-slot]");
  const seen = new Set();

  mounts.forEach((mount) => {
    const slot = mount.dataset.camMjpegSlot;
    const src = mount.dataset.camMjpegSrc;
    if (!slot || !src) return;
    seen.add(slot);

    let el = CAM_MJPEG_PLAYERS.get(slot);
    if (!el) {
      el = makeMjpegPlayer(src, mount.dataset.camAlt || "Камера принтера");
      CAM_MJPEG_PLAYERS.set(slot, el);
      mount.appendChild(el);
      startMjpegPlayer(el);
    } else {
      if (el.dataset.baseSrc !== src) {
        el.dataset.baseSrc = src;
        startMjpegPlayer(el);
      }
      if (el.parentNode !== mount) {
        mount.appendChild(el);
      }
      setMjpegLive(el, el.dataset.live === "1");
    }
  });

  for (const [slot, el] of CAM_MJPEG_PLAYERS) {
    if (!seen.has(slot)) {
      stopMjpegPlayer(el);
      CAM_MJPEG_PLAYERS.delete(slot);
    }
  }
}

/** Привязать постоянные live-плееры к свежим креплениям камер после перерисовки. */
export function reconcileCameras() {
  reconcileWebrtcCameras();
  reconcileMjpegCameras();
}
