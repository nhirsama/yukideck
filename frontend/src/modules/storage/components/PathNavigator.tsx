import { Crosshair, Folder, FolderOpen, FolderPlus, Search, X } from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import type { PathTreeNode } from '../justifiedLayout';

interface PathNavigatorProps {
  nodes: PathTreeNode[];
  totalFiles: number;
  activePrefix: string | null;
  focusedPrefix: string | null;
  pointerDropPrefix?: string | null;
  onJumpToPrefix: (prefix: string, hasSection: boolean) => void;
  onToggleFocus: (prefix: string) => void;
  onClearFocus: () => void;
  onOpenSearch?: () => void;
  onCreateFolder?: () => void;
}

export function PathNavigatorContent({
  nodes,
  totalFiles,
  activePrefix,
  focusedPrefix,
  pointerDropPrefix = null,
  onJumpToPrefix,
  onToggleFocus,
  onClearFocus,
  onOpenSearch,
  onCreateFolder,
}: PathNavigatorProps) {
  // Precompute whether each ancestor depth has a following sibling so vertical guide lines stop cleanly.
  const hasFollowingAtDepth = nodes.map((node, idx) => {
    const flags: boolean[] = [];
    for (let d = 1; d <= node.depth; d++) {
      let continues = false;
      for (let j = idx + 1; j < nodes.length; j++) {
        if (nodes[j].depth < d) break;
        if (nodes[j].depth === d) {
          continues = true;
          break;
        }
      }
      flags[d] = continues;
    }
    return flags;
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-1.5 px-2 pb-1">
        <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-zinc-400">
          <span>路径</span>
          <span className="font-mono tabular-nums">{totalFiles}</span>
        </div>

        <div className="flex items-center gap-0.5">
          {focusedPrefix !== null && (
            <button
              type="button"
              onClick={onClearFocus}
              className="inline-flex items-center gap-0.5 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-600 hover:bg-sky-100 transition-colors mr-0.5"
            >
              全部
              <X className="h-3 w-3" />
            </button>
          )}
          {onOpenSearch && (
            <Tooltip content="搜索文件或路径 (/)">
              <button
                type="button"
                onClick={onOpenSearch}
                aria-label="搜索"
                className="rounded-md p-1 text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700 transition-colors"
              >
                <Search className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
          {onCreateFolder && (
            <Tooltip content="新建路径">
              <button
                type="button"
                onClick={onCreateFolder}
                aria-label="新建路径"
                className="rounded-md p-1 text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700 transition-colors"
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {nodes.length === 0 ? (
        <div className="px-2.5 py-3 text-xs text-zinc-400">暂无路径</div>
      ) : (
        <nav aria-label="路径前缀导航" className="relative space-y-0.5">
          {nodes.map((node, idx) => {
            const isActive = activePrefix === node.prefix;
            const isFocused = focusedPrefix === node.prefix;
            const isDragOver = pointerDropPrefix === node.prefix;
            const count = node.prefix === '' ? node.directCount : node.subtreeCount;
            const isRoot = node.prefix === '';
            const isTopLevel = node.depth === 0;
            const guideFlags = hasFollowingAtDepth[idx];

            return (
              <div
                key={node.prefix || '__root__'}
                data-storage-nav-prefix={node.prefix}
                className={`group relative flex items-center justify-between gap-1 rounded-lg pr-1 transition-colors ${
                  isDragOver
                    ? 'bg-sky-100/90 text-sky-800 ring-1 ring-inset ring-sky-300 font-medium'
                    : isFocused
                      ? 'bg-sky-50/95 text-sky-700 font-medium'
                      : isActive
                        ? 'bg-sky-50/65 text-sky-600 font-medium'
                        : isTopLevel
                          ? 'text-zinc-700 hover:bg-zinc-200/45 hover:text-zinc-900'
                          : 'text-zinc-500 hover:bg-zinc-200/45 hover:text-zinc-800'
                }`}
                style={{ paddingLeft: `${8 + node.depth * 16}px` }}
              >
                {/* Vertical tree guide lines for ancestor depths */}
                {Array.from({ length: node.depth }, (_, i) => {
                  const d = i + 1;
                  const isOwnBranch = d === node.depth;
                  const leftPx = 14 + (d - 1) * 16;
                  if (isOwnBranch) {
                    return (
                      <span
                        key={d}
                        aria-hidden="true"
                        style={{ left: `${leftPx}px` }}
                        className="pointer-events-none absolute top-0 bottom-0 w-3"
                      >
                        {/* Upper vertical + horizontal elbow */}
                        <span
                          className={`absolute left-0 top-0 h-1/2 w-2.5 border-l border-b rounded-bl-[4px] ${
                            isActive || isFocused ? 'border-sky-300' : 'border-zinc-200/95'
                          }`}
                        />
                        {/* Lower vertical continuation if more siblings follow at this depth */}
                        {guideFlags[d] && (
                          <span className="absolute left-0 top-1/2 bottom-0 w-px bg-zinc-200/90" />
                        )}
                      </span>
                    );
                  }
                  return guideFlags[d] ? (
                    <span
                      key={d}
                      aria-hidden="true"
                      style={{ left: `${leftPx}px` }}
                      className="pointer-events-none absolute top-0 bottom-0 w-px bg-zinc-200/80"
                    />
                  ) : null;
                })}

                {/* Active left accent pill */}
                {(isActive || isFocused || isDragOver) && (
                  <span
                    className={`absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full ${
                      isFocused || isDragOver ? 'bg-sky-500' : 'bg-sky-400'
                    }`}
                  />
                )}

                <button
                  type="button"
                  onClick={() => onJumpToPrefix(node.prefix, node.hasSection)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
                  title={node.prefix ? `/${node.prefix.replace(/\/+$/, '')}` : '/'}
                >
                  {isRoot ? (
                    <span
                      className={`inline-flex h-4 px-1.5 shrink-0 items-center justify-center rounded font-mono text-[12px] font-semibold ${
                        isActive || isFocused
                          ? 'bg-sky-100 text-sky-700'
                          : 'bg-zinc-200/70 text-zinc-600'
                      }`}
                    >
                      /
                    </span>
                  ) : isTopLevel ? (
                    <>
                      {isActive || isFocused ? (
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-sky-500" />
                      ) : (
                        <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-400 group-hover:text-sky-400 transition-colors" />
                      )}
                      <span className="truncate text-[12.5px] font-medium">{node.label}</span>
                    </>
                  ) : (
                    <>
                      <span
                        className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                          isActive || isFocused
                            ? 'bg-sky-400'
                            : 'bg-zinc-300 group-hover:bg-sky-300'
                        }`}
                      />
                      <span className="truncate text-[12px]">{node.label}</span>
                    </>
                  )}
                </button>

                <div className="flex shrink-0 items-center gap-0.5">
                  <span className="font-mono text-[10.5px] text-zinc-400/90 tabular-nums px-1">
                    {count}
                  </span>
                  <Tooltip content={isFocused ? '取消聚焦' : '仅看此路径'}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFocus(node.prefix);
                      }}
                      aria-label={isFocused ? '取消聚焦' : `聚焦 ${node.label}`}
                      className={`rounded-md p-1 transition-all ${
                        isFocused
                          ? 'text-sky-600 bg-sky-100/80 opacity-100'
                          : 'text-zinc-400 hover:bg-white/90 hover:text-sky-600 opacity-100 lg:opacity-0 lg:group-hover:opacity-100'
                      }`}
                    >
                      <Crosshair className="h-3 w-3" />
                    </button>
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </nav>
      )}
    </div>
  );
}
