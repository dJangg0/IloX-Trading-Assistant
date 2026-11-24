import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { fmtPrice, fmtTime } from '../lib/format';
import type { FsmState, MonitorView } from '../lib/types';

interface Props {
  monitor: MonitorView;
  canAdmin: boolean;
  onChanged: () => void;
}

const FSM_LABEL: Record<FsmState, string> = {
  NEUTRAL: 'Neutral',
  ARMED_LOWER: 'Armed · lower band touched',
  ARMED_UPPER: 'Armed · upper band touched',
};

export function MonitorCard({ monitor: m, canAdmin, onChanged }: Props) {
  const [draftPct, setDraftPct] = useState(Math.round(m.reversionPct * 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const dragging = useRef(false);

  // Follow the server value unless the user is mid-drag.
  useEffect(() => {
    if (!dragging.current) setDraftPct(Math.round(m.reversionPct * 100));
  }, [m.reversionPct]);

  const r = draftPct / 100;
  const hasBands = m.upper !== null && m.middle !== null && m.lower !== null;
  // Live dollar preview of the thresholds at the slider's current value.
  const previewBull = hasBands ? m.lower! + r * (m.middle! - m.lower!) : null;
  const previewBear = hasBands ? m.upper! - r * (m.upper! - m.middle!) : null;

  const armed = m.fsmState !== 'NEUTRAL';
  const progress = recoveryProgress(m);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  function commitThreshold() {
    dragging.current = false;
    const pct = draftPct / 100;
    if (Math.abs(pct - m.reversionPct) < 1e-9) return;
    void run(() => api.updateMonitor(m.id, { reversionPct: pct }));
  }

  return (
    <article className={`card monitor ${armed ? 'is-armed' : ''}`}>
      <header className="monitor__head">
        <div>
          <h2 className="monitor__symbol">
            {m.symbol} <span className="chip">{m.timeframe}</span>
          </h2>
          <div className="badges">
            <span className={`badge ${m.feedStatus === 'LIVE' ? 'badge--live' : 'badge--paused'}`}>
              {m.feedStatus === 'LIVE' ? '● Live' : 'Feed Paused / Market Closed'}
            </span>
            <span className={`badge ${armed ? 'badge--armed' : 'badge--neutral'}`}>{FSM_LABEL[m.fsmState]}</span>
            {!m.isActive && <span className="badge badge--neutral">Paused</span>}
          </div>
        </div>
        <div className="price">
          <span className="label">Price</span>
          <strong>{fmtPrice(m.price)}</strong>
        </div>
      </header>

      {!m.ready && <p className="muted small">Warming up history…</p>}

      <dl className="levels">
        <div>
          <dt>Upper</dt>
          <dd>{fmtPrice(m.upper)}</dd>
        </div>
        <div>
          <dt>Middle</dt>
          <dd>{fmtPrice(m.middle)}</dd>
        </div>
        <div>
          <dt>Lower</dt>
          <dd>{fmtPrice(m.lower)}</dd>
        </div>
      </dl>

      {progress !== null && (
        <div className="progress" aria-label="Recovery toward the median">
          <div className="progress__fill" style={{ width: `${progress * 100}%` }} />
          <div className="progress__marker" style={{ left: `${draftPct}%` }} title={`Trigger at ${draftPct}%`} />
        </div>
      )}

      <div className="threshold">
        <div className="threshold__head">
          <label htmlFor={`pct-${m.id}`}>Reversion trigger</label>
          <strong>{draftPct}%</strong>
        </div>
        <input
          id={`pct-${m.id}`}
          type="range"
          min={10}
          max={100}
          step={1}
          value={draftPct}
          disabled={!canAdmin || busy}
          onChange={(e) => setDraftPct(Number(e.target.value))}
          onPointerDown={() => (dragging.current = true)}
          onPointerUp={commitThreshold}
          onKeyUp={commitThreshold}
        />
        <div className="preview">
          <span>
            Bull trigger <strong>{fmtPrice(previewBull)}</strong>
          </span>
          <span>
            Bear trigger <strong>{fmtPrice(previewBear)}</strong>
          </span>
        </div>
        {m.lastTriggeredAt && <p className="muted small">Last fired {fmtTime(m.lastTriggeredAt)}</p>}
      </div>

      {canAdmin && (
        <footer className="actions">
          <button
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => void run(() => api.updateMonitor(m.id, { isActive: !m.isActive }))}
          >
            {m.isActive ? 'Pause' : 'Resume'}
          </button>
          {confirmingDelete ? (
            <button className="btn btn--danger" disabled={busy} onClick={() => void run(() => api.deleteMonitor(m.id))}>
              Confirm delete
            </button>
          ) : (
            <button className="btn btn--ghost" disabled={busy} onClick={() => setConfirmingDelete(true)}>
              Delete
            </button>
          )}
        </footer>
      )}

      {error && <p className="error small">{error}</p>}
    </article>
  );
}

/** Share of the band-touch → median move completed, for the armed side only. */
function recoveryProgress(m: MonitorView): number | null {
  if (m.price === null || m.upper === null || m.middle === null || m.lower === null) return null;
  if (m.fsmState === 'ARMED_LOWER' && m.middle > m.lower) {
    return clamp01((m.price - m.lower) / (m.middle - m.lower));
  }
  if (m.fsmState === 'ARMED_UPPER' && m.upper > m.middle) {
    return clamp01((m.upper - m.price) / (m.upper - m.middle));
  }
  return null;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
