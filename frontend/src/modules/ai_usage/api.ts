import { request } from '@/core/api';
import type {
  Device,
  HeatmapResponse,
  ModelAlias,
  ModelPrice,
  PricesResponse,
  SessionDetailResponse,
  SessionsResponse,
  SummaryResponse,
  ToolsResponse,
  TrendsResponse,
  UpdateDeviceInput,
  UpsertModelAliasInput,
  UpsertModelPriceInput,
} from './api.gen';

export type * from './api.gen';

export interface UsageQueryParams {
  start?: string;
  end?: string;
  tz?: string;
  agent?: string;
  model?: string;
  device_id?: string;
  project?: string;
  include_hidden?: boolean;
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === false) continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const aiUsageApi = {
  summary: (params: UsageQueryParams) =>
    request<SummaryResponse>(`/api/v1/ai-usage/summary${buildQuery({ ...params })}`),

  trends: (params: UsageQueryParams & { granularity?: string; group_by?: string }) =>
    request<TrendsResponse>(`/api/v1/ai-usage/trends${buildQuery({ ...params })}`),

  heatmap: (params: UsageQueryParams) =>
    request<HeatmapResponse>(`/api/v1/ai-usage/heatmap${buildQuery({ ...params })}`),

  sessions: (params: UsageQueryParams & { page?: number; page_size?: number }) =>
    request<SessionsResponse>(`/api/v1/ai-usage/sessions${buildQuery({ ...params })}`),

  sessionDetail: (sessionId: string, deviceId?: string) =>
    request<SessionDetailResponse>(
      `/api/v1/ai-usage/sessions/${encodeURIComponent(sessionId)}${buildQuery({ device_id: deviceId })}`,
    ),

  tools: (params: UsageQueryParams) =>
    request<ToolsResponse>(`/api/v1/ai-usage/tools${buildQuery({ ...params })}`),

  listDevices: () => request<{ devices: Device[] }>('/api/v1/ai-usage/devices'),
  updateDevice: (deviceId: string, input: UpdateDeviceInput) =>
    request<{ device: Device }>(`/api/v1/ai-usage/devices/${encodeURIComponent(deviceId)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteDevice: (deviceId: string) =>
    request<{ ok: boolean }>(`/api/v1/ai-usage/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
    }),

  listAliases: () => request<{ aliases: ModelAlias[] }>('/api/v1/ai-usage/aliases'),
  upsertAlias: (input: UpsertModelAliasInput) =>
    request<{ alias: ModelAlias }>('/api/v1/ai-usage/aliases', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteAlias: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/ai-usage/aliases/${id}`, { method: 'DELETE' }),

  listPrices: () => request<PricesResponse>('/api/v1/ai-usage/prices'),
  upsertPrice: (input: UpsertModelPriceInput) =>
    request<{ price: ModelPrice }>('/api/v1/ai-usage/prices', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deletePrice: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/ai-usage/prices/${id}`, { method: 'DELETE' }),
};
