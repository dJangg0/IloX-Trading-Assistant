import { useEffect, useState } from 'react';
import { installAvailable, onInstallAvailabilityChange, promptInstall } from '../lib/install';
import { isIos, isStandalone } from '../lib/push';

/** Install button for browsers that support it (Chrome, Edge, Android). Hidden when already installed. */
export function InstallCard() {
  const [available, setAvailable] = useState(installAvailable);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => onInstallAvailabilityChange(() => setAvailable(installAvailable())), []);

  // iOS has no install event, and the IosInstallGuide card covers it.
  if (isStandalone() || isIos() || !available) return null;

  async function install() {
    const outcome = await promptInstall();
    if (outcome === 'accepted') setMessage('Installed. Open BandAlert from your dock or app list.');
    else if (outcome === 'dismissed') setMessage('Install cancelled. You can try again any time.');
    else setMessage('Install is not available in this browser right now.');
  }

  return (
    <section className="card callout" aria-labelledby="install-title">
      <h2 id="install-title">Install BandAlert</h2>
      <p className="muted small">Open it in its own window, from your dock or app list, like a native app.</p>
      <button className="btn btn--primary" data-install onClick={() => void install()}>
        Install app
      </button>
      {message && <p className="small muted">{message}</p>}
    </section>
  );
}
