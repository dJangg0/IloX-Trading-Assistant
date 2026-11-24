import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AddMonitorForm } from './components/AddMonitorForm';
import { AlertHistory } from './components/AlertHistory';
import { ChartPanel } from './components/ChartPanel';
import { ToastStack } from './components/ToastStack';
import { InstallCard } from './components/InstallCard';
import { IosInstallGuide } from './components/IosInstallGuide';
import { MonitorCard } from './components/MonitorCard';
import { PushSetupCard } from './components/PushSetupCard';
import { adminToken, api } from './lib/api';
import { findNewAlerts, toToast, type ToastData } from './lib/alerts';
import { requiresHomeScreenInstall } from './lib/push';
import { TIMEFRAMES, type AlertView, type MonitorView, type Timeframe } from './lib/types';

// Commodity codes from the Sifting docs, offered as suggestions in the chart's symbol box.
const SUGGESTED_SYMBOLS = ['XAUUSD', 'XAGUSD', 'XCUUSD', 'USOUSD', 'NATGAS'];

const POLL_MS = 2_000;
const MAX_TOASTS = 3;

/** Chart selection can come from the URL (?symbol=XAUUSD&tf=1m) so a view can be bookmarked or shared. */
function initialChart(): { symbol: string; timeframe: Timeframe } {
  const params = new URLSearchParams(window.location.search);
  const symbol = params.get('symbol')?.trim().toUpperCase();
  const tf = params.get('tf') as Timeframe | null;
  return {
    symbol: symbol && /^[A-Z0-9][A-Z0-9._/-]{0,19}$/.test(symbol) ? symbol : 'XAUUSD',
    timeframe: tf && (TIMEFRAMES as readonly string[]).includes(tf) ? tf : '5m',
  };
}

export function App() {
  const [monitors, setMonitors] = useState<MonitorView[]>([]);
  const [alerts, setAlerts] = useState<AlertView[]>([]);
  const [toasts, setToasts] = useState<ToastData[]>([]);
  // null until the first load. Alerts already in history at load time must not pop up.
  const seenAlerts = useRef<Set<string> | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [token, setToken] = useState<string | null>(adminToken.get());
  const [tokenDraft, setTokenDraft] = useState('');
  const [initial] = useState(initialChart);
  const [chartSymbol, setChartSymbol] = useState(initial.symbol);
  const [chartTimeframe, setChartTimeframe] = useState<Timeframe>(initial.timeframe);
  // Computed once: the install prompt only applies while the page is a regular iOS Safari tab.
  const [needsInstall] = useState(() => requiresHomeScreenInstall());

  const refresh = useCallback(async () => {
    try {
      const [m, a] = await Promise.all([api.monitors(), api.alerts(50)]);
      setMonitors(m);
      setAlerts(a);
      setOnline(true);

      if (seenAlerts.current === null) {
        seenAlerts.current = new Set(a.map((x) => x.id));
      } else {
        const fresh = findNewAlerts(seenAlerts.current, a);
        if (fresh.length > 0) {
          for (const x of fresh) seenAlerts.current.add(x.id);
          setToasts((prev) => [...fresh.map(toToast), ...prev].slice(0, MAX_TOASTS));
        }
      }
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    // Refresh immediately when the PWA returns to the foreground.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const dismissToast = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const canAdmin = token !== null;
  const symbolOptions = [...new Set([...monitors.map((m) => m.symbol), ...SUGGESTED_SYMBOLS])];

  function saveToken(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!tokenDraft.trim()) return;
    adminToken.set(tokenDraft);
    setToken(tokenDraft.trim());
    setTokenDraft('');
  }

  function forgetToken() {
    adminToken.clear();
    setToken(null);
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>BandAlert</h1>
          <p className="muted small">Bollinger reversion monitor · 20 / 2σ</p>
        </div>
        <span className={`conn ${online === false ? 'conn--down' : online ? 'conn--up' : ''}`}>
          {online === null ? 'Connecting…' : online ? 'Server online' : 'Server unreachable'}
        </span>
      </header>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <ChartPanel
        symbols={symbolOptions}
        monitors={monitors}
        symbol={chartSymbol}
        timeframe={chartTimeframe}
        onSymbolChange={setChartSymbol}
        onTimeframeChange={setChartTimeframe}
      />

      <InstallCard />
      {needsInstall ? <IosInstallGuide /> : <PushSetupCard />}

      <section className="card admin">
        {canAdmin ? (
          <div className="row">
            <span className="badge badge--live">Admin unlocked</span>
            <button className="btn btn--ghost" onClick={forgetToken}>
              Forget token
            </button>
          </div>
        ) : (
          <form className="row" onSubmit={saveToken}>
            <label className="field grow">
              <span>Admin token</span>
              <input
                type="password"
                autoComplete="off"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder="Paste ADMIN_TOKEN to change rules"
              />
            </label>
            <button className="btn btn--primary" type="submit" disabled={!tokenDraft.trim()}>
              Unlock
            </button>
          </form>
        )}
      </section>

      {canAdmin && <AddMonitorForm onCreated={() => void refresh()} />}

      <section className="monitors" aria-label="Monitors">
        {monitors.length === 0 && online !== false && (
          <p className="muted">No monitors yet{canAdmin ? '. Add one above.' : '.'}</p>
        )}
        {monitors.map((m) => (
          <MonitorCard key={m.id} monitor={m} canAdmin={canAdmin} onChanged={() => void refresh()} />
        ))}
      </section>

      <AlertHistory alerts={alerts} />
    </div>
  );
}
