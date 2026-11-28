import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { InfoTooltip } from '@/components/InfoTooltip';
import { Select } from '@/components/Select';
import { formatDateISOInTimezone, useUserTimezone } from '@/core/timezone';
import {
  COMMON_TIMEZONES,
  formatTimezoneOptionLabel,
  lunarPartsToSolarLocal,
  plannerApi,
  solarLocalToLunarParts,
  type CalendarType,
  type PlannerItem,
  type RepeatConfig,
  type RepeatType,
  type UpsertPlannerItemPayload,
} from './api';
import {
  DateTimePicker,
  formatSolarLocal,
  parseSolarLocal,
  type LunarDateValue,
  type SolarDateValue,
} from './DateTimePicker';
import {
  getOverdueCycleError,
  NotificationFields,
  toOverdueConfigPayload,
  type NotificationFieldsState,
} from './NotificationModal';

const WEEKDAYS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 0, label: '日' },
];

function defaultLocalDateTime(tz: string, prefillDate?: string): string {
  if (prefillDate) {
    return prefillDate.includes('T') ? prefillDate.slice(0, 16) : `${prefillDate}T09:00`;
  }
  return `${formatDateISOInTimezone(new Date(), tz)}T09:00`;
}

export function ItemModal({
  initial,
  prefillDate,
  onClose,
  onSaved,
}: {
  initial: PlannerItem | null;
  prefillDate?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEditing = Boolean(initial);
  const userTimezone = useUserTimezone();

  const [title, setTitle] = useState(initial?.title ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [hasTarget, setHasTarget] = useState<boolean>(
    Boolean(initial?.target_at || initial?.repeat_type === 'cron' || prefillDate),
  );
  const [calendarType, setCalendarType] = useState<CalendarType>(initial?.calendar_type ?? 'solar');
  const [timezone, setTimezone] = useState(initial?.timezone ?? userTimezone);
  const initialTargetLocal = initial?.target_local ?? defaultLocalDateTime(initial?.timezone ?? userTimezone, prefillDate);
  const initialSolarParsed = useMemo(
    () => parseSolarLocal(initialTargetLocal),
    [initialTargetLocal],
  );
  const [solarDate, setSolarDate] = useState<SolarDateValue>(initialSolarParsed.date);
  const [timeStr, setTimeStr] = useState(initialSolarParsed.time);

  // Lunar fields (initialized from current occurrence or today's real lunar date)
  const initialLunar = useMemo<LunarDateValue>(() => {
    const fromSolar = solarLocalToLunarParts(initialTargetLocal);
    if (fromSolar) {
      return {
        year: fromSolar.year,
        signedMonth: fromSolar.signedMonth,
        day: fromSolar.day,
      };
    }
    if (
      initial?.calendar_type === 'lunar' &&
      initial.repeat_config.anchor_year &&
      initial.repeat_config.anchor_month &&
      initial.repeat_config.anchor_day
    ) {
      const m = initial.repeat_config.anchor_month;
      return {
        year: initial.repeat_config.anchor_year,
        signedMonth: initial.repeat_config.anchor_is_leap ? -m : m,
        day: initial.repeat_config.anchor_day,
      };
    }
    return { year: new Date().getFullYear(), signedMonth: 1, day: 1 };
  }, [initial, initialTargetLocal]);

  const [lunarDate, setLunarDate] = useState<LunarDateValue>(initialLunar);

  const handleSelectSolarDate = (next: SolarDateValue) => {
    setSolarDate(next);
    const synced = solarLocalToLunarParts(formatSolarLocal(next, timeStr));
    if (synced) {
      setLunarDate({
        year: synced.year,
        signedMonth: synced.signedMonth,
        day: synced.day,
      });
    }
  };

  const handleSelectLunarDate = (next: LunarDateValue) => {
    setLunarDate(next);
    const converted = lunarPartsToSolarLocal(next.year, next.signedMonth, next.day, timeStr);
    if (converted) {
      setSolarDate(parseSolarLocal(converted).date);
    }
  };

  const switchCalendarType = (nextType: CalendarType) => {
    if (nextType === calendarType) return;
    if (nextType === 'lunar') {
      const parts = solarLocalToLunarParts(formatSolarLocal(solarDate, timeStr));
      if (parts) {
        setLunarDate({
          year: parts.year,
          signedMonth: parts.signedMonth,
          day: parts.day,
        });
      }
    } else {
      const converted = lunarPartsToSolarLocal(
        lunarDate.year,
        lunarDate.signedMonth,
        lunarDate.day,
        timeStr,
      );
      if (converted) {
        setSolarDate(parseSolarLocal(converted).date);
      }
    }
    setCalendarType(nextType);
  };

  // Recurrence
  const [repeatType, setRepeatType] = useState<RepeatType>(initial?.repeat_type ?? 'none');
  const [weekdays, setWeekdays] = useState<number[]>(initial?.repeat_config.weekdays ?? []);
  const [intervalDays, setIntervalDays] = useState<number>(initial?.repeat_config.interval || 7);
  const [cronExpr, setCronExpr] = useState(initial?.repeat_config.cron_expr ?? '0 9 * * *');
  const [autoAdvance, setAutoAdvance] = useState(initial?.auto_advance ?? true);

  // Notification fields (only rendered when creating a new item; preserved on edit)
  const [notifyState, setNotifyState] = useState<NotificationFieldsState>(() => ({
    offsets: initial?.remind_offsets ?? [],
    overdueEnabled: Boolean(initial?.overdue_config?.enabled),
    overdueIntervalUnit: initial?.overdue_config?.interval_unit === 'hour' ? 'hour' : 'day',
    overdueIntervalValue: initial?.overdue_config?.interval_value || 1,
    overdueMaxCount: Math.min(10, Math.max(1, initial?.overdue_config?.max_count || 3)),
    autoAdvance: initial?.auto_advance ?? true,
    channelMode: (initial?.channel_ids?.length ?? 0) > 0 ? 'selected' : 'default',
    selectedChannels: initial?.channel_ids ?? [],
  }));

  const [error, setError] = useState('');

  const saveMut = useMutation({
    mutationFn: (payload: UpsertPlannerItemPayload) =>
      initial ? plannerApi.updateItem(initial.id, payload) : plannerApi.createItem(payload),
    onSuccess: onSaved,
    onError: (err: Error) => setError(err.message),
  });

  const toggleWeekday = (wd: number) => {
    setWeekdays((prev) => (prev.includes(wd) ? prev.filter((x) => x !== wd) : [...prev, wd]));
  };

  const currentRepeatConfig: RepeatConfig =
    repeatType === 'cron'
      ? { cron_expr: cronExpr }
      : {
          weekdays: repeatType === 'weekly' ? weekdays : undefined,
          interval: repeatType === 'interval_days' ? intervalDays : undefined,
        };

  const effectiveAutoAdvance = isEditing ? autoAdvance : notifyState.autoAdvance;
  const overdueActive = isEditing
    ? Boolean(initial?.overdue_config?.enabled)
    : notifyState.overdueEnabled;

  const cycleErr = hasTarget
    ? getOverdueCycleError(notifyState, repeatType, calendarType, currentRepeatConfig)
    : '';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (cycleErr) {
      setError(cycleErr);
      return;
    }

    const payload: UpsertPlannerItemPayload = {
      title,
      note,
      timezone,
    };

    if (hasTarget) {
      payload.calendar_type = calendarType;
      payload.repeat_type = repeatType;
      payload.auto_advance = effectiveAutoAdvance;
      payload.remind_offsets = isEditing ? (initial?.remind_offsets ?? []) : notifyState.offsets;
      payload.overdue_config = isEditing
        ? (initial?.overdue_config ?? { enabled: false })
        : toOverdueConfigPayload(notifyState);
      payload.channel_ids = isEditing
        ? (initial?.channel_ids ?? [])
        : notifyState.channelMode === 'selected'
          ? notifyState.selectedChannels
          : [];

      if (repeatType === 'cron') {
        payload.calendar_type = 'solar';
        payload.repeat_config = { cron_expr: cronExpr };
      } else {
        if (calendarType === 'lunar') {
          const [hh, mm] = timeStr.split(':').map((n) => Number(n) || 0);
          payload.lunar_target = {
            year: lunarDate.year,
            month: Math.abs(lunarDate.signedMonth),
            day: lunarDate.day,
            is_leap: lunarDate.signedMonth < 0,
            hour: hh,
            minute: mm,
          };
        } else {
          payload.target_local = formatSolarLocal(solarDate, timeStr);
        }
        payload.repeat_config = currentRepeatConfig;
      }
    } else {
      payload.repeat_type = 'none';
      payload.remind_offsets = [];
      payload.overdue_config = { enabled: false };
      payload.channel_ids = [];
    }

    saveMut.mutate(payload);
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-slate-900/15 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-0 sm:p-4"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-full max-w-xl max-h-[92dvh] sm:max-h-[calc(100dvh-2rem)] flex flex-col rounded-t-2xl sm:rounded-2xl border border-zinc-200/90 bg-white shadow-xl overflow-hidden"
      >
        <div className="px-4 sm:px-6 py-3.5 sm:py-4 border-b border-zinc-100 flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold text-zinc-900">
            {isEditing ? '编辑事项' : '新建事项'}
          </h3>
          <button type="button" onClick={onClose} className="yd-btn-icon">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-5 overflow-y-auto">
          {error && <div className="yd-notice-error">{error}</div>}

          {/* Only Title is required */}
          <div className="space-y-3.5">
            <label className="block space-y-1.5">
              <span className="yd-label">名称 *</span>
              <input
                required
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="待办、日程或订阅提醒名称"
                className="yd-input"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="yd-label">备注</span>
              <textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="补充说明（随提醒一并发送）"
                className="yd-input resize-none"
              />
            </label>
          </div>

          {/* Optional Target Time + Cycle (+ Initial Notification on Create) */}
          <div className="border-t border-zinc-100 pt-4 space-y-4">
            <label className="inline-flex items-center gap-2 text-[13px] font-medium text-zinc-800 cursor-pointer">
              <input
                type="checkbox"
                checked={hasTarget}
                onChange={(e) => setHasTarget(e.target.checked)}
              />
              {isEditing ? '目标时间与周期' : '时间与提醒'}
            </label>

            {hasTarget && (
              <div className="yd-panel-subtle p-4 space-y-4">
                {/* Calendar type + Timezone */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <span className="yd-label">历法</span>
                    <div className="yd-segment w-full">
                      <button
                        type="button"
                        onClick={() => switchCalendarType('solar')}
                        className={`yd-segment-btn flex-1 ${
                          calendarType === 'solar' ? 'yd-segment-active' : 'yd-segment-idle'
                        }`}
                      >
                        公历
                      </button>
                      <button
                        type="button"
                        disabled={repeatType === 'cron'}
                        onClick={() => switchCalendarType('lunar')}
                        className={`yd-segment-btn flex-1 disabled:opacity-40 ${
                          calendarType === 'lunar' ? 'yd-segment-active' : 'yd-segment-idle'
                        }`}
                      >
                        农历
                      </button>
                    </div>
                  </div>

                  <div className="block space-y-1.5">
                    <span className="yd-label">时区</span>
                    <Select
                      value={timezone}
                      onChange={setTimezone}
                      options={[
                        ...(!COMMON_TIMEZONES.some((z) => z.value === timezone) && timezone
                          ? [{ value: timezone, label: formatTimezoneOptionLabel(timezone) }]
                          : []),
                        ...COMMON_TIMEZONES,
                      ]}
                      className="w-full"
                      ariaLabel="选择时区"
                    />
                  </div>
                </div>

                {/* Unified Solar / Lunar Target DateTime Picker */}
                {repeatType !== 'cron' && (
                  <DateTimePicker
                    calendarType={calendarType}
                    solarDate={solarDate}
                    lunarDate={lunarDate}
                    time={timeStr}
                    onSelectSolarDate={handleSelectSolarDate}
                    onSelectLunarDate={handleSelectLunarDate}
                    onTimeChange={setTimeStr}
                  />
                )}

                {/* Unified Cycle / Repeat Config */}
                <div className="space-y-2.5">
                  <div className="block space-y-1.5">
                    <span className="yd-label">循环周期</span>
                    <Select
                      value={repeatType}
                      onChange={(v) => {
                        const next = v as RepeatType;
                        setRepeatType(next);
                        if (next === 'cron') switchCalendarType('solar');
                      }}
                      options={[
                        { value: 'none', label: '不重复' },
                        { value: 'daily', label: '每天' },
                        { value: 'weekly', label: '每周' },
                        { value: 'monthly', label: '每月' },
                        { value: 'yearly', label: '每年' },
                        { value: 'interval_days', label: '每隔 N 天' },
                        { value: 'cron', label: 'Cron 表达式' },
                      ]}
                      size="md"
                      className="w-full"
                      ariaLabel="选择循环周期"
                    />
                  </div>

                  {repeatType === 'weekly' && (
                    <div className="flex flex-wrap gap-1.5">
                      {WEEKDAYS.map((w) => {
                        const active = weekdays.includes(w.value);
                        return (
                          <button
                            key={w.value}
                            type="button"
                            onClick={() => toggleWeekday(w.value)}
                            className={`h-8 w-8 rounded-lg border text-xs font-medium transition-colors ${
                              active
                                ? 'bg-sky-50 border-sky-300 text-sky-700'
                                : 'bg-white border-zinc-200 text-zinc-600 hover:border-zinc-300'
                            }`}
                          >
                            {w.label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {repeatType === 'interval_days' && (
                    <label className="flex items-center gap-2 text-xs text-zinc-700">
                      <span>每隔</span>
                      <input
                        type="number"
                        min={1}
                        max={3650}
                        value={intervalDays}
                        onChange={(e) => setIntervalDays(Number(e.target.value))}
                        className="yd-input-sm w-20"
                      />
                      <span>天重复一次</span>
                    </label>
                  )}

                  {repeatType === 'cron' && (
                    <label className="block space-y-1.5">
                      <span className="text-xs text-zinc-500">
                        5 位 Cron（分 时 日 月 周，按所选时区执行）
                      </span>
                      <input
                        required
                        value={cronExpr}
                        onChange={(e) => setCronExpr(e.target.value)}
                        placeholder="例如：30 9 * * 1-5"
                        className="yd-input font-mono"
                      />
                    </label>
                  )}

                  {repeatType !== 'none' && (
                    <div className="flex items-center gap-1.5">
                      <label className="inline-flex items-center gap-2 text-xs text-zinc-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={effectiveAutoAdvance}
                          onChange={(e) => {
                            setAutoAdvance(e.target.checked);
                            setNotifyState((prev) => ({ ...prev, autoAdvance: e.target.checked }));
                          }}
                        />
                        {overdueActive ? '确认后自动推进' : '通知后自动推进至下一周期'}
                      </label>
                      {overdueActive && (
                        <InfoTooltip
                          content="达到逾期通知上限后也会自动推进至下一周期"
                          ariaLabel="确认后自动推进说明"
                        />
                      )}
                    </div>
                  )}
                </div>

                {/* Initial Notification Config on Create; Edit mode uses the standalone Bell modal */}
                {!isEditing && (
                  <div className="pt-3 border-t border-zinc-200/70">
                    <NotificationFields
                      state={notifyState}
                      onChange={(next) => {
                        setNotifyState(next);
                        setAutoAdvance(next.autoAdvance);
                      }}
                      repeatType={repeatType}
                      calendarType={calendarType}
                      repeatConfig={currentRepeatConfig}
                      showAutoAdvanceWhenOverdue={false}
                    />
                  </div>
                )}

                {isEditing && cycleErr && (
                  <div className="text-xs text-red-600">{cycleErr}</div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="px-4 sm:px-6 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] sm:pb-3.5 border-t border-zinc-100 bg-zinc-50/50 flex justify-end gap-2 shrink-0">
          <button type="button" onClick={onClose} className="yd-btn-secondary">
            取消
          </button>
          <button
            type="submit"
            disabled={saveMut.isPending || Boolean(cycleErr)}
            className="yd-btn-primary"
          >
            {saveMut.isPending ? '保存中...' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
