import { fmtPct, fmtPrice, fmtTime } from '../lib/format';
import type { AlertView } from '../lib/types';

export function AlertHistory({ alerts }: { alerts: AlertView[] }) {
  if (alerts.length === 0) {
    return (
      <section className="card">
        <h2>Alert history</h2>
        <p className="muted small">No alerts yet. A reversion fires once per outer-band touch cycle.</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Alert history</h2>
      <ul className="alerts">
        {alerts.map((a) => {
          const bull = a.direction === 'BULL_REVERSION';
          return (
            <li key={a.id} className="alert">
              <span className={`dir ${bull ? 'dir--bull' : 'dir--bear'}`}>{bull ? '▲ Bull' : '▼ Bear'}</span>
              <div className="alert__body">
                <strong>
                  {a.symbol} <span className="chip">{a.timeframe}</span>
                </strong>
                <span className="muted small">
                  @ {fmtPrice(a.triggerPrice)} · retraced {fmtPct(a.retracedPct, 0)} (trigger {fmtPct(a.reversionPct, 0)})
                </span>
              </div>
              <time className="muted small" dateTime={a.createdAt}>
                {fmtTime(a.createdAt)}
              </time>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
