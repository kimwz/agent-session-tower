/** What a device is told about. Each device chooses for itself. */
export interface NotificationEvents {
  /** A conversation turn you started in a project finished, or stopped with an error. */
  runCompleted: boolean;
  /** A trigger started work. */
  triggerStarted: boolean;
  /** A conversation waits for your approval or your answer to its question. */
  runWaiting: boolean;
}
export const DEFAULT_NOTIFICATION_EVENTS: NotificationEvents = { runCompleted: true, triggerStarted: true, runWaiting: true };
export type NotificationLanguage = 'ko' | 'en';
export interface NotificationDevice {
  /** SHA-256 of the push endpoint, hex; a page finds its own device by hashing its subscription's endpoint. */
  id: string;
  label: string;
  language: NotificationLanguage;
  events: NotificationEvents;
  createdAt: string;
  lastSentAt?: string;
  lastError?: string;
}
export interface NotificationOverview {
  /** The VAPID public key browsers subscribe with, base64url. */
  publicKey: string;
  devices: NotificationDevice[];
}
/** What the service worker receives in each push message. */
export interface NotificationPayload {
  title: string;
  body: string;
  /** Same-origin page to open when the notification is clicked. */
  url: string;
  /** Notifications with the same tag replace each other. */
  tag: string;
}
