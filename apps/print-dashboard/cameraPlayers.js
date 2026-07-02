/* ── Камеры: живые WebRTC-плееры ───────────────────────────────
   K2 отдаёт keyframe только по родному WebRTC, поэтому живое видео берём через
   go2rtc-компонент <camera-stream> (WebRTC → MSE), проксируемый nginx на
   /go2rtc/ (см. camera-webrtc.js). Компонент сам ведёт переговоры,
   переподключается при обрыве и ставит поток на паузу на скрытой вкладке.

   Элементы живут в реестре по «слоту» (id принтера + место показа) и переносятся
   в свежие крепления после каждой перерисовки доски — трансляция не рвётся при
   обновлении телеметрии: у компонента есть 5-секундная фора на отсоединение от
   DOM, а повторная вставка её отменяет. */

const CAM_PLAYERS = new Map(); // slot -> <camera-stream>

/** Привязать постоянные WebRTC-плееры к свежим креплениям камер после перерисовки. */
export function reconcileCameras() {
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
