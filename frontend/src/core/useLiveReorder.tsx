import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';

export type LiveReorderLayout = 'list' | 'grid' | 'waterfall';

export interface UseLiveReorderOptions<T extends { id: number }> {
  items: T[];
  enabled: boolean;
  layout: LiveReorderLayout;
  /**
   * Required when `layout === 'waterfall'`: current columns array.
   * During drag, column membership of non-dragged items stays frozen (Kanban-style) so
   * dragging never causes cascading cross-column jitter.
   */
  columns?: T[][];
  /**
   * Optional custom serializer converting 2D waterfall columns into a 1D id order on commit
   * (e.g. horizontal row/y-order inverse of shortest-column-first). Defaults to column-major flat().
   */
  serializeColumns?: (cols: number[][]) => number[];
  /**
   * Optional waterfall drop callback receiving both the final 2D columns and serialized 1D ids.
   * When provided, columns stay pinned in place on drop without a forced rebalance jump.
   */
  onCommitColumns?: (cols: number[][], orderedIds: number[], orderChanged: boolean) => void;
  /** Optional group key; items only reorder within the same group (e.g. starred vs normal). */
  getGroup?: (item: T) => string | number | boolean;
  /** Optional predicate to prevent dragging specific items (e.g. optimistic temp ids <= 0). */
  canDragItem?: (item: T) => boolean;
  /** Called once on drop when the 1D order actually changed (ignored if `onCommitColumns` is set). */
  onCommit: (orderedIds: number[]) => void;
}

export interface DragOverlayState<T> {
  item: T;
  width: number;
  height: number;
  initialLeft: number;
  initialTop: number;
}

export interface LiveReorderItemProps {
  ref: (el: HTMLElement | null) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onClickCapture: (e: React.MouseEvent) => void;
}

export interface LiveReorderColumnProps {
  ref: (el: HTMLElement | null) => void;
}

export interface UseLiveReorderResult<T extends { id: number }> {
  orderedItems: T[];
  orderedColumns: T[][];
  activeId: number | null;
  activeGroup: string | number | boolean | null;
  isDragging: boolean;
  overlay: DragOverlayState<T> | null;
  overlayRef: React.RefObject<HTMLDivElement | null>;
  overlayPosRef: React.RefObject<{ x: number; y: number }>;
  getItemProps: (item: T) => LiveReorderItemProps;
  getColumnProps: (colIdx: number) => LiveReorderColumnProps;
}

interface DocRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface PendingDrag<T> {
  item: T;
  downX: number;
  downY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  width: number;
  height: number;
}

const DRAG_ACTIVATION_PX = 6;
const FLIP_DURATION_MS = 220;
const FLIP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const AUTO_SCROLL_EDGE_PX = 72;
const AUTO_SCROLL_MAX_STEP = 14;
// Schmitt-trigger hysteresis half-band past target center (in normalized [-1, +1] half-span units,
// capped in pixels so tall/wide cards remain responsive while resisting accidental reversals).
const HYSTERESIS_RATIO = 0.28;
const HYSTERESIS_MAX_PX = 38;
// Horizontal penetration margin when crossing into another waterfall column.
const COLUMN_ENTRY_HYSTERESIS_PX = 24;

function calcHysteresisThreshold(spanPx: number): number {
  const half = spanPx / 2;
  if (half <= 1) return 0;
  return Math.min(HYSTERESIS_RATIO, HYSTERESIS_MAX_PX / half);
}

function toDocRect(rect: DOMRect): DocRect {
  const sx = window.scrollX;
  const sy = window.scrollY;
  return {
    left: rect.left + sx,
    top: rect.top + sy,
    right: rect.right + sx,
    bottom: rect.bottom + sy,
    width: rect.width,
    height: rect.height,
  };
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[data-drag-handle="true"]')) return false;
  return Boolean(
    target.closest('button, a, input, select, textarea, label, [role="button"], [data-no-drag]'),
  );
}

function moveArrayIndex(ids: number[], fromIdx: number, toIdx: number): number[] {
  const next = ids.slice();
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function columnsEqual(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!arraysEqual(a[i], b[i])) return false;
  }
  return true;
}

/**
 * Unified Pointer-Event + FLIP live-reorder hook supporting:
 * - Vertical lists & tables (`list`) — Schmitt-trigger midpoint crossing
 * - Multi-column equal grids (`grid`) — 2D directional Schmitt-trigger hysteresis
 * - Horizontal / vertical waterfalls (`waterfall`) — frozen-column Kanban drag during interaction
 *   (zero cross-column jitter) with optional pinned drop layout (no forced rebalance)
 */
export function useLiveReorder<T extends { id: number }>({
  items,
  enabled,
  layout,
  columns,
  serializeColumns,
  onCommitColumns,
  getGroup,
  canDragItem,
  onCommit,
}: UseLiveReorderOptions<T>): UseLiveReorderResult<T> {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [previewIds, setPreviewIds] = useState<number[] | null>(null);
  const [dragCols, setDragCols] = useState<number[][] | null>(null);
  const [overlay, setOverlay] = useState<DragOverlayState<T> | null>(null);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const overlayPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const nodeMapRef = useRef<Map<number, HTMLElement>>(new Map());
  const colNodeMapRef = useRef<Map<number, HTMLElement>>(new Map());
  const refCallbacksRef = useRef<Map<number, (el: HTMLElement | null) => void | (() => void)>>(
    new Map(),
  );
  const colRefCallbacksRef = useRef<Map<number, (el: HTMLElement | null) => void | (() => void)>>(
    new Map(),
  );
  const cancelAnimMapRef = useRef<Map<HTMLElement, () => void>>(new Map());

  // Settled layout rects in document coordinates (updated right after React layout commit,
  // before applying FLIP inverse transforms, so mid-flight cards never corrupt hit-testing).
  const layoutRectsRef = useRef<Map<number, DocRect>>(new Map());
  const colBoundsRef = useRef<Map<number, DocRect>>(new Map());
  const flipPrevRectsRef = useRef<Map<number, DocRect> | null>(null);

  // Latest props & live drag state refs so window listeners never go stale.
  const itemsRef = useRef<T[]>(items);
  itemsRef.current = items;
  const columnsRef = useRef<T[][] | undefined>(columns);
  columnsRef.current = columns;
  const serializeColumnsRef = useRef(serializeColumns);
  serializeColumnsRef.current = serializeColumns;
  const onCommitColumnsRef = useRef(onCommitColumns);
  onCommitColumnsRef.current = onCommitColumns;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const getGroupRef = useRef(getGroup);
  getGroupRef.current = getGroup;
  const canDragItemRef = useRef(canDragItem);
  canDragItemRef.current = canDragItem;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const pendingRef = useRef<PendingDrag<T> | null>(null);
  const activeIdRef = useRef<number | null>(null);
  const previewIdsRef = useRef<number[] | null>(null);
  const dragColsRef = useRef<number[][] | null>(null);
  const initialColsRef = useRef<number[][] | null>(null);
  const initialIdsRef = useRef<number[] | null>(null);
  const groupRankMapRef = useRef<Map<string | number | boolean, number>>(new Map());
  const grabOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pointerClientRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastSwapTimeRef = useRef<number>(0);
  const lastSwapClientRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef<boolean>(false);
  const autoScrollRafRef = useRef<number | null>(null);

  const snapshotVisualRects = useCallback((): Map<number, DocRect> => {
    const map = new Map<number, DocRect>();
    for (const [id, el] of nodeMapRef.current.entries()) {
      map.set(id, toDocRect(el.getBoundingClientRect()));
    }
    return map;
  }, []);

  const clearElementAnimation = useCallback((el: HTMLElement) => {
    const cancel = cancelAnimMapRef.current.get(el);
    if (cancel) {
      cancel();
      cancelAnimMapRef.current.delete(el);
    }
    el.style.transition = '';
    el.style.transform = '';
    el.style.willChange = '';
  }, []);

  const measureSettledRects = useCallback(() => {
    for (const el of nodeMapRef.current.values()) {
      clearElementAnimation(el);
    }
    const map = new Map<number, DocRect>();
    for (const [id, el] of nodeMapRef.current.entries()) {
      map.set(id, toDocRect(el.getBoundingClientRect()));
    }
    layoutRectsRef.current = map;

    const cMap = new Map<number, DocRect>();
    for (const [idx, el] of colNodeMapRef.current.entries()) {
      cMap.set(idx, toDocRect(el.getBoundingClientRect()));
    }
    colBoundsRef.current = cMap;
  }, [clearElementAnimation]);

  // Apply overlay transform synchronously on mount/re-render without letting React style clobber it.
  useLayoutEffect(() => {
    const ov = overlayRef.current;
    if (ov && overlay) {
      const { x, y } = overlayPosRef.current;
      ov.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
  }, [overlay, previewIds, dragCols]);

  // FLIP animation + settled rect refresh whenever previewIds / dragCols / balanced columns change.
  useLayoutEffect(() => {
    const prevRects = flipPrevRectsRef.current;
    flipPrevRectsRef.current = null;

    if (!previewIds && !dragCols && !prevRects) {
      return;
    }

    // 1. Clear inline transforms so we can read exact post-layout positions.
    for (const el of nodeMapRef.current.values()) {
      const cancel = cancelAnimMapRef.current.get(el);
      if (cancel) {
        cancel();
        cancelAnimMapRef.current.delete(el);
      }
      el.style.transition = 'none';
      el.style.transform = '';
    }

    // 2. Batch-read all settled rects in document coordinates.
    const nextRects = new Map<number, DocRect>();
    for (const [id, el] of nodeMapRef.current.entries()) {
      nextRects.set(id, toDocRect(el.getBoundingClientRect()));
    }
    layoutRectsRef.current = nextRects;

    const nextColBounds = new Map<number, DocRect>();
    for (const [idx, el] of colNodeMapRef.current.entries()) {
      nextColBounds.set(idx, toDocRect(el.getBoundingClientRect()));
    }
    colBoundsRef.current = nextColBounds;

    // 3. Invert & play FLIP for displaced items (skip active placeholder while still dragging).
    const animated: HTMLElement[] = [];
    const curActiveId = activeIdRef.current;
    if (prevRects) {
      for (const [id, el] of nodeMapRef.current.entries()) {
        if (id === curActiveId) {
          el.style.transition = '';
          continue;
        }
        const prev = prevRects.get(id);
        const next = nextRects.get(id);
        if (!prev || !next) {
          el.style.transition = '';
          continue;
        }
        const dx = prev.left - next.left;
        const dy = prev.top - next.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          el.style.transition = 'none';
          el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
          el.style.willChange = 'transform';
          animated.push(el);
        } else {
          el.style.transition = '';
        }
      }
    } else {
      for (const el of nodeMapRef.current.values()) {
        el.style.transition = '';
      }
    }

    if (animated.length > 0) {
      // Force one synchronous reflow so the browser registers the inverted starting transform.
      void document.body.offsetHeight;
      for (const el of animated) {
        el.style.transition = `transform ${FLIP_DURATION_MS}ms ${FLIP_EASING}`;
        el.style.transform = 'translate3d(0, 0, 0)';
        let done = false;
        const onEnd = (ev: TransitionEvent) => {
          if (ev.target === el && ev.propertyName === 'transform') {
            finish();
          }
        };
        const timer = window.setTimeout(() => finish(), FLIP_DURATION_MS + 60);
        const cancel = () => {
          if (done) return;
          done = true;
          window.clearTimeout(timer);
          el.removeEventListener('transitionend', onEnd);
        };
        const finish = () => {
          cancel();
          cancelAnimMapRef.current.delete(el);
          el.style.transition = '';
          el.style.transform = '';
          el.style.willChange = '';
        };
        el.addEventListener('transitionend', onEnd);
        cancelAnimMapRef.current.set(el, cancel);
      }
    }
  }, [previewIds, dragCols, columns]);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current !== null) {
      window.cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  const restoreBodyStyles = useCallback(() => {
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }, []);

  const evaluateWaterfallReorder = useCallback(
    (clientX: number, clientY: number) => {
      const curActiveId = activeIdRef.current;
      const curCols = dragColsRef.current;
      if (curActiveId == null || !curCols || curCols.length === 0) return;

      const docX = clientX + window.scrollX;
      const docY = clientY + window.scrollY;
      const rects = layoutRectsRef.current;
      const cBounds = colBoundsRef.current;

      const activeRect = rects.get(curActiveId);
      if (
        activeRect &&
        docX >= activeRect.left &&
        docX <= activeRect.right &&
        docY >= activeRect.top &&
        docY <= activeRect.bottom
      ) {
        return;
      }

      // Locate current (sourceColIdx, sourceRowIdx) of activeId.
      let sourceColIdx = -1;
      let sourceRowIdx = -1;
      for (let c = 0; c < curCols.length; c++) {
        const r = curCols[c].indexOf(curActiveId);
        if (r !== -1) {
          sourceColIdx = c;
          sourceRowIdx = r;
          break;
        }
      }
      if (sourceColIdx === -1) return;

      // Determine target column from pointer X.
      let targetColIdx = -1;
      for (let c = 0; c < curCols.length; c++) {
        const b = cBounds.get(c);
        if (!b) continue;
        if (docX >= b.left && docX <= b.right) {
          targetColIdx = c;
          break;
        }
      }
      if (targetColIdx === -1) {
        // Clamp past outer left / right edges; ignore inner gaps between columns so pointer doesn't flicker.
        const firstB = cBounds.get(0);
        const lastB = cBounds.get(curCols.length - 1);
        if (firstB && docX < firstB.left) {
          targetColIdx = 0;
        } else if (lastB && docX > lastB.right) {
          targetColIdx = curCols.length - 1;
        } else {
          return;
        }
      }

      // Horizontal Lenz-law hysteresis when crossing into a different column:
      // pointer must penetrate at least COLUMN_ENTRY_HYSTERESIS_PX inside the target column edge.
      if (targetColIdx !== sourceColIdx) {
        const targetBound = cBounds.get(targetColIdx);
        if (targetBound) {
          const inset = Math.min(COLUMN_ENTRY_HYSTERESIS_PX, targetBound.width * 0.2);
          if (targetColIdx > sourceColIdx && docX < targetBound.left + inset) {
            return;
          }
          if (targetColIdx < sourceColIdx && docX > targetBound.right - inset) {
            return;
          }
        }
      }

      const itemById = new Map<number, T>();
      for (const it of itemsRef.current) itemById.set(it.id, it);
      const activeItem = itemById.get(curActiveId);
      if (!activeItem) return;

      const groupFn = getGroupRef.current;
      const rankMap = groupRankMapRef.current;
      const getRank = (id: number): number => {
        if (!groupFn) return 0;
        const it = itemById.get(id);
        if (!it) return 0;
        return rankMap.get(groupFn(it)) ?? 0;
      };
      const activeRank = getRank(curActiveId);

      // Build columns without activeId to compute valid per-column group boundaries
      // (higher-priority groups such as starred always stay above lower-priority groups in each column).
      const colsWithoutActive = curCols.map((col, idx) =>
        idx === sourceColIdx ? col.filter((id) => id !== curActiveId) : col,
      );

      const targetOtherIds = colsWithoutActive[targetColIdx];
      let minRow = 0;
      let maxRow = targetOtherIds.length;
      if (groupFn) {
        for (let i = 0; i < targetOtherIds.length; i++) {
          const r = getRank(targetOtherIds[i]);
          if (r < activeRank) minRow = i + 1;
          else if (r > activeRank && i < maxRow) maxRow = i;
        }
        if (minRow > maxRow) return;
      }

      let desiredRow = sourceRowIdx;

      if (targetColIdx === sourceColIdx) {
        // Same column: pure 1D vertical Schmitt-trigger hysteresis!
        const colIds = curCols[sourceColIdx];
        let hitId: number | null = null;
        let hitRect: DocRect | null = null;
        for (const id of colIds) {
          if (id === curActiveId) continue;
          if (groupFn && getRank(id) !== activeRank) continue;
          const r = rects.get(id);
          if (!r) continue;
          if (docY >= r.top - 4 && docY <= r.bottom + 4) {
            hitId = id;
            hitRect = r;
            break;
          }
        }
        if (hitId == null) {
          // Check gap between cards or above/below column ends.
          let bestDist = 32;
          for (const id of colIds) {
            if (id === curActiveId) continue;
            if (groupFn && getRank(id) !== activeRank) continue;
            const r = rects.get(id);
            if (!r) continue;
            const dy = docY < r.top ? r.top - docY : docY > r.bottom ? docY - r.bottom : 0;
            if (dy < bestDist) {
              bestDist = dy;
              hitId = id;
              hitRect = r;
            }
          }
        }
        if (hitId == null || !hitRect) return;

        const hitRow = colIds.indexOf(hitId);
        const otherRow = targetOtherIds.indexOf(hitId);
        if (hitRow === -1 || otherRow === -1) return;

        const midY = hitRect.top + hitRect.height / 2;
        const halfH = Math.max(1, hitRect.height / 2);
        const uy = (docY - midY) / halfH;
        const hy = calcHysteresisThreshold(hitRect.height);

        if (sourceRowIdx < hitRow) {
          desiredRow = uy > hy ? otherRow + 1 : otherRow;
        } else {
          desiredRow = uy < -hy ? otherRow : otherRow + 1;
        }
        desiredRow = Math.max(minRow, Math.min(maxRow, desiredRow));
        if (desiredRow === sourceRowIdx) return;
      } else {
        // Different column: place directly at vertical slot determined by card midpoints.
        let slot = minRow;
        for (let i = minRow; i < maxRow; i++) {
          const r = rects.get(targetOtherIds[i]);
          if (!r) continue;
          if (docY > r.top + r.height / 2) {
            slot = i + 1;
          } else {
            break;
          }
        }
        desiredRow = slot;
      }

      const nextCols = colsWithoutActive.map((col, idx) => {
        if (idx !== targetColIdx) return col;
        const copy = col.slice();
        copy.splice(desiredRow, 0, curActiveId);
        return copy;
      });

      flipPrevRectsRef.current = snapshotVisualRects();
      dragColsRef.current = nextCols;
      previewIdsRef.current = nextCols.flat();
      setDragCols(nextCols);
    },
    [snapshotVisualRects],
  );

  const evaluateReorder = useCallback(
    (clientX: number, clientY: number) => {
      if (layoutRef.current === 'waterfall' && dragColsRef.current) {
        evaluateWaterfallReorder(clientX, clientY);
        return;
      }

      const curActiveId = activeIdRef.current;
      const curIds = previewIdsRef.current;
      if (curActiveId == null || !curIds || curIds.length < 2) return;

      const curLayout = layoutRef.current;
      const now = performance.now();

      // Anti-oscillation guard for 2D grid.
      if (curLayout === 'grid' && lastSwapClientRef.current) {
        const dt = now - lastSwapTimeRef.current;
        const moved = Math.hypot(
          clientX - lastSwapClientRef.current.x,
          clientY - lastSwapClientRef.current.y,
        );
        if (dt < 140 || moved < 8) {
          return;
        }
      }

      const docX = clientX + window.scrollX;
      const docY = clientY + window.scrollY;
      const rects = layoutRectsRef.current;

      const activeRect = rects.get(curActiveId);
      if (
        activeRect &&
        docX >= activeRect.left &&
        docX <= activeRect.right &&
        docY >= activeRect.top &&
        docY <= activeRect.bottom
      ) {
        return;
      }

      const itemById = new Map<number, T>();
      for (const it of itemsRef.current) itemById.set(it.id, it);
      const activeItem = itemById.get(curActiveId);
      if (!activeItem) return;
      const groupFn = getGroupRef.current;
      const activeGrp = groupFn ? groupFn(activeItem) : null;

      let hitId: number | null = null;
      let hitRect: DocRect | null = null;
      const pad = curLayout === 'list' ? 4 : 2;

      for (const id of curIds) {
        if (id === curActiveId) continue;
        const cand = itemById.get(id);
        if (!cand) continue;
        if (groupFn && groupFn(cand) !== activeGrp) continue;
        const r = rects.get(id);
        if (!r) continue;
        if (
          docX >= r.left - pad &&
          docX <= r.right + pad &&
          docY >= r.top - pad &&
          docY <= r.bottom + pad
        ) {
          hitId = id;
          hitRect = r;
          break;
        }
      }

      if (hitId == null && curLayout === 'list') {
        let bestDist = 28;
        for (const id of curIds) {
          if (id === curActiveId) continue;
          const cand = itemById.get(id);
          if (!cand) continue;
          if (groupFn && groupFn(cand) !== activeGrp) continue;
          const r = rects.get(id);
          if (!r) continue;
          if (docX < r.left - 32 || docX > r.right + 32) continue;
          const dy = docY < r.top ? r.top - docY : docY > r.bottom ? docY - r.bottom : 0;
          if (dy < bestDist) {
            bestDist = dy;
            hitId = id;
            hitRect = r;
          }
        }
      }

      if (hitId == null || !hitRect) return;

      const activeIdx = curIds.indexOf(curActiveId);
      const hitIdx = curIds.indexOf(hitId);
      if (activeIdx === -1 || hitIdx === -1) return;

      let desiredIdx = activeIdx;

      if (curLayout === 'list') {
        const midY = hitRect.top + hitRect.height / 2;
        const halfH = Math.max(1, hitRect.height / 2);
        const uy = (docY - midY) / halfH;
        const hy = calcHysteresisThreshold(hitRect.height);
        const otherIds = curIds.filter((id) => id !== curActiveId);
        const otherIdx = otherIds.indexOf(hitId);
        if (activeIdx < hitIdx) {
          desiredIdx = uy > hy ? otherIdx + 1 : otherIdx;
        } else {
          desiredIdx = uy < -hy ? otherIdx : otherIdx + 1;
        }
      } else {
        // 2D directional Schmitt-trigger hysteresis for equal-cell grid.
        if (activeRect) {
          const acx = activeRect.left + activeRect.width / 2;
          const acy = activeRect.top + activeRect.height / 2;
          const hcx = hitRect.left + hitRect.width / 2;
          const hcy = hitRect.top + hitRect.height / 2;
          const vx = hcx - acx;
          const vy = hcy - acy;
          const len = Math.hypot(vx, vy);
          if (len >= 1) {
            const nx = vx / len;
            const ny = vy / len;
            const ux = (docX - hcx) / Math.max(1, hitRect.width / 2);
            const uy = (docY - hcy) / Math.max(1, hitRect.height / 2);
            const progress = ux * nx + uy * ny;
            const hx = calcHysteresisThreshold(hitRect.width);
            const hy = calcHysteresisThreshold(hitRect.height);
            const threshold = Math.hypot(nx * hx, ny * hy);
            if (progress <= threshold) return;
          }
        }
        desiredIdx = hitIdx;
      }

      if (desiredIdx === activeIdx) return;

      const nextIds = moveArrayIndex(curIds, activeIdx, desiredIdx);
      flipPrevRectsRef.current = snapshotVisualRects();
      previewIdsRef.current = nextIds;
      lastSwapTimeRef.current = now;
      lastSwapClientRef.current = { x: clientX, y: clientY };
      setPreviewIds(nextIds);
    },
    [evaluateWaterfallReorder, snapshotVisualRects],
  );

  const finishDrag = useCallback(
    (cancelled: boolean) => {
      stopAutoScroll();
      restoreBodyStyles();

      const finalCols = dragColsRef.current;
      const origCols = initialColsRef.current;
      const serializeFn = serializeColumnsRef.current;
      const finalIds = finalCols
        ? serializeFn
          ? serializeFn(finalCols)
          : finalCols.flat()
        : previewIdsRef.current;
      const origIds = initialIdsRef.current;
      const wasActive = activeIdRef.current !== null;

      pendingRef.current = null;
      activeIdRef.current = null;
      previewIdsRef.current = null;
      dragColsRef.current = null;
      initialColsRef.current = null;
      initialIdsRef.current = null;
      lastSwapClientRef.current = null;

      if (wasActive) {
        const orderChanged = Boolean(finalIds && origIds && !arraysEqual(finalIds, origIds));
        const colsChanged = Boolean(finalCols && origCols && !columnsEqual(finalCols, origCols));
        // Only run drop-time FLIP on cancel-rollback, or on waterfall drop when caller does NOT pin columns.
        if ((cancelled && (orderChanged || colsChanged)) || (finalCols && !onCommitColumnsRef.current)) {
          flipPrevRectsRef.current = snapshotVisualRects();
        }
        setActiveId(null);
        setOverlay(null);
        setPreviewIds(null);
        setDragCols(null);

        if (!cancelled) {
          if (finalCols && onCommitColumnsRef.current) {
            if (colsChanged || orderChanged) {
              onCommitColumnsRef.current(finalCols, finalIds ?? finalCols.flat(), orderChanged);
            }
          } else if (orderChanged && finalIds) {
            onCommitRef.current(finalIds);
          }
        }

        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 90);
      }
    },
    [restoreBodyStyles, snapshotVisualRects, stopAutoScroll],
  );

  const startAutoScrollLoop = useCallback(() => {
    if (autoScrollRafRef.current !== null) return;
    const step = () => {
      if (activeIdRef.current === null) {
        autoScrollRafRef.current = null;
        return;
      }
      const { x, y } = pointerClientRef.current;
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
          evaluateReorder(x, y);
        }
      }
      autoScrollRafRef.current = window.requestAnimationFrame(step);
    };
    autoScrollRafRef.current = window.requestAnimationFrame(step);
  }, [evaluateReorder]);

  // Global pointer & keyboard listeners while pending or dragging.
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      pointerClientRef.current = { x: e.clientX, y: e.clientY };

      if (activeIdRef.current === null) {
        const pending = pendingRef.current;
        if (!pending) return;
        const dist = Math.hypot(e.clientX - pending.downX, e.clientY - pending.downY);
        if (dist < DRAG_ACTIVATION_PX) return;

        // Crossed threshold -> activate drag.
        window.getSelection()?.removeAllRanges();
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
        suppressClickRef.current = true;

        // Record group encounter order (e.g. starred=true -> rank 0, starred=false -> rank 1).
        const rankMap = new Map<string | number | boolean, number>();
        const groupFn = getGroupRef.current;
        if (groupFn) {
          for (const it of itemsRef.current) {
            const g = groupFn(it);
            if (!rankMap.has(g)) rankMap.set(g, rankMap.size);
          }
        }
        groupRankMapRef.current = rankMap;

        const isWaterfall =
          layoutRef.current === 'waterfall' &&
          columnsRef.current != null &&
          columnsRef.current.length > 0;
        const initialCols = isWaterfall
          ? columnsRef.current!.map((col) => col.map((it) => it.id))
          : null;
        const serializeFn = serializeColumnsRef.current;
        const currentOrder = initialCols
          ? serializeFn
            ? serializeFn(initialCols)
            : initialCols.flat()
          : itemsRef.current.map((it) => it.id);

        activeIdRef.current = pending.item.id;
        initialColsRef.current = initialCols;
        initialIdsRef.current = currentOrder;
        previewIdsRef.current = currentOrder;
        dragColsRef.current = initialCols;
        grabOffsetRef.current = { x: pending.grabOffsetX, y: pending.grabOffsetY };
        lastSwapTimeRef.current = 0;
        lastSwapClientRef.current = null;

        const initLeft = e.clientX - pending.grabOffsetX;
        const initTop = e.clientY - pending.grabOffsetY;
        overlayPosRef.current = { x: initLeft, y: initTop };

        measureSettledRects();

        setActiveId(pending.item.id);
        if (initialCols) {
          setDragCols(initialCols);
        } else {
          setPreviewIds(currentOrder);
        }
        setOverlay({
          item: pending.item,
          width: pending.width,
          height: pending.height,
          initialLeft: initLeft,
          initialTop: initTop,
        });

        startAutoScrollLoop();
        evaluateReorder(e.clientX, e.clientY);
        return;
      }

      // Update floating overlay at 60fps directly on DOM (zero React re-render).
      const left = e.clientX - grabOffsetRef.current.x;
      const top = e.clientY - grabOffsetRef.current.y;
      overlayPosRef.current = { x: left, y: top };
      const ov = overlayRef.current;
      if (ov) {
        ov.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      }

      evaluateReorder(e.clientX, e.clientY);
    };

    const onPointerUp = () => {
      if (activeIdRef.current !== null) {
        finishDrag(false);
      } else {
        pendingRef.current = null;
      }
    };

    const onPointerCancel = () => {
      if (activeIdRef.current !== null) {
        finishDrag(true);
      } else {
        pendingRef.current = null;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeIdRef.current !== null) {
        e.preventDefault();
        finishDrag(true);
      }
    };

    const onWindowClickCapture = (e: MouseEvent) => {
      if (suppressClickRef.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('click', onWindowClickCapture, true);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('click', onWindowClickCapture, true);
    };
  }, [evaluateReorder, finishDrag, measureSettledRects, startAutoScrollLoop]);

  useEffect(() => {
    if (!enabled && activeIdRef.current !== null) {
      finishDrag(true);
    }
  }, [enabled, finishDrag]);

  useEffect(() => {
    return () => {
      stopAutoScroll();
      restoreBodyStyles();
      for (const cancel of cancelAnimMapRef.current.values()) {
        cancel();
      }
      cancelAnimMapRef.current.clear();
    };
  }, [restoreBodyStyles, stopAutoScroll]);

  const orderedItems = useMemo(() => {
    const activeIds = dragCols ? dragCols.flat() : previewIds;
    if (!activeIds) return items;
    const byId = new Map<number, T>();
    for (const it of items) byId.set(it.id, it);
    const out: T[] = [];
    const seen = new Set<number>();
    for (const id of activeIds) {
      const it = byId.get(id);
      if (it) {
        out.push(it);
        seen.add(id);
      }
    }
    for (const it of items) {
      if (!seen.has(it.id)) out.push(it);
    }
    return out;
  }, [items, previewIds, dragCols]);

  const orderedColumns = useMemo(() => {
    if (!dragCols) return columns ?? [];
    const byId = new Map<number, T>();
    for (const it of items) byId.set(it.id, it);
    const seen = new Set<number>();
    const out: T[][] = dragCols.map((colIds) => {
      const col: T[] = [];
      for (const id of colIds) {
        const it = byId.get(id);
        if (it) {
          col.push(it);
          seen.add(id);
        }
      }
      return col;
    });
    // If new items arrived via SSE mid-drag, append them to the last column gracefully.
    if (out.length > 0) {
      for (const it of items) {
        if (!seen.has(it.id)) out[out.length - 1].push(it);
      }
    }
    return out;
  }, [columns, dragCols, items]);

  const activeGroup = useMemo(() => {
    if (activeId == null || !getGroup) return null;
    const found = items.find((it) => it.id === activeId);
    return found ? getGroup(found) : null;
  }, [activeId, getGroup, items]);

  const getItemRefCallback = useCallback((id: number) => {
    let cb = refCallbacksRef.current.get(id);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) {
          nodeMapRef.current.set(id, el);
          return () => {
            if (nodeMapRef.current.get(id) === el) {
              nodeMapRef.current.delete(id);
            }
          };
        }
      };
      refCallbacksRef.current.set(id, cb);
    }
    return cb;
  }, []);

  const getColumnRefCallback = useCallback((colIdx: number) => {
    let cb = colRefCallbacksRef.current.get(colIdx);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) {
          colNodeMapRef.current.set(colIdx, el);
          return () => {
            if (colNodeMapRef.current.get(colIdx) === el) {
              colNodeMapRef.current.delete(colIdx);
            }
          };
        }
      };
      colRefCallbacksRef.current.set(colIdx, cb);
    }
    return cb;
  }, []);

  const getItemProps = useCallback(
    (item: T): LiveReorderItemProps => ({
      ref: getItemRefCallback(item.id),
      onPointerDown: (e: React.PointerEvent) => {
        if (!enabledRef.current) return;
        if (e.button !== 0 || e.pointerType === 'touch') return;
        if (canDragItemRef.current && !canDragItemRef.current(item)) return;
        if (isInteractiveTarget(e.target)) return;

        const el = nodeMapRef.current.get(item.id);
        if (!el) return;
        const rect = el.getBoundingClientRect();

        if (e.target instanceof Element && e.target.closest('[data-drag-handle="true"]')) {
          e.preventDefault();
        }

        pendingRef.current = {
          item,
          downX: e.clientX,
          downY: e.clientY,
          grabOffsetX: e.clientX - rect.left,
          grabOffsetY: e.clientY - rect.top,
          width: rect.width,
          height: rect.height,
        };
      },
      onClickCapture: (e: React.MouseEvent) => {
        if (suppressClickRef.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    }),
    [getItemRefCallback],
  );

  const getColumnProps = useCallback(
    (colIdx: number): LiveReorderColumnProps => ({
      ref: getColumnRefCallback(colIdx),
    }),
    [getColumnRefCallback],
  );

  return {
    orderedItems,
    orderedColumns,
    activeId,
    activeGroup,
    isDragging: activeId !== null,
    overlay,
    overlayRef,
    overlayPosRef,
    getItemProps,
    getColumnProps,
  };
}

/**
 * Renders the floating dragged element in document.body without React overwriting `transform`.
 */
export function renderDragOverlay<T>(
  overlay: DragOverlayState<T> | null,
  overlayRef: React.RefObject<HTMLDivElement | null>,
  renderContent: (item: T) => React.ReactNode,
): React.ReactPortal | null {
  if (!overlay || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={overlayRef}
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: overlay.width,
        minHeight: overlay.height,
        pointerEvents: 'none',
        zIndex: 60,
        willChange: 'transform',
      }}
    >
      {renderContent(overlay.item)}
    </div>,
    document.body,
  );
}

/**
 * Serializes & coalesces rapid reorder API requests so only one reorder request runs at a time,
 * always delivering the latest user order and only settling once the queue drains.
 */
export function useSerialReorder(
  persist: (ids: number[]) => Promise<unknown>,
  options: {
    onOptimistic: (ids: number[]) => void;
    onError: (err: Error) => void;
    onDrained: () => void;
  },
): (ids: number[]) => void {
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const flushingRef = useRef(false);
  const queuedIdsRef = useRef<number[] | null>(null);

  return useCallback((ids: number[]) => {
    optionsRef.current.onOptimistic(ids);
    queuedIdsRef.current = ids;

    if (flushingRef.current) return;
    flushingRef.current = true;

    const drain = async () => {
      let hadError = false;
      try {
        while (queuedIdsRef.current !== null) {
          const nextIds = queuedIdsRef.current;
          queuedIdsRef.current = null;
          try {
            await persistRef.current(nextIds);
          } catch (err) {
            hadError = true;
            optionsRef.current.onError(err instanceof Error ? err : new Error(String(err)));
            queuedIdsRef.current = null;
            break;
          }
        }
      } finally {
        flushingRef.current = false;
        if (hadError || queuedIdsRef.current === null) {
          optionsRef.current.onDrained();
        }
      }
    };

    void drain();
  }, []);
}
