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

export function isUnauthenticatedError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export interface ApiRequestInit extends RequestInit {
  /**
   * Skip triggering the global login modal on HTTP 401 (used only by the /api/v1/auth/me probe).
   */
  silentAuth?: boolean;
  /** Force opening the login modal on HTTP 401 even for GET/HEAD requests while browsing as guest. */
  promptLogin?: boolean;
}

export interface ApiAuthBridge {
  isAuthenticated: () => boolean;
  onUnauthorized: (ctx: { path: string; method: string; expired: boolean }) => void;
}

let authBridge: ApiAuthBridge | null = null;

/**
 * Registers the global auth bridge used by the unified API gateway.
 * Called by AuthProvider so every core & module API shares one post-flight HTTP 401 pipeline,
 * while keeping the backend router as the single source of truth for route auth rules.
 */
export function configureApiAuthBridge(bridge: ApiAuthBridge | null): void {
  authBridge = bridge;
}

function sanitizeLoginNext(next?: string): string {
  if (!next) return '';
  const trimmed = next.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return '';
  if (trimmed === '/' || trimmed === '/login' || trimmed.startsWith('/login?')) return '';
  return trimmed;
}

/**
 * Canonical single entry point for all YukiDeck backend API calls.
 */
export async function request<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const { silentAuth = false, promptLogin, ...fetchInit } = init ?? {};
  const method = (fetchInit.method ?? 'GET').toUpperCase();
  const isInteractive = promptLogin ?? (method !== 'GET' && method !== 'HEAD');

  const headers = new Headers(fetchInit.headers);
  if (fetchInit.body && !(fetchInit.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(apiUrl(path), {
    ...fetchInit,
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

    if (res.status === 401 && !silentAuth && authBridge) {
      const wasAuthenticated = authBridge.isAuthenticated();
      if (wasAuthenticated || isInteractive) {
        authBridge.onUnauthorized({ path, method, expired: wasAuthenticated });
      }
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
export type {
  User,
  ResourceOption,
  PermissionDef,
  PermissionSchemaItem,
  PolicyRule,
  APIKeyView as APIKey,
  CreateAPIKeyResponse,
  UpsertAPIKeyInput as UpsertAPIKeyPayload,
} from './generated/auth.gen';
export type {
  ConfigField as DriverConfigField,
  DriverInfo,
  ChannelView as Channel,
  UpsertChannelInput as UpsertChannelPayload,
  PushEndpointView as PushEndpoint,
  UpsertPushEndpointInput as UpsertPushEndpointPayload,
} from './generated/messenger.gen';

import type { AppMeta } from './generated/app.gen';
import type {
  User,
  PermissionSchemaItem,
  APIKeyView as APIKey,
  CreateAPIKeyResponse,
  UpsertAPIKeyInput as UpsertAPIKeyPayload,
} from './generated/auth.gen';
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
  getMe: () => request<{ user: User }>('/api/v1/auth/me', { silentAuth: true }),
  logout: () => request<{ ok: boolean }>('/api/v1/auth/logout', { method: 'POST', silentAuth: true }),
  loginUrl: (next?: string) => {
    const safeNext = sanitizeLoginNext(next);
    const qs = safeNext ? `?next=${encodeURIComponent(safeNext)}` : '';
    return apiUrl(`/api/v1/auth/login${qs}`);
  },

  // Global Scoped API Keys
  getAPIKeySchema: () => request<{ permissions: PermissionSchemaItem[] }>('/api/v1/auth/api-keys/schema'),
  listAPIKeys: () => request<{ api_keys: APIKey[] }>('/api/v1/auth/api-keys'),
  createAPIKey: (payload: UpsertAPIKeyPayload) =>
    request<CreateAPIKeyResponse>('/api/v1/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateAPIKey: (id: number, payload: UpsertAPIKeyPayload) =>
    request<{ api_key: APIKey }>(`/api/v1/auth/api-keys/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  rotateAPIKey: (id: number) =>
    request<CreateAPIKeyResponse>(`/api/v1/auth/api-keys/${id}/rotate`, {
      method: 'POST',
    }),
  deleteAPIKey: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/auth/api-keys/${id}`, { method: 'DELETE' }),

  // Core Messenger Infrastructure
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
  deletePushEndpoint: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/messenger/push-endpoints/${id}`, { method: 'DELETE' }),
};
