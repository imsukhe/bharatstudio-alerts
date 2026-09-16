/*
 * PRF-02 slice 3 — small, pure/browser-API-only helpers shared by the
 * Support Theater canvas module (modules/support-theater-module.ts).
 *
 * These are deliberately a SEPARATE, canvas-scoped copy of the same two
 * helpers already defined inline in the standalone overlay page
 * (../[overlayId]/page.tsx's playChime/safeAudioUrl) rather than an
 * extraction that would also touch that file. The standalone page is this
 * product's named mid-stream rollback path (§21.3, PRF-02's own kill
 * switch) and slice 3's own scope boundary is "apps/web/app/overlay/ is
 * yours exclusively" together with every earlier slice's stated invariant
 * that no existing widget/standalone route is modified by a Canvas task —
 * editing the rollback file to share fourteen lines was judged a worse
 * trade than two small, easily-diffed, behaviourally-identical copies. If
 * these two ever need to change, they must change in both places — that
 * cost is accepted explicitly here rather than left implicit.
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

/**
 * Only ever resolves to a same-origin `/v1/overlay-audio/...` URL. This is
 * a security boundary, not presentation logic: `ttsAudioUrl` arrives inside
 * a server-composed event payload, and this function is the one place that
 * refuses anything that is not the scoped, bearer-token-gated artifact
 * route — never an arbitrary absolute URL a compromised/misbehaving server
 * response could otherwise smuggle into an `<audio>` element.
 */
export function safeAudioUrl(value: string, origin: string): string | undefined {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/v1/overlay-audio/')) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
