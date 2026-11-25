import { Lunar, Solar } from 'lunar-typescript';
import { request } from '@/core/api';
import type {
  CalendarEventView,
  ItemView,
  LogRecord,
  RemindOffset,
  RepeatConfig,
  UpsertItemInput,
} from './api.gen';

export type CalendarType = ItemView['calendar_type'];
export type RepeatType = ItemView['repeat_type'];
export type {
  RepeatConfig,
  RemindOffset,
  LunarDateInput as LunarTargetInput,
  ItemView as PlannerItem,
  UpsertItemInput as UpsertPlannerItemPayload,
  CalendarEventView as CalendarEvent,
  LogRecord as PlannerLog,
} from './api.gen';

export const plannerApi = {
  listItems: () => request<{ items: ItemView[] }>('/api/v1/planner/items'),
  createItem: (payload: UpsertItemInput) =>
    request<{ item: ItemView }>('/api/v1/planner/items', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateItem: (id: number, payload: UpsertItemInput) =>
    request<{ item: ItemView }>(`/api/v1/planner/items/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteItem: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/planner/items/${id}`, { method: 'DELETE' }),
  completeItem: (id: number) =>
    request<{ item: ItemView }>(`/api/v1/planner/items/${id}/complete`, { method: 'POST' }),
  reopenItem: (id: number) =>
    request<{ item: ItemView }>(`/api/v1/planner/items/${id}/reopen`, { method: 'POST' }),
  testItem: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/planner/items/${id}/test`, { method: 'POST' }),
  listCalendar: (startISO: string, endISO: string) =>
    request<{ events: CalendarEventView[] }>(
      `/api/v1/planner/calendar?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`,
    ),
  listLogs: () => request<{ logs: LogRecord[] }>('/api/v1/planner/logs'),
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
