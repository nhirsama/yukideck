import { request } from '@/core/api';
import type {
  BestDayView,
  BreakdownItem,
  BreakdownsResponse,
  ConfigView,
  HeatmapDay,
  HeatmapResponse,
  HistoryImportStatus,
  HourOfDayItem,
  HourlyResponse,
  SummaryResponse,
  SyncResponse,
  TestConfigInput,
  TestConfigResponse,
  TimelineBlock,
  TimelineResponse,
  TrendPoint,
  TrendsResponse,
  UpdateConfigInput,
} from './api.gen';

export type {
  BestDayView,
  BreakdownItem,
  BreakdownsResponse,
  ConfigView as ScreenTimeConfig,
  HeatmapDay,
  HeatmapResponse,
  HistoryImportStatus,
  HourOfDayItem,
  HourlyResponse,
  SummaryResponse,
  SyncResponse,
  TestConfigInput,
  TestConfigResponse,
  TimelineBlock,
  TimelineResponse,
  TrendPoint,
  TrendsResponse,
  UpdateConfigInput,
};

export type TrendGranularity = TrendsResponse['granularity'];
export type TrendGroupBy = TrendsResponse['group_by'];

export interface RangeQuery {
  start?: string;
  end?: string;
  tz?: string;
}

export interface TrendsQuery extends RangeQuery {
  granularity?: TrendGranularity;
  group_by?: TrendGroupBy;
  top_n?: number;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') {
      qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const screenTimeApi = {
  summary: (q: RangeQuery = {}) =>
    request<SummaryResponse>(`/api/v1/screen-time/summary${buildQuery({ ...q })}`),

  trends: (q: TrendsQuery = {}) =>
    request<TrendsResponse>(`/api/v1/screen-time/trends${buildQuery({ ...q })}`),

  heatmap: (params: { year?: number; tz?: string } = {}) =>
    request<HeatmapResponse>(
      `/api/v1/screen-time/heatmap${buildQuery({
        year: params.year && params.year > 0 ? params.year : undefined,
        tz: params.tz,
      })}`,
    ),

  breakdowns: (q: RangeQuery & { limit?: number } = {}) =>
    request<BreakdownsResponse>(`/api/v1/screen-time/breakdowns${buildQuery({ ...q })}`),

  hourly: (q: RangeQuery = {}) =>
    request<HourlyResponse>(`/api/v1/screen-time/hourly${buildQuery({ ...q })}`),

  timeline: (params: { date?: string; tz?: string } = {}) =>
    request<TimelineResponse>(`/api/v1/screen-time/timeline${buildQuery({ ...params })}`),

  syncOnVisit: () =>
    request<SyncResponse>('/api/v1/screen-time/sync', {
      method: 'POST',
      silentAuth: true,
    }),

  getConfig: () => request<{ config: ConfigView }>('/api/v1/screen-time/config'),

  updateConfig: (payload: UpdateConfigInput) =>
    request<{ config: ConfigView }>('/api/v1/screen-time/config', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  testConfig: (payload: TestConfigInput) =>
    request<TestConfigResponse>('/api/v1/screen-time/config/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getHistoryImportStatus: () =>
    request<HistoryImportStatus>('/api/v1/screen-time/history-import'),

  startHistoryImport: () =>
    request<HistoryImportStatus>('/api/v1/screen-time/history-import', {
      method: 'POST',
    }),
};
