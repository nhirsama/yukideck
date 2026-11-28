import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { getDateOffsetISOInTimezone, useUserTimezone } from '@/core/timezone';

export const WEEKDAYS_MON_FIRST = ['一', '二', '三', '四', '五', '六', '日'];
export const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export interface SolarDateParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
}

export interface DaySubBadge {
  text: string;
  highlight?: boolean;
}

interface PopoverCoords {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
}

export function clampCalendarYear(y: number): number {
  return Math.min(2099, Math.max(1901, Math.floor(y)));
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatISODate(d: SolarDateParts): string {
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;
}

export function parseISODate(raw: string | undefined): SolarDateParts | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1901 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return { year, month, day };
}

function daysInSolarMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

// --- Shared Floating Calendar Popover Shell (used by both DatePicker and planner DateTimePicker) ---

export interface CalendarPopoverProps {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  ariaLabel: string;
  viewMode: 'days' | 'months';
  headerYear: number;
  headerTitle: string;
  onStepYear: (delta: number) => void;
  onStepMonth: (delta: number) => void;
  onToggleViewMode: () => void;
  onCommitYear: (year: number) => void;
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
  children: ReactNode;
}

export function CalendarPopover({
  open,
  onClose,
  triggerRef,
  ariaLabel,
  viewMode,
  headerYear,
  headerTitle,
  onStepYear,
  onStepMonth,
  onToggleViewMode,
  onCommitYear,
  footerLeft,
  footerRight,
  children,
}: CalendarPopoverProps) {
  const [coords, setCoords] = useState<PopoverCoords | null>(null);
  const [editingYear, setEditingYear] = useState(false);
  const [yearDraft, setYearDraft] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setEditingYear(false);
    }
  }, [open]);

  const updatePosition = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 6;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const popWidth = Math.min(312, viewportW - 16);
    const popHeight = 356;
    const spaceBelow = viewportH - rect.bottom - gap - 10;
    const spaceAbove = rect.top - gap - 10;
    const openUpward = spaceBelow < popHeight && spaceAbove > spaceBelow;
    const left = Math.min(Math.max(8, rect.left), viewportW - popWidth - 8);
    if (openUpward) {
      setCoords({ left, width: popWidth, bottom: viewportH - rect.top + gap });
    } else {
      setCoords({ left, width: popWidth, top: rect.bottom + gap });
    }
  }, [triggerRef]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
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
  }, [open, onClose, triggerRef, updatePosition]);

  const commitDraft = () => {
    setEditingYear(false);
    const parsed = Number(yearDraft);
    if (!Number.isFinite(parsed) || parsed < 1901 || parsed > 2099) return;
    onCommitYear(Math.floor(parsed));
  };

  if (!open || !coords) return null;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: coords.left,
        top: coords.top,
        bottom: coords.bottom,
        width: coords.width,
      }}
      className="z-[75] max-h-[calc(100dvh-16px)] overflow-y-auto rounded-2xl border border-zinc-200/90 bg-white p-3 shadow-[0_12px_32px_rgba(15,23,42,0.12)] select-none"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-1 pb-2.5 border-b border-zinc-100">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => onStepYear(-1)}
            disabled={headerYear <= 1901}
            title="上一年"
            className="yd-btn-icon h-7 w-7 p-0"
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </button>
          {viewMode === 'days' && (
            <button
              type="button"
              onClick={() => onStepMonth(-1)}
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
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitDraft();
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
                onToggleViewMode();
              } else {
                setYearDraft(String(headerYear));
                setEditingYear(true);
              }
            }}
            title={viewMode === 'days' ? '点击切换月份' : '点击直接输入年份'}
            className="rounded-lg px-2 py-1 text-[13px] font-semibold text-zinc-800 hover:bg-zinc-100/80 transition-colors tabular-nums truncate"
          >
            {headerTitle}
          </button>
        )}

        <div className="flex items-center gap-0.5">
          {viewMode === 'days' && (
            <button
              type="button"
              onClick={() => onStepMonth(1)}
              title="下一月"
              className="yd-btn-icon h-7 w-7 p-0"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onStepYear(1)}
            disabled={headerYear >= 2099}
            title="下一年"
            className="yd-btn-icon h-7 w-7 p-0"
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      {children}

      {/* Footer */}
      {(footerLeft || footerRight) && (
        <div className="mt-2 pt-2 border-t border-zinc-100 flex items-center justify-between text-xs">
          <div>{footerLeft}</div>
          <div>{footerRight}</div>
        </div>
      )}
    </div>,
    document.body,
  );
}

// --- Shared Solar Month & Day Grids ---

interface SolarCalendarBodyProps {
  viewMode: 'days' | 'months';
  viewYear: number;
  viewMonth: number;
  selected: SolarDateParts | null;
  today: SolarDateParts;
  min?: string;
  max?: string;
  getDaySub?: (year: number, month: number, day: number) => DaySubBadge | null;
  onSelectMonth: (month: number) => void;
  onSelectDay: (date: SolarDateParts) => void;
}

export function SolarCalendarBody({
  viewMode,
  viewYear,
  viewMonth,
  selected,
  today,
  min,
  max,
  getDaySub,
  onSelectMonth,
  onSelectDay,
}: SolarCalendarBodyProps) {
  const cells = useMemo(() => {
    if (viewMode !== 'days') return [];
    const total = daysInSolarMonth(viewYear, viewMonth);
    const firstDow = new Date(viewYear, viewMonth - 1, 1).getDay();
    const leading = (firstDow + 6) % 7;

    const prevY = viewMonth === 1 ? viewYear - 1 : viewYear;
    const prevM = viewMonth === 1 ? 12 : viewMonth - 1;
    const prevTotal = daysInSolarMonth(prevY, prevM);

    const nextY = viewMonth === 12 ? viewYear + 1 : viewYear;
    const nextM = viewMonth === 12 ? 1 : viewMonth + 1;

    const list: Array<{
      year: number;
      month: number;
      day: number;
      iso: string;
      inMonth: boolean;
      sub?: DaySubBadge | null;
    }> = [];

    for (let i = leading - 1; i >= 0; i--) {
      const d = prevTotal - i;
      list.push({
        year: prevY,
        month: prevM,
        day: d,
        iso: formatISODate({ year: prevY, month: prevM, day: d }),
        inMonth: false,
        sub: getDaySub ? getDaySub(prevY, prevM, d) : null,
      });
    }
    for (let d = 1; d <= total; d++) {
      list.push({
        year: viewYear,
        month: viewMonth,
        day: d,
        iso: formatISODate({ year: viewYear, month: viewMonth, day: d }),
        inMonth: true,
        sub: getDaySub ? getDaySub(viewYear, viewMonth, d) : null,
      });
    }
    const trailing = (7 - (list.length % 7)) % 7;
    for (let d = 1; d <= trailing; d++) {
      list.push({
        year: nextY,
        month: nextM,
        day: d,
        iso: formatISODate({ year: nextY, month: nextM, day: d }),
        inMonth: false,
        sub: getDaySub ? getDaySub(nextY, nextM, d) : null,
      });
    }
    return list;
  }, [viewMode, viewYear, viewMonth, getDaySub]);

  if (viewMode === 'months') {
    return (
      <div className="pt-2.5 pb-1">
        <div className="grid grid-cols-3 gap-1.5">
          {Array.from({ length: 12 }, (_, idx) => {
            const m = idx + 1;
            const active = viewMonth === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => onSelectMonth(m)}
                className={`rounded-lg py-2 text-xs font-medium transition-colors ${
                  active ? 'bg-sky-500 text-white' : 'text-zinc-700 hover:bg-zinc-100/80'
                }`}
              >
                {m}月
              </button>
            );
          })}
        </div>
        <div className="mt-2 text-center text-[11px] text-zinc-400">
          点击上方年份可直接输入跳转
        </div>
      </div>
    );
  }

  const hasSub = Boolean(getDaySub);

  return (
    <div className="pt-2">
      <div className="grid grid-cols-7 text-center text-[11px] font-medium text-zinc-400 pb-1">
        {WEEKDAYS_MON_FIRST.map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((cell) => {
          const isSelected =
            selected !== null &&
            cell.year === selected.year &&
            cell.month === selected.month &&
            cell.day === selected.day;
          const isToday =
            cell.year === today.year && cell.month === today.month && cell.day === today.day;
          const disabled =
            Boolean(min && cell.iso < min) || Boolean(max && cell.iso > max);

          return (
            <button
              key={cell.iso}
              type="button"
              disabled={disabled}
              onClick={() => onSelectDay({ year: cell.year, month: cell.month, day: cell.day })}
              className={`rounded-lg text-center transition-colors ${
                hasSub ? 'py-1' : 'py-1.5'
              } ${
                disabled
                  ? 'text-zinc-200 cursor-not-allowed'
                  : isSelected
                    ? 'bg-sky-500 text-white'
                    : isToday
                      ? 'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200'
                      : cell.inMonth
                        ? 'text-zinc-800 hover:bg-zinc-100/80'
                        : 'text-zinc-300 hover:bg-zinc-50'
              }`}
            >
              <div className="text-xs font-medium leading-tight tabular-nums">{cell.day}</div>
              {hasSub && (
                <div
                  className={`text-[9px] leading-tight mt-0.5 truncate px-0.5 ${
                    disabled
                      ? 'text-zinc-200'
                      : isSelected
                        ? 'text-sky-100'
                        : !cell.inMonth
                          ? 'text-zinc-300'
                          : cell.sub?.highlight
                            ? 'text-sky-600 font-medium'
                            : 'text-zinc-400'
                  }`}
                >
                  {cell.sub?.text ?? ''}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Public Shared DatePicker (drop-in replacement for <input type="date" />) ---

export interface DatePickerProps {
  value: string; // 'YYYY-MM-DD' or ''
  onChange: (value: string) => void;
  placeholder?: string;
  size?: 'sm' | 'md';
  min?: string;
  max?: string;
  clearable?: boolean;
  disabled?: boolean;
  showWeekday?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function DatePicker({
  value,
  onChange,
  placeholder = '选择日期',
  size = 'sm',
  min,
  max,
  clearable = false,
  disabled = false,
  showWeekday = false,
  className = '',
  ariaLabel,
}: DatePickerProps) {
  const tz = useUserTimezone();
  const todayISO = useMemo(() => getDateOffsetISOInTimezone(0, tz), [tz]);
  const todayParts = useMemo<SolarDateParts>(() => {
    const parsed = parseISODate(todayISO);
    if (parsed) return parsed;
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }, [todayISO]);

  const selectedParts = useMemo(() => parseISODate(value), [value]);

  const [open, setOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'days' | 'months'>('days');
  const [viewYear, setViewYear] = useState(() => (selectedParts ?? todayParts).year);
  const [viewMonth, setViewMonth] = useState(() => (selectedParts ?? todayParts).month);

  const triggerRef = useRef<HTMLButtonElement>(null);

  const toggleOpen = () => {
    if (disabled) return;
    if (!open) {
      const anchor = selectedParts ?? todayParts;
      setViewYear(anchor.year);
      setViewMonth(anchor.month);
      setViewMode('days');
    }
    setOpen((v) => !v);
  };

  const stepMonth = (delta: number) => {
    let y = viewYear;
    let m = viewMonth + delta;
    if (m < 1) {
      y -= 1;
      m = 12;
    } else if (m > 12) {
      y += 1;
      m = 1;
    }
    if (y < 1901 || y > 2099) return;
    setViewYear(y);
    setViewMonth(m);
  };

  const triggerLabel = useMemo(() => {
    if (!selectedParts) return '';
    const base = formatISODate(selectedParts);
    if (!showWeekday) return base;
    const d = new Date(selectedParts.year, selectedParts.month - 1, selectedParts.day);
    const wd = WEEKDAY_ZH[d.getDay()] ?? '';
    return wd ? `${base}（${wd}）` : base;
  }, [selectedParts, showWeekday]);

  const todayDisabled =
    Boolean(min && todayISO < min) || Boolean(max && todayISO > max);

  const baseInputClass =
    size === 'md'
      ? 'yd-input flex items-center justify-between gap-2 text-left'
      : 'yd-input-sm flex items-center justify-between gap-1.5 text-left';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={toggleOpen}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`${baseInputClass} tabular-nums ${
          open ? 'border-sky-300 ring-2 ring-sky-500/12' : ''
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${className}`}
      >
        <span
          className={`truncate ${
            triggerLabel ? 'text-zinc-800' : 'text-zinc-400'
          }`}
        >
          {triggerLabel || placeholder}
        </span>
        <CalendarIcon
          className={`${size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'} shrink-0 text-zinc-400`}
        />
      </button>

      <CalendarPopover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        ariaLabel={ariaLabel || '选择日期'}
        viewMode={viewMode}
        headerYear={viewYear}
        headerTitle={viewMode === 'days' ? `${viewYear}年 ${viewMonth}月` : `${viewYear}年`}
        onStepYear={(delta) => setViewYear((y) => clampCalendarYear(y + delta))}
        onStepMonth={stepMonth}
        onToggleViewMode={() => setViewMode('months')}
        onCommitYear={(y) => setViewYear(clampCalendarYear(y))}
        footerLeft={
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={todayDisabled}
              onClick={() => {
                onChange(todayISO);
                setOpen(false);
              }}
              className="text-sky-600 hover:text-sky-700 disabled:text-zinc-300 disabled:hover:bg-transparent font-medium px-1.5 py-0.5 rounded-md hover:bg-sky-50 transition-colors"
            >
              今天
            </button>
            {clearable && value && (
              <button
                type="button"
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
                className="text-zinc-500 hover:text-zinc-700 px-1.5 py-0.5 rounded-md hover:bg-zinc-100 transition-colors"
              >
                清除
              </button>
            )}
          </div>
        }
        footerRight={
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-zinc-500 hover:text-zinc-700 px-1.5 py-0.5 rounded-md hover:bg-zinc-100 transition-colors"
          >
            关闭
          </button>
        }
      >
        <SolarCalendarBody
          viewMode={viewMode}
          viewYear={viewYear}
          viewMonth={viewMonth}
          selected={selectedParts}
          today={todayParts}
          min={min}
          max={max}
          onSelectMonth={(m) => {
            setViewMonth(m);
            setViewMode('days');
          }}
          onSelectDay={(d) => {
            onChange(formatISODate(d));
            setOpen(false);
          }}
        />
      </CalendarPopover>
    </>
  );
}
