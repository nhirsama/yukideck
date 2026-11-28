import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FolderInput,
  Link2,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  Square,
  Upload,
} from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import type { FileEntry, PathItem, PrefixGroup } from '../api';
import {
  computeJustifiedLayout,
  formatPrefixLabel,
  getFileDimensions,
  isTransparentCapableImage,
} from '../justifiedLayout';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export interface PrefixSectionProps {
  group: PrefixGroup;
  containerWidth: number;
  dimsMap: Record<string, [number, number]>;
  loadedUrls: Record<string, true>;
  selected: Map<string, PathItem>;
  copiedUrl: string | null;
  isActive: boolean;
  isPointerDropTarget: boolean;
  draggingKeys: Set<string> | null;
  sectionRef: (el: HTMLElement | null) => void;
  onActivatePrefix: (prefix: string) => void;
  onSelectBreadcrumb: (prefix: string) => void;
  onSectionDragEnter: () => void;
  onUploadToPrefix: (prefix: string) => void;
  onDropFilesToPrefix: (prefix: string, files: FileList) => void;
  onToggleSelectGroup: (prefix: string, files: FileEntry[]) => void;
  onRenamePrefix: (prefix: string) => void;
  onToggleSelectFile: (item: PathItem) => void;
  onTilePointerDown: (e: React.PointerEvent, file: FileEntry, items: PathItem[]) => void;
  onOpenLightbox: (file: FileEntry) => void;
  onCopyLink: (url: string) => void;
  onRenameFile: (file: FileEntry) => void;
  onOpenMobileActions: (file: FileEntry) => void;
  onImageLoaded: (file: FileEntry, naturalWidth: number, naturalHeight: number) => void;
}

export const PrefixSection = memo(function PrefixSection({
  group,
  containerWidth,
  dimsMap,
  loadedUrls,
  selected,
  copiedUrl,
  isActive,
  isPointerDropTarget,
  draggingKeys,
  sectionRef,
  onActivatePrefix,
  onSelectBreadcrumb,
  onSectionDragEnter,
  onUploadToPrefix,
  onDropFilesToPrefix,
  onToggleSelectGroup,
  onRenamePrefix,
  onToggleSelectFile,
  onTilePointerDown,
  onOpenLightbox,
  onCopyLink,
  onRenameFile,
  onOpenMobileActions,
  onImageLoaded,
}: PrefixSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [osDropActive, setOsDropActive] = useState(false);
  const [nearViewport, setNearViewport] = useState(false);
  const bodyHostRef = useRef<HTMLDivElement | null>(null);
  const dragDepthRef = useRef(0);

  // Lazy-mount section images only when approaching viewport (450px margin).
  useEffect(() => {
    if (nearViewport || collapsed) return;
    const el = bodyHostRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setNearViewport(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: '450px 0px 450px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [nearViewport, collapsed]);

  const gap = containerWidth < 520 ? 8 : 10;
  const layout = useMemo(
    () => computeJustifiedLayout(group.files, containerWidth, dimsMap, { gap }),
    [group.files, containerWidth, dimsMap, gap],
  );

  const selectedCountInGroup = useMemo(() => {
    let cnt = 0;
    for (const f of group.files) {
      if (selected.has(`file:${f.key}`)) cnt++;
    }
    return cnt;
  }, [group.files, selected]);

  const isEmptyFolderSelected =
    group.files.length === 0 && group.prefix !== '' && selected.has(`folder:${group.prefix}`);
  const allSelectedInGroup =
    (group.files.length > 0 && selectedCountInGroup === group.files.length) || isEmptyFolderSelected;

  const segments = useMemo(() => {
    if (!group.prefix) return [];
    const parts = group.prefix.replace(/\/+$/, '').split('/').filter(Boolean);
    const out: Array<{ label: string; prefix: string }> = [];
    let acc = '';
    for (const p of parts) {
      acc += `${p}/`;
      out.push({ label: p, prefix: acc });
    }
    return out;
  }, [group.prefix]);

  const showDropHighlight = osDropActive || isPointerDropTarget;

  return (
    <section
      ref={sectionRef}
      data-storage-prefix={group.prefix}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        dragDepthRef.current++;
        setOsDropActive(true);
        onSectionDragEnter();
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.stopPropagation();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setOsDropActive(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragDepthRef.current = 0;
        setOsDropActive(false);
        onDropFilesToPrefix(group.prefix, e.dataTransfer.files);
      }}
      className={`scroll-mt-16 lg:scroll-mt-3 rounded-2xl transition-colors ${
        showDropHighlight ? 'ring-2 ring-sky-400/80 bg-sky-50/40 p-2 -mx-2' : ''
      }`}
    >
      {/* Floating frosted-pill sticky breadcrumb header:
          outer container is fully transparent; only the left breadcrumb pill & right action pill
          have rounded glass blur so scrolling images pass cleanly behind the open space. */}
      <div className="group/hdr sticky top-16 lg:top-2.5 z-20 mb-2.5 flex items-center justify-between gap-2 pointer-events-none">
        {/* Left floating pill: Collapse + "/" breadcrumb + count */}
        <div
          onClick={() => onActivatePrefix(group.prefix)}
          className={`pointer-events-auto inline-flex min-w-0 max-w-[75%] items-center gap-0.5 overflow-x-auto rounded-full border px-2 py-1 cursor-pointer backdrop-blur-md transition-all ${
            isActive
              ? 'border-sky-300/80 bg-white/88 shadow-[0_2px_10px_rgba(14,165,233,0.1)] ring-1 ring-sky-200/50'
              : 'border-zinc-200/75 bg-white/80 shadow-[0_2px_8px_rgba(15,23,42,0.04)] hover:border-zinc-300/80 hover:bg-white/92'
          }`}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed((v) => !v);
            }}
            aria-label={collapsed ? '展开分组' : '折叠分组'}
            className="rounded-full p-0.5 text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700 transition-colors shrink-0"
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (group.prefix === '') onActivatePrefix('');
              else onSelectBreadcrumb('');
            }}
            title="根目录 (/)"
            className={`rounded-full px-1.5 py-0.5 font-mono text-[12.5px] leading-none whitespace-nowrap transition-colors shrink-0 ${
              group.prefix === ''
                ? isActive
                  ? 'font-semibold text-sky-700'
                  : 'font-semibold text-zinc-700'
                : 'text-zinc-400 hover:text-zinc-700'
            }`}
          >
            /
          </button>

          {segments.map((seg, idx) => {
            const isLast = idx === segments.length - 1;
            return (
              <div key={seg.prefix} className="flex items-center gap-0.5 shrink-0">
                {idx > 0 && <span className="font-mono text-zinc-300 text-xs select-none">/</span>}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isLast) onActivatePrefix(group.prefix);
                    else onSelectBreadcrumb(seg.prefix);
                  }}
                  className={`rounded-full px-1 py-0.5 text-[12.5px] leading-none whitespace-nowrap transition-colors ${
                    isLast
                      ? isActive
                        ? 'font-semibold text-sky-700'
                        : 'font-semibold text-zinc-700 hover:text-sky-600'
                      : 'text-zinc-400 hover:text-zinc-700'
                  }`}
                >
                  {seg.label}
                </button>
              </div>
            );
          })}

          <span
            className={`ml-1 pr-1 font-mono text-[11px] leading-none tabular-nums shrink-0 transition-colors ${
              isActive ? 'text-sky-500' : 'text-zinc-400'
            }`}
          >
            {group.files.length}
          </span>
        </div>

        {/* Right floating pill: Quiet inline actions (upload, select-all, rename) */}
        <div
          onClick={(e) => e.stopPropagation()}
          className={`pointer-events-auto inline-flex items-center gap-0.5 shrink-0 rounded-full border border-zinc-200/75 bg-white/80 px-1.5 py-0.5 shadow-[0_2px_8px_rgba(15,23,42,0.04)] backdrop-blur-md transition-opacity ${
            allSelectedInGroup || selectedCountInGroup > 0 || isActive
              ? 'opacity-100'
              : 'opacity-100 sm:opacity-75 sm:group-hover/hdr:opacity-100'
          }`}
        >
          <Tooltip content={`上传至此路径（${formatPrefixLabel(group.prefix)}）`}>
            <button
              type="button"
              onClick={() => onUploadToPrefix(group.prefix)}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11.5px] font-medium text-zinc-500 hover:bg-sky-50 hover:text-sky-600 transition-colors"
            >
              <Upload className="h-3 w-3" />
              <span className="hidden sm:inline">上传</span>
            </button>
          </Tooltip>

          {(group.files.length > 0 || group.prefix !== '') && (
            <Tooltip
              content={
                group.files.length === 0
                  ? isEmptyFolderSelected
                    ? '取消选择空路径'
                    : '选择此空路径'
                  : allSelectedInGroup
                    ? '取消全选本路径'
                    : '全选本路径'
              }
            >
              <button
                type="button"
                onClick={() => onToggleSelectGroup(group.prefix, group.files)}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11.5px] font-medium transition-colors ${
                  allSelectedInGroup
                    ? 'bg-sky-50 text-sky-600'
                    : 'text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-800'
                }`}
              >
                {allSelectedInGroup ? (
                  <CheckSquare className="h-3 w-3" />
                ) : (
                  <Square className="h-3 w-3" />
                )}
                <span className="hidden sm:inline">
                  {group.files.length === 0
                    ? isEmptyFolderSelected
                      ? '已选'
                      : '选择'
                    : allSelectedInGroup
                      ? '已全选'
                      : selectedCountInGroup > 0
                        ? `已选 ${selectedCountInGroup}`
                        : '全选'}
                </span>
              </button>
            </Tooltip>
          )}

          {group.prefix !== '' && (
            <Tooltip content="重命名此路径">
              <button
                type="button"
                onClick={() => onRenamePrefix(group.prefix)}
                className="inline-flex items-center rounded-full p-1 text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700 transition-colors"
                aria-label="重命名路径"
              >
                <Pencil className="h-3 w-3" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Drop target hint banner */}
      {showDropHighlight && (
        <div className="mb-2 flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-sky-400 bg-sky-50/90 py-2 text-xs font-medium text-sky-700">
          {isPointerDropTarget ? (
            <>
              <FolderInput className="h-3.5 w-3.5" />
              松开移动至「{formatPrefixLabel(group.prefix)}」
            </>
          ) : (
            <>
              <Upload className="h-3.5 w-3.5" />
              松开上传至「{formatPrefixLabel(group.prefix)}」
            </>
          )}
        </div>
      )}

      {/* Justified Gallery Rows (Lazy-rendered near viewport) */}
      {!collapsed && (
        <div ref={bodyHostRef}>
          {group.files.length === 0 ? (
            <div
              className={`rounded-xl border border-dashed px-4 py-5 text-center text-xs transition-colors ${
                isEmptyFolderSelected
                  ? 'border-sky-400 bg-sky-50/50 text-sky-700'
                  : 'border-zinc-200/80 bg-white/50 text-zinc-400'
              }`}
            >
              空路径 · 拖入文件或点击「上传」添加内容
            </div>
          ) : !nearViewport ? (
            <div
              className="flex flex-col"
              style={{ gap: `${gap}px`, minHeight: `${layout.totalHeight}px` }}
            >
              {layout.rows.map((row, rowIdx) => (
                <div
                  key={rowIdx}
                  className="flex items-stretch"
                  style={{ gap: `${gap}px`, height: `${row.height}px` }}
                >
                  {row.tiles.map((tile) => (
                    <div
                      key={tile.file.key}
                      style={{ width: `${tile.width}px`, height: `${tile.height}px` }}
                      className="shrink-0 rounded-xl bg-[#eef2f7]/80 border border-zinc-200/40"
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col" style={{ gap: `${gap}px` }}>
              {layout.rows.map((row, rowIdx) => (
                <div
                  key={rowIdx}
                  className="flex items-stretch"
                  style={{ gap: `${gap}px`, height: `${row.height}px` }}
                >
                  {row.tiles.map((tile) => {
                    const file = tile.file;
                    const isSel = selected.has(`file:${file.key}`);
                    const isLoaded = Boolean(loadedUrls[file.url]);
                    const isDraggingTile = Boolean(draggingKeys?.has(file.key));
                    const isTransparent = isTransparentCapableImage(file);
                    const dims = getFileDimensions(file, dimsMap);

                    return (
                      <div
                        key={file.key}
                        onPointerDown={(e) => {
                          const itemsToMove: PathItem[] =
                            isSel && selected.size > 0
                              ? Array.from(selected.values())
                              : [{ type: 'file', path: file.key }];
                          onTilePointerDown(e, file, itemsToMove);
                        }}
                        onClick={() => {
                          if (file.is_image) onOpenLightbox(file);
                          else window.open(file.url, '_blank', 'noopener');
                        }}
                        style={{ width: `${tile.width}px`, height: `${tile.height}px` }}
                        className={`group relative shrink-0 rounded-xl border bg-white overflow-hidden cursor-pointer select-none transition-all ${
                          isDraggingTile ? 'opacity-40 scale-[0.98]' : ''
                        } ${
                          isSel
                            ? 'border-sky-400 ring-2 ring-sky-500/25'
                            : 'border-zinc-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.025)] hover:border-sky-300/80'
                        }`}
                      >
                        {file.is_image ? (
                          <div
                            className={`relative h-full w-full overflow-hidden ${
                              !isLoaded
                                ? 'bg-[#f1f5f9] animate-pulse'
                                : isTransparent
                                  ? 'yd-checkerboard'
                                  : 'bg-[#f8fafc]'
                            }`}
                          >
                            <img
                              src={file.url}
                              alt={file.name}
                              draggable={false}
                              loading="lazy"
                              decoding="async"
                              width={dims?.[0]}
                              height={dims?.[1]}
                              onLoad={(e) => {
                                const img = e.currentTarget;
                                onImageLoaded(file, img.naturalWidth, img.naturalHeight);
                              }}
                              className={`block h-full w-full object-contain transition-all duration-300 group-hover:scale-[1.018] ${
                                isLoaded ? 'opacity-100' : 'opacity-0'
                              }`}
                            />
                          </div>
                        ) : (
                          <div className="h-full w-full flex flex-col items-center justify-center gap-1.5 p-3 bg-[#f8fafc] text-zinc-500">
                            <FileIcon className="h-8 w-8 text-zinc-300 shrink-0" />
                            <div className="text-xs font-medium text-zinc-700 truncate max-w-full">
                              {file.name}
                            </div>
                            <div className="text-[11px] text-zinc-400 tabular-nums">
                              {formatBytes(file.size)}
                            </div>
                          </div>
                        )}

                        {/* Top-left subtle circular selection checkbox */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleSelectFile({ type: 'file', path: file.key });
                          }}
                          className={`absolute top-1.5 left-1.5 h-5 w-5 rounded-full border items-center justify-center transition-all duration-150 ${
                            isSel
                              ? 'flex bg-sky-500 border-sky-500 text-white opacity-100 shadow-xs'
                              : selected.size > 0
                                ? 'flex bg-black/25 border-white/80 text-white backdrop-blur-[2px] opacity-90 sm:opacity-0 sm:group-hover:opacity-100'
                                : 'hidden sm:flex bg-black/25 hover:bg-black/45 border-white/75 text-white backdrop-blur-[2px] opacity-0 group-hover:opacity-100'
                          }`}
                        >
                          {isSel && <Check className="h-3 w-3 stroke-[2.5]" />}
                        </button>

                        {/* Top-right low-intrusion translucent micro-buttons (Copy Link + Rename) */}
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="hidden sm:flex absolute top-1.5 right-1.5 items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                        >
                          <Tooltip content="复制直链">
                            <button
                              type="button"
                              onClick={() => onCopyLink(file.url)}
                              className={`h-6 w-6 rounded-full backdrop-blur-[2px] flex items-center justify-center transition-colors ${
                                copiedUrl === file.url
                                  ? 'bg-emerald-500/90 text-white'
                                  : 'bg-black/35 hover:bg-black/55 text-white/95'
                              }`}
                            >
                              {copiedUrl === file.url ? (
                                <Check className="h-3 w-3" />
                              ) : (
                                <Link2 className="h-3 w-3" />
                              )}
                            </button>
                          </Tooltip>
                          <Tooltip content="重命名">
                            <button
                              type="button"
                              onClick={() => onRenameFile(file)}
                              className="h-6 w-6 rounded-full bg-black/35 hover:bg-black/55 text-white/95 backdrop-blur-[2px] flex items-center justify-center transition-colors"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          </Tooltip>
                        </div>

                        {/* Bottom ultra-subtle gradient scrim metadata (non-intrusive) */}
                        {file.is_image && (
                          <div className="hidden sm:flex pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/50 via-black/15 to-transparent pt-6 pb-1.5 px-2.5 text-white/95 opacity-0 group-hover:opacity-100 transition-opacity duration-150 items-end justify-between gap-2">
                            <span className="text-[10.5px] font-medium truncate drop-shadow-xs">
                              {file.name}
                            </span>
                            <span className="text-[10px] text-white/85 shrink-0 inline-flex items-center gap-1 tabular-nums font-mono drop-shadow-xs">
                              {file.metadata_stripped && (
                                <ShieldCheck className="h-2.5 w-2.5 text-emerald-300" />
                              )}
                              {dims && <span>{dims[0]}×{dims[1]}</span>}
                              <span>{formatBytes(file.size)}</span>
                            </span>
                          </div>
                        )}

                        {/* Mobile compact overlay buttons */}
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="sm:hidden absolute bottom-1.5 right-1.5 flex items-center gap-1"
                        >
                          <button
                            type="button"
                            aria-label="复制直链"
                            onClick={() => onCopyLink(file.url)}
                            className={`inline-flex h-6 w-6 items-center justify-center rounded-full backdrop-blur-xs ${
                              copiedUrl === file.url
                                ? 'bg-emerald-500/90 text-white'
                                : 'bg-black/35 text-white'
                            }`}
                          >
                            {copiedUrl === file.url ? (
                              <Check className="h-3 w-3" />
                            ) : (
                              <Link2 className="h-3 w-3" />
                            )}
                          </button>
                          <button
                            type="button"
                            aria-label="更多操作"
                            onClick={() => onOpenMobileActions(file)}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-xs"
                          >
                            <MoreHorizontal className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
});
