import { Lunar, Solar } from 'lunar-typescript';
import { request } from '@/core/api';

export type CalendarType = 'solar' | 'lunar';
export type RepeatType = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'interval_days' | 'cron';

export interface RepeatConfig {
  anchor_year?: number;
  anchor_month?: number;
  anchor_day?: number;
  anchor_is_leap?: boolean;
  anchor_hour?: number;
  anchor_minute?: number;
  weekdays?: number[];
  interval?: number;
  cron_expr?: string;
}

export interface RemindOffset {
  unit: 'minute' | 'hour' | 'day';
  value: number;
}

export interface LunarTargetInput {
  year: number;
  month: number;
  day: number;
  is_leap: boolean;
  hour: number;
  minute: number;
}

export interface PlannerItem {
  id: number;
  title: string;
  note: string;
  status: 'pending' | 'done';
  target_at?: string;
  target_local?: string;
  lunar_label?: string;
  timezone: string;
  calendar_type: CalendarType;
  repeat_type: RepeatType;
  repeat_config: RepeatConfig;
  auto_advance: boolean;
  remind_offsets: RemindOffset[];
  channel_ids: number[];
  next_trigger_at?: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertPlannerItemPayload {
  title: string;
  note?: string;
  target_local?: string;
  lunar_target?: LunarTargetInput;
  timezone?: string;
  calendar_type?: CalendarType;
  repeat_type?: RepeatType;
  repeat_config?: RepeatConfig;
  auto_advance?: boolean;
  remind_offsets?: RemindOffset[];
  channel_ids?: number[];
}

export interface CalendarEvent {
  id: string;
  item_id: number;
  title: string;
  note: string;
  status: 'pending' | 'done';
  start: string;
  calendar_type: CalendarType;
  lunar_label: string;
  repeat_type: RepeatType;
  has_reminder: boolean;
}

export interface PlannerLog {
  id: number;
  item_id?: number;
  item_title: string;
  trigger_key: string;
  trigger_label: string;
  status: 'ok' | 'failed';
  error?: string;
  sent_at: string;
}

export const plannerApi = {
  listItems: () => request<{ items: PlannerItem[] }>('/api/v1/planner/items'),
  createItem: (payload: UpsertPlannerItemPayload) =>
    request<{ item: PlannerItem }>('/api/v1/planner/items', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateItem: (id: number, payload: UpsertPlannerItemPayload) =>
    request<{ item: PlannerItem }>(`/api/v1/planner/items/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteItem: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/planner/items/${id}`, { method: 'DELETE' }),
  completeItem: (id: number) =>
    request<{ item: PlannerItem }>(`/api/v1/planner/items/${id}/complete`, { method: 'POST' }),
  reopenItem: (id: number) =>
    request<{ item: PlannerItem }>(`/api/v1/planner/items/${id}/reopen`, { method: 'POST' }),
  testItem: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/planner/items/${id}/test`, { method: 'POST' }),
  listCalendar: (startISO: string, endISO: string) =>
    request<{ events: CalendarEvent[] }>(
      `/api/v1/planner/calendar?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`,
    ),
  listLogs: () => request<{ logs: PlannerLog[] }>('/api/v1/planner/logs'),
};

export function formatOffsetLabel(o: RemindOffset): string {
  if (o.value <= 0) return '准点';
  if (o.unit === 'day') return `提前 ${o.value} 天`;
  if (o.unit === 'hour') return `提前 ${o.value} 小时`;
  return `提前 ${o.value} 分钟`;
}

export function formatRepeatLabel(type: RepeatType, cfg: RepeatConfig): string {
  switch (type) {
    case 'daily':
      return '每天';
    case 'weekly':
      return '每周';
    case 'monthly':
      return '每月';
    case 'yearly':
      return '每年';
    case 'interval_days':
      return `每 ${cfg.interval || 1} 天`;
    case 'cron':
      return `Cron: ${cfg.cron_expr || ''}`;
    default:
      return '';
  }
}

export function getLunarDayBadge(date: Date): { text: string; highlight: boolean } {
  try {
    const solar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
    const lunar = solar.getLunar();
    const jieQi = lunar.getJieQi();
    if (jieQi) {
      return { text: jieQi, highlight: true };
    }
    if (lunar.getDay() === 1) {
      return { text: `${lunar.getMonthInChinese()}月`, highlight: true };
    }
    return { text: lunar.getDayInChinese(), highlight: false };
  } catch {
    return { text: '', highlight: false };
  }
}

export function previewLunarToSolar(year: number, month: number, day: number, isLeap: boolean): string {
  try {
    const signedMonth = isLeap ? -month : month;
    const l = Lunar.fromYmd(year, signedMonth, day);
    const s = l.getSolar();
    return `${s.getYear()}-${String(s.getMonth()).padStart(2, '0')}-${String(s.getDay()).padStart(2, '0')}`;
  } catch {
    return '该农历日期在当年不存在（保存时将自动夹逼/回退）';
  }
}
