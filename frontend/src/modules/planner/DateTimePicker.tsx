import { useCallback, useMemo, useRef, useState } from 'react';
import { Calendar as CalendarIcon } from 'lucide-react';
import { Lunar, Solar } from 'lunar-typescript';
import {
  CalendarPopover,
  clampCalendarYear,
  pad2,
  SolarCalendarBody,
  WEEKDAY_ZH,
  WEEKDAYS_MON_FIRST,
  type DaySubBadge,
  type SolarDateParts,
} from '@/components/DatePicker';
import {
  formatLunarYearLabel,
  getLunarDayBadge,
  getLunarMonthOptions,
  previewLunarToSolar,
  type CalendarType,
} from './api';

const LUNAR_DAY_NAMES = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
];

export type SolarDateValue = SolarDateParts;

export interface LunarDateValue {
  year: number; // 1901..2099
  signedMonth: number; // 1..12 normal, -1..-12 leap
  day: number; // 1..30
}

export function parseSolarLocal(localStr: string): { date: SolarDateValue; time: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(localStr.trim());
  if (m) {
    return {
      date: { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) },
      time: m[4] ?? '09:00',
    };
  }
  const now = new Date();
  return {
    date: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
    time: '09:00',
  };
}

export function formatSolarLocal(date: SolarDateValue, time: string): string {
  const [hh, mm] = time.split(':');
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}T${pad2(Number(hh) || 0)}:${pad2(Number(mm) || 0)}`;
}

interface DateTimePickerProps {
  calendarType: CalendarType;
  solarDate: SolarDateValue;
  lunarDate: LunarDateValue;
  time: string;
  onSelectSolarDate: (next: SolarDateValue) => void;
  onSelectLunarDate: (next: LunarDateValue) => void;
  onTimeChange: (nextTime: string) => void;
}

export function DateTimePicker({
  calendarType,
  solarDate,
  lunarDate,
  time,
  onSelectSolarDate,
  onSelectLunarDate,
  onTimeChange,
}: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'days' | 'months'>('days');

  // Calendar viewport state (separate for solar & lunar so flipping never mutates selected date)
  const [viewSolarYear, setViewSolarYear] = useState(solarDate.year);
  const [viewSolarMonth, setViewSolarMonth] = useState(solarDate.month);

  const [viewLunarYear, setViewLunarYear] = useState(lunarDate.year);
  const [viewLunarSignedMonth, setViewLunarSignedMonth] = useState(lunarDate.signedMonth);

  const triggerRef = useRef<HTMLButtonElement>(null);

  const todayInfo = useMemo(() => {
    const now = new Date();
    const s = Solar.fromYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const l = s.getLunar();
    return {
      solar: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
      lunar: { year: clampCalendarYear(l.getYear()), signedMonth: l.getMonth(), day: l.getDay() },
    };
  }, []);

  const openPopover = () => {
    setViewSolarYear(solarDate.year);
    setViewSolarMonth(solarDate.month);
    setViewLunarYear(lunarDate.year);
    setViewLunarSignedMonth(lunarDate.signedMonth);
    setViewMode('days');
    setOpen((v) => !v);
  };

  // --- Lunar month metadata for current viewport year ---
  const lunarMonthOptions = useMemo(() => getLunarMonthOptions(viewLunarYear), [viewLunarYear]);
  const activeLunarMonthOpt = useMemo(
    () =>
      lunarMonthOptions.find((m) => m.signedMonth === viewLunarSignedMonth) ??
      lunarMonthOptions.find((m) => m.month === Math.abs(viewLunarSignedMonth) && !m.isLeap) ??
      lunarMonthOptions[0],
    [lunarMonthOptions, viewLunarSignedMonth],
  );

  // --- Trigger display text & opposite-calendar preview ---
  const triggerDisplay = useMemo(() => {
    if (calendarType === 'solar') {
      const d = new Date(solarDate.year, solarDate.month - 1, solarDate.day);
      const wd = WEEKDAY_ZH[d.getDay()] ?? '';
      return `${solarDate.year}-${pad2(solarDate.month)}-${pad2(solarDate.day)}${wd ? `（${wd}）` : ''}`;
    }
    const opts = getLunarMonthOptions(lunarDate.year);
    const mOpt =
      opts.find((m) => m.signedMonth === lunarDate.signedMonth) ??
      opts.find((m) => m.month === Math.abs(lunarDate.signedMonth) && !m.isLeap);
    const monthLabel = mOpt?.label ?? `${Math.abs(lunarDate.signedMonth)}月`;
    const dayLabel = LUNAR_DAY_NAMES[Math.min(lunarDate.day, 30) - 1] ?? `${lunarDate.day}日`;
    return `${formatLunarYearLabel(lunarDate.year)} · ${monthLabel}${dayLabel}`;
  }, [calendarType, solarDate, lunarDate]);

  const oppositeCaption = useMemo(() => {
    if (calendarType === 'solar') {
      try {
        const l = Solar.fromYmd(solarDate.year, solarDate.month, solarDate.day).getLunar();
        return `对应农历：${formatLunarYearLabel(l.getYear())} ${l.getMonthInChinese()}月${l.getDayInChinese()}`;
      } catch {
        return '';
      }
    }
    return `对应公历：${previewLunarToSolar(
      lunarDate.year,
      Math.abs(lunarDate.signedMonth),
      lunarDate.day,
      lunarDate.signedMonth < 0,
    )}`;
  }, [calendarType, solarDate, lunarDate]);

  // --- Navigation handlers ---
  const stepYear = (delta: number) => {
    if (calendarType === 'solar') {
      setViewSolarYear((y) => clampCalendarYear(y + delta));
      return;
    }
    const nextYear = clampCalendarYear(viewLunarYear + delta);
    setViewLunarYear(nextYear);
    const nextMonths = getLunarMonthOptions(nextYear);
    const matched =
      nextMonths.find((m) => m.signedMonth === viewLunarSignedMonth) ??
      nextMonths.find((m) => m.month === Math.abs(viewLunarSignedMonth) && !m.isLeap) ??
      nextMonths[0];
    if (matched) setViewLunarSignedMonth(matched.signedMonth);
  };

  const stepMonth = (delta: number) => {
    if (calendarType === 'solar') {
      let y = viewSolarYear;
      let m = viewSolarMonth + delta;
      if (m < 1) {
        y -= 1;
        m = 12;
      } else if (m > 12) {
        y += 1;
        m = 1;
      }
      if (y < 1901 || y > 2099) return;
      setViewSolarYear(y);
      setViewSolarMonth(m);
      return;
    }
    const idx = lunarMonthOptions.findIndex(
      (m) => m.signedMonth === (activeLunarMonthOpt?.signedMonth ?? viewLunarSignedMonth),
    );
    const nextIdx = idx + delta;
    if (nextIdx >= 0 && nextIdx < lunarMonthOptions.length) {
      setViewLunarSignedMonth(lunarMonthOptions[nextIdx].signedMonth);
      return;
    }
    if (nextIdx < 0 && viewLunarYear > 1901) {
      const prevYear = viewLunarYear - 1;
      const prevMonths = getLunarMonthOptions(prevYear);
      setViewLunarYear(prevYear);
      setViewLunarSignedMonth(prevMonths[prevMonths.length - 1].signedMonth);
    } else if (nextIdx >= lunarMonthOptions.length && viewLunarYear < 2099) {
      const nextYear = viewLunarYear + 1;
      const nextMonths = getLunarMonthOptions(nextYear);
      setViewLunarYear(nextYear);
      setViewLunarSignedMonth(nextMonths[0].signedMonth);
    }
  };

  const commitYear = (year: number) => {
    const y = clampCalendarYear(year);
    if (calendarType === 'solar') {
      setViewSolarYear(y);
    } else {
      setViewLunarYear(y);
      const nextMonths = getLunarMonthOptions(y);
      const matched =
        nextMonths.find((m) => m.signedMonth === viewLunarSignedMonth) ??
        nextMonths.find((m) => m.month === Math.abs(viewLunarSignedMonth) && !m.isLeap) ??
        nextMonths[0];
      if (matched) setViewLunarSignedMonth(matched.signedMonth);
    }
  };

  const getSolarLunarSub = useCallback((year: number, month: number, day: number): DaySubBadge => {
    const badge = getLunarDayBadge(new Date(year, month - 1, day));
    return { text: badge.text, highlight: badge.highlight };
  }, []);

  // --- Authentic Lunar Day Cells (Mon-first 7-col grid aligned to real weekdays) ---
  const lunarCells = useMemo(() => {
    if (calendarType !== 'lunar' || !activeLunarMonthOpt) return [];
    const signedMonth = activeLunarMonthOpt.signedMonth;
    const dayCount = activeLunarMonthOpt.dayCount;
    let leading = 0;
    try {
      const firstSolar = Lunar.fromYmd(viewLunarYear, signedMonth, 1).getSolar();
      leading = (firstSolar.getWeek() + 6) % 7;
    } catch {
      leading = 0;
    }

    const cells: Array<
      | { empty: true; key: string }
      | {
          empty: false;
          key: string;
          day: number;
          label: string;
          subText: string;
          subHighlight: boolean;
        }
    > = [];

    for (let i = 0; i < leading; i++) {
      cells.push({ empty: true, key: `pad-${i}` });
    }
    for (let d = 1; d <= dayCount; d++) {
      let subText = '';
      let subHighlight = false;
      try {
        const s = Lunar.fromYmd(viewLunarYear, signedMonth, d).getSolar();
        if (s.getDay() === 1) {
          subText = `${s.getMonth()}月`;
          subHighlight = true;
        } else if (d === 1) {
          subText = `${s.getMonth()}/${s.getDay()}`;
        } else {
          subText = String(s.getDay());
        }
      } catch {
        subText = '';
      }
      cells.push({
        empty: false,
        key: `${viewLunarYear}-${signedMonth}-${d}`,
        day: d,
        label: LUNAR_DAY_NAMES[d - 1] ?? String(d),
        subText,
        subHighlight,
      });
    }
    return cells;
  }, [calendarType, viewLunarYear, activeLunarMonthOpt]);

  const headerYear = calendarType === 'solar' ? viewSolarYear : viewLunarYear;
  const headerTitle =
    viewMode === 'days'
      ? calendarType === 'solar'
        ? `${viewSolarYear}年 ${viewSolarMonth}月`
        : `${formatLunarYearLabel(viewLunarYear)} · ${activeLunarMonthOpt?.label ?? ''}`
      : calendarType === 'solar'
        ? `${viewSolarYear}年`
        : formatLunarYearLabel(viewLunarYear);

  return (
    <div className="space-y-1.5">
      <span className="yd-label">{calendarType === 'solar' ? '目标时间' : '目标时间（农历）'}</span>
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <button
          ref={triggerRef}
          type="button"
          onClick={openPopover}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={`flex-1 min-w-0 yd-input flex items-center justify-between gap-2 text-left tabular-nums ${
            open ? 'border-sky-300 ring-2 ring-sky-500/12' : ''
          }`}
        >
          <span className="truncate">{triggerDisplay}</span>
          <CalendarIcon className="h-4 w-4 shrink-0 text-zinc-400" />
        </button>

        <input
          type="time"
          required
          value={time}
          onChange={(e) => onTimeChange(e.target.value)}
          aria-label="选择时刻"
          className="yd-input w-full sm:w-[112px] shrink-0"
        />
      </div>

      {oppositeCaption && (
        <div className="text-xs text-zinc-400 tabular-nums">{oppositeCaption}</div>
      )}

      <CalendarPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        ariaLabel={calendarType === 'solar' ? '选择公历日期' : '选择农历日期'}
        viewMode={viewMode}
        headerYear={headerYear}
        headerTitle={headerTitle}
        onStepYear={stepYear}
        onStepMonth={stepMonth}
        onToggleViewMode={() => setViewMode('months')}
        onCommitYear={commitYear}
        footerLeft={
          <button
            type="button"
            onClick={() => {
              if (calendarType === 'solar') {
                onSelectSolarDate(todayInfo.solar);
              } else {
                onSelectLunarDate(todayInfo.lunar);
              }
              setOpen(false);
            }}
            className="text-sky-600 hover:text-sky-700 font-medium px-1.5 py-0.5 rounded-md hover:bg-sky-50 transition-colors"
          >
            今天
          </button>
        }
        footerRight={
          calendarType === 'lunar' && activeLunarMonthOpt ? (
            <span className="text-[11px] text-zinc-400">
              {activeLunarMonthOpt.description}
              {lunarMonthOptions.some((m) => m.isLeap)
                ? ` · 该年含${lunarMonthOptions.find((m) => m.isLeap)?.label}`
                : ''}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-zinc-500 hover:text-zinc-700 px-1.5 py-0.5 rounded-md hover:bg-zinc-100 transition-colors"
            >
              关闭
            </button>
          )
        }
      >
        {calendarType === 'solar' ? (
          <SolarCalendarBody
            viewMode={viewMode}
            viewYear={viewSolarYear}
            viewMonth={viewSolarMonth}
            selected={solarDate}
            today={todayInfo.solar}
            getDaySub={getSolarLunarSub}
            onSelectMonth={(m) => {
              setViewSolarMonth(m);
              setViewMode('days');
            }}
            onSelectDay={(d) => {
              onSelectSolarDate(d);
              setOpen(false);
            }}
          />
        ) : viewMode === 'months' ? (
          <div className="pt-2.5 pb-1">
            <div className="grid grid-cols-3 gap-1.5">
              {lunarMonthOptions.map((opt) => {
                const active =
                  opt.signedMonth === (activeLunarMonthOpt?.signedMonth ?? viewLunarSignedMonth);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      setViewLunarSignedMonth(opt.signedMonth);
                      setViewMode('days');
                    }}
                    className={`rounded-lg py-1.5 px-1 text-center transition-colors ${
                      active
                        ? 'bg-sky-500 text-white'
                        : opt.isLeap
                          ? 'bg-sky-50/70 text-sky-700 hover:bg-sky-100/70'
                          : 'text-zinc-700 hover:bg-zinc-100/80'
                    }`}
                  >
                    <div className="text-xs font-medium leading-tight">{opt.label}</div>
                    <div
                      className={`text-[10px] mt-0.5 tabular-nums ${
                        active ? 'text-sky-100' : 'text-zinc-400'
                      }`}
                    >
                      {opt.dayCount}天
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="mt-2 text-center text-[11px] text-zinc-400">
              点击上方年份可直接输入跳转
            </div>
          </div>
        ) : (
          <div className="pt-2">
            <div className="grid grid-cols-7 text-center text-[11px] font-medium text-zinc-400 pb-1">
              {WEEKDAYS_MON_FIRST.map((w) => (
                <div key={w} className="py-1">
                  {w}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-0.5">
              {lunarCells.map((cell) => {
                if (cell.empty) {
                  return <div key={cell.key} className="h-[38px]" />;
                }
                const curSigned = activeLunarMonthOpt?.signedMonth ?? viewLunarSignedMonth;
                const isSelected =
                  viewLunarYear === lunarDate.year &&
                  curSigned === lunarDate.signedMonth &&
                  cell.day === lunarDate.day;
                const isToday =
                  viewLunarYear === todayInfo.lunar.year &&
                  curSigned === todayInfo.lunar.signedMonth &&
                  cell.day === todayInfo.lunar.day;
                return (
                  <button
                    key={cell.key}
                    type="button"
                    onClick={() => {
                      onSelectLunarDate({
                        year: viewLunarYear,
                        signedMonth: curSigned,
                        day: cell.day,
                      });
                      setOpen(false);
                    }}
                    className={`rounded-lg py-1 text-center transition-colors ${
                      isSelected
                        ? 'bg-sky-500 text-white'
                        : isToday
                          ? 'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200'
                          : 'text-zinc-800 hover:bg-zinc-100/80'
                    }`}
                  >
                    <div className="text-[11px] font-medium leading-tight">{cell.label}</div>
                    <div
                      className={`text-[9px] leading-tight mt-0.5 tabular-nums ${
                        isSelected
                          ? 'text-sky-100'
                          : cell.subHighlight
                            ? 'text-sky-600 font-medium'
                            : 'text-zinc-400'
                      }`}
                    >
                      {cell.subText}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </CalendarPopover>
    </div>
  );
}
