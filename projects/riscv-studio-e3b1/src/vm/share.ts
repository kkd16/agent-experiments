// Encode the editor buffer into a shareable URL.
//
// The program rides in the query string (`?prog=…`) rather than the hash, because the hash is
// already owned by the tab router (`#/console`). A query param sits *before* the hash, so a
// shared link can carry both a program and a starting tab and still survive a refresh under the
// site's relative base.

/** URL-safe base64 of the UTF-8 source. */
export function encodeProgram(src: string): string {
  const bytes = new TextEncoder().encode(src);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeProgram(enc: string): string | null {
  try {
    let b64 = enc.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Read a `?prog=…` program from the current URL, or null if absent/invalid. */
export function programFromUrl(): string | null {
  try {
    const p = new URLSearchParams(window.location.search).get('prog');
    return p ? decodeProgram(p) : null;
  } catch {
    return null;
  }
}

/** Build a self-contained link to the given source, preserving the active tab. */
export function buildShareUrl(src: string): string {
  const base = window.location.origin + window.location.pathname;
  const hash = window.location.hash || '#/console';
  return `${base}?prog=${encodeProgram(src)}${hash}`;
}
