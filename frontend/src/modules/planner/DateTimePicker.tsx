import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { Lunar, Solar } from 'lunar-typescript';
import {
  formatLunarYearLabel,
  getLunarDayBadge,
  getLunarMonthOptions,
  previewLunarToSolar,
  type CalendarType,
} from './api';

const WEEKDAYS_MON_FIRST = ['一', '二', '三', '四', '五', '六', '日'];
const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const LUNAR_DAY_NAMES = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
];

export interface SolarDateValue {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
}

export interface LunarDateValue {
  year: number; // 1901..2099
  signedMonth: number; // 1..12 normal, -1..-12 leap
  day: number; // 1..30
}

interface PopoverCoords {
  left: number;
  top?: number;
  bottom?: number;
}

function clampYear(y: number): number {
  return Math.min(2099, Math.max(1901, Math.floor(y)));
}

function daysInSolarMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
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
  const [coords, setCoords] = useState<PopoverCoords | null>(null);

  // Calendar viewport state (separate for solar & lunar so flipping never mutates selected date)
  const [viewSolarYear, setViewSolarYear] = useState(solarDate.year);
  const [viewSolarMonth, setViewSolarMonth] = useState(solarDate.month);

  const [viewLunarYear, setViewLunarYear] = useState(lunarDate.year);
  const [viewLunarSignedMonth, setViewLunarSignedMonth] = useState(lunarDate.signedMonth);

  const [yearDraft, setYearDraft] = useState('');
  const [editingYear, setEditingYear] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const todayInfo = useMemo(() => {
    const now = new Date();
    const s = Solar.fromYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const l = s.getLunar();
    return {
      solar: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
      lunar: { year: clampYear(l.getYear()), signedMonth: l.getMonth(), day: l.getDay() },
    };
  }, []);

  const openPopover = () => {
    setViewSolarYear(solarDate.year);
    setViewSolarMonth(solarDate.month);
    setViewLunarYear(lunarDate.year);
    setViewLunarSignedMonth(lunarDate.signedMonth);
    setViewMode('days');
    setEditingYear(false);
    setOpen((v) => !v);
  };

  const updatePosition = () => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 6;
    const popWidth = 312;
    const popHeight = 356;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - rect.bottom - gap - 10;
    const spaceAbove = rect.top - gap - 10;
    const openUpward = spaceBelow < popHeight && spaceAbove > spaceBelow;
    const left = Math.min(Math.max(8, rect.left), viewportW - popWidth - 8);
    if (openUpward) {
      setCoords({ left, bottom: viewportH - rect.top + gap });
    } else {
      setCoords({ left, top: rect.bottom + gap });
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onScrollOrResize = (e: Event) => {
      if (popoverRef.current && e.target instanceof Node && popoverRef.current.contains(e.target)) {
        return;
      }
      updatePosition();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open]);

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
      setViewSolarYear((y) => clampYear(y + delta));
      return;
    }
    const nextYear = clampYear(viewLunarYear + delta);
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

  const commitYearDraft = () => {
    setEditingYear(false);
    const parsed = Number(yearDraft);
    if (!Number.isFinite(parsed) || parsed < 1901 || parsed > 2099) return;
    const y = Math.floor(parsed);
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

  // --- Build Solar Day Cells (Mon-first 7-col grid) ---
  const solarCells = useMemo(() => {
    if (calendarType !== 'solar') return [];
    const total = daysInSolarMonth(viewSolarYear, viewSolarMonth);
    const firstDow = new Date(viewSolarYear, viewSolarMonth - 1, 1).getDay();
    const leading = (firstDow + 6) % 7;

    const prevY = viewSolarMonth === 1 ? viewSolarYear - 1 : viewSolarYear;
    const prevM = viewSolarMonth === 1 ? 12 : viewSolarMonth - 1;
    const prevTotal = daysInSolarMonth(prevY, prevM);

    const nextY = viewSolarMonth === 12 ? viewSolarYear + 1 : viewSolarYear;
    const nextM = viewSolarMonth === 12 ? 1 : viewSolarMonth + 1;

    const cells: Array<{
      year: number;
      month: number;
      day: number;
      inMonth: boolean;
      subText: string;
      subHighlight: boolean;
    }> = [];

    for (let i = leading - 1; i >= 0; i--) {
      const d = prevTotal - i;
      const badge = getLunarDayBadge(new Date(prevY, prevM - 1, d));
      cells.push({
        year: prevY,
        month: prevM,
        day: d,
        inMonth: false,
        subText: badge.text,
        subHighlight: false,
      });
    }
    for (let d = 1; d <= total; d++) {
      const badge = getLunarDayBadge(new Date(viewSolarYear, viewSolarMonth - 1, d));
      cells.push({
        year: viewSolarYear,
        month: viewSolarMonth,
        day: d,
        inMonth: true,
        subText: badge.text,
        subHighlight: badge.highlight,
      });
    }
    const trailing = (7 - (cells.length % 7)) % 7;
    for (let d = 1; d <= trailing; d++) {
      const badge = getLunarDayBadge(new Date(nextY, nextM - 1, d));
      cells.push({
        year: nextY,
        month: nextM,
        day: d,
        inMonth: false,
        subText: badge.text,
        subHighlight: false,
      });
    }
    return cells;
  }, [calendarType, viewSolarYear, viewSolarMonth]);

  // --- Build Authentic Lunar Day Cells (Mon-first 7-col grid aligned to real weekdays) ---
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

  return (
    <div className="space-y-1.5">
      <span className="yd-label">{calendarType === 'solar' ? '目标时间' : '目标时间（农历）'}</span>
      <div className="flex items-center gap-2">
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
          className="yd-input w-[112px] shrink-0"
        />
      </div>

      {oppositeCaption && (
        <div className="text-xs text-zinc-400 tabular-nums">{oppositeCaption}</div>
      )}

      {open &&
        coords &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={calendarType === 'solar' ? '选择公历日期' : '选择农历日期'}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: coords.left,
              top: coords.top,
              bottom: coords.bottom,
              width: 312,
            }}
            className="z-[75] rounded-2xl border border-zinc-200/90 bg-white p-3 shadow-[0_12px_32px_rgba(15,23,42,0.12)] select-none"
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-1 pb-2.5 border-b border-zinc-100">
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => stepYear(-1)}
                  disabled={headerYear <= 1901}
                  title="上一年"
                  className="yd-btn-icon h-7 w-7 p-0"
                >
                  <ChevronsLeft className="h-3.5 w-3.5" />
                </button>
                {viewMode === 'days' && (
                  <button
                    type="button"
                    onClick={() => stepMonth(-1)}
                    title="上一月"
                    className="yd-btn-icon h-7 w-7 p-0"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {viewMode === 'months' && editingYear ? (
                <input
                  type="number"
                  min={1901}
                  max={2099}
                  autoFocus
                  value={yearDraft}
                  onChange={(e) => setYearDraft(e.target.value)}
                  onBlur={commitYearDraft}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitYearDraft();
                    } else if (e.key === 'Escape') {
                      e.stopPropagation();
                      setEditingYear(false);
                    }
                  }}
                  className="yd-input-sm w-24 py-0.5 text-center tabular-nums"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (viewMode === 'days') {
                      setViewMode('months');
                    } else {
                      setYearDraft(String(headerYear));
                      setEditingYear(true);
                    }
                  }}
                  title={viewMode === 'days' ? '点击切换月份' : '点击直接输入年份'}
                  className="rounded-lg px-2 py-1 text-[13px] font-semibold text-zinc-800 hover:bg-zinc-100/80 transition-colors tabular-nums truncate"
                >
                  {viewMode === 'days'
                    ? calendarType === 'solar'
                      ? `${viewSolarYear}年 ${viewSolarMonth}月`
                      : `${formatLunarYearLabel(viewLunarYear)} · ${activeLunarMonthOpt?.label ?? ''}`
                    : calendarType === 'solar'
                      ? `${viewSolarYear}年`
                      : formatLunarYearLabel(viewLunarYear)}
                </button>
              )}

              <div className="flex items-center gap-0.5">
                {viewMode === 'days' && (
                  <button
                    type="button"
                    onClick={() => stepMonth(1)}
                    title="下一月"
                    className="yd-btn-icon h-7 w-7 p-0"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => stepYear(1)}
                  disabled={headerYear >= 2099}
                  title="下一年"
                  className="yd-btn-icon h-7 w-7 p-0"
                >
                  <ChevronsRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Body: Day Grid OR Month Grid */}
            {viewMode === 'months' ? (
              <div className="pt-2.5 pb-1">
                <div className="grid grid-cols-3 gap-1.5">
                  {calendarType === 'solar'
                    ? Array.from({ length: 12 }, (_, idx) => {
                        const m = idx + 1;
                        const active = viewSolarMonth === m;
                        return (
                          <button
                            key={m}
                            type="button"
                            onClick={() => {
                              setViewSolarMonth(m);
                              setViewMode('days');
                            }}
                            className={`rounded-lg py-2 text-xs font-medium transition-colors ${
                              active
                                ? 'bg-sky-500 text-white'
                                : 'text-zinc-700 hover:bg-zinc-100/80'
                            }`}
                          >
                            {m}月
                          </button>
                        );
                      })
                    : lunarMonthOptions.map((opt) => {
                        const active =
                          opt.signedMonth ===
                          (activeLunarMonthOpt?.signedMonth ?? viewLunarSignedMonth);
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

                {calendarType === 'solar' ? (
                  <div className="grid grid-cols-7 gap-0.5">
                    {solarCells.map((cell) => {
                      const isSelected =
                        cell.year === solarDate.year &&
                        cell.month === solarDate.month &&
                        cell.day === solarDate.day;
                      const isToday =
                        cell.year === todayInfo.solar.year &&
                        cell.month === todayInfo.solar.month &&
                        cell.day === todayInfo.solar.day;
                      return (
                        <button
                          key={`${cell.year}-${cell.month}-${cell.day}`}
                          type="button"
                          onClick={() => {
                            onSelectSolarDate({
                              year: cell.year,
                              month: cell.month,
                              day: cell.day,
                            });
                            setOpen(false);
                          }}
                          className={`rounded-lg py-1 text-center transition-colors ${
                            isSelected
                              ? 'bg-sky-500 text-white'
                              : isToday
                                ? 'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200'
                                : cell.inMonth
                                  ? 'text-zinc-800 hover:bg-zinc-100/80'
                                  : 'text-zinc-300 hover:bg-zinc-50'
                          }`}
                        >
                          <div className="text-xs font-medium leading-tight tabular-nums">
                            {cell.day}
                          </div>
                          <div
                            className={`text-[9px] leading-tight mt-0.5 truncate px-0.5 ${
                              isSelected
                                ? 'text-sky-100'
                                : !cell.inMonth
                                  ? 'text-zinc-300'
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
                ) : (
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
                )}
              </div>
            )}

            {/* Footer */}
            <div className="mt-2 pt-2 border-t border-zinc-100 flex items-center justify-between text-xs">
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

              {calendarType === 'lunar' && activeLunarMonthOpt ? (
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
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
