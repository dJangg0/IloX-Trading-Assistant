/**
 * "Install app" support. Chrome and Edge fire `beforeinstallprompt` when the app is installable. We keep
 * the event and let the user trigger it from a button. iOS has no such event, so it uses the guide instead.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // stop the browser's mini-infobar so our button is the one offered
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

export function onInstallAvailabilityChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function installAvailable(): boolean {
  return deferred !== null;
}

/** Opens the browser's install dialog. Must run directly from a click. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable';
  const event = deferred;
  deferred = null;
  notify();
  const { outcome } = await event.prompt();
  return outcome;
}
