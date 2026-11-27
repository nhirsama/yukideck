import { Lunar, LunarYear, Solar } from 'lunar-typescript';
import { request } from '@/core/api';
import type {
  CalendarEventView,
  ItemView,
  LogRecord,
  OverdueConfig,
  PauseItemInput,
  RemindOffset,
  RepeatConfig,
  UpsertItemInput,
} from './api.gen';

export type CalendarType = ItemView['calendar_type'];
export type RepeatType = ItemView['repeat_type'];
export type LogStatus = LogRecord['status'];
export type {
  RepeatConfig,
  RemindOffset,
  OverdueConfig,
  RetryState,
  PauseItemInput,
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
  finishItem: (id: number) =>
    request<{ item: ItemView }>(`/api/v1/planner/items/${id}/finish`, { method: 'POST' }),
  advanceItemToCurrent: (id: number) =>
    request<{ item: ItemView }>(`/api/v1/planner/items/${id}/advance-current`, {
      method: 'POST',
    }),
  reopenItem: (id: number) =>
    request<{ item: ItemView }>(`/api/v1/planner/items/${id}/reopen`, { method: 'POST' }),
  pauseItem: (id: number, payload: PauseItemInput) =>
    request<{ item: ItemView }>(`/api/v1/planner/items/${id}/pause`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  resumeItem: (id: number) =>
    request<{ item: ItemView }>(`/api/v1/planner/items/${id}/resume`, { method: 'POST' }),
  testItem: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/planner/items/${id}/test`, { method: 'POST' }),
  listCalendar: (startISO: string, endISO: string) =>
    request<{ events: CalendarEventView[] }>(
      `/api/v1/planner/calendar?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`,
    ),
  listLogs: (status?: string) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return request<{ logs: LogRecord[] }>(`/api/v1/planner/logs${qs}`);
  },
};

export const COMMON_TIMEZONES: Array<{ value: string; label: string }> = [
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai (北京 / 上海 UTC+8)' },
  { value: 'Asia/Hong_Kong', label: 'Asia/Hong_Kong (香港 UTC+8)' },
  { value: 'Asia/Taipei', label: 'Asia/Taipei (台北 UTC+8)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore (新加坡 UTC+8)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (东京 UTC+9)' },
  { value: 'Asia/Seoul', label: 'Asia/Seoul (首尔 UTC+9)' },
  { value: 'Asia/Bangkok', label: 'Asia/Bangkok (曼谷 UTC+7)' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai (迪拜 UTC+4)' },
  { value: 'Europe/London', label: 'Europe/London (伦敦 UTC+0/+1)' },
  { value: 'Europe/Paris', label: 'Europe/Paris (巴黎 UTC+1/+2)' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin (柏林 UTC+1/+2)' },
  { value: 'America/New_York', label: 'America/New_York (纽约 UTC-5/-4)' },
  { value: 'America/Chicago', label: 'America/Chicago (芝加哥 UTC-6/-5)' },
  { value: 'America/Denver', label: 'America/Denver (丹佛 UTC-7/-6)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (洛杉矶 UTC-8/-7)' },
  { value: 'America/Vancouver', label: 'America/Vancouver (温哥华 UTC-8/-7)' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney (悉尼 UTC+10/+11)' },
  { value: 'Pacific/Auckland', label: 'Pacific/Auckland (奥克兰 UTC+12/+13)' },
  { value: 'UTC', label: 'UTC (协调世界时 UTC+0)' },
];

export function formatTimezoneOptionLabel(tz: string): string {
  const preset = COMMON_TIMEZONES.find((z) => z.value === tz);
  if (preset) return preset.label;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    const rawOffset = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const utcOffset = rawOffset.replace(/^GMT/, 'UTC') || 'UTC+0';
    return `${tz} (${utcOffset === 'UTC' ? 'UTC+0' : utcOffset})`;
  } catch {
    return tz;
  }
}

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

export function formatOverdueConfigLabel(cfg?: OverdueConfig): string {
  if (!cfg?.enabled) return '';
  const unit = cfg.interval_unit === 'hour' ? '小时' : '天';
  const val = cfg.interval_value || 1;
  const max = cfg.max_count || 3;
  return `逾期每 ${val} ${unit}催办 · 上限 ${max} 次`;
}

export function isItemOverdue(item: ItemView, nowMs = Date.now()): boolean {
  if (item.status !== 'pending' || !item.target_at) return false;
  return new Date(item.target_at).getTime() < nowMs;
}

export function formatOverdueElapsed(targetIso: string, nowMs = Date.now()): string {
  const diffMs = nowMs - new Date(targetIso).getTime();
  if (diffMs < 60_000) return '刚逾期';
  const totalMins = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMins / (24 * 60));
  const hours = Math.floor((totalMins % (24 * 60)) / 60);
  const mins = totalMins % 60;
  if (days > 0) {
    return hours > 0 ? `已逾期 ${days} 天 ${hours} 小时` : `已逾期 ${days} 天`;
  }
  if (hours > 0) {
    return mins > 0 ? `已逾期 ${hours} 小时 ${mins} 分钟` : `已逾期 ${hours} 小时`;
  }
  return `已逾期 ${mins} 分钟`;
}

export function estimateMinCycleHours(
  repeatType: RepeatType,
  calendarType: CalendarType,
  repeatConfig: RepeatConfig,
): number | null {
  switch (repeatType) {
    case 'none':
      return null;
    case 'daily':
      return 24;
    case 'interval_days':
      return Math.max(1, repeatConfig.interval || 1) * 24;
    case 'weekly': {
      const days = Array.from(
        new Set((repeatConfig.weekdays ?? []).filter((d) => d >= 0 && d <= 6)),
      ).sort((a, b) => a - b);
      if (days.length <= 1) return 7 * 24;
      let minGap = 7;
      for (let i = 0; i < days.length; i++) {
        const gap = i + 1 < days.length ? days[i + 1] - days[i] : 7 - days[i] + days[0];
        if (gap > 0 && gap < minGap) minGap = gap;
      }
      return minGap * 24;
    }
    case 'monthly':
      return (calendarType === 'lunar' ? 29 : 28) * 24;
    case 'yearly':
      return (calendarType === 'lunar' ? 353 : 365) * 24;
    case 'cron':
      return null;
    default:
      return null;
  }
}

export function formatHoursHuman(hours: number): string {
  if (hours % 24 === 0) return `${hours / 24} 天`;
  if (hours > 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
  return `${hours} 小时`;
}

export function formatLogReason(reason?: string): string {
  switch (reason) {
    case 'partial_channel_failure':
      return '部分渠道失败（已送达可用渠道）';
    case 'retry_scheduled':
      return '发送失败，已安排自动重试';
    case 'retry_exhausted':
      return '已达最大重试次数（3 次），停止重试';
    case 'no_channel':
      return '未配置可用的出站推送渠道';
    case 'missed_grace_window':
      return '超过 15 分钟容错窗口，已跳过补发';
    case 'paused':
      return '事项暂停期间跳过，不补发';
    case 'overdue_limit_reached':
      return '逾期催办已达上限，停止继续催办';
    case 'cycle_superseded':
      return '已被下一周期替代，放弃旧周期重试';
    default:
      return '';
  }
}

export function buildUpsertPayloadFromItem(
  item: ItemView,
  overrides: Partial<UpsertItemInput> = {},
): UpsertItemInput {
  const base: UpsertItemInput = {
    title: item.title,
    note: item.note,
    timezone: item.timezone,
    calendar_type: item.calendar_type,
    repeat_type: item.repeat_type,
    repeat_config: item.repeat_config,
    auto_advance: item.auto_advance,
    remind_offsets: item.remind_offsets,
    overdue_config: item.overdue_config,
    channel_ids: item.channel_ids,
  };

  if (item.target_at && item.repeat_type !== 'cron') {
    if (item.calendar_type === 'lunar') {
      if (item.target_local) {
        const cur = solarLocalToLunarParts(item.target_local);
        if (cur) {
          const curMonthDays = getLunarMonthDayCount(cur.year, cur.signedMonth);
          const preserveDay30 =
            item.repeat_config.anchor_day === 30 && cur.day === curMonthDays && curMonthDays === 29;
          const [hh, mm] = cur.time.split(':').map((n) => Number(n) || 0);
          base.lunar_target = {
            year: cur.year,
            month: Math.abs(cur.signedMonth),
            day: preserveDay30 ? 30 : cur.day,
            is_leap: cur.signedMonth < 0,
            hour: hh,
            minute: mm,
          };
        }
      } else if (
        item.repeat_config.anchor_year &&
        item.repeat_config.anchor_month &&
        item.repeat_config.anchor_day
      ) {
        base.lunar_target = {
          year: item.repeat_config.anchor_year,
          month: item.repeat_config.anchor_month,
          day: item.repeat_config.anchor_day,
          is_leap: Boolean(item.repeat_config.anchor_is_leap),
          hour: item.repeat_config.anchor_hour ?? 9,
          minute: item.repeat_config.anchor_minute ?? 0,
        };
      }
    } else if (item.target_local) {
      base.target_local = item.target_local;
    }
  }

  return { ...base, ...overrides };
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

const HEAVENLY_STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const EARTHLY_BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const CHINESE_ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

const LUNAR_MONTH_NAMES = [
  '正',
  '二',
  '三',
  '四',
  '五',
  '六',
  '七',
  '八',
  '九',
  '十',
  '冬',
  '腊',
];

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export interface LunarMonthOption {
  value: string;
  label: string;
  description: string;
  signedMonth: number; // 1..12 for normal month, -1..-12 for leap month
  month: number;
  isLeap: boolean;
  dayCount: number;
}

export interface LunarParts {
  year: number;
  signedMonth: number;
  day: number;
  time: string; // HH:MM
}

export function formatLunarYearLabel(year: number): string {
  const safeYear = Math.min(2099, Math.max(1901, Math.floor(year || new Date().getFullYear())));
  const ganZhi = HEAVENLY_STEMS[(safeYear - 4) % 10] + EARTHLY_BRANCHES[(safeYear - 4) % 12];
  const zodiac = CHINESE_ZODIAC[(safeYear - 4) % 12];
  return `${safeYear} ${ganZhi}${zodiac}年`;
}

export function getLunarMonthOptions(year: number): LunarMonthOption[] {
  const safeYear = Math.min(2099, Math.max(1901, Math.floor(year || new Date().getFullYear())));
  try {
    const months = LunarYear.fromYear(safeYear).getMonthsInYear();
    return months.map((m) => {
      const signed = m.getMonth();
      const absMonth = Math.abs(signed);
      const isLeap = m.isLeap();
      const dayCount = m.getDayCount();
      const baseName = LUNAR_MONTH_NAMES[absMonth - 1] ?? String(absMonth);
      return {
        value: String(signed),
        label: `${isLeap ? '闰' : ''}${baseName}月`,
        description: `${dayCount === 30 ? '大月' : '小月'} · ${dayCount}天`,
        signedMonth: signed,
        month: absMonth,
        isLeap,
        dayCount,
      };
    });
  } catch {
    return LUNAR_MONTH_NAMES.map((name, idx) => ({
      value: String(idx + 1),
      label: `${name}月`,
      description: '30天',
      signedMonth: idx + 1,
      month: idx + 1,
      isLeap: false,
      dayCount: 30,
    }));
  }
}

export function getLunarMonthDayCount(year: number, signedMonth: number): number {
  const opts = getLunarMonthOptions(year);
  return opts.find((o) => o.signedMonth === signedMonth)?.dayCount ?? 30;
}

export function solarLocalToLunarParts(localStr: string): LunarParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(localStr.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const hh = match[4] ?? '09';
  const mm = match[5] ?? '00';
  try {
    const lunar = Solar.fromYmd(y, m, d).getLunar();
    const ly = Math.min(2099, Math.max(1901, lunar.getYear()));
    return {
      year: ly,
      signedMonth: lunar.getMonth(),
      day: lunar.getDay(),
      time: `${hh}:${mm}`,
    };
  } catch {
    return null;
  }
}

export function lunarPartsToSolarLocal(
  year: number,
  signedMonth: number,
  day: number,
  time: string,
): string | null {
  try {
    const l = Lunar.fromYmd(year, signedMonth, day);
    const s = l.getSolar();
    const [rawH, rawM] = time.split(':');
    const hh = String(Number(rawH) || 0).padStart(2, '0');
    const mm = String(Number(rawM) || 0).padStart(2, '0');
    return `${s.getYear()}-${String(s.getMonth()).padStart(2, '0')}-${String(s.getDay()).padStart(2, '0')}T${hh}:${mm}`;
  } catch {
    return null;
  }
}

export function previewLunarToSolar(year: number, month: number, day: number, isLeap: boolean): string {
  try {
    const signedMonth = isLeap ? -month : month;
    const l = Lunar.fromYmd(year, signedMonth, day);
    const s = l.getSolar();
    const wd = WEEKDAY_ZH[s.getWeek()] ?? '';
    const dateStr = `${s.getYear()}-${String(s.getMonth()).padStart(2, '0')}-${String(s.getDay()).padStart(2, '0')}`;
    return wd ? `${dateStr}（${wd}）` : dateStr;
  } catch {
    return '该农历日期无效';
  }
}
