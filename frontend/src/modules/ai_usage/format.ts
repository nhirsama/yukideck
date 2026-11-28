import {
  detectBrowserTimezone as coreDetectBrowserTimezone,
  formatDateTimeInTimezone,
  getActiveUserTimezone,
  getDateOffsetISOInTimezone,
} from '@/core/timezone';

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function formatUSD(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0.0%';
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatDateTime(iso: string, tz?: string): string {
  if (!iso) return '-';
  return formatDateTimeInTimezone(iso, tz || getActiveUserTimezone());
}

export function localDateISO(daysOffset = 0, tz?: string): string {
  return getDateOffsetISOInTimezone(daysOffset, tz || getActiveUserTimezone());
}

export function detectBrowserTimezone(): string {
  return coreDetectBrowserTimezone();
}

export type ChartScaleMode = 'log' | 'linear';

export interface AxisTick {
  value: number;
  label: string;
  pct: number; // 0..100 from bottom
}

export interface AxisScale {
  ticks: AxisTick[];
  toPct: (val: number) => number;
}

function trimTrailingZero(n: number): string {
  if (Math.abs(n - Math.round(n)) < 1e-6) return String(Math.round(n));
  return Number(n.toFixed(1)).toString();
}

export function formatAxisValue(n: number, kind: 'tokens' | 'cost'): string {
  if (!Number.isFinite(n) || n <= 0) return kind === 'cost' ? '$0' : '0';
  if (kind === 'tokens') {
    if (n >= 1_000_000_000) return `${trimTrailingZero(n / 1_000_000_000)}B`;
    if (n >= 1_000_000) return `${trimTrailingZero(n / 1_000_000)}M`;
    if (n >= 1_000) return `${trimTrailingZero(n / 1_000)}K`;
    return String(Math.round(n));
  }
  if (n >= 1_000) return `$${trimTrailingZero(n / 1_000)}K`;
  if (n >= 1) return `$${trimTrailingZero(n)}`;
  if (n >= 0.0001) return `$${Number(n.toPrecision(2)).toString()}`;
  return `$${n.toExponential(0)}`;
}

export function buildAxisScale(
  values: number[],
  kind: 'tokens' | 'cost',
  mode: ChartScaleMode,
  options?: { maxTicks?: number; minVisiblePct?: number },
): AxisScale {
  const maxTicks = options?.maxTicks ?? 5;
  const minVisiblePct = options?.minVisiblePct ?? 2;
  const positives = values.filter((v) => Number.isFinite(v) && v > 0);
  if (positives.length === 0) {
    return { ticks: [], toPct: () => 0 };
  }

  const minPos = Math.min(...positives);
  const maxPos = Math.max(...positives);

  if (mode === 'linear') {
    const rawStep = maxPos / Math.max(1, maxTicks - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const niceMult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    const step = niceMult * mag;
    const steps = Math.max(1, Math.ceil(maxPos / step));
    const niceMax = steps * step;
    const ticks: AxisTick[] = [];
    for (let i = 0; i <= steps; i++) {
      const value = i * step;
      ticks.push({
        value,
        label: formatAxisValue(value, kind),
        pct: (i / steps) * 100,
      });
    }
    return {
      ticks,
      toPct: (val: number) => {
        if (!Number.isFinite(val) || val <= 0 || niceMax <= 0) return 0;
        return Math.min(100, Math.max(minVisiblePct, (val / niceMax) * 100));
      },
    };
  }

  // Logarithmic (base-10) scale with clean 10^k ticks
  const floorMinExp = kind === 'tokens' ? 0 : -4;
  let maxExp = Math.ceil(Math.log10(maxPos));
  let minExp = Math.floor(Math.log10(minPos));

  // Give the smallest non-zero value visible room above the baseline
  if (Math.log10(minPos) - minExp < 0.2) {
    minExp -= 1;
  }
  minExp = Math.max(floorMinExp, minExp);
  if (minExp >= maxExp) {
    if (maxExp <= floorMinExp) {
      maxExp = floorMinExp + 1;
      minExp = floorMinExp;
    } else {
      minExp = maxExp - 1;
    }
  }
  // Cap total span to avoid extreme outliers squashing everything
  if (maxExp - minExp > 6) {
    minExp = maxExp - 6;
  }

  let span = maxExp - minExp;
  const step = Math.max(1, Math.ceil(span / Math.max(1, maxTicks - 1)));
  if (span % step !== 0) {
    const pad = step - (span % step);
    if (minExp - pad >= floorMinExp) {
      minExp -= pad;
    } else {
      maxExp += pad;
    }
    span = maxExp - minExp;
  }

  const ticks: AxisTick[] = [];
  for (let e = minExp; e <= maxExp; e += step) {
    const value = Math.pow(10, e);
    ticks.push({
      value,
      label: formatAxisValue(value, kind),
      pct: ((e - minExp) / span) * 100,
    });
  }

  return {
    ticks,
    toPct: (val: number) => {
      if (!Number.isFinite(val) || val <= 0) return 0;
      const pct = ((Math.log10(val) - minExp) / span) * 100;
      return Math.min(100, Math.max(minVisiblePct, pct));
    },
  };
}
