import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';
import { File as FileIcon, FolderInput } from 'lucide-react';
import type { FileEntry, PathItem } from './api';
import { formatPrefixLabel } from './justifiedLayout';

export interface ActiveStorageDrag {
  leadFile: FileEntry;
  items: PathItem[];
}

export interface StorageDropTarget {
  zone: 'section' | 'nav';
  prefix: string;
}

interface PendingDrag {
  leadFile: FileEntry;
  items: PathItem[];
  downX: number;
  downY: number;
}

const DRAG_ACTIVATION_PX = 6;
const AUTO_SCROLL_EDGE_PX = 88;
const AUTO_SCROLL_MAX_STEP = 18;

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('button, a, input, select, textarea, [role="button"]'));
}

function hitTestDropTarget(clientX: number, clientY: number): StorageDropTarget | null {
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    const navEl = el.closest<HTMLElement>('[data-storage-nav-prefix]');
    if (navEl) {
      return { zone: 'nav', prefix: navEl.dataset.storageNavPrefix ?? '' };
    }
    const secEl = el.closest<HTMLElement>('[data-storage-prefix]');
    if (secEl) {
      return { zone: 'section', prefix: secEl.dataset.storagePrefix ?? '' };
    }
  }
  return null;
}

/**
 * Pointer-Event based drag-to-move engine for storage files & images.
 * Unlike native HTML5 DnD, Pointer Events allow:
 * - Native mouse-wheel scrolling while holding & dragging a file/image
 * - Smooth 60fps edge auto-scroll near the top/bottom of the viewport
 * - Unified drag behavior for both images and non-image files
 */
export function useStoragePointerMove(
  onDropMove: (targetPrefix: string, items: PathItem[]) => void,
) {
  const [activeDrag, setActiveDrag] = useState<ActiveStorageDrag | null>(null);
  const [dropTarget, setDropTarget] = useState<StorageDropTarget | null>(null);

  const onDropMoveRef = useRef(onDropMove);
  onDropMoveRef.current = onDropMove;

  const pendingRef = useRef<PendingDrag | null>(null);
  const activeDragRef = useRef<ActiveStorageDrag | null>(null);
  const dropTargetRef = useRef<StorageDropTarget | null>(null);
  const pointerPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const autoScrollRafRef = useRef<number | null>(null);

  const updateDropTarget = useCallback((clientX: number, clientY: number) => {
    const next = hitTestDropTarget(clientX, clientY);
    const cur = dropTargetRef.current;
    if (cur?.zone === next?.zone && cur?.prefix === next?.prefix) return;
    dropTargetRef.current = next;
    setDropTarget(next);
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current !== null) {
      window.cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  const startAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current !== null) return;
    const step = () => {
      if (!activeDragRef.current) {
        autoScrollRafRef.current = null;
        return;
      }
      const { x, y } = pointerPosRef.current;
      const vh = window.innerHeight;
      let delta = 0;
      if (y < AUTO_SCROLL_EDGE_PX) {
        const ratio = (AUTO_SCROLL_EDGE_PX - y) / AUTO_SCROLL_EDGE_PX;
        delta = -Math.ceil(ratio * AUTO_SCROLL_MAX_STEP);
      } else if (y > vh - AUTO_SCROLL_EDGE_PX) {
        const ratio = (y - (vh - AUTO_SCROLL_EDGE_PX)) / AUTO_SCROLL_EDGE_PX;
        delta = Math.ceil(ratio * AUTO_SCROLL_MAX_STEP);
      }
      if (delta !== 0) {
        const beforeY = window.scrollY;
        window.scrollBy(0, delta);
        if (window.scrollY !== beforeY) {
          updateDropTarget(x, y);
        }
      }
      autoScrollRafRef.current = window.requestAnimationFrame(step);
    };
    autoScrollRafRef.current = window.requestAnimationFrame(step);
  }, [updateDropTarget]);

  const finishDrag = useCallback(
    (cancelled: boolean) => {
      stopAutoScroll();
      document.body.style.userSelect = '';
      document.body.style.cursor = '';

      const drag = activeDragRef.current;
      const target = dropTargetRef.current;

      pendingRef.current = null;
      activeDragRef.current = null;
      dropTargetRef.current = null;

      if (drag) {
        setActiveDrag(null);
        setDropTarget(null);
        if (!cancelled && target) {
          onDropMoveRef.current(target.prefix, drag.items);
        }
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 90);
      }
    },
    [stopAutoScroll],
  );

  // Sync floating overlay position on mount/update without letting React overwrite transform.
  useLayoutEffect(() => {
    const ov = overlayRef.current;
    if (ov && activeDrag) {
      const { x, y } = pointerPosRef.current;
      ov.style.transform = `translate3d(${x + 14}px, ${y + 14}px, 0)`;
    }
  }, [activeDrag, dropTarget]);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      pointerPosRef.current = { x: e.clientX, y: e.clientY };

      if (!activeDragRef.current) {
        const pending = pendingRef.current;
        if (!pending) return;
        if (Math.hypot(e.clientX - pending.downX, e.clientY - pending.downY) < DRAG_ACTIVATION_PX) {
          return;
        }
        window.getSelection()?.removeAllRanges();
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
        suppressClickRef.current = true;

        const nextDrag: ActiveStorageDrag = {
          leadFile: pending.leadFile,
          items: pending.items,
        };
        activeDragRef.current = nextDrag;
        setActiveDrag(nextDrag);
        updateDropTarget(e.clientX, e.clientY);
        startAutoScroll();
        return;
      }

      const ov = overlayRef.current;
      if (ov) {
        ov.style.transform = `translate3d(${e.clientX + 14}px, ${e.clientY + 14}px, 0)`;
      }
      updateDropTarget(e.clientX, e.clientY);
    };

    const onScroll = () => {
      if (!activeDragRef.current) return;
      const { x, y } = pointerPosRef.current;
      updateDropTarget(x, y);
    };

    const onPointerUp = () => {
      if (activeDragRef.current) finishDrag(false);
      else pendingRef.current = null;
    };

    const onPointerCancel = () => {
      if (activeDragRef.current) finishDrag(true);
      else pendingRef.current = null;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeDragRef.current) {
        e.preventDefault();
        finishDrag(true);
      }
    };

    const onClickCapture = (e: MouseEvent) => {
      if (suppressClickRef.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('click', onClickCapture, true);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('click', onClickCapture, true);
    };
  }, [finishDrag, startAutoScroll, updateDropTarget]);

  useEffect(() => {
    return () => {
      stopAutoScroll();
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [stopAutoScroll]);

  const handleTilePointerDown = useCallback(
    (e: React.PointerEvent, file: FileEntry, items: PathItem[]) => {
      if (e.button !== 0 || e.pointerType === 'touch') return;
      if (isInteractiveTarget(e.target)) return;
      pendingRef.current = {
        leadFile: file,
        items,
        downX: e.clientX,
        downY: e.clientY,
      };
    },
    [],
  );

  const draggingKeys = activeDrag
    ? new Set(activeDrag.items.filter((i) => i.type === 'file').map((i) => i.path))
    : null;

  const overlayPortal =
    activeDrag && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={overlayRef}
            style={{
              position: 'fixed',
              left: 0,
              top: 0,
              pointerEvents: 'none',
              zIndex: 70,
              willChange: 'transform',
            }}
            className="flex items-center gap-2.5 rounded-xl border border-sky-300/90 bg-white/95 px-2.5 py-2 shadow-[0_12px_32px_rgba(14,165,233,0.2)] ring-2 ring-sky-200/70 backdrop-blur-md max-w-[260px]"
          >
            {activeDrag.leadFile.is_image ? (
              <img
                src={activeDrag.leadFile.url}
                alt=""
                className="h-10 w-10 rounded-lg object-cover border border-zinc-200/80 shrink-0 yd-checkerboard"
              />
            ) : (
              <div className="h-10 w-10 rounded-lg bg-[#f3f6fa] border border-zinc-200/80 flex items-center justify-center shrink-0">
                <FileIcon className="h-5 w-5 text-zinc-400" />
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-800">
                <span className="truncate">{activeDrag.leadFile.name}</span>
                {activeDrag.items.length > 1 && (
                  <span className="shrink-0 rounded-full bg-sky-500 px-1.5 py-0.5 text-[10px] font-semibold text-white tabular-nums">
                    {activeDrag.items.length}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-[11px] text-sky-600">
                <FolderInput className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {dropTarget
                    ? `移至「${formatPrefixLabel(dropTarget.prefix)}」`
                    : '拖到目标路径或滚轮翻页'}
                </span>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return {
    activeDrag,
    dropTarget,
    draggingKeys,
    handleTilePointerDown,
    overlayPortal,
  };
}
