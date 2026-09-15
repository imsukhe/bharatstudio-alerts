/** A timer that is always cancelled and whose abort listener is unregistered. */
export function abortableSleep(timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener('abort', finish, { once: true });
    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });
}
