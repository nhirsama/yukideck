import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pause, X } from 'lucide-react';
import { plannerApi, type PauseItemInput, type PlannerItem } from './api';

type PausePreset = '1h' | '3h' | '1d' | '3d' | '7d' | 'indefinite' | 'custom';

function defaultCustomResumeLocal(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

const PRESETS: Array<{ key: PausePreset; label: string; ms?: number }> = [
  { key: '1h', label: '1 小时', ms: 60 * 60 * 1000 },
  { key: '3h', label: '3 小时', ms: 3 * 60 * 60 * 1000 },
  { key: '1d', label: '1 天', ms: 24 * 60 * 60 * 1000 },
  { key: '3d', label: '3 天', ms: 3 * 24 * 60 * 60 * 1000 },
  { key: '7d', label: '7 天', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: 'indefinite', label: '一直暂停' },
  { key: 'custom', label: '自定义时间' },
];

export function PauseModal({
  item,
  onClose,
  onSaved,
}: {
  item: PlannerItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [preset, setPreset] = useState<PausePreset>('1d');
  const [customLocal, setCustomLocal] = useState(defaultCustomResumeLocal);
  const [error, setError] = useState('');

  const pauseMut = useMutation({
    mutationFn: (payload: PauseItemInput) => plannerApi.pauseItem(item.id, payload),
    onSuccess: onSaved,
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (preset === 'indefinite') {
      pauseMut.mutate({ indefinite: true });
      return;
    }
    if (preset === 'custom') {
      const parsed = new Date(customLocal);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        setError('自定义恢复时间必须晚于当前时间');
        return;
      }
      pauseMut.mutate({ until: parsed.toISOString() });
      return;
    }

    const found = PRESETS.find((p) => p.key === preset);
    if (!found?.ms) return;
    pauseMut.mutate({ until: new Date(Date.now() + found.ms).toISOString() });
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-slate-900/15 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-0 sm:p-4"
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-full max-w-md max-h-[92dvh] sm:max-h-[calc(100dvh-2rem)] flex flex-col rounded-t-2xl sm:rounded-2xl border border-zinc-200/90 bg-white shadow-xl overflow-hidden"
      >
        <div className="px-4 sm:px-6 py-3.5 sm:py-4 border-b border-zinc-100 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Pause className="h-4 w-4 text-zinc-500 shrink-0" />
            <h3 className="text-sm font-semibold text-zinc-900 truncate">
              暂停通知 · {item.title}
            </h3>
          </div>
          <button type="button" onClick={onClose} className="yd-btn-icon shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-4 overflow-y-auto">
          {error && <div className="yd-notice-error">{error}</div>}

          <div className="space-y-2">
            <span className="yd-label">选择暂停时长</span>
            <div className="grid grid-cols-3 gap-2">
              {PRESETS.map((p) => {
                const active = preset === p.key;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setPreset(p.key)}
                    className={`rounded-xl border px-3 py-2 text-xs font-medium transition-colors ${
                      active
                        ? 'border-sky-300 bg-sky-50 text-sky-700'
                        : 'border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {preset === 'custom' && (
            <label className="block space-y-1.5">
              <span className="yd-label">自动恢复时间</span>
              <input
                type="datetime-local"
                required
                value={customLocal}
                onChange={(e) => setCustomLocal(e.target.value)}
                className="yd-input"
              />
            </label>
          )}

          <p className="text-xs text-zinc-500 leading-relaxed">
            {preset === 'indefinite'
              ? '将持续暂停该事项的所有提醒与催办，直到你手动恢复。'
              : '暂停期间错过的通知将直接跳过不补发，到达恢复时间后自动恢复。'}
          </p>
        </div>

        <div className="px-4 sm:px-6 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] sm:pb-3.5 border-t border-zinc-100 bg-zinc-50/50 flex justify-end gap-2 shrink-0">
          <button type="button" onClick={onClose} className="yd-btn-secondary">
            取消
          </button>
          <button type="submit" disabled={pauseMut.isPending} className="yd-btn-primary">
            {pauseMut.isPending ? '保存中...' : '确认暂停'}
          </button>
        </div>
      </form>
    </div>
  );
}
