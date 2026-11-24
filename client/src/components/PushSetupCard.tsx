import { useEffect, useState } from 'react';
import { adminToken, api } from '../lib/api';
import {
  currentSubscription,
  pushSupport,
  requestPermissionFromGesture,
  subscribeDevice,
  unsubscribeDevice,
} from '../lib/push';

type Phase = 'checking' | 'off' | 'on' | 'denied' | 'unsupported';

export function PushSetupCard() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pushSupport().supported) {
      setPhase('unsupported');
      return;
    }
    void (async () => {
      const sub = await currentSubscription();
      if (Notification.permission === 'denied') setPhase('denied');
      else setPhase(sub && Notification.permission === 'granted' ? 'on' : 'off');
    })();
  }, []);

  /**
   * Runs directly inside the click. requestPermissionFromGesture() is the first call made, before any
   * await, because iOS only shows the permission prompt for a gesture that reaches it synchronously.
   */
  function enable() {
    setBusy(true);
    setError(null);
    setMessage(null);
    requestPermissionFromGesture()
      .then(async (permission) => {
        if (permission !== 'granted') {
          setPhase(permission === 'denied' ? 'denied' : 'off');
          return;
        }
        await subscribeDevice();
        setPhase('on');
        setMessage('Notifications are on for this device.');
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not enable notifications'))
      .finally(() => setBusy(false));
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      await unsubscribeDevice();
      setPhase('off');
      setMessage('Notifications turned off for this device.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn off notifications');
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await api.sendTest();
      setMessage(`Test sent · delivered to ${r.sent} · failed ${r.failed} · pruned ${r.pruned}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'unsupported') {
    return (
      <section className="card">
        <h2>Notifications</h2>
        <p className="muted">{pushSupport().reason}</p>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="push-title">
      <h2 id="push-title">Notifications</h2>

      {phase === 'checking' && <p className="muted">Checking device status…</p>}

      {phase === 'off' && (
        <>
          <p className="muted small">Allow alerts so you hear about band reversions even when the app is in the background or locked.</p>
          <button className="btn btn--primary" disabled={busy} onClick={enable}>
            Enable notifications
          </button>
        </>
      )}

      {phase === 'denied' && (
        <p className="error small">
          Notifications are blocked for this site. Re-enable them in your browser or iOS Settings, then reload.
        </p>
      )}

      {phase === 'on' && (
        <div className="row">
          <span className="badge badge--live">Enabled on this device</span>
          <button className="btn btn--ghost" disabled={busy || !adminToken.get()} onClick={() => void sendTest()}>
            Send test alert
          </button>
          <button className="btn btn--ghost" disabled={busy} onClick={() => void disable()}>
            Turn off
          </button>
        </div>
      )}

      {phase === 'on' && !adminToken.get() && (
        <p className="muted small">Add the admin token below to send a test alert.</p>
      )}
      {message && <p className="ok small">{message}</p>}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
