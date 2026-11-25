const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${normalized}`;
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(apiUrl(path), {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    let code = 'request_failed';
    let message = `请求失败 (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error?.code) code = data.error.code;
      if (data?.error?.message) message = data.error.message;
    } catch {
      // keep default error text
    }
    throw new ApiError(res.status, code, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

// --- Core API Types (generated from Go DTOs via `make types`) ---

export type { Meta as BackendModuleMeta } from './generated/module.gen';
export type { AppMeta, HealthResponse } from './generated/app.gen';
export type { User } from './generated/auth.gen';
export type {
  ConfigField as DriverConfigField,
  DriverInfo,
  ChannelView as Channel,
  UpsertChannelInput as UpsertChannelPayload,
  PushEndpointView as PushEndpoint,
  UpsertPushEndpointInput as UpsertPushEndpointPayload,
} from './generated/messenger.gen';

import type { AppMeta } from './generated/app.gen';
import type { User } from './generated/auth.gen';
import type {
  DriverInfo,
  ChannelView as Channel,
  UpsertChannelInput as UpsertChannelPayload,
  PushEndpointView as PushEndpoint,
  UpsertPushEndpointInput as UpsertPushEndpointPayload,
} from './generated/messenger.gen';

export type Capability = 'outbound' | 'inbound';

// --- Core API Calls ---

export const coreApi = {
  getMeta: () => request<AppMeta>('/api/v1/meta'),
  getMe: () => request<{ user: User }>('/api/v1/auth/me'),
  logout: () => request<{ ok: boolean }>('/api/v1/auth/logout', { method: 'POST' }),
  loginUrl: () => apiUrl('/api/v1/auth/login'),

  listDrivers: () => request<{ drivers: DriverInfo[] }>('/api/v1/messenger/drivers'),
  listChannels: (capability?: Capability) => {
    const q = capability ? `?capability=${capability}` : '';
    return request<{ channels: Channel[] }>(`/api/v1/messenger/channels${q}`);
  },
  createChannel: (payload: UpsertChannelPayload) =>
    request<{ channel: Channel }>('/api/v1/messenger/channels', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateChannel: (id: number, payload: UpsertChannelPayload) =>
    request<{ channel: Channel }>(`/api/v1/messenger/channels/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteChannel: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/messenger/channels/${id}`, { method: 'DELETE' }),
  testChannel: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/messenger/channels/${id}/test`, { method: 'POST' }),

  listPushEndpoints: () => request<{ endpoints: PushEndpoint[] }>('/api/v1/messenger/push-endpoints'),
  createPushEndpoint: (payload: UpsertPushEndpointPayload) =>
    request<{ endpoint: PushEndpoint }>('/api/v1/messenger/push-endpoints', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updatePushEndpoint: (id: number, payload: UpsertPushEndpointPayload) =>
    request<{ endpoint: PushEndpoint }>(`/api/v1/messenger/push-endpoints/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  rotatePushEndpoint: (id: number) =>
    request<{ endpoint: PushEndpoint }>(`/api/v1/messenger/push-endpoints/${id}/rotate`, {
      method: 'POST',
    }),
  deletePushEndpoint: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/messenger/push-endpoints/${id}`, { method: 'DELETE' }),
};
