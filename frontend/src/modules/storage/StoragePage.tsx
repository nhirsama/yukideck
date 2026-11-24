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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        void refetch();
        showToast(lastErr ? `成功 ${okCount} 个，部分失败：${lastErr}` : `已上传 ${okCount} 个文件`, lastErr ? 'error' : 'info');
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
    return <div className="text-sm text-slate-500">加载图床配置...</div>;
  }

  if (!cfg?.configured) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center space-y-4">
        <div className="mx-auto h-12 w-12 rounded-xl bg-slate-100 text-slate-600 flex items-center justify-center">
          <ImageIcon className="h-6 w-6" />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-slate-900">尚未配置对象存储桶</h2>
          <p className="text-xs text-slate-500">
            请先前往「系统设置」填写你自己的 Cloudflare R2 / S3 存储桶与公开直链域名。
          </p>
        </div>
        <Link
          to="/settings?tab=storage"
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
        >
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
          className="fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-xs flex items-center justify-center p-6"
        >
          <div className="rounded-2xl border-2 border-dashed border-slate-900 bg-white px-10 py-8 text-center shadow-lg">
            <Upload className="h-8 w-8 mx-auto text-slate-900" />
            <div className="mt-2 text-sm font-medium text-slate-900">
              松开即可上传至「{prefix || '根目录'}」
            </div>
            <div className="text-xs text-slate-500 mt-1">图片将自动无损剥离 EXIF 并按 SHA-256 命名</div>
          </div>
        </div>
      )}

      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 text-lg font-medium text-slate-900">
          {breadcrumbs.map((b, i) => (
            <div key={b.prefix} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-slate-300 text-sm">/</span>}
              <button
                type="button"
                onClick={() => {
                  setPrefix(b.prefix);
                  setSelected(new Map());
                }}
                className={`rounded-lg px-2 py-0.5 text-sm transition-colors ${
                  i === breadcrumbs.length - 1
                    ? 'text-slate-900 font-semibold cursor-default'
                    : 'text-slate-500 hover:bg-slate-200/70 hover:text-slate-900'
                }`}
              >
                {b.label}
              </button>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="筛选当前目录..."
              className="w-36 outline-none text-slate-700 placeholder:text-slate-400"
            />
          </div>

          <Link
            to="/settings?tab=storage"
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:text-slate-900"
            title="点击修改上传模式或存储桶配置"
          >
            {cfg.upload_mode === 'direct' ? '直传（不限大小）' : `中转（≤${cfg.proxy_max_mb}MB）`}
          </Link>

          <button
            type="button"
            onClick={() => {
              const name = window.prompt('新建文件夹名称（支持多级如 2026/trips）');
              if (name && name.trim()) createFolderMut.mutate(name.trim());
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            新建文件夹
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            <Upload className="h-3.5 w-3.5" />
            上传文件
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

      {/* Notices */}
      {uploadingText && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs text-blue-800">
          {uploadingText}
        </div>
      )}
      {toast && (
        <div
          className={`rounded-lg border px-4 py-2.5 text-xs ${
            toast.tone === 'error'
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-slate-200 bg-white text-slate-700'
          }`}
        >
          {toast.text}
        </div>
      )}

      {listLoading ? (
        <div className="py-12 text-center text-sm text-slate-500">正在读取存储桶...</div>
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
                    className={`group flex items-center justify-between gap-2 rounded-xl border bg-white px-3.5 py-3 cursor-pointer transition-all ${
                      isSel ? 'border-slate-900 ring-2 ring-slate-900/10' : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelect({ type: 'folder', path: folder.prefix });
                        }}
                        className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 ${
                          isSel
                            ? 'bg-slate-900 border-slate-900 text-white'
                            : 'border-slate-300 opacity-0 group-hover:opacity-100'
                        }`}
                      >
                        {isSel && <Check className="h-3 w-3" />}
                      </button>
                      <Folder className="h-4 w-4 text-blue-600 shrink-0" />
                      <span className="text-sm text-slate-800 truncate">{folder.name}</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 shrink-0">
                      <button
                        type="button"
                        title="重命名文件夹"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRename('folder', folder.prefix, folder.name);
                        }}
                        className="p-1 rounded hover:bg-slate-100 text-slate-500"
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
                        className="p-1 rounded hover:bg-red-50 text-slate-500 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Album Files Grid */}
          {filteredFiles.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredFiles.map((file: FileEntry) => {
                const isSel = selected.has(`file:${file.key}`);
                const imgIdx = file.is_image ? imageFiles.findIndex((x) => x.key === file.key) : -1;
                return (
                  <div
                    key={file.key}
                    onClick={() => {
                      if (file.is_image && imgIdx >= 0) setLightboxIdx(imgIdx);
                      else window.open(file.url, '_blank', 'noopener');
                    }}
                    className={`group relative aspect-[4/3] rounded-2xl border bg-white overflow-hidden cursor-pointer transition-all ${
                      isSel ? 'border-slate-900 ring-2 ring-slate-900/15' : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    {file.is_image ? (
                      <img
                        src={file.url}
                        alt={file.name}
                        loading="lazy"
                        className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-6 bg-slate-50 text-slate-500">
                        <FileIcon className="h-10 w-10 text-slate-400" />
                        <div className="text-xs font-medium text-slate-700 truncate max-w-full">{file.name}</div>
                        <div className="text-[11px] text-slate-400">{formatBytes(file.size)}</div>
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
                          ? 'bg-slate-900 border-slate-900 text-white opacity-100'
                          : 'bg-white/90 border-slate-300 opacity-0 group-hover:opacity-100'
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
                        className="h-7 w-7 rounded-lg bg-white/90 hover:bg-white text-slate-700 shadow-xs flex items-center justify-center"
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
                        className="h-7 w-7 rounded-lg bg-white/90 hover:bg-white text-slate-700 shadow-xs flex items-center justify-center"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="重命名"
                        onClick={() => handleRename('file', file.key, file.name)}
                        className="h-7 w-7 rounded-lg bg-white/90 hover:bg-white text-slate-700 shadow-xs flex items-center justify-center"
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
                        className="h-7 w-7 rounded-lg bg-white/90 hover:bg-red-50 text-slate-700 hover:text-red-600 shadow-xs flex items-center justify-center"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* Bottom overlay metadata */}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950/70 via-slate-950/30 to-transparent px-3 py-2.5 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-between gap-2">
                      <span className="text-xs truncate">{file.name}</span>
                      <span className="text-[11px] text-white/80 shrink-0 inline-flex items-center gap-1">
                        {file.metadata_stripped && <ShieldCheck className="h-3 w-3 text-emerald-300" />}
                        {formatBytes(file.size)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : filteredFolders.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white py-16 text-center space-y-2">
              <p className="text-sm font-medium text-slate-700">当前目录为空</p>
              <p className="text-xs text-slate-500">支持拖拽文件到此页面、直接 Ctrl+V 粘贴截图，或点击右上角上传。</p>
            </div>
          ) : null}
        </>
      )}

      {/* Floating Batch Selection Bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 rounded-full border border-slate-200 bg-slate-900 px-5 py-2.5 text-xs text-white shadow-xl">
          <span>已选 {selected.size} 项</span>
          <button
            type="button"
            onClick={() => setMoveModalOpen(true)}
            className="inline-flex items-center gap-1 rounded-full bg-white/15 px-3 py-1 hover:bg-white/25"
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
            className="inline-flex items-center gap-1 rounded-full bg-red-500/80 px-3 py-1 hover:bg-red-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Map())}
            className="text-slate-300 hover:text-white"
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
          className="fixed inset-0 z-50 bg-slate-950/90 flex flex-col items-center justify-center p-4"
        >
          <button
            type="button"
            onClick={() => setLightboxIdx(null)}
            className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
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
              className="absolute left-4 rounded-full bg-white/10 p-2.5 text-white hover:bg-white/20"
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
              className="absolute right-4 rounded-full bg-white/10 p-2.5 text-white hover:bg-white/20"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}

          <img
            src={activeLightbox.url}
            alt={activeLightbox.name}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
          />

          <div
            onClick={(e) => e.stopPropagation()}
            className="mt-4 flex flex-wrap items-center gap-3 rounded-full bg-white/10 px-4 py-2 text-xs text-white"
          >
            <span>{activeLightbox.name}</span>
            <span className="text-white/60">{formatBytes(activeLightbox.size)}</span>
            <button
              type="button"
              onClick={() => void copyLink(activeLightbox.url, '直链')}
              className="rounded-full bg-white/15 px-3 py-1 hover:bg-white/25"
            >
              复制直链
            </button>
            <button
              type="button"
              onClick={() => void copyLink(`![](${activeLightbox.url})`, ' Markdown')}
              className="rounded-full bg-white/15 px-3 py-1 hover:bg-white/25"
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
    <div onClick={onClose} className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 space-y-4 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">移动 {items.length} 个项目到...</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="text-xs text-slate-500">
          目标路径：<span className="font-mono text-slate-800">/{browsePrefix}</span>
        </div>

        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

        <div className="max-h-60 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100">
          {browsePrefix !== '' && (
            <button
              type="button"
              onClick={goParent}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-xs text-slate-600 hover:bg-slate-50"
            >
              <Folder className="h-4 w-4 text-slate-400" />
              ..（返回上一级）
            </button>
          )}
          {isLoading ? (
            <div className="p-4 text-xs text-slate-400 text-center">加载目录中...</div>
          ) : (data?.folders ?? []).length === 0 ? (
            <div className="p-4 text-xs text-slate-400 text-center">无更深层子文件夹</div>
          ) : (
            (data?.folders ?? []).map((f) => (
              <button
                key={f.prefix}
                type="button"
                onClick={() => setBrowsePrefix(f.prefix)}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-xs text-slate-800 hover:bg-slate-50"
              >
                <Folder className="h-4 w-4 text-blue-600" />
                {f.name}
              </button>
            ))
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-3.5 py-1.5 text-xs text-slate-700"
          >
            取消
          </button>
          <button
            type="button"
            disabled={moveMut.isPending}
            onClick={() => moveMut.mutate()}
            className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            {moveMut.isPending ? '移动中...' : '移动到当前目录'}
          </button>
        </div>
      </div>
    </div>
  );
}
