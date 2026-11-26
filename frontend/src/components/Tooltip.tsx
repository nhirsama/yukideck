import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type TooltipPlacement = 'top' | 'bottom';

interface TooltipProps {
  content?: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  delay?: number;
  disabled?: boolean;
  placement?: TooltipPlacement;
  maxWidth?: number;
}

interface TipCoords {
  left: number;
  top?: number;
  bottom?: number;
}

export function Tooltip({
  content,
  children,
  delay = 160,
  disabled = false,
  placement = 'top',
  maxWidth = 280,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<TipCoords | null>(null);
  const triggerElRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  const updatePosition = useCallback(() => {
    const el = triggerElRef.current;
    if (!el || !el.isConnected) {
      setOpen(false);
      return;
    }
    const rect = el.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const tipWidth = tipRef.current?.offsetWidth ?? 120;
    const tipHeight = tipRef.current?.offsetHeight ?? 32;
    const gap = 7;

    const centerX = rect.left + rect.width / 2;
    const left = Math.min(Math.max(10, centerX - tipWidth / 2), viewportW - tipWidth - 10);

    const canShowAbove = rect.top > tipHeight + gap + 8;
    const canShowBelow = viewportH - rect.bottom > tipHeight + gap + 8;
    const showAbove =
      placement === 'top' ? canShowAbove || !canShowBelow : !canShowBelow && canShowAbove;

    if (showAbove) {
      setCoords({ left, bottom: viewportH - rect.top + gap });
    } else {
      setCoords({ left, top: rect.bottom + gap });
    }
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const raf = requestAnimationFrame(updatePosition);
    return () => cancelAnimationFrame(raf);
  }, [open, content, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => updatePosition();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, updatePosition, hide]);

  useEffect(() => clearTimer, [clearTimer]);

  if (disabled || content === undefined || content === null || content === '' || !isValidElement(children)) {
    return children;
  }

  const childProps = children.props as {
    onMouseEnter?: (e: MouseEvent<HTMLElement>) => void;
    onMouseLeave?: (e: MouseEvent<HTMLElement>) => void;
    onFocus?: (e: FocusEvent<HTMLElement>) => void;
    onBlur?: (e: FocusEvent<HTMLElement>) => void;
    onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
    'aria-label'?: string;
  };

  const trigger = cloneElement(children, {
    'aria-label':
      childProps['aria-label'] ?? (typeof content === 'string' ? content : undefined),
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      childProps.onMouseEnter?.(e);
      triggerElRef.current = e.currentTarget;
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        setOpen(true);
      }, delay);
    },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => {
      childProps.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(e);
      if (e.currentTarget.matches(':focus-visible')) {
        triggerElRef.current = e.currentTarget;
        clearTimer();
        setOpen(true);
      }
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(e);
      hide();
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      childProps.onPointerDown?.(e);
      hide();
    },
  });

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            style={{
              position: 'fixed',
              left: coords?.left ?? -9999,
              top: coords?.top,
              bottom: coords?.bottom,
              maxWidth,
              visibility: coords ? 'visible' : 'hidden',
            }}
            className="pointer-events-none z-[80] rounded-lg border border-zinc-200/90 bg-white/95 backdrop-blur-xs px-2.5 py-1.5 text-xs leading-snug text-zinc-700 shadow-[0_6px_20px_rgba(15,23,42,0.08)] whitespace-pre-line tabular-nums"
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
