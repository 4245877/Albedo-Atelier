/* ═══════════════════════════════════════════════════════════════
   Честность значка LIVE: «есть media track» ≠ «идут кадры».

   Замёрзший WebRTC-поток оставляет track на месте и не эмитит
   ни stalled, ни error — прежний значок LIVE горел бы вечно.
   Этот модуль классифицирует состояние по ФАКТУ обновления кадров
   (счётчик декодированных кадров, снимаемый вачдогом раз в секунду):

     live    — кадры декодировались недавно (< staleMs назад);
     stale   — track есть, но счётчик кадров стоит дольше staleMs;
     offline — соединения/track нет вовсе.

   Чистый модуль без DOM — тестируется в Node.
   ═══════════════════════════════════════════════════════════════ */

export const DEFAULT_STALE_MS = 4000;

/** Отслеживает продвижение счётчика кадров одного видеоэлемента. */
export class FrameFreshness {
  constructor({ staleMs = DEFAULT_STALE_MS } = {}) {
    this.staleMs = staleMs;
    this.lastFrames = null;
    this.lastAdvanceAt = null;
  }

  /**
   * Записывает очередной замер счётчика кадров (`framesDecoded` из
   * getVideoPlaybackQuality()/WebRTC stats). Продвижение счётчика — и только
   * оно — обновляет отметку «кадры идут». Сброс счётчика (переподключение,
   * новый track) тоже считается продвижением.
   */
  sample(now, framesDecoded) {
    if (typeof framesDecoded !== "number" || Number.isNaN(framesDecoded)) return;
    if (this.lastFrames === null || framesDecoded !== this.lastFrames) {
      this.lastFrames = framesDecoded;
      this.lastAdvanceAt = now;
    }
  }

  /** Текущий честный статус: live / stale / offline. */
  classify(now, hasTrack) {
    if (!hasTrack) return "offline";
    if (this.lastAdvanceAt === null) return "stale"; // track есть, кадров ещё не видели
    return now - this.lastAdvanceAt <= this.staleMs ? "live" : "stale";
  }

  /** Забыть историю (закрытие/пересоздание соединения). */
  reset() {
    this.lastFrames = null;
    this.lastAdvanceAt = null;
  }
}
