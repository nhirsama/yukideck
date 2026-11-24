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

// --- Core API Types ---

export interface BackendModuleMeta {
  id: string;
  name: string;
  description: string;
  api_prefix: string;
}

export interface AppMeta {
  app: string;
  version: string;
  ui_enabled: boolean;
  modules: BackendModuleMeta[];
}

export interface User {
  id: number;
  username: string;
  email: string;
  avatar_url: string;
}

export type Capability = 'outbound' | 'inbound';

export interface DriverConfigField {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
  required: boolean;
}

export interface DriverInfo {
  type: string;
  display_name: string;
  description: string;
  capabilities: Capability[];
  fields: DriverConfigField[];
}

export interface Channel {
  id: number;
  type: string;
  name: string;
  capabilities: Capability[];
  enable_outbound: boolean;
  enable_inbound: boolean;
  is_default_outbound: boolean;
  enabled: boolean;
  config: Record<string, unknown>;
  webhook_url?: string;
  webhook_warning?: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertChannelPayload {
  type: string;
  name: string;
  enable_outbound: boolean;
  enable_inbound: boolean;
  is_default_outbound: boolean;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface PushEndpoint {
  id: number;
  name: string;
  push_url: string;
  target_mode: 'default' | 'selected';
  target_channel_ids: number[];
  enabled: boolean;
  last_called_at?: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertPushEndpointPayload {
  name: string;
  target_mode: 'default' | 'selected';
  target_channel_ids: number[];
  enabled: boolean;
}

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
