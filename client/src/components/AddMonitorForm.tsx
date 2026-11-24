import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { TIMEFRAMES, type Timeframe } from '../lib/types';

interface Props {
  onCreated: () => void;
}

export function AddMonitorForm({ onCreated }: Props) {
  const [symbol, setSymbol] = useState('XAUUSD');
  const [timeframe, setTimeframe] = useState<Timeframe>('5m');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createMonitor({ symbol: symbol.trim().toUpperCase(), timeframe });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create monitor');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={onSubmit}>
      <h2>Add monitor</h2>
      <div className="row">
        <label className="field">
          <span>Symbol</span>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={20} required autoCapitalize="characters" />
        </label>
        <label className="field">
          <span>Timeframe</span>
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn--primary" type="submit" disabled={busy || !symbol.trim()}>
          Add
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
      <p className="muted small">New monitors start at an 85% reversion trigger. Adjust it on the card.</p>
    </form>
  );
}
