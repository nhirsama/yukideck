import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, AlertTriangle, Check } from 'lucide-react';

export type ToastTone = 'info' | 'warning' | 'error';

interface ToastState {
  id: number;
  text: string;
  tone: ToastTone;
}

interface ToastContextValue {
  showToast: (text: string, tone?: ToastTone, durationMs?: number) => void;
  setProgress: (key: string, text: string | null) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION: Record<ToastTone, number> = {
  info: 2200,
  warning: 4000,
  error: 3500,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, string>>({});
  const timerRef = useRef<number | null>(null);
  const seqRef = useRef(0);

  const showToast = useCallback(
    (text: string, tone: ToastTone = 'info', durationMs?: number) => {
      seqRef.current += 1;
      setToast({ id: seqRef.current, text, tone });
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setToast(null);
        timerRef.current = null;
      }, durationMs ?? DEFAULT_DURATION[tone]);
    },
    [],
  );

  const setProgress = useCallback((key: string, text: string | null) => {
    setProgressMap((prev) => {
      if (!text) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (prev[key] === text) return prev;
      return { ...prev, [key]: text };
    });
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const value = useMemo(() => ({ showToast, setProgress }), [showToast, setProgress]);
  const progressEntries = Object.entries(progressMap);
  const hasVisible = progressEntries.length > 0 || toast !== null;

  return (
    <ToastContext.Provider value={value}>
      {children}
      {hasVisible &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            aria-live="polite"
            className="fixed top-5 right-5 z-[60] pointer-events-none flex flex-col items-end gap-2 max-w-[calc(100vw-2.5rem)]"
          >
            {progressEntries.map(([key, text]) => (
              <div
                key={key}
                className="pointer-events-auto flex items-center gap-2 rounded-xl border border-sky-200/90 bg-white/95 backdrop-blur-md px-3.5 py-2 text-xs text-sky-700 shadow-[0_8px_24px_rgba(15,23,42,0.08)]"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse shrink-0" />
                <span>{text}</span>
              </div>
            ))}
            {toast && (
              <div
                key={toast.id}
                role={toast.tone === 'error' ? 'alert' : 'status'}
                className={`pointer-events-auto flex items-center gap-2 rounded-xl border bg-white/95 backdrop-blur-md px-3.5 py-2 text-xs shadow-[0_8px_24px_rgba(15,23,42,0.08)] yd-fade-in ${
                  toast.tone === 'error'
                    ? 'border-red-200 text-red-700'
                    : toast.tone === 'warning'
                      ? 'border-amber-200 text-amber-800'
                      : 'border-zinc-200/90 text-zinc-700'
                }`}
              >
                {toast.tone === 'error' ? (
                  <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                ) : toast.tone === 'warning' ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                ) : (
                  <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                )}
                <span>{toast.text}</span>
              </div>
            )}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}
