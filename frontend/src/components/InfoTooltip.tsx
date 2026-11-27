import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle } from 'lucide-react';

interface InfoTooltipProps {
  content: ReactNode;
  ariaLabel?: string;
  className?: string;
}

interface TipCoords {
  left: number;
  top?: number;
  bottom?: number;
}

export function InfoTooltip({
  content,
  ariaLabel = '查看详情',
  className = '',
}: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<TipCoords | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleClose = () => {
    clearTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
    }, 110);
  };

  const updatePosition = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const tipWidth = tipRef.current?.offsetWidth ?? 240;
    const tipHeight = tipRef.current?.offsetHeight ?? 80;
    const gap = 8;

    const centerX = rect.left + rect.width / 2;
    const left = Math.min(Math.max(10, centerX - tipWidth / 2), viewportW - tipWidth - 10);
    const showAbove = rect.top > tipHeight + gap + 12;

    if (showAbove) {
      setCoords({ left, bottom: viewportH - rect.top + gap });
    } else {
      setCoords({ left, top: rect.bottom + gap });
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const raf = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || tipRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScrollOrResize = () => updatePosition();
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open]);

  useEffect(() => clearTimer, []);

  return (
    <>
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        onClick={(e) => {
          e.stopPropagation();
          clearTimer();
          setOpen((v) => !v);
        }}
        onMouseEnter={() => {
          clearTimer();
          setOpen(true);
        }}
        onMouseLeave={scheduleClose}
        onFocus={() => {
          clearTimer();
          setOpen(true);
        }}
        onBlur={scheduleClose}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={`inline-flex items-center justify-center rounded-full text-zinc-400 hover:text-sky-500 focus:text-sky-500 focus:outline-none transition-colors shrink-0 ${className}`}
      >
        <AlertCircle className="h-3.5 w-3.5" />
      </span>

      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={clearTimer}
            onMouseLeave={scheduleClose}
            style={{
              position: 'fixed',
              left: coords?.left ?? -9999,
              top: coords?.top,
              bottom: coords?.bottom,
              visibility: coords ? 'visible' : 'hidden',
            }}
            className="z-[70] max-w-[min(360px,calc(100vw-20px))] rounded-xl border border-zinc-200/90 bg-white px-3.5 py-2.5 text-xs leading-relaxed text-zinc-700 shadow-[0_8px_24px_rgba(15,23,42,0.10)]"
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
