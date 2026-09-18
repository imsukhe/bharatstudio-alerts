/**
 * Resolve the one API-owned audio-artifact route an overlay may fetch.
 *
 * Event payloads intentionally carry a relative path so the API does not bake a
 * web deployment hostname into a durable delivery.  The configured API origin —
 * not the browser-source page's origin — is therefore the only valid base.  This
 * is a security boundary: a payload cannot select an arbitrary URL even if it
 * reaches an overlay client.
 */
export function safeOverlayAudioUrl(value: string, configuredApiOrigin: string): string | undefined {
  try {
    const api = new URL(configuredApiOrigin);
    if (
      (api.protocol !== 'http:' && api.protocol !== 'https:') ||
      api.username ||
      api.password ||
      api.pathname !== '/' ||
      api.search ||
      api.hash
    ) return undefined;

    const url = new URL(value, api.origin);
    const pathSegments = url.pathname.split('/');
    if (
      url.origin !== api.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.includes('%') ||
      pathSegments.length !== 5 ||
      pathSegments[0] !== '' ||
      pathSegments[1] !== 'v1' ||
      pathSegments[2] !== 'overlay-audio' ||
      !pathSegments[3] ||
      !pathSegments[4]
    ) return undefined;

    return url.toString();
  } catch {
    return undefined;
  }
}
