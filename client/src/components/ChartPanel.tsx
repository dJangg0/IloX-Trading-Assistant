import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { api } from '../lib/api';
import { fmtPrice } from '../lib/format';
import { TIMEFRAMES, type ChartResponse, type MonitorView, type Timeframe } from '../lib/types';

const POLL_MS = 3_000;
const CANDLES = 200;

const COLORS = {
  up: '#34d399',
  down: '#f87171',
  band: '#f59e0b',
  mid: '#94a3b8',
  text: '#8b96a8',
  grid: '#162033',
  border: '#1f2a3d',
  panel: '#0c1322',
};

interface Props {
  symbols: string[];
  monitors: MonitorView[];
  symbol: string;
  timeframe: Timeframe;
  onSymbolChange: (s: string) => void;
  onTimeframeChange: (tf: Timeframe) => void;
}

interface SeriesSet {
  candles: ISeriesApi<'Candlestick'>;
  upper: ISeriesApi<'Line'>;
  middle: ISeriesApi<'Line'>;
  lower: ISeriesApi<'Line'>;
  markers: ISeriesMarkersPluginApi<Time>;
  triggerLines: IPriceLine[];
}

export function ChartPanel({ symbols, monitors, symbol, timeframe, onSymbolChange, onTimeframeChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<SeriesSet | null>(null);
  const fittedKey = useRef<string | null>(null);
  const [data, setData] = useState<ChartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [symbolDraft, setSymbolDraft] = useState(symbol);

  useEffect(() => setSymbolDraft(symbol), [symbol]);

  // Create the chart once. autoSize keeps it responsive to the container.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { color: COLORS.panel }, textColor: COLORS.text, fontSize: 12 },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.border },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
      borderVisible: false,
    });
    const line = (color: string, style: LineStyle) =>
      chart.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        lineStyle: style,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });

    seriesRef.current = {
      candles,
      upper: line(COLORS.band, LineStyle.Solid),
      middle: line(COLORS.mid, LineStyle.Dotted),
      lower: line(COLORS.band, LineStyle.Solid),
      markers: createSeriesMarkers(candles, []),
      triggerLines: [],
    };
    chartRef.current = chart;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Poll the chart for the current symbol and timeframe.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);

    const load = async () => {
      try {
        const d = await api.chart(symbol, timeframe, CANDLES);
        if (cancelled) return;
        setData(d);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Chart unavailable');
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbol, timeframe]);

  // Push the response into the chart. Each series is only updated when its data changes.
  useEffect(() => {
    const s = seriesRef.current;
    const chart = chartRef.current;
    if (!s || !chart || !data) return;

    s.candles.setData(
      data.candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    s.upper.setData(data.bands.map((b) => ({ time: b.time as UTCTimestamp, value: b.upper })));
    s.middle.setData(data.bands.map((b) => ({ time: b.time as UTCTimestamp, value: b.middle })));
    s.lower.setData(data.bands.map((b) => ({ time: b.time as UTCTimestamp, value: b.lower })));

    s.markers.setMarkers(
      data.alerts.map(
        (a): SeriesMarker<Time> => ({
          time: a.time as UTCTimestamp,
          position: a.direction === 'BULL_REVERSION' ? 'belowBar' : 'aboveBar',
          shape: a.direction === 'BULL_REVERSION' ? 'arrowUp' : 'arrowDown',
          color: a.direction === 'BULL_REVERSION' ? COLORS.up : COLORS.down,
          text: `${a.direction === 'BULL_REVERSION' ? 'Bull' : 'Bear'} ${fmtPrice(a.price)}`,
        }),
      ),
    );

    for (const line of s.triggerLines) s.candles.removePriceLine(line);
    s.triggerLines = [];
    if (data.triggers?.tBull != null) {
      s.triggerLines.push(
        s.candles.createPriceLine({
          price: data.triggers.tBull,
          color: COLORS.up,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `Bull ${Math.round(data.triggers.reversionPct * 100)}%`,
        }),
      );
    }
    if (data.triggers?.tBear != null) {
      s.triggerLines.push(
        s.candles.createPriceLine({
          price: data.triggers.tBear,
          color: COLORS.down,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `Bear ${Math.round(data.triggers.reversionPct * 100)}%`,
        }),
      );
    }

    // Fit once per symbol and timeframe so polling does not reset the user's zoom.
    const key = `${data.symbol}|${data.timeframe}`;
    if (fittedKey.current !== key) {
      chart.timeScale().fitContent();
      fittedKey.current = key;
    }
  }, [data]);

  const monitor = monitors.find((m) => m.symbol === symbol && m.timeframe === timeframe) ?? null;
  const last = data?.candles.at(-1);
  const price = data?.live.price ?? last?.close ?? null;
  const feed = data?.live.feedStatus ?? 'STALE';

  return (
    <section className="card chart" aria-label="Price chart">
      <div className="chart__toolbar">
        <form
          className="chart__symbol"
          onSubmit={(e) => {
            e.preventDefault();
            const next = symbolDraft.trim().toUpperCase();
            if (next) onSymbolChange(next);
          }}
        >
          <input
            list="chart-symbols"
            value={symbolDraft}
            onChange={(e) => setSymbolDraft(e.target.value)}
            onBlur={() => setSymbolDraft(symbol)}
            aria-label="Symbol"
            maxLength={20}
            autoCapitalize="characters"
          />
          <datalist id="chart-symbols">
            {symbols.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </form>
        <div className="seg" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              className={tf === timeframe ? 'is-on' : ''}
              onClick={() => onTimeframeChange(tf)}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      <div className="chart__head">
        <div>
          <strong className="chart__price">{fmtPrice(price)}</strong>
          <span className={`badge ${feed === 'LIVE' ? 'badge--live' : 'badge--paused'}`}>
            {feed === 'LIVE' ? '● Live' : 'Feed Paused / Market Closed'}
          </span>
          {data?.historyStale && <span className="badge badge--paused">History cached</span>}
        </div>
        <div className="legend small">
          <span className="sw sw--band" /> Bollinger 20, 2σ
          <span className="sw sw--mid" /> Middle
          {monitor ? (
            <span className="muted">
              · {monitor.fsmState === 'NEUTRAL' ? 'Neutral' : monitor.fsmState === 'ARMED_LOWER' ? 'Armed below' : 'Armed above'}
            </span>
          ) : (
            <span className="muted">· no monitor for this timeframe (add one below for triggers and alerts)</span>
          )}
        </div>
      </div>

      <div className="chart__canvas" ref={hostRef} />

      {error && <p className="error small">{error}</p>}
      {!data && !error && <p className="muted small">Loading {symbol} {timeframe}…</p>}
    </section>
  );
}
