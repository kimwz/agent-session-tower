/**
 * The request IDs a joined computer accepts: time-ordered UUIDv7, so it can run each request at most once and tell how
 * old a resend is. A random UUIDv4 is refused (`not-admitted`).
 */
const UUID_V7 = /^[a-f\d]{8}-[a-f\d]{4}-7[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

export function remoteRequestTime(id: string): number | undefined {
  if (!UUID_V7.test(id)) return undefined;
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

export function remoteRequestId(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let time = now;
  for (let index = 5; index >= 0; index--) { bytes[index] = time % 256; time = Math.floor(time / 256); }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
