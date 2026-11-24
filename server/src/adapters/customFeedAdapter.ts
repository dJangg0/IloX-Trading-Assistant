import type { Candle, IMarketFeedAdapter, MarketTick, Timeframe } from '../types/market.js';

/**
 * Slot for your real market-data provider (handoff §2.3 / Phase 3). Select it with FEED_ADAPTER=custom.
 *
 * Wire your provider's REST history and WebSocket ticks into the four methods below. Normalise
 * everything to the `Candle` and `MarketTick` shapes in ../types/market.ts. Call the handler
 * passed to `onReconnect` after every socket reconnect so the engine re-syncs history.
 *
 * Until implemented, every method throws, so warm-up retries and the server logs the reason.
 */
export class CustomFeedAdapter implements IMarketFeedAdapter {
  private reconnectHandler: (() => Promise<void>) | null = null;

  async fetchHistoricalCandles(_symbol: string, _timeframe: Timeframe, _limit: number): Promise<Candle[]> {
    throw new Error('CustomFeedAdapter.fetchHistoricalCandles is not implemented');
  }

  async subscribe(_symbols: string[], _onTick: (tick: MarketTick) => void): Promise<void> {
    throw new Error('CustomFeedAdapter.subscribe is not implemented');
  }

  async updateSubscriptions(_symbols: string[]): Promise<void> {
    throw new Error('CustomFeedAdapter.updateSubscriptions is not implemented');
  }

  async disconnect(): Promise<void> {
    this.reconnectHandler = null;
  }

  onReconnect(handler: () => Promise<void>): void {
    this.reconnectHandler = handler;
  }

  /** Call from your socket's `open`/`reconnected` handler. */
  protected async notifyReconnected(): Promise<void> {
    await this.reconnectHandler?.();
  }
}
