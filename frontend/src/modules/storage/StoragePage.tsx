import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  File as FileIcon,
  Folder,
  FolderInput,
  FolderPlus,
  Image as ImageIcon,
  Link2,
  Pencil,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  storageApi,
  type FileEntry,
  type FolderEntry,
  type PathItem,
} from './api';
import { loadCachedDimensions, saveCachedDimensionsBatch } from './metadata';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function useWaterfallColumns(): number {
  const getCols = () => {
    if (typeof window === 'undefined') return 3;
    if (window.innerWidth >= 1024) return 3;
    if (window.innerWidth >= 640) return 2;
    return 1;
  };
  const [cols, setCols] = useState(getCols);
  useEffect(() => {
    const onResize = () => setCols(getCols());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return cols;
}

export default function StoragePage() {
  const qc = useQueryClient();
  const [prefix, setPrefix] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Map<string, PathItem>>(new Map());
  const [toast, setToast] = useState<{ text: string; tone?: 'info' | 'error' } | null>(null);
  const [uploadingText, setUploadingText] = useState('');
  const [dragging, setDragging] = useState(false);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [dimsMap, setDimsMap] = useState<Record<string, [number, number]>>(() => loadCachedDimensions());
  const [loadedUrls, setLoadedUrls] = useState<Record<string, true>>({});
  const probedUrlsRef = useRef<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const colCount = useWaterfallColumns();

  const showToast = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    setToast({ text, tone });
    setTimeout(() => {
      setToast((cur) => (cur?.text === text ? null : cur));
    }, 2600);
  }, []);

  const { data: cfgData, isLoading: cfgLoading } = useQuery({
    queryKey: ['storage', 'config'],
    queryFn: storageApi.getConfig,
  });
  const cfg = cfgData?.config;

  const { data: listing, isLoading: listLoading, refetch } = useQuery({
    queryKey: ['storage', 'list', prefix],
    queryFn: () => storageApi.list(prefix),
    enabled: Boolean(cfg?.configured),
  });

  const filteredFolders = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = listing?.folders ?? [];
    if (!q) return list;
    return list.filter((f) => f.name.toLowerCase().includes(q));
  }, [listing?.folders, search]);

  const filteredFiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = listing?.files ?? [];
    if (!q) return list;
    return list.filter((f) => f.name.toLowerCase().includes(q));
  }, [listing?.files, search]);

  const imageFiles = useMemo(() => filteredFiles.filter((f) => f.is_image), [filteredFiles]);

  // Pre-probe uncached image dimensions as soon as header bytes arrive (zero server proxy traffic)
  useEffect(() => {
    const cached = loadCachedDimensions();
    const missing = imageFiles.filter((f) => !cached[f.url] && !probedUrlsRef.current.has(f.url));
    if (missing.length === 0) return;

    let cancelled = false;
    const pending: Record<string, [number, number]> = {};
    let flushTimer: number | null = null;
    const timers: number[] = [];

    const flush = () => {
      if (cancelled) return;
      const keys = Object.keys(pending);
      if (keys.length === 0) return;
      const batch = { ...pending };
      for (const k of keys) delete pending[k];
      saveCachedDimensionsBatch(batch);
      setDimsMap((prev) => ({ ...prev, ...batch }));
    };

    const record = (url: string, w: number, h: number) => {
      if (cancelled || w <= 0 || h <= 0) return;
      pending[url] = [w, h];
      if (flushTimer === null) {
        flushTimer = window.setTimeout(() => {
          flushTimer = null;
          flush();
        }, 60);
      }
    };

    for (const f of missing) {
      probedUrlsRef.current.add(f.url);
      const probe = new Image();
      let done = false;
      const check = () => {
        if (done || cancelled) return true;
        if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
          done = true;
          record(f.url, probe.naturalWidth, probe.naturalHeight);
          return true;
        }
        return false;
      };
      probe.onload = () => {
        check();
      };
      probe.onerror = () => {
        done = true;
      };
      probe.src = f.url;
      if (!check()) {
        let attempts = 0;
        const intervalId = window.setInterval(() => {
          attempts++;
          if (check() || attempts >= 50) {
            window.clearInterval(intervalId);
          }
        }, 60);
        timers.push(intervalId);
      }
    }

    return () => {
      cancelled = true;
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      for (const id of timers) window.clearInterval(id);
    };
  }, [imageFiles]);

  // Balanced N-column waterfall distribution (row-first order, shortest column next)
  const waterfallColumns = useMemo(() => {
    const cols: FileEntry[][] = Array.from({ length: colCount }, () => []);
    const heights: number[] = Array.from({ length: colCount }, () => 0);

    for (const file of filteredFiles) {
      let minIdx = 0;
      for (let i = 1; i < colCount; i++) {
        if (heights[i] < heights[minIdx]) minIdx = i;
      }
      cols[minIdx].push(file);
      const dims = file.is_image ? dimsMap[file.url] : undefined;
      const ratio = dims ? dims[1] / dims[0] : file.is_image ? 0.75 : 0.45;
      heights[minIdx] += ratio + 0.08;
    }
    return cols;
  }, [filteredFiles, colCount, dimsMap]);

  const handleUploadFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!cfg?.configured) return;
      const arr = Array.from(files);
      if (arr.length === 0) return;

      let okCount = 0;
      let lastErr = '';
      for (let i = 0; i < arr.length; i++) {
        setUploadingText(`正在上传 (${i + 1}/${arr.length})：${arr[i].name || '剪贴板文件'}`);
        try {
          await storageApi.uploadFile(arr[i], prefix, cfg);
          okCount++;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : '上传失败';
        }
      }
      setUploadingText('');
      if (okCount > 0) {
        setDimsMap(loadCachedDimensions());
        void refetch();
        showToast(
          lastErr ? `成功 ${okCount} 个，部分失败：${lastErr}` : `已上传 ${okCount} 个文件`,
          lastErr ? 'error' : 'info',
        );
      } else if (lastErr) {
        showToast(lastErr, 'error');
      }
    },
    [cfg, prefix, refetch, showToast],
  );

  // Global Ctrl+V paste upload (matching yukilink experience)
  useEffect(() => {
    if (!cfg?.configured) return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        e.preventDefault();
        void handleUploadFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [cfg?.configured, handleUploadFiles]);

  // Lightbox keyboard navigation
  useEffect(() => {
    if (lightboxIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxIdx(null);
      if (e.key === 'ArrowLeft') setLightboxIdx((i) => (i !== null && i > 0 ? i - 1 : i));
      if (e.key === 'ArrowRight')
        setLightboxIdx((i) => (i !== null && i < imageFiles.length - 1 ? i + 1 : i));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxIdx, imageFiles.length]);

  const createFolderMut = useMutation({
    mutationFn: (name: string) => storageApi.createFolder(`${prefix}${name}`),
    onSuccess: () => {
      void refetch();
      showToast('文件夹已创建');
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const renameMut = useMutation({
    mutationFn: (p: { type: 'file' | 'folder'; oldPath: string; newPath: string }) =>
      storageApi.rename(p.type, p.oldPath, p.newPath),
    onSuccess: () => {
      setSelected(new Map());
      void refetch();
      showToast('已重命名');
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: (items: PathItem[]) => storageApi.remove(items),
    onSuccess: (res) => {
      setSelected(new Map());
      void refetch();
      showToast(`已删除 ${res.deletedCount} 个对象`);
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const toggleSelect = (item: PathItem) => {
    const key = `${item.type}:${item.path}`;
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, item);
      return next;
    });
  };

  const copyLink = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    showToast(`已复制${label}`);
  };

  const handleRename = (type: 'file' | 'folder', currentPath: string, currentName: string) => {
    const nextName = window.prompt(`重命名${type === 'folder' ? '文件夹' : '文件'}`, currentName);
    if (!nextName || nextName.trim() === '' || nextName.trim() === currentName) return;
    const cleanName = nextName.trim();
    const newPath = type === 'folder' ? `${prefix}${cleanName}/` : `${prefix}${cleanName}`;
    renameMut.mutate({ type, oldPath: currentPath, newPath });
  };

  const breadcrumbs = useMemo(() => {
    const parts = prefix.replace(/\/+$/, '').split('/').filter(Boolean);
    const items: Array<{ label: string; prefix: string }> = [{ label: '根目录', prefix: '' }];
    let acc = '';
    for (const p of parts) {
      acc += `${p}/`;
      items.push({ label: p, prefix: acc });
    }
    return items;
  }, [prefix]);

  if (cfgLoading) {
    return <div className="text-xs text-zinc-400">加载图床配置...</div>;
  }

  if (!cfg?.configured) {
    return (
      <div className="yd-empty p-14 space-y-4">
        <div className="mx-auto h-11 w-11 rounded-xl bg-zinc-100 text-zinc-500 flex items-center justify-center">
          <ImageIcon className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-zinc-900">尚未配置对象存储桶</h2>
          <p className="text-xs text-zinc-500">
            请先前往「系统设置」填写你自己的 Cloudflare R2 / S3 存储桶与公开直链域名。
          </p>
        </div>
        <Link to="/settings?tab=storage" className="yd-btn-primary">
          <Settings className="h-3.5 w-3.5" />
          前往配置存储桶
        </Link>
      </div>
    );
  }

  const activeLightbox = lightboxIdx !== null ? imageFiles[lightboxIdx] : null;

  return (
    <div
      className="space-y-5 relative min-h-[70vh]"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length > 0) {
          void handleUploadFiles(e.dataTransfer.files);
        }
      }}
    >
      {/* Drag overlay */}
      {dragging && (
        <div
          onDragLeave={() => setDragging(false)}
          className="fixed inset-0 z-40 bg-sky-50/50 backdrop-blur-[3px] flex items-center justify-center p-6"
        >
          <div className="rounded-2xl border border-dashed border-sky-300 bg-white px-10 py-8 text-center shadow-lg">
            <Upload className="h-7 w-7 mx-auto text-sky-500" />
            <div className="mt-2.5 text-sm font-medium text-zinc-800">
              松开上传至「{prefix || '根目录'}」
            </div>
            <div className="text-xs text-zinc-500 mt-1">自动去除 EXIF 并按哈希命名</div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h1 className="yd-page-title">图床管理</h1>
          <Link
            to="/settings?tab=storage"
            className="yd-badge yd-badge-neutral hover:bg-sky-50 hover:text-sky-700 transition-colors"
            title="修改上传模式或存储桶配置"
          >
            {cfg.upload_mode === 'direct' ? '直传' : `中转 ≤${cfg.proxy_max_mb}MB`}
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const name = window.prompt('新建文件夹名称（支持多级如 2026/trips）');
              if (name && name.trim()) createFolderMut.mutate(name.trim());
            }}
            className="yd-btn-secondary"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            新建文件夹
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="yd-btn-primary py-1.5"
          >
            <Upload className="h-3.5 w-3.5" />
            上传
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void handleUploadFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {/* Sub-toolbar: Breadcrumbs + Search */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-zinc-200/70">
        <div className="flex flex-wrap items-center gap-1">
          {breadcrumbs.map((b, i) => (
            <div key={b.prefix} className="flex items-center gap-1">
              {i > 0 && <span className="text-zinc-300 text-xs">/</span>}
              <button
                type="button"
                onClick={() => {
                  setPrefix(b.prefix);
                  setSelected(new Map());
                }}
                className={`rounded-md px-2 py-1 text-xs transition-colors ${
                  i === breadcrumbs.length - 1
                    ? 'text-zinc-800 font-medium cursor-default'
                    : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
                }`}
              >
                {b.label}
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-1.5 rounded-lg border border-zinc-200/90 bg-white px-2.5 py-1.5 text-xs focus-within:border-sky-300 focus-within:ring-2 focus-within:ring-sky-500/12 transition-colors">
          <Search className="h-3.5 w-3.5 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="筛选当前目录..."
            className="w-40 outline-none text-zinc-800 placeholder:text-zinc-400 bg-transparent"
          />
        </div>
      </div>

      {/* Notices */}
      {uploadingText && <div className="yd-notice-info">{uploadingText}</div>}
      {toast && (
        <div className={toast.tone === 'error' ? 'yd-notice-error' : 'yd-notice'}>
          {toast.text}
        </div>
      )}

      {listLoading ? (
        <div className="py-12 text-center text-xs text-zinc-400">正在读取存储桶...</div>
      ) : (
        <>
          {/* Folders Grid */}
          {filteredFolders.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {filteredFolders.map((folder: FolderEntry) => {
                const isSel = selected.has(`folder:${folder.prefix}`);
                return (
                  <div
                    key={folder.prefix}
                    onClick={() => {
                      setPrefix(folder.prefix);
                      setSelected(new Map());
                    }}
                    className={`group flex items-center justify-between gap-2 rounded-xl border bg-white px-3.5 py-2.5 cursor-pointer transition-all ${
                      isSel
                        ? 'border-sky-400 ring-2 ring-sky-500/15'
                        : 'border-zinc-200/75 shadow-[0_1px_2px_rgba(15,23,42,0.025)] hover:border-sky-200'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelect({ type: 'folder', path: folder.prefix });
                        }}
                        className="relative h-4 w-4 shrink-0 flex items-center justify-center"
                        title={isSel ? '取消选择' : '选择文件夹'}
                      >
                        {isSel ? (
                          <span className="h-4 w-4 rounded bg-sky-500 text-white flex items-center justify-center">
                            <Check className="h-3 w-3" />
                          </span>
                        ) : (
                          <>
                            <Folder className="h-4 w-4 text-sky-400 group-hover:opacity-0 transition-opacity" />
                            <span className="absolute inset-0 rounded border border-zinc-300 bg-white opacity-0 group-hover:opacity-100 transition-opacity" />
                          </>
                        )}
                      </button>
                      <span className="text-[13px] text-zinc-800 truncate">{folder.name}</span>
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <button
                        type="button"
                        title="重命名文件夹"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRename('folder', folder.prefix, folder.name);
                        }}
                        className="yd-btn-icon p-1"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="删除文件夹"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`确定递归删除文件夹「${folder.name}」及其下所有文件？`)) {
                            deleteMut.mutate([{ type: 'folder', path: folder.prefix }]);
                          }
                        }}
                        className="yd-btn-danger-icon p-1"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Album Files Waterfall Masonry */}
          {filteredFiles.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
              {waterfallColumns.map((colFiles, colIdx) => (
                <div key={colIdx} className="flex flex-col gap-4 min-w-0">
                  {colFiles.map((file: FileEntry) => {
                    const isSel = selected.has(`file:${file.key}`);
                    const imgIdx = file.is_image ? imageFiles.findIndex((x) => x.key === file.key) : -1;
                    const dims = file.is_image ? dimsMap[file.url] : undefined;
                    const isLoaded = Boolean(loadedUrls[file.url]);
                    return (
                      <div
                        key={file.key}
                        onClick={() => {
                          if (file.is_image && imgIdx >= 0) setLightboxIdx(imgIdx);
                          else window.open(file.url, '_blank', 'noopener');
                        }}
                        className={`group relative rounded-xl border bg-white overflow-hidden cursor-pointer transition-all ${
                          isSel
                            ? 'border-sky-400 ring-2 ring-sky-500/15'
                            : 'border-zinc-200/75 shadow-[0_1px_2px_rgba(15,23,42,0.025)] hover:border-sky-200'
                        }`}
                      >
                        {file.is_image ? (
                          <div
                            className={`relative w-full overflow-hidden ${isLoaded ? 'bg-white' : 'bg-[#f1f5f9] animate-pulse'}`}
                            style={{ aspectRatio: dims ? `${dims[0]} / ${dims[1]}` : '4 / 3' }}
                          >
                            <img
                              src={file.url}
                              alt={file.name}
                              loading="lazy"
                              width={dims?.[0]}
                              height={dims?.[1]}
                              onLoad={(e) => {
                                const img = e.currentTarget;
                                setLoadedUrls((prev) => (prev[file.url] ? prev : { ...prev, [file.url]: true }));
                                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                                  const existing = dimsMap[file.url];
                                  if (!existing || existing[0] !== img.naturalWidth || existing[1] !== img.naturalHeight) {
                                    saveCachedDimensionsBatch({ [file.url]: [img.naturalWidth, img.naturalHeight] });
                                    setDimsMap((prev) => ({
                                      ...prev,
                                      [file.url]: [img.naturalWidth, img.naturalHeight],
                                    }));
                                  }
                                }
                              }}
                              className={`block w-full h-full object-contain transition-all duration-300 group-hover:scale-[1.02] ${
                                isLoaded ? 'opacity-100' : 'opacity-0'
                              }`}
                            />
                          </div>
                        ) : (
                          <div className="w-full min-h-[148px] flex flex-col items-center justify-center gap-2 p-6 bg-[#f8fafc] text-zinc-500">
                            <FileIcon className="h-9 w-9 text-zinc-300" />
                            <div className="text-xs font-medium text-zinc-700 truncate max-w-full">
                              {file.name}
                            </div>
                            <div className="text-[11px] text-zinc-400 tabular-nums">
                              {formatBytes(file.size)}
                            </div>
                          </div>
                        )}

                        {/* Top-left selection checkbox */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSelect({ type: 'file', path: file.key });
                          }}
                          className={`absolute top-2.5 left-2.5 h-6 w-6 rounded-md border flex items-center justify-center transition-opacity ${
                            isSel
                              ? 'bg-sky-500 border-sky-500 text-white opacity-100'
                              : 'bg-white/90 backdrop-blur-xs border-zinc-300 opacity-0 group-hover:opacity-100'
                          }`}
                        >
                          {isSel && <Check className="h-3.5 w-3.5" />}
                        </button>

                        {/* Top-right quick actions */}
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="absolute top-2.5 right-2.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <button
                            type="button"
                            title="复制直链"
                            onClick={() => void copyLink(file.url, '直链')}
                            className="h-7 w-7 rounded-lg bg-white/90 backdrop-blur-xs hover:bg-white text-zinc-700 shadow-xs flex items-center justify-center transition-colors"
                          >
                            <Link2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            title="复制 Markdown"
                            onClick={() =>
                              void copyLink(
                                file.is_image ? `![](${file.url})` : `[${file.name}](${file.url})`,
                                ' Markdown',
                              )
                            }
                            className="h-7 w-7 rounded-lg bg-white/90 backdrop-blur-xs hover:bg-white text-zinc-700 shadow-xs flex items-center justify-center transition-colors"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            title="重命名"
                            onClick={() => handleRename('file', file.key, file.name)}
                            className="h-7 w-7 rounded-lg bg-white/90 backdrop-blur-xs hover:bg-white text-zinc-700 shadow-xs flex items-center justify-center transition-colors"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            title="删除"
                            onClick={() => {
                              if (window.confirm(`确定删除文件「${file.name}」吗？`)) {
                                deleteMut.mutate([{ type: 'file', path: file.key }]);
                              }
                            }}
                            className="h-7 w-7 rounded-lg bg-white/90 backdrop-blur-xs hover:bg-red-50 text-zinc-700 hover:text-red-600 shadow-xs flex items-center justify-center transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        {/* Bottom overlay metadata */}
                        <div className="absolute inset-x-0 bottom-0 bg-white/90 backdrop-blur-xs border-t border-zinc-200/60 px-3 py-2 text-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-between gap-2">
                          <span className="text-xs font-medium truncate">{file.name}</span>
                          <span className="text-[11px] text-zinc-500 shrink-0 inline-flex items-center gap-1 tabular-nums">
                            {file.metadata_stripped && <ShieldCheck className="h-3 w-3 text-emerald-500" />}
                            {formatBytes(file.size)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : filteredFolders.length === 0 ? (
            <div className="yd-empty py-16 space-y-1">
              <p className="text-sm font-medium text-zinc-700">当前目录为空</p>
              <p className="text-xs text-zinc-400">支持拖拽、Ctrl+V 粘贴截图或点击上传</p>
            </div>
          ) : null}
        </>
      )}

      {/* Floating Batch Selection Bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-full border border-zinc-200/90 bg-white/95 backdrop-blur-md px-4 py-2 text-xs text-zinc-700 shadow-[0_8px_28px_rgba(15,23,42,0.1)]">
          <span className="px-1.5 font-medium text-zinc-800 tabular-nums">已选 {selected.size} 项</span>
          <button
            type="button"
            onClick={() => setMoveModalOpen(true)}
            className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-3 py-1 font-medium text-sky-700 hover:bg-sky-100 transition-colors"
          >
            <FolderInput className="h-3.5 w-3.5" />
            移动到...
          </button>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`确定删除选中的 ${selected.size} 个项目吗？`)) {
                deleteMut.mutate(Array.from(selected.values()));
              }
            }}
            className="inline-flex items-center gap-1 rounded-full bg-red-50 px-3 py-1 font-medium text-red-600 hover:bg-red-100 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Map())}
            className="px-1.5 text-zinc-400 hover:text-zinc-700 transition-colors"
          >
            取消
          </button>
        </div>
      )}

      {/* Batch Move Modal */}
      {moveModalOpen && (
        <MoveFolderModal
          items={Array.from(selected.values())}
          onClose={() => setMoveModalOpen(false)}
          onMoved={(count) => {
            setMoveModalOpen(false);
            setSelected(new Map());
            void qc.invalidateQueries({ queryKey: ['storage'] });
            showToast(`已移动 ${count} 个对象`);
          }}
        />
      )}

      {/* Fullscreen Lightbox */}
      {activeLightbox && lightboxIdx !== null && (
        <div
          onClick={() => setLightboxIdx(null)}
          className="fixed inset-0 z-50 bg-white/85 backdrop-blur-md flex flex-col items-center justify-center p-4"
        >
          <button
            type="button"
            onClick={() => setLightboxIdx(null)}
            className="absolute top-4 right-4 rounded-full border border-zinc-200 bg-white p-2 text-zinc-600 shadow-xs hover:bg-zinc-50 hover:text-zinc-900 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>

          {lightboxIdx > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxIdx(lightboxIdx - 1);
              }}
              className="absolute left-4 rounded-full border border-zinc-200 bg-white p-2.5 text-zinc-600 shadow-xs hover:bg-zinc-50 hover:text-zinc-900 transition-colors"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}
          {lightboxIdx < imageFiles.length - 1 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxIdx(lightboxIdx + 1);
              }}
              className="absolute right-4 rounded-full border border-zinc-200 bg-white p-2.5 text-zinc-600 shadow-xs hover:bg-zinc-50 hover:text-zinc-900 transition-colors"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}

          <img
            src={activeLightbox.url}
            alt={activeLightbox.name}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] max-w-[90vw] object-contain rounded-xl border border-zinc-200/80 bg-white shadow-xl"
          />

          <div
            onClick={(e) => e.stopPropagation()}
            className="mt-4 flex flex-wrap items-center gap-2.5 rounded-full border border-zinc-200/90 bg-white px-4 py-2 text-xs text-zinc-700 shadow-sm"
          >
            <span className="font-medium text-zinc-800">{activeLightbox.name}</span>
            <span className="text-zinc-400 tabular-nums">{formatBytes(activeLightbox.size)}</span>
            <button
              type="button"
              onClick={() => void copyLink(activeLightbox.url, '直链')}
              className="rounded-full bg-sky-50 px-3 py-1 font-medium text-sky-700 hover:bg-sky-100 transition-colors"
            >
              复制直链
            </button>
            <button
              type="button"
              onClick={() => void copyLink(`![](${activeLightbox.url})`, ' Markdown')}
              className="rounded-full bg-sky-50 px-3 py-1 font-medium text-sky-700 hover:bg-sky-100 transition-colors"
            >
              复制 Markdown
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MoveFolderModal({
  items,
  onClose,
  onMoved,
}: {
  items: PathItem[];
  onClose: () => void;
  onMoved: (count: number) => void;
}) {
  const [browsePrefix, setBrowsePrefix] = useState('');
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['storage', 'folders', browsePrefix],
    queryFn: () => storageApi.listFolders(browsePrefix),
  });

  const moveMut = useMutation({
    mutationFn: () => storageApi.move(items, browsePrefix),
    onSuccess: (res) => onMoved(res.movedCount),
    onError: (err: Error) => setError(err.message),
  });

  const goParent = () => {
    const parts = browsePrefix.replace(/\/+$/, '').split('/').filter(Boolean);
    parts.pop();
    setBrowsePrefix(parts.length > 0 ? `${parts.join('/')}/` : '');
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-slate-900/15 backdrop-blur-[2px] flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-zinc-200/90 bg-white p-5 space-y-4 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-900">移动 {items.length} 个项目到...</h3>
          <button type="button" onClick={onClose} className="yd-btn-icon">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="text-xs text-zinc-500">
          目标路径：<span className="yd-code">/{browsePrefix}</span>
        </div>

        {error && <div className="yd-notice-error">{error}</div>}

        <div className="max-h-60 overflow-y-auto rounded-xl border border-zinc-200/80 divide-y divide-zinc-100">
          {browsePrefix !== '' && (
            <button
              type="button"
              onClick={goParent}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-xs text-zinc-600 hover:bg-zinc-50 transition-colors"
            >
              <Folder className="h-4 w-4 text-zinc-400" />
              ..（返回上一级）
            </button>
          )}
          {isLoading ? (
            <div className="p-4 text-xs text-zinc-400 text-center">加载目录中...</div>
          ) : (data?.folders ?? []).length === 0 ? (
            <div className="p-4 text-xs text-zinc-400 text-center">无更深层子文件夹</div>
          ) : (
            (data?.folders ?? []).map((f) => (
              <button
                key={f.prefix}
                type="button"
                onClick={() => setBrowsePrefix(f.prefix)}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-xs text-zinc-800 hover:bg-zinc-50 transition-colors"
              >
                <Folder className="h-4 w-4 text-zinc-400" />
                {f.name}
              </button>
            ))
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="yd-btn-secondary">
            取消
          </button>
          <button
            type="button"
            disabled={moveMut.isPending}
            onClick={() => moveMut.mutate()}
            className="yd-btn-primary"
          >
            {moveMut.isPending ? '移动中...' : '移动到当前目录'}
          </button>
        </div>
      </div>
    </div>
  );
}
