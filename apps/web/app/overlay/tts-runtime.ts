/**
 * Audio is an optional presentation side effect. It must never hold the
 * visual alert or its durable acknowledgement open while a provider/browser
 * playback promise is slow or stuck.
 */
export const DEFAULT_TTS_PLAYBACK_TIMEOUT_MS = 1_500;

type AudioPlayback = {
  play: () => Promise<void> | void;
  pause: () => void;
};

function boundedTimeoutMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TTS_PLAYBACK_TIMEOUT_MS;
  return Math.min(DEFAULT_TTS_PLAYBACK_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

/**
 * Resolve true only when playback starts before the hard timeout. A timeout
 * pauses the element and resolves false so the caller can use the chime
 * fallback. The play promise is still observed after a timeout to prevent a
 * late provider rejection from becoming an unhandled browser error.
 */
export async function playAudioWithTimeout(
  audio: AudioPlayback,
  timeoutMs = DEFAULT_TTS_PLAYBACK_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = audio.play();
  if (!pending || typeof pending.then !== 'function') return true;

  const playback = Promise.resolve(pending).then(
    () => true,
    () => false,
  );
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      audio.pause();
      resolve(false);
    }, boundedTimeoutMs(timeoutMs));
  });

  try {
    return await Promise.race([playback, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
