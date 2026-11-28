import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Link2,
  RotateCcw,
  RotateCw,
  Scan,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import type { FileEntry } from '../api';
import { formatPrefixLabel, isTransparentCapableImage } from '../justifiedLayout';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 5;

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(s * 100) / 100));
}

export interface StorageLightboxProps {
  image: FileEntry;
  dims?: [number, number];
  index: number;
  total: number;
  copiedUrl: string | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onCopyLink: (url: string) => void;
}

export function StorageLightbox({
  image,
  dims,
  index,
  total,
  copiedUrl,
  onClose,
  onPrev,
  onNext,
  onCopyLink,
}: StorageLightboxProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  const backdropRef = useRef<HTMLDivElement | null>(null);
  const panStartRef = useRef<{ x: number; y: number; origX: number; origY: number } | null>(null);
  const touchStartXRef = useRef<number | null>(null);

  // Reset transform whenever active image changes.
  useEffect(() => {
    setScale(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
    setIsPanning(false);
    panStartRef.current = null;
  }, [image.key]);

  // Lock background page scroll while lightbox is mounted.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // Non-passive wheel listener so scrolling zooms the image directly and never scrolls the background.
  useEffect(() => {
    const el = backdropRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Support both mouse wheel notches and smooth trackpad pinch/scroll deltas.
      const factor = Math.exp(-e.deltaY * 0.0022);
      setScale((prev) => {
        const next = clampScale(prev * factor);
        if (next <= 1) {
          setPan({ x: 0, y: 0 });
        }
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const zoomIn = useCallback(() => {
    setScale((s) => clampScale(s * 1.25));
  }, []);

  const zoomOut = useCallback(() => {
    setScale((s) => {
      const next = clampScale(s / 1.25);
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
  }, []);

  const rotateLeft = useCallback(() => {
    setRotation((r) => r - 90);
  }, []);

  const rotateRight = useCallback(() => {
    setRotation((r) => r + 90);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault();
        onPrev();
      } else if (e.key === 'ArrowRight' && index < total - 1) {
        e.preventDefault();
        onNext();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        resetView();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        if (e.shiftKey) rotateLeft();
        else rotateRight();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, total, onClose, onPrev, onNext, zoomIn, zoomOut, resetView, rotateLeft, rotateRight]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || scale <= 1) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsPanning(true);
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      origX: pan.x,
      origY: pan.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const start = panStartRef.current;
    if (!start) return;
    setPan({
      x: start.origX + (e.clientX - start.x),
      y: start.origY + (e.clientY - start.y),
    });
  };

  const handlePointerUp = () => {
    panStartRef.current = null;
    setIsPanning(false);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (scale > 1.05) {
      setScale(1);
      setPan({ x: 0, y: 0 });
    } else {
      setScale(2);
    }
  };

  const isTransformed = scale !== 1 || rotation % 360 !== 0 || pan.x !== 0 || pan.y !== 0;

  return (
    <div
      ref={backdropRef}
      onClick={onClose}
      onTouchStart={(e) => {
        if (scale > 1) return;
        touchStartXRef.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const startX = touchStartXRef.current;
        touchStartXRef.current = null;
        if (startX === null || scale > 1) return;
        const endX = e.changedTouches[0]?.clientX ?? startX;
        const dx = endX - startX;
        if (dx > 50 && index > 0) onPrev();
        else if (dx < -50 && index < total - 1) onNext();
      }}
      className="fixed inset-0 z-50 bg-white/88 backdrop-blur-md flex flex-col items-center justify-center p-4 select-none yd-fade-in"
    >
      {/* Top Bar: Counter + Close */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute top-4 inset-x-4 z-20 flex items-center justify-between pointer-events-none"
      >
        <div className="pointer-events-auto rounded-full border border-zinc-200/80 bg-white/90 px-3 py-1 text-xs font-mono text-zinc-500 shadow-xs backdrop-blur-sm tabular-nums">
          {index + 1} / {total}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭预览"
          className="pointer-events-auto rounded-full border border-zinc-200/80 bg-white/90 p-2 text-zinc-600 shadow-xs backdrop-blur-sm hover:bg-white hover:text-zinc-900 transition-colors"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Prev / Next arrows */}
      {index > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          aria-label="上一张"
          className="absolute left-3 sm:left-5 z-20 rounded-full border border-zinc-200/80 bg-white/90 p-2 sm:p-2.5 text-zinc-600 shadow-xs backdrop-blur-sm hover:bg-white hover:text-zinc-900 transition-colors"
        >
          <ChevronLeft className="h-5 w-5 sm:h-6 sm:w-6" />
        </button>
      )}
      {index < total - 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          aria-label="下一张"
          className="absolute right-3 sm:right-5 z-20 rounded-full border border-zinc-200/80 bg-white/90 p-2 sm:p-2.5 text-zinc-600 shadow-xs backdrop-blur-sm hover:bg-white hover:text-zinc-900 transition-colors"
        >
          <ChevronRight className="h-5 w-5 sm:h-6 sm:w-6" />
        </button>
      )}

      {/* Image Canvas */}
      <div
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={handleDoubleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className={`relative flex items-center justify-center max-h-[76dvh] sm:max-h-[78vh] max-w-[92vw] sm:max-w-[88vw] ${
          scale > 1 ? (isPanning ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'
        }`}
      >
        <img
          src={image.url}
          alt={image.name}
          draggable={false}
          style={{
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale}) rotate(${rotation}deg)`,
            transition: isPanning ? 'none' : 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          className={`max-h-[76dvh] sm:max-h-[78vh] max-w-[92vw] sm:max-w-[88vw] object-contain rounded-xl border border-zinc-200/80 shadow-xl ${
            isTransparentCapableImage(image) ? 'yd-checkerboard' : 'bg-white'
          }`}
        />
      </div>

      {/* Bottom Floating Album Controls + Metadata Pill */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-4 sm:bottom-6 z-20 max-w-[94vw] flex flex-wrap items-center justify-center gap-1.5 sm:gap-2 rounded-2xl sm:rounded-full border border-zinc-200/90 bg-white/95 px-3 sm:px-4 py-1.5 sm:py-2 text-xs text-zinc-700 shadow-[0_8px_28px_rgba(15,23,42,0.08)] backdrop-blur-md"
      >
        {/* File Meta */}
        <div className="flex items-center gap-1.5 pr-1 sm:pr-2 sm:border-r border-zinc-200/80 max-w-[60vw] sm:max-w-[260px]">
          <span className="rounded bg-[#f3f6fa] px-1.5 py-0.5 text-[11px] text-zinc-500 shrink-0">
            {formatPrefixLabel(image.prefix ?? '')}
          </span>
          <span className="font-medium text-zinc-800 truncate">{image.name}</span>
        </div>

        <span className="hidden md:inline font-mono text-[11px] text-zinc-400 tabular-nums">
          {dims ? `${dims[0]}×${dims[1]} · ` : ''}
          {formatBytes(image.size)}
        </span>

        {/* Zoom & Rotate Controls */}
        <div className="flex items-center gap-0.5 sm:pl-1 sm:border-l border-zinc-200/80">
          <Tooltip content="缩小 (-)">
            <button
              type="button"
              onClick={zoomOut}
              disabled={scale <= MIN_SCALE}
              aria-label="缩小"
              className="yd-btn-icon p-1.5"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="点击重置缩放与旋转 (0)">
            <button
              type="button"
              onClick={resetView}
              className="min-w-[44px] rounded-md px-1.5 py-1 text-center font-mono text-[11px] text-zinc-600 hover:bg-zinc-100 tabular-nums transition-colors"
            >
              {Math.round(scale * 100)}%
            </button>
          </Tooltip>
          <Tooltip content="放大 (+)">
            <button
              type="button"
              onClick={zoomIn}
              disabled={scale >= MAX_SCALE}
              aria-label="放大"
              className="yd-btn-icon p-1.5"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
          </Tooltip>

          <Tooltip content="向左旋转 90° (Shift+R)">
            <button
              type="button"
              onClick={rotateLeft}
              aria-label="向左旋转 90 度"
              className="yd-btn-icon p-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="向右旋转 90° (R)">
            <button
              type="button"
              onClick={rotateRight}
              aria-label="向右旋转 90 度"
              className="yd-btn-icon p-1.5"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          </Tooltip>

          {isTransformed && (
            <Tooltip content="恢复原貌 (0)">
              <button
                type="button"
                onClick={resetView}
                aria-label="恢复原貌"
                className="yd-btn-icon p-1.5 text-sky-600 hover:bg-sky-50"
              >
                <Scan className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
        </div>

        {/* Copy & Open Original */}
        <div className="flex items-center gap-1 pl-1 border-l border-zinc-200/80">
          <button
            type="button"
            onClick={() => onCopyLink(image.url)}
            className={`rounded-full px-2.5 py-1 font-medium transition-colors inline-flex items-center gap-1 ${
              copiedUrl === image.url
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-sky-50 text-sky-700 hover:bg-sky-100'
            }`}
          >
            {copiedUrl === image.url ? (
              <>
                <Check className="h-3 w-3" />
                已复制
              </>
            ) : (
              <>
                <Link2 className="h-3 w-3" />
                复制直链
              </>
            )}
          </button>
          <Tooltip content="新标签页打开原图">
            <a
              href={image.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="新标签页打开原图"
              className="yd-btn-icon p-1.5"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
