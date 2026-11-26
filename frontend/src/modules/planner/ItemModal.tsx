import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { InfoTooltip } from '@/components/InfoTooltip';
import { Select } from '@/components/Select';
import {
  COMMON_TIMEZONES,
  formatTimezoneOptionLabel,
  plannerApi,
  previewLunarToSolar,
  type CalendarType,
  type PlannerItem,
  type RepeatConfig,
  type RepeatType,
  type UpsertPlannerItemPayload,
} from './api';
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

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

function defaultLocalDateTime(prefillDate?: string): string {
  if (prefillDate) {
    return prefillDate.includes('T') ? prefillDate.slice(0, 16) : `${prefillDate}T09:00`;
  }
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}T09:00`;
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

  const [title, setTitle] = useState(initial?.title ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [hasTarget, setHasTarget] = useState<boolean>(
    Boolean(initial?.target_at || initial?.repeat_type === 'cron' || prefillDate),
  );
  const [calendarType, setCalendarType] = useState<CalendarType>(initial?.calendar_type ?? 'solar');
  const [timezone, setTimezone] = useState(initial?.timezone ?? defaultTimezone());
  const [targetLocal, setTargetLocal] = useState(
    initial?.target_local ?? defaultLocalDateTime(prefillDate),
  );

  // Lunar fields
  const nowYear = new Date().getFullYear();
  const [lunarYear, setLunarYear] = useState(initial?.repeat_config.anchor_year || nowYear);
  const [lunarMonth, setLunarMonth] = useState(initial?.repeat_config.anchor_month || 1);
  const [lunarDay, setLunarDay] = useState(initial?.repeat_config.anchor_day || 1);
  const [lunarIsLeap, setLunarIsLeap] = useState(Boolean(initial?.repeat_config.anchor_is_leap));
  const [lunarTime, setLunarTime] = useState(() => {
    const h = String(initial?.repeat_config.anchor_hour ?? 9).padStart(2, '0');
    const m = String(initial?.repeat_config.anchor_minute ?? 0).padStart(2, '0');
    return `${h}:${m}`;
  });

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
          const [hh, mm] = lunarTime.split(':').map((n) => Number(n) || 0);
          payload.lunar_target = {
            year: lunarYear,
            month: lunarMonth,
            day: lunarDay,
            is_leap: lunarIsLeap,
            hour: hh,
            minute: mm,
          };
        } else {
          payload.target_local = targetLocal;
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
      className="fixed inset-0 z-50 bg-slate-900/15 backdrop-blur-[2px] flex items-center justify-center p-4"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-full max-w-xl max-h-[calc(100vh-2rem)] flex flex-col rounded-2xl border border-zinc-200/90 bg-white shadow-xl overflow-hidden"
      >
        <div className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold text-zinc-900">
            {isEditing ? '编辑事项' : '新建事项'}
          </h3>
          <button type="button" onClick={onClose} className="yd-btn-icon">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto">
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
                        onClick={() => setCalendarType('solar')}
                        className={`yd-segment-btn flex-1 ${
                          calendarType === 'solar' ? 'yd-segment-active' : 'yd-segment-idle'
                        }`}
                      >
                        公历
                      </button>
                      <button
                        type="button"
                        disabled={repeatType === 'cron'}
                        onClick={() => setCalendarType('lunar')}
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

                {/* Target DateTime (exact to minute) */}
                {repeatType !== 'cron' &&
                  (calendarType === 'solar' ? (
                    <label className="block space-y-1.5">
                      <span className="yd-label">目标时间</span>
                      <input
                        type="datetime-local"
                        required
                        value={targetLocal}
                        onChange={(e) => setTargetLocal(e.target.value)}
                        className="yd-input"
                      />
                    </label>
                  ) : (
                    <div className="space-y-2">
                      <span className="yd-label">农历目标日期与时刻</span>
                      <div className="grid grid-cols-4 gap-2">
                        <input
                          type="number"
                          min={1901}
                          max={2099}
                          value={lunarYear}
                          onChange={(e) => setLunarYear(Number(e.target.value))}
                          placeholder="年"
                          className="yd-input-sm w-full"
                        />
                        <Select
                          value={String(lunarMonth)}
                          onChange={(v) => setLunarMonth(Number(v))}
                          options={Array.from({ length: 12 }, (_, i) => ({
                            value: String(i + 1),
                            label: `${i + 1}月`,
                          }))}
                          searchable={false}
                          className="w-full"
                          ariaLabel="选择农历月份"
                        />
                        <Select
                          value={String(lunarDay)}
                          onChange={(v) => setLunarDay(Number(v))}
                          options={Array.from({ length: 30 }, (_, i) => ({
                            value: String(i + 1),
                            label: `${i + 1}日`,
                          }))}
                          searchable={false}
                          className="w-full"
                          ariaLabel="选择农历日期"
                        />
                        <input
                          type="time"
                          value={lunarTime}
                          onChange={(e) => setLunarTime(e.target.value)}
                          className="yd-input-sm w-full"
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs text-zinc-500">
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={lunarIsLeap}
                            onChange={(e) => setLunarIsLeap(e.target.checked)}
                          />
                          闰月
                        </label>
                        <span className="tabular-nums">
                          对应公历：{previewLunarToSolar(lunarYear, lunarMonth, lunarDay, lunarIsLeap)}
                        </span>
                      </div>
                    </div>
                  ))}

                {/* Unified Cycle / Repeat Config */}
                <div className="space-y-2.5">
                  <div className="block space-y-1.5">
                    <span className="yd-label">循环周期</span>
                    <Select
                      value={repeatType}
                      onChange={(v) => {
                        const next = v as RepeatType;
                        setRepeatType(next);
                        if (next === 'cron') setCalendarType('solar');
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

        <div className="px-6 py-3.5 border-t border-zinc-100 bg-zinc-50/50 flex justify-end gap-2 shrink-0">
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
