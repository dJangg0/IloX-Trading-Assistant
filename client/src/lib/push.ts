import { api } from './api';

export const isIos = (): boolean => /iphone|ipad|ipod/i.test(window.navigator.userAgent);

/** Home-screen web apps on iOS expose `navigator.standalone`; a regular Safari tab does not. */
export const isStandalone = (): boolean =>
  window.matchMedia?.('(display-mode: standalone)').matches === true ||
  (window.navigator as Navigator & { standalone?: boolean }).standalone === true;

/** iOS 16.4+ only exposes Notification and PushManager inside an installed Home Screen app. */
export const requiresHomeScreenInstall = (): boolean => isIos() && !isStandalone();

export function pushSupport(): { supported: boolean; reason?: string } {
  if (!('serviceWorker' in navigator)) return { supported: false, reason: 'Service workers are unavailable (HTTPS required).' };
  if (!('PushManager' in window)) return { supported: false, reason: 'Web Push is not available in this browser.' };
  if (!('Notification' in window)) return { supported: false, reason: 'Notifications are not available in this browser.' };
  return { supported: true };
}

/**
 * Must be the first statement run from a click handler. iOS rejects permission prompts that are not
 * directly tied to a user gesture, so do not await anything before calling this.
 */
export function requestPermissionFromGesture(): Promise<NotificationPermission> {
  return Notification.requestPermission();
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupport().supported) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Subscribes this device (after permission is granted) and registers the subscription with the server. */
export async function subscribeDevice(): Promise<PushSubscription> {
  const reg = await registerServiceWorker();
  const { publicKey } = await api.vapidPublicKey();

  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Browser returned an incomplete push subscription');
  }
  await api.subscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
  return sub;
}

export async function unsubscribeDevice(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await api.unsubscribe(endpoint).catch(() => undefined);
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
