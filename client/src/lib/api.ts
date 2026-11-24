import type { AlertView, ChartResponse, DispatchResult, Health, MonitorView, Timeframe } from './types';

const ADMIN_TOKEN_KEY = 'bandalert.adminToken';

/** Admin token is stored in localStorage on first login (handoff §6.2). */
export const adminToken = {
  get(): string | null {
    try {
      return localStorage.getItem(ADMIN_TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    localStorage.setItem(ADMIN_TOKEN_KEY, token.trim());
  },
  clear(): void {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  },
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  admin?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.admin) {
    const token = adminToken.get();
    if (!token) throw new ApiError(401, 'Enter the admin token first');
    headers['X-Admin-Token'] = token;
  }

  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as { error?: string }).error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const api = {
  health: () => request<Health>('/api/health'),
  vapidPublicKey: () => request<{ publicKey: string }>('/api/vapid-public-key'),
  monitors: () => request<MonitorView[]>('/api/monitors'),
  alerts: (limit = 50) => request<AlertView[]>(`/api/alerts?limit=${limit}`),
  chart: (symbol: string, timeframe: Timeframe, limit = 200) =>
    request<ChartResponse>(`/api/chart?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}`),

  subscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ subscribed: boolean }>('/api/subscriptions', { method: 'POST', body: sub }),
  unsubscribe: (endpoint: string) =>
    request<{ removed: boolean }>('/api/subscriptions', { method: 'DELETE', body: { endpoint } }),

  createMonitor: (input: { symbol: string; timeframe: Timeframe; reversionPct?: number }) =>
    request<MonitorView>('/api/monitors', { method: 'POST', body: input, admin: true }),
  updateMonitor: (id: string, patch: { reversionPct?: number; isActive?: boolean }) =>
    request<MonitorView>(`/api/monitors/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, admin: true }),
  deleteMonitor: (id: string) =>
    request<void>(`/api/monitors/${encodeURIComponent(id)}`, { method: 'DELETE', admin: true }),
  sendTest: () => request<DispatchResult>('/api/notifications/test', { method: 'POST', admin: true }),
};
