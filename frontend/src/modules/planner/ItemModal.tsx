import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Bell, Plus, X } from 'lucide-react';
import { coreApi } from '@/core/api';
import {
  formatOffsetLabel,
  plannerApi,
  previewLunarToSolar,
  type CalendarType,
  type PlannerItem,
  type RemindOffset,
  type RepeatType,
  type UpsertPlannerItemPayload,
} from './api';

const PRESET_OFFSETS: RemindOffset[] = [
  { unit: 'minute', value: 0 },
  { unit: 'minute', value: 15 },
  { unit: 'minute', value: 30 },
  { unit: 'hour', value: 1 },
  { unit: 'day', value: 1 },
  { unit: 'day', value: 3 },
  { unit: 'day', value: 7 },
];

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
  const { data: outboundData } = useQuery({
    queryKey: ['messenger', 'channels', 'outbound'],
    queryFn: () => coreApi.listChannels('outbound'),
  });
  const outboundChannels = outboundData?.channels ?? [];

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

  // Multiple notification time points
  const [offsets, setOffsets] = useState<RemindOffset[]>(initial?.remind_offsets ?? []);
  const [customVal, setCustomVal] = useState(10);
  const [customUnit, setCustomUnit] = useState<'minute' | 'hour' | 'day'>('minute');

  // Outbound channels (empty = default outbound channel)
  const [channelMode, setChannelMode] = useState<'default' | 'selected'>(
    (initial?.channel_ids?.length ?? 0) > 0 ? 'selected' : 'default',
  );
  const [selectedChannels, setSelectedChannels] = useState<number[]>(initial?.channel_ids ?? []);
  const [error, setError] = useState('');

  const saveMut = useMutation({
    mutationFn: (payload: UpsertPlannerItemPayload) =>
      initial ? plannerApi.updateItem(initial.id, payload) : plannerApi.createItem(payload),
    onSuccess: onSaved,
    onError: (err: Error) => setError(err.message),
  });

  const addOffset = (o: RemindOffset) => {
    const norm: RemindOffset = o.value <= 0 ? { unit: 'minute', value: 0 } : o;
    const key = `${norm.unit}:${norm.value}`;
    if (offsets.some((x) => `${x.unit}:${x.value}` === key)) return;
    setOffsets((prev) => [...prev, norm]);
  };

  const removeOffset = (idx: number) => {
    setOffsets((prev) => prev.filter((_, i) => i !== idx));
  };

  const toggleWeekday = (wd: number) => {
    setWeekdays((prev) => (prev.includes(wd) ? prev.filter((x) => x !== wd) : [...prev, wd]));
  };

  const toggleChannel = (id: number) => {
    setSelectedChannels((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const payload: UpsertPlannerItemPayload = {
      title,
      note,
      timezone,
    };

    if (hasTarget) {
      payload.calendar_type = calendarType;
      payload.repeat_type = repeatType;
      payload.auto_advance = autoAdvance;
      payload.remind_offsets = offsets;
      payload.channel_ids = channelMode === 'selected' ? selectedChannels : [];

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
        payload.repeat_config = {
          weekdays: repeatType === 'weekly' ? weekdays : undefined,
          interval: repeatType === 'interval_days' ? intervalDays : undefined,
        };
      }
    } else {
      payload.repeat_type = 'none';
      payload.remind_offsets = [];
      payload.channel_ids = [];
    }

    saveMut.mutate(payload);
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto">
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 space-y-5 shadow-xl my-8"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">{initial ? '编辑事项' : '新建事项'}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

        {/* Only Title is required */}
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-700">名称 *</span>
            <input
              required
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="待办、日程或订阅提醒名称"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-700">备注（可选）</span>
            <textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="补充说明（推送通知时一并发送）"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm resize-none"
            />
          </label>
        </div>

        {/* Optional Target Time + Cycle + Notifications */}
        <div className="border-t border-slate-100 pt-4 space-y-4">
          <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-800 cursor-pointer">
            <input
              type="checkbox"
              checked={hasTarget}
              onChange={(e) => setHasTarget(e.target.checked)}
            />
            设置目标时间 / 周期与推送提醒
          </label>

          {hasTarget && (
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              {/* Calendar type + Timezone */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <span className="text-xs font-medium text-slate-700">历法</span>
                  <div className="inline-flex w-full rounded-lg border border-slate-200 bg-white p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setCalendarType('solar')}
                      className={`flex-1 rounded-md py-1.5 font-medium ${
                        calendarType === 'solar' ? 'bg-slate-900 text-white' : 'text-slate-600'
                      }`}
                    >
                      公历
                    </button>
                    <button
                      type="button"
                      disabled={repeatType === 'cron'}
                      onClick={() => setCalendarType('lunar')}
                      className={`flex-1 rounded-md py-1.5 font-medium disabled:opacity-40 ${
                        calendarType === 'lunar' ? 'bg-slate-900 text-white' : 'text-slate-600'
                      }`}
                    >
                      农历
                    </button>
                  </div>
                </div>

                <label className="block space-y-1">
                  <span className="text-xs font-medium text-slate-700">时区 (IANA)</span>
                  <input
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    placeholder="Asia/Shanghai"
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm"
                  />
                </label>
              </div>

              {/* Target DateTime (exact to minute) */}
              {repeatType !== 'cron' && (
                calendarType === 'solar' ? (
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-slate-700">目标时间（精确到分钟）</span>
                    <input
                      type="datetime-local"
                      required
                      value={targetLocal}
                      onChange={(e) => setTargetLocal(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                    />
                  </label>
                ) : (
                  <div className="space-y-2">
                    <span className="text-xs font-medium text-slate-700">农历目标日期与时刻</span>
                    <div className="grid grid-cols-4 gap-2">
                      <input
                        type="number"
                        min={1901}
                        max={2099}
                        value={lunarYear}
                        onChange={(e) => setLunarYear(Number(e.target.value))}
                        placeholder="年"
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
                      />
                      <select
                        value={lunarMonth}
                        onChange={(e) => setLunarMonth(Number(e.target.value))}
                        className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
                      >
                        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                          <option key={m} value={m}>
                            {m}月
                          </option>
                        ))}
                      </select>
                      <select
                        value={lunarDay}
                        onChange={(e) => setLunarDay(Number(e.target.value))}
                        className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
                      >
                        {Array.from({ length: 30 }, (_, i) => i + 1).map((d) => (
                          <option key={d} value={d}>
                            {d}日
                          </option>
                        ))}
                      </select>
                      <input
                        type="time"
                        value={lunarTime}
                        onChange={(e) => setLunarTime(e.target.value)}
                        className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm"
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <label className="inline-flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={lunarIsLeap}
                          onChange={(e) => setLunarIsLeap(e.target.checked)}
                        />
                        闰月
                      </label>
                      <span>对应公历：{previewLunarToSolar(lunarYear, lunarMonth, lunarDay, lunarIsLeap)}</span>
                    </div>
                  </div>
                )
              )}

              {/* Unified Cycle / Repeat Config */}
              <div className="space-y-2.5">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-slate-700">循环周期</span>
                  <select
                    value={repeatType}
                    onChange={(e) => {
                      const next = e.target.value as RepeatType;
                      setRepeatType(next);
                      if (next === 'cron') setCalendarType('solar');
                    }}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  >
                    <option value="none">一次性（不重复）</option>
                    <option value="daily">每天</option>
                    <option value="weekly">每周（可选星期几）</option>
                    <option value="monthly">每月（保留日期锚点，月末自动夹逼）</option>
                    <option value="yearly">每年（保留锚点，闰年自动恢复）</option>
                    <option value="interval_days">每隔 N 天</option>
                    <option value="cron">自定义 Cron 表达式（5 位）</option>
                  </select>
                </label>

                {repeatType === 'weekly' && (
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((w) => {
                      const active = weekdays.includes(w.value);
                      return (
                        <button
                          key={w.value}
                          type="button"
                          onClick={() => toggleWeekday(w.value)}
                          className={`h-8 w-8 rounded-lg border text-xs font-medium ${
                            active
                              ? 'bg-slate-900 border-slate-900 text-white'
                              : 'bg-white border-slate-200 text-slate-600'
                          }`}
                        >
                          {w.label}
                        </button>
                      );
                    })}
                  </div>
                )}

                {repeatType === 'interval_days' && (
                  <label className="flex items-center gap-2 text-xs text-slate-700">
                    <span>每隔</span>
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      value={intervalDays}
                      onChange={(e) => setIntervalDays(Number(e.target.value))}
                      className="w-20 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-sm"
                    />
                    <span>天重复一次</span>
                  </label>
                )}

                {repeatType === 'cron' && (
                  <label className="block space-y-1">
                    <span className="text-xs text-slate-600">5 位 Cron（分 时 日 月 周，按所选时区执行）</span>
                    <input
                      required
                      value={cronExpr}
                      onChange={(e) => setCronExpr(e.target.value)}
                      placeholder="例如：30 9 * * 1-5"
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-mono"
                    />
                  </label>
                )}

                {repeatType !== 'none' && (
                  <label className="inline-flex items-center gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={autoAdvance}
                      onChange={(e) => setAutoAdvance(e.target.checked)}
                    />
                    本期通知结束后自动推算下一周期（关闭则等待手动点击完成再推进）
                  </label>
                )}
              </div>

              {/* Multiple Notification Points */}
              <div className="space-y-2 pt-2 border-t border-slate-200/70">
                <div className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
                  <Bell className="h-3.5 w-3.5" />
                  通知时间点（可添加多个，留空则不推送）
                </div>

                {/* Selected offsets */}
                {offsets.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {offsets.map((o, idx) => (
                      <span
                        key={`${o.unit}:${o.value}`}
                        className="inline-flex items-center gap-1 rounded-full bg-slate-900 px-2.5 py-1 text-xs text-white"
                      >
                        {formatOffsetLabel(o)}
                        <button type="button" onClick={() => removeOffset(idx)} className="hover:text-slate-300">
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {/* Quick preset chips */}
                <div className="flex flex-wrap gap-1.5">
                  {PRESET_OFFSETS.map((p) => (
                    <button
                      key={`${p.unit}:${p.value}`}
                      type="button"
                      onClick={() => addOffset(p)}
                      className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-[11px] text-slate-600 hover:border-slate-400 hover:text-slate-900"
                    >
                      + {formatOffsetLabel(p)}
                    </button>
                  ))}
                </div>

                {/* Custom offset adder */}
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-xs text-slate-500">自定义提前</span>
                  <input
                    type="number"
                    min={0}
                    max={3650}
                    value={customVal}
                    onChange={(e) => setCustomVal(Number(e.target.value))}
                    className="w-20 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
                  />
                  <select
                    value={customUnit}
                    onChange={(e) => setCustomUnit(e.target.value as 'minute' | 'hour' | 'day')}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs"
                  >
                    <option value="minute">分钟</option>
                    <option value="hour">小时</option>
                    <option value="day">天</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => addOffset({ unit: customUnit, value: customVal })}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <Plus className="h-3 w-3" />
                    添加
                  </button>
                </div>
              </div>

              {/* Outbound Channel Selection (only shown when at least 1 notification point is set) */}
              {offsets.length > 0 && (
                <div className="space-y-2 pt-2 border-t border-slate-200/70">
                  <span className="text-xs font-medium text-slate-700">推送渠道（筛选 outbound 渠道）</span>
                  <div className="flex gap-4 text-xs text-slate-700">
                    <label className="inline-flex items-center gap-1.5">
                      <input
                        type="radio"
                        checked={channelMode === 'default'}
                        onChange={() => setChannelMode('default')}
                      />
                      使用默认出站渠道
                    </label>
                    <label className="inline-flex items-center gap-1.5">
                      <input
                        type="radio"
                        checked={channelMode === 'selected'}
                        onChange={() => setChannelMode('selected')}
                      />
                      指定渠道
                    </label>
                  </div>
                  {channelMode === 'selected' && (
                    <div className="rounded-lg border border-slate-200 bg-white p-2.5 space-y-1.5">
                      {outboundChannels.length === 0 ? (
                        <div className="text-xs text-slate-400">暂无可用的出站渠道，请先在消息中枢添加。</div>
                      ) : (
                        outboundChannels.map((ch) => (
                          <label key={ch.id} className="flex items-center gap-2 text-xs text-slate-700">
                            <input
                              type="checkbox"
                              checked={selectedChannels.includes(ch.id)}
                              onChange={() => toggleChannel(ch.id)}
                            />
                            <span>{ch.name}</span>
                            <span className="text-slate-400">({ch.type})</span>
                          </label>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saveMut.isPending}
            className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
          >
            {saveMut.isPending ? '保存中...' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
