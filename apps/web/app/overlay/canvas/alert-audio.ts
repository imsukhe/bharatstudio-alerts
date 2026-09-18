/*
 * PRF-02 slice 3 — browser-API-only fallback chime shared by the Support
 * Theater Canvas module. API-origin validation now lives in the overlay-wide
 * `../alert-audio-url` helper because both Canvas and the standalone rollback
 * overlay consume server-composed relative artifact paths. One boundary keeps
 * that security behaviour from silently drifting between the two surfaces.
 */

/** Plays the non-blocking RT-03 fallback chime. Best-effort: a browser
 * with no (usable) AudioContext degrades to silence, never a thrown
 * error — the visual alert is already on screen regardless. */
export function playChime(): void {
  const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;
  const context = new AudioContextCtor();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(660, context.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(880, context.currentTime + 0.12);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.24);
  oscillator.addEventListener('ended', () => { void context.close(); }, { once: true });
}
