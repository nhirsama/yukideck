import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Bell, Plus, X } from 'lucide-react';
import { InfoTooltip } from '@/components/InfoTooltip';
import { Select } from '@/components/Select';
import { coreApi } from '@/core/api';
import {
  buildUpsertPayloadFromItem,
  estimateMinCycleHours,
  formatHoursHuman,
  formatOffsetLabel,
  plannerApi,
  type CalendarType,
  type OverdueConfig,
  type PlannerItem,
  type RemindOffset,
  type RepeatConfig,
  type RepeatType,
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

export interface NotificationFieldsState {
  offsets: RemindOffset[];
  overdueEnabled: boolean;
  overdueIntervalUnit: 'hour' | 'day';
  overdueIntervalValue: number;
  overdueMaxCount: number;
  autoAdvance: boolean;
  channelMode: 'default' | 'selected';
  selectedChannels: number[];
}

export function getOverdueCycleError(
  state: NotificationFieldsState,
  repeatType: RepeatType,
  calendarType: CalendarType,
  repeatConfig: RepeatConfig,
): string {
  if (!state.overdueEnabled || repeatType === 'none') return '';
  const cycleHours = estimateMinCycleHours(repeatType, calendarType, repeatConfig);
  if (!cycleHours) return '';
  const unitHours = state.overdueIntervalUnit === 'hour' ? 1 : 24;
  const spanHours = state.overdueMaxCount * Math.max(1, state.overdueIntervalValue) * unitHours;
  if (spanHours >= cycleHours) {
    return `催办总时长（${formatHoursHuman(spanHours)}）必须严格小于循环周期长度（${formatHoursHuman(cycleHours)}）`;
  }
  return '';
}

export function toOverdueConfigPayload(state: NotificationFieldsState): OverdueConfig {
  if (!state.overdueEnabled) {
    return { enabled: false };
  }
  const clampedCount = Math.min(10, Math.max(1, Math.floor(state.overdueMaxCount || 3)));
  const safeInterval = Math.max(1, Math.floor(state.overdueIntervalValue || 1));
  return {
    enabled: true,
    interval_unit: state.overdueIntervalUnit,
    interval_value: safeInterval,
    max_count: clampedCount,
  };
}

export function NotificationFields({
  state,
  onChange,
  repeatType,
  calendarType,
  repeatConfig,
  showAutoAdvanceWhenOverdue = true,
}: {
  state: NotificationFieldsState;
  onChange: (next: NotificationFieldsState) => void;
  repeatType: RepeatType;
  calendarType: CalendarType;
  repeatConfig: RepeatConfig;
  showAutoAdvanceWhenOverdue?: boolean;
}) {
  const { data: outboundData } = useQuery({
    queryKey: ['messenger', 'channels', 'outbound'],
    queryFn: () => coreApi.listChannels('outbound'),
  });
  const outboundChannels = outboundData?.channels ?? [];

  const [customVal, setCustomVal] = useState(10);
  const [customUnit, setCustomUnit] = useState<'minute' | 'hour' | 'day'>('minute');

  const addOffset = (o: RemindOffset) => {
    const norm: RemindOffset = o.value <= 0 ? { unit: 'minute', value: 0 } : o;
    const key = `${norm.unit}:${norm.value}`;
    if (state.offsets.some((x) => `${x.unit}:${x.value}` === key)) return;
    onChange({ ...state, offsets: [...state.offsets, norm] });
  };

  const removeOffset = (idx: number) => {
    onChange({ ...state, offsets: state.offsets.filter((_, i) => i !== idx) });
  };

  const toggleChannel = (id: number) => {
    const next = state.selectedChannels.includes(id)
      ? state.selectedChannels.filter((x) => x !== id)
      : [...state.selectedChannels, id];
    onChange({ ...state, selectedChannels: next });
  };

  const cycleErr = getOverdueCycleError(state, repeatType, calendarType, repeatConfig);
  const hasAnyPush = state.offsets.length > 0 || state.overdueEnabled;

  return (
    <div className="space-y-4">
      {/* Multiple Notification Points */}
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5 yd-label">
          <Bell className="h-3.5 w-3.5 text-zinc-400" />
          提醒时间（留空不推送）
        </div>

        {state.offsets.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {state.offsets.map((o, idx) => (
              <span
                key={`${o.unit}:${o.value}`}
                className="inline-flex items-center gap-1 rounded-full bg-sky-50 border border-sky-200/80 px-2.5 py-0.5 text-[11px] font-medium text-sky-700"
              >
                {formatOffsetLabel(o)}
                <button
                  type="button"
                  onClick={() => removeOffset(idx)}
                  className="text-sky-400 hover:text-sky-700 transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {PRESET_OFFSETS.map((p) => (
            <button
              key={`${p.unit}:${p.value}`}
              type="button"
              onClick={() => addOffset(p)}
              className="rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 text-[11px] text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-900"
            >
              + {formatOffsetLabel(p)}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <span className="text-xs text-zinc-500">自定义提前</span>
          <input
            type="number"
            min={0}
            max={3650}
            value={customVal}
            onChange={(e) => setCustomVal(Number(e.target.value))}
            className="yd-input-sm w-20"
          />
          <Select
            value={customUnit}
            onChange={(v) => setCustomUnit(v as 'minute' | 'hour' | 'day')}
            options={[
              { value: 'minute', label: '分钟' },
              { value: 'hour', label: '小时' },
              { value: 'day', label: '天' },
            ]}
            searchable={false}
            className="min-w-[78px]"
            ariaLabel="选择提前时间单位"
          />
          <button
            type="button"
            onClick={() => addOffset({ unit: customUnit, value: customVal })}
            className="yd-btn-secondary"
          >
            <Plus className="h-3 w-3" />
            添加
          </button>
        </div>
      </div>

      {/* Overdue Persistent Nagging */}
      <div className="space-y-2.5 pt-3 border-t border-zinc-200/70">
        <label className="inline-flex items-center gap-2 text-xs font-medium text-zinc-800 cursor-pointer">
          <input
            type="checkbox"
            checked={state.overdueEnabled}
            onChange={(e) =>
              onChange({
                ...state,
                overdueEnabled: e.target.checked,
              })
            }
          />
          逾期未完成时持续催办
        </label>

        {state.overdueEnabled && (
          <div className="rounded-xl border border-zinc-200/80 bg-white p-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-700">
              <span>每隔</span>
              <input
                type="number"
                min={1}
                max={3650}
                value={state.overdueIntervalValue}
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  onChange({
                    ...state,
                    overdueIntervalValue: Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 1,
                  });
                }}
                className="yd-input-sm w-20"
              />
              <Select
                value={state.overdueIntervalUnit}
                onChange={(v) =>
                  onChange({ ...state, overdueIntervalUnit: v as 'hour' | 'day' })
                }
                options={[
                  { value: 'hour', label: '小时' },
                  { value: 'day', label: '天' },
                ]}
                searchable={false}
                className="min-w-[76px]"
                ariaLabel="选择逾期催办间隔单位"
              />
              <span>催办一次，最多</span>
              <input
                type="number"
                min={1}
                max={10}
                value={state.overdueMaxCount}
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  if (!Number.isFinite(raw)) {
                    onChange({ ...state, overdueMaxCount: 1 });
                    return;
                  }
                  const clamped = raw > 10 ? 10 : Math.max(1, Math.floor(raw));
                  onChange({ ...state, overdueMaxCount: clamped });
                }}
                className="yd-input-sm w-16"
              />
              <span>次</span>
            </div>

            {showAutoAdvanceWhenOverdue && repeatType !== 'none' && (
              <div className="flex items-center gap-1.5">
                <label className="inline-flex items-center gap-2 text-xs text-zinc-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={state.autoAdvance}
                    onChange={(e) =>
                      onChange({ ...state, autoAdvance: e.target.checked })
                    }
                  />
                  确认后自动推进
                </label>
                <InfoTooltip
                  content="达到逾期通知上限后也会自动推进至下一周期"
                  ariaLabel="确认后自动推进说明"
                />
              </div>
            )}

            {cycleErr && <div className="text-xs text-red-600">{cycleErr}</div>}
          </div>
        )}
      </div>

      {/* Outbound Channel Selection */}
      {hasAnyPush && (
        <div className="space-y-2 pt-3 border-t border-zinc-200/70">
          <span className="yd-label">推送渠道</span>
          <div className="flex gap-4 text-xs text-zinc-700">
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={state.channelMode === 'default'}
                onChange={() => onChange({ ...state, channelMode: 'default' })}
              />
              使用默认出站渠道
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={state.channelMode === 'selected'}
                onChange={() => onChange({ ...state, channelMode: 'selected' })}
              />
              指定渠道
            </label>
          </div>
          {state.channelMode === 'selected' && (
            <div className="rounded-lg border border-zinc-200/80 bg-white p-2.5 space-y-1.5">
              {outboundChannels.length === 0 ? (
                <div className="text-xs text-zinc-400">
                  暂无可用的出站渠道，请先在消息中枢添加。
                </div>
              ) : (
                outboundChannels.map((ch) => (
                  <label
                    key={ch.id}
                    className="flex items-center gap-2 text-xs text-zinc-700 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={state.selectedChannels.includes(ch.id)}
                      onChange={() => toggleChannel(ch.id)}
                    />
                    <span>{ch.name}</span>
                    <span className="text-zinc-400">({ch.type})</span>
                  </label>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function NotificationModal({
  item,
  onClose,
  onSaved,
}: {
  item: PlannerItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [state, setState] = useState<NotificationFieldsState>(() => ({
    offsets: item.remind_offsets ?? [],
    overdueEnabled: Boolean(item.overdue_config?.enabled),
    overdueIntervalUnit: item.overdue_config?.interval_unit === 'hour' ? 'hour' : 'day',
    overdueIntervalValue: item.overdue_config?.interval_value || 1,
    overdueMaxCount: Math.min(10, Math.max(1, item.overdue_config?.max_count || 3)),
    autoAdvance: item.auto_advance,
    channelMode: (item.channel_ids?.length ?? 0) > 0 ? 'selected' : 'default',
    selectedChannels: item.channel_ids ?? [],
  }));
  const [error, setError] = useState('');

  const saveMut = useMutation({
    mutationFn: () =>
      plannerApi.updateItem(
        item.id,
        buildUpsertPayloadFromItem(item, {
          remind_offsets: state.offsets,
          overdue_config: toOverdueConfigPayload(state),
          auto_advance: state.autoAdvance,
          channel_ids: state.channelMode === 'selected' ? state.selectedChannels : [],
        }),
      ),
    onSuccess: onSaved,
    onError: (err: Error) => setError(err.message),
  });

  const cycleErr = getOverdueCycleError(
    state,
    item.repeat_type,
    item.calendar_type,
    item.repeat_config,
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (cycleErr) {
      setError(cycleErr);
      return;
    }
    saveMut.mutate();
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
        <div className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900 truncate">
              通知配置 · {item.title}
            </h3>
          </div>
          <button type="button" onClick={onClose} className="yd-btn-icon shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          {error && <div className="yd-notice-error">{error}</div>}
          <div className="yd-panel-subtle p-4">
            <NotificationFields
              state={state}
              onChange={setState}
              repeatType={item.repeat_type}
              calendarType={item.calendar_type}
              repeatConfig={item.repeat_config}
            />
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
            {saveMut.isPending ? '保存中...' : '保存通知配置'}
          </button>
        </div>
      </form>
    </div>
  );
}
