import { useEffect, useMemo, useState } from 'react';
import { Clock, X } from 'lucide-react';
import { formatDateTimeFull, getMaxExpiryDate, toLocalDateTimeInput } from '../api';

interface ExpiryModalProps {
  open: boolean;
  currentExpiresAt: string;
  saving?: boolean;
  onClose: () => void;
  onConfirm: (isoExpiresAt: string) => void;
}

const PRESETS: { label: string; compute: (now: Date) => Date }[] = [
  {
    label: '1 小时',
    compute: (now) => new Date(now.getTime() + 1 * 3_600_000),
  },
  {
    label: '24 小时',
    compute: (now) => new Date(now.getTime() + 24 * 3_600_000),
  },
  {
    label: '7 天',
    compute: (now) => new Date(now.getTime() + 7 * 86_400_000),
  },
  {
    label: '30 天',
    compute: (now) => new Date(now.getTime() + 30 * 86_400_000),
  },
  {
    label: '1 年',
    compute: (now) => getMaxExpiryDate(now),
  },
];

export function ExpiryModal({
  open,
  currentExpiresAt,
  saving = false,
  onClose,
  onConfirm,
}: ExpiryModalProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const { minInput, maxInput } = useMemo(() => {
    const now = new Date();
    const min = new Date(now.getTime() + 60_000);
    const max = getMaxExpiryDate(now);
    return {
      minInput: toLocalDateTimeInput(min),
      maxInput: toLocalDateTimeInput(max),
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setError('');
    const parsed = new Date(currentExpiresAt);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) {
      setValue(toLocalDateTimeInput(parsed));
    } else {
      setValue(toLocalDateTimeInput(new Date(Date.now() + 24 * 3_600_000)));
    }
  }, [open, currentExpiresAt]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const applyPreset = (compute: (now: Date) => Date) => {
    setError('');
    setValue(toLocalDateTimeInput(compute(new Date())));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const target = new Date(value);
    if (!value || Number.isNaN(target.getTime())) {
      setError('请选择有效的到期时间');
      return;
    }
    const now = new Date();
    if (target.getTime() <= now.getTime()) {
      setError('到期时间必须晚于当前时间');
      return;
    }
    const max = new Date(now.getTime());
    max.setFullYear(max.getFullYear() + 1);
    max.setMinutes(max.getMinutes() + 1);
    if (target.getTime() > max.getTime()) {
      setError('单次设置的到期时间最长不能超过 1 年');
      return;
    }
    onConfirm(target.toISOString());
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/25 p-4 backdrop-blur-[2px] yd-fade-in"
      onClick={onClose}
    >
      <div
        className="yd-card yd-modal-in w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-sky-500" />
            <h2 className="text-base font-semibold text-zinc-800">更改到期时间</h2>
          </div>
          <button type="button" onClick={onClose} className="yd-btn-icon" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-1.5 text-xs text-zinc-500">
          当前到期：{formatDateTimeFull(currentExpiresAt)}。到期前随时可修改延长，单次最远可设至 1 年后。
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <div className="yd-label">快捷延长（从现在起）</div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p.compute)}
                  className="yd-btn-secondary px-2.5 py-1 text-xs"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="yd-label block" htmlFor="clipboard-expiry-input">
              自定义到期时间
            </label>
            <input
              id="clipboard-expiry-input"
              type="datetime-local"
              value={value}
              min={minInput}
              max={maxInput}
              onChange={(e) => {
                setValue(e.target.value);
                setError('');
              }}
              className="yd-input"
              required
            />
          </div>

          {error && <div className="yd-notice-error text-xs">{error}</div>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="yd-btn-secondary">
              取消
            </button>
            <button type="submit" disabled={saving} className="yd-btn-primary">
              {saving ? '保存中...' : '确认更改'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
