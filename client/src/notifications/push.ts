import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import type { NotificationEvents, NotificationOverview } from '../../../shared/notifications';
import { getLanguage } from '../i18n/i18n';
import { api } from '../common/lib';

export type PushSupport = 'supported' | 'insecure' | 'install' | 'unsupported';

/** Whether this browser can receive Tower's push notifications, and if not, what would make it able to. */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  // iPhone and iPad deliver web push only to a page added to the Home Screen.
  if (apple && !standalone && !('PushManager' in window)) return 'install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return apple && !standalone ? 'install' : 'unsupported';
  return 'supported';
}

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !window.isSecureContext || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

/** The page's own device: the SHA-256 of its push endpoint, as the server names it. */
export async function deviceIdOf(subscription: PushSubscription): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function deviceLabel(agent = navigator.userAgent): string {
  const device = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android'
    : /Macintosh/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) || /CriOS/.test(agent) ? 'Chrome'
    : /Safari\//.test(agent) ? 'Safari' : 'Browser';
  return device ? `${device} · ${browser}` : browser;
}

const keyBytes = (value: string) => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
};
const sameKey = (key: ArrayBuffer | null, publicKey: string) => {
  if (!key) return false;
  const a = new Uint8Array(key), b = keyBytes(publicKey);
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

export function notificationPost(path: string, token: string, body: unknown): Promise<NotificationOverview> {
  return api<NotificationOverview>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify(body) });
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration ? registration.pushManager.getSubscription() : null;
}

/** This browser's subscription, if it has one for this Tower's key. */
export async function existingSubscription(publicKey: string): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null;
  const subscription = await currentSubscription();
  return subscription && sameKey(subscription.options.applicationServerKey, publicKey) ? subscription : null;
}

/** Asks for permission if needed, subscribes this browser, and registers it with Tower. */
export async function enablePush(token: string, publicKey: string, events?: NotificationEvents): Promise<NotificationOverview> {
  if (Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') throw new Error('브라우저에서 알림 권한이 허용되지 않았습니다.');
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made for another key (an earlier Tower installation) cannot receive this one's messages.
  if (subscription && !sameKey(subscription.options.applicationServerKey, publicKey)) { await subscription.unsubscribe(); subscription = null; }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  return notificationPost('/api/notifications/subscribe', token, { subscription: subscription.toJSON(), label: deviceLabel(), language: getLanguage(), ...(events ? { events } : {}) });
}

export async function disablePush(token: string, publicKey: string): Promise<NotificationOverview | undefined> {
  const subscription = await existingSubscription(publicKey);
  if (!subscription) return undefined;
  const id = await deviceIdOf(subscription);
  await subscription.unsubscribe().catch(() => false);
  return notificationPost('/api/notifications/remove', token, { id });
}

/** Keeps a registered browser's notifications in the language its page now uses. Asks nothing of the user. */
export async function refreshPush(token: string): Promise<void> {
  if (!token || pushSupport() !== 'supported' || Notification.permission !== 'granted') return;
  const overview = await api<NotificationOverview>('/api/notifications');
  const subscription = await existingSubscription(overview.publicKey);
  if (!subscription) return;
  const id = await deviceIdOf(subscription);
  // A device removed from the list stays removed until its page turns notifications on again.
  const known = overview.devices.find(device => device.id === id);
  if (known && known.language !== getLanguage()) await notificationPost('/api/notifications/update', token, { id, language: getLanguage() });
}
