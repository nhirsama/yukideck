import { useAuth } from './auth';

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

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

export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

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

// Module-level snapshot synced by AuthProvider so non-React helpers (e.g. API default query builders)
// always stay consistent with the user's configured global timezone.
let activeUserTimezone: string | null = null;

export function setActiveUserTimezone(tz: string | null | undefined): void {
  const trimmed = tz?.trim();
  activeUserTimezone = trimmed ? trimmed : null;
}

export function getActiveUserTimezone(): string {
  return activeUserTimezone || detectBrowserTimezone() || DEFAULT_TIMEZONE;
}

export function useUserTimezone(): string {
  const { user } = useAuth();
  const configured = user?.timezone?.trim();
  return configured || detectBrowserTimezone() || DEFAULT_TIMEZONE;
}

/**
 * Formats a Date as YYYY-MM-DD in the specified IANA timezone.
 */
export function formatDateISOInTimezone(date: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    // fall back to local calendar date
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Returns today's calendar date (YYYY-MM-DD) offset by daysOffset in the given IANA timezone.
 */
export function getDateOffsetISOInTimezone(daysOffset = 0, tz = getActiveUserTimezone()): string {
  const baseISO = formatDateISOInTimezone(new Date(), tz);
  if (daysOffset === 0) return baseISO;
  const [y, m, d] = baseISO.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + daysOffset));
  const sy = shifted.getUTCFullYear();
  const sm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const sd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${sy}-${sm}-${sd}`;
}

export function formatDateTimeInTimezone(
  iso: string | Date,
  tz = getActiveUserTimezone(),
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return typeof iso === 'string' ? iso : '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...options,
    }).format(d);
  } catch {
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...options,
    });
  }
}
