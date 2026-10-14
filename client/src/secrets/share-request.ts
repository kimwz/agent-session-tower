import { openSettings } from '../settings/settings-open';

/**
 * A share push of the host (`secretShareMessage` on the server): a computer that follows this Tower asked for a secret
 * not shared with it. The link opens that secret's sharing with a one-tap share to that computer; the share itself is
 * the owner's usual sharing change from the page, never something the notification does on its own. Without a secret
 * (`secretShare=`) it opens the secrets, where a locked vault is opened.
 */
export interface ShareRequest { secretId?: string; hostId?: string }

let pending: ShareRequest | undefined;

export function shareRequestOf(url: URL): ShareRequest | undefined {
  if (!url.searchParams.has('secretShare')) return undefined;
  const secretId = url.searchParams.get('secretShare') || undefined; const hostId = url.searchParams.get('machine') || undefined;
  return { ...(secretId ? { secretId } : {}), ...(secretId && hostId ? { hostId } : {}) };
}

/** Opens the secrets for a share push's link; false when the link is not one or the settings cannot open yet. */
export function openShareRequest(url: URL): boolean {
  const request = shareRequestOf(url);
  if (!request) return false;
  pending = request.hostId ? request : undefined;
  return openSettings({ section: 'secrets', ...(request.secretId ? { secretId: request.secretId } : {}) });
}

/** The page was opened from a share push: opens it once the settings can, and leaves the address as it was otherwise. */
export function openShareRequestFromAddress(): void {
  const url = new URL(window.location.href);
  if (!openShareRequest(url)) return;
  url.searchParams.delete('secretShare'); url.searchParams.delete('machine');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

/** The computer a push asked to share this secret with, while its sharing is open. */
export function pendingShare(secretId: string): string | undefined { return pending?.secretId === secretId ? pending.hostId : undefined; }
export function clearShare(): void { pending = undefined; }
