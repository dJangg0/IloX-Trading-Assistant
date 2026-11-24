import { fmtPct, fmtPrice } from './format';
import type { AlertView } from './types';

export interface ToastData {
  id: string;
  title: string;
  body: string;
  tone: 'bull' | 'bear';
}

/** Alerts not seen before. Used so a pop-up appears only for alerts that arrive while the page is open. */
export function findNewAlerts(seen: ReadonlySet<string>, alerts: readonly AlertView[]): AlertView[] {
  return alerts.filter((a) => !seen.has(a.id));
}

export function toToast(a: AlertView): ToastData {
  const bull = a.direction === 'BULL_REVERSION';
  const retraced =
    a.retracedPct === null
      ? ''
      : a.retracedPct >= 1
        ? ' · through the median'
        : ` · ${fmtPct(a.retracedPct)} back to the median`;
  return {
    id: a.id,
    title: `${bull ? '▲ Bullish' : '▼ Bearish'} reversion · ${a.symbol} ${a.timeframe}`,
    body: `@ ${fmtPrice(a.triggerPrice)}${retraced}`,
    tone: bull ? 'bull' : 'bear',
  };
}
