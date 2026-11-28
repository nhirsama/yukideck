import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Folder,
  FolderInput,
  FolderPlus,
  Image as ImageIcon,
  Layers,
  Link2,
  Pencil,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { LoadingState } from '@/components/LoadingState';
import { useToast } from '@/components/Toast';
import { Tooltip } from '@/components/Tooltip';
import {
  storageApi,
  type FileEntry,
  type ObjectDimensionInput,
  type PathItem,
  type PrefixGroup,
} from './api';
import { PathNavigatorContent } from './components/PathNavigator';
import { PrefixSection } from './components/PrefixSection';
import { StorageLightbox } from './components/StorageLightbox';
import {
  buildPathTree,
  formatPrefixLabel,
  getFileDimensions,
} from './justifiedLayout';
import { loadCachedDimensions, saveCachedDimensionsBatch } from './metadata';
import { useStoragePointerMove } from './useStoragePointerMove';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getKeyParentPrefix(key: string): string {
  const idx = key.lastIndexOf('/');
  return idx >= 0 ? key.slice(0, idx + 1) : '';
}

export default function StoragePage() {
  const qc = useQueryClient();
  const { showToast, setProgress } = useToast();

  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusedPrefix, setFocusedPrefix] = useState<string | null>(null);
  const [activePrefix, setActivePrefix] = useState<string>('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [selected, setSelected] = useState<Map<string, PathItem>>(new Map());
  const [dragging, setDragging] = useState(false);
  const [lightboxKey, setLightboxKey] = useState<string | null>(null);
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [mobileActionFile, setMobileActionFile] = useState<FileEntry | null>(null);
  const [dimsMap, setDimsMap] = useState<Record<string, [number, number]>>(() =>
    loadCachedDimensions(),
  );
  const [loadedUrls, setLoadedUrls] = useState<Record<string, true>>({});
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [galleryWidth, setGalleryWidth] = useState<number>(() =>
    typeof window === 'undefined' ? 920 : Math.min(960, Math.max(320, window.innerWidth - 320)),
  );
  const [bottomSpacerHeight, setBottomSpacerHeight] = useState<number>(0);
  const bottomSpacerRef = useRef<HTMLDivElement | null>(null);

  const galleryHostRef = useRef<HTMLDivElement | null>(null);
  const sectionRefsRef = useRef<Map<string, HTMLElement>>(new Map());
  const sectionRefCallbacksRef = useRef<Map<string, (el: HTMLElement | null) => void>>(new Map());
  const pendingDimsRef = useRef<Map<string, ObjectDimensionInput>>(new Map());
  const dimsFlushTimerRef = useRef<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pickerTargetPrefixRef = useRef<string>('');
  const pendingScrollPrefixRef = useRef<string | null>(null);
  const scrollSpyLockUntilRef = useRef<number>(0);
  const manualFocusScrollYRef = useRef<number | null>(null);

  // Active upload path always follows whichever section is highlighted / focused!
  const effectiveUploadPrefix = focusedPrefix ?? activePrefix;

  const flushPendingDims = useCallback(() => {
    if (dimsFlushTimerRef.current !== null) {
      window.clearTimeout(dimsFlushTimerRef.current);
      dimsFlushTimerRef.current = null;
    }
    if (pendingDimsRef.current.size === 0) return;
    const batch = Array.from(pendingDimsRef.current.values());
    pendingDimsRef.current.clear();
    void storageApi.saveDimensions(batch).catch(() => {
      // Ephemeral cache write failure is non-fatal; will self-heal next load.
    });
  }, []);

  useEffect(() => {
    return () => {
      flushPendingDims();
      setProgress('storage-upload', null);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, [flushPendingDims, setProgress]);

  const { data: cfgData, isLoading: cfgLoading } = useQuery({
    queryKey: ['storage', 'config'],
    queryFn: storageApi.getConfig,
  });
  const cfg = cfgData?.config;

  const {
    data: gallery,
    isLoading: galleryLoading,
    refetch,
  } = useQuery({
    queryKey: ['storage', 'gallery'],
    queryFn: () => storageApi.gallery(),
    enabled: Boolean(cfg?.configured),
  });

  const allGroups = gallery?.groups ?? [];

  // Measure main gallery column width dynamically for flush Justified Row layout.
  useEffect(() => {
    const el = galleryHostRef.current;
    if (!el) return;
    const update = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w > 0) setGalleryWidth(w);
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [cfg?.configured, galleryLoading]);

  const pathTreeNodes = useMemo(() => buildPathTree(allGroups), [allGroups]);

  // Apply focus filter + global search across all prefixes.
  const visibleGroups: PrefixGroup[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out: PrefixGroup[] = [];

    for (const g of allGroups) {
      if (focusedPrefix !== null) {
        if (focusedPrefix === '') {
          if (g.prefix !== '') continue;
        } else if (g.prefix !== focusedPrefix && !g.prefix.startsWith(focusedPrefix)) {
          continue;
        }
      }

      if (!q) {
        out.push(g);
        continue;
      }

      const prefixMatches = (g.prefix === '' ? '/' : `/${g.prefix.toLowerCase()}`).includes(q);
      if (prefixMatches) {
        out.push(g);
        continue;
      }

      const matchedFiles = g.files.filter(
        (f) => f.name.toLowerCase().includes(q) || f.key.toLowerCase().includes(q),
      );
      if (matchedFiles.length > 0) {
        out.push({ prefix: g.prefix, files: matchedFiles });
      }
    }

    return out;
  }, [allGroups, focusedPrefix, search]);

  const allVisibleImages = useMemo(() => {
    const imgs: FileEntry[] = [];
    for (const g of visibleGroups) {
      for (const f of g.files) {
        if (f.is_image) imgs.push(f);
      }
    }
    return imgs;
  }, [visibleGroups]);

  const lightboxIdx = useMemo(() => {
    if (!lightboxKey) return null;
    const idx = allVisibleImages.findIndex((f) => f.key === lightboxKey);
    return idx >= 0 ? idx : null;
  }, [allVisibleImages, lightboxKey]);

  // Measure exact DOM span from the last section's top to the document bottom (excluding the spacer),
  // then size the spacer so 100% bottom scroll stops at the exact pixel where the last section's
  // breadcrumb reaches its sticky top offset (10px desktop / 64px mobile) — 0px overlap with images!
  useEffect(() => {
    if (visibleGroups.length <= 1) {
      setBottomSpacerHeight(0);
      return;
    }
    const lastPrefix = visibleGroups[visibleGroups.length - 1].prefix;
    const recalc = () => {
      const lastEl = sectionRefsRef.current.get(lastPrefix);
      if (!lastEl) {
        setBottomSpacerHeight(0);
        return;
      }
      const stickyTop = window.innerWidth >= 1024 ? 10 : 64;
      const curSpacerH = bottomSpacerRef.current?.getBoundingClientRect().height ?? 0;
      const lastTopDoc = lastEl.getBoundingClientRect().top + window.scrollY;
      const naturalSpan = document.documentElement.scrollHeight - lastTopDoc - curSpacerH;
      const next = Math.max(0, Math.floor(window.innerHeight - stickyTop - naturalSpan));
      setBottomSpacerHeight((prev) => (Math.abs(prev - next) <= 1 ? prev : next));
    };

    const rafId = window.requestAnimationFrame(recalc);
    const lastEl = sectionRefsRef.current.get(lastPrefix);
    const ro =
      lastEl && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => recalc()) : null;
    if (ro && lastEl) ro.observe(lastEl);
    window.addEventListener('resize', recalc);
    return () => {
      window.cancelAnimationFrame(rafId);
      ro?.disconnect();
      window.removeEventListener('resize', recalc);
    };
  }, [visibleGroups, galleryWidth, dimsMap]);

  // Execute pending scroll after exiting focus mode.
  useEffect(() => {
    const target = pendingScrollPrefixRef.current;
    if (target === null) return;
    pendingScrollPrefixRef.current = null;
    window.requestAnimationFrame(() => {
      const el = sectionRefsRef.current.get(target);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [visibleGroups]);

  // Scroll-Spy: highlight the section scrolled into view -> automatically becomes the default upload path.
  useEffect(() => {
    if (visibleGroups.length === 0) {
      setActivePrefix(focusedPrefix ?? '');
      return;
    }

    let rafId: number | null = null;
    const updateActive = () => {
      rafId = null;
      if (performance.now() < scrollSpyLockUntilRef.current) return;
      if (manualFocusScrollYRef.current !== null) {
        if (Math.abs(window.scrollY - manualFocusScrollYRef.current) < 24) return;
        manualFocusScrollYRef.current = null;
      }

      // Anchor matches the sticky section breadcrumb bar position (top-0 on desktop, top-14 on mobile).
      const anchorY = window.innerWidth >= 1024 ? 28 : 84;
      let chosen: string = visibleGroups[0].prefix;
      for (const g of visibleGroups) {
        const el = sectionRefsRef.current.get(g.prefix);
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        if (top <= anchorY) {
          chosen = g.prefix;
        } else {
          break;
        }
      }
      setActivePrefix((prev) => (prev === chosen ? prev : chosen));
    };

    const onScroll = () => {
      if (rafId === null) {
        rafId = window.requestAnimationFrame(updateActive);
      }
    };

    updateActive();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [visibleGroups, focusedPrefix]);

  const getSectionRefCallback = useCallback((prefix: string) => {
    let cb = sectionRefCallbacksRef.current.get(prefix);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) sectionRefsRef.current.set(prefix, el);
        else sectionRefsRef.current.delete(prefix);
      };
      sectionRefCallbacksRef.current.set(prefix, cb);
    }
    return cb;
  }, []);

  const handleImageLoaded = useCallback(
    (file: FileEntry, naturalWidth: number, naturalHeight: number) => {
      setLoadedUrls((prev) => (prev[file.url] ? prev : { ...prev, [file.url]: true }));
      if (naturalWidth <= 0 || naturalHeight <= 0) return;

      const serverMatched = file.width === naturalWidth && file.height === naturalHeight;
      setDimsMap((prev) => {
        const existing = prev[file.key] ?? prev[file.url];
        if (existing && existing[0] === naturalWidth && existing[1] === naturalHeight) {
          return prev;
        }
        saveCachedDimensionsBatch({ [file.url]: [naturalWidth, naturalHeight] });
        return {
          ...prev,
          [file.key]: [naturalWidth, naturalHeight],
          [file.url]: [naturalWidth, naturalHeight],
        };
      });

      if (!serverMatched) {
        pendingDimsRef.current.set(file.key, {
          key: file.key,
          size: file.size,
          width: naturalWidth,
          height: naturalHeight,
        });
        if (pendingDimsRef.current.size >= 24) {
          flushPendingDims();
        } else if (dimsFlushTimerRef.current === null) {
          dimsFlushTimerRef.current = window.setTimeout(flushPendingDims, 500);
        }
      }
    },
    [flushPendingDims],
  );

  const handleUploadFiles = useCallback(
    async (files: FileList | File[], targetPrefix?: string) => {
      if (!cfg?.configured) return;
      const arr = Array.from(files);
      if (arr.length === 0) return;
      const destPrefix = targetPrefix ?? effectiveUploadPrefix;

      let okCount = 0;
      let lastErr = '';
      for (let i = 0; i < arr.length; i++) {
        setProgress(
          'storage-upload',
          `正在上传至「${formatPrefixLabel(destPrefix)}」(${i + 1}/${arr.length})：${arr[i].name || '剪贴板文件'}`,
        );
        try {
          await storageApi.uploadFile(arr[i], destPrefix, cfg);
          okCount++;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : '上传失败';
        }
      }
      setProgress('storage-upload', null);
      if (okCount > 0) {
        setDimsMap((prev) => ({ ...prev, ...loadCachedDimensions() }));
        void refetch();
        showToast(
          lastErr
            ? `成功 ${okCount} 个，部分失败：${lastErr}`
            : `已上传 ${okCount} 个文件至「${formatPrefixLabel(destPrefix)}」`,
          lastErr ? 'error' : 'info',
        );
      } else if (lastErr) {
        showToast(lastErr, 'error');
      }
    },
    [cfg, effectiveUploadPrefix, refetch, setProgress, showToast],
  );

  // Global "/" shortcut opens search cleanly when not typing in an input.
  useEffect(() => {
    if (!cfg?.configured) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setSearchOpen(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      window.setTimeout(() => searchInputRef.current?.focus(), 60);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cfg?.configured]);

  const handleOpenSearch = useCallback(() => {
    setSearchOpen(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    window.setTimeout(() => searchInputRef.current?.focus(), 60);
  }, []);

  // Global Ctrl+V paste upload -> always targets current active/focused path!
  useEffect(() => {
    if (!cfg?.configured) return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        e.preventDefault();
        void handleUploadFiles(files, effectiveUploadPrefix);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [cfg?.configured, handleUploadFiles, effectiveUploadPrefix]);

  const createFolderMut = useMutation({
    mutationFn: (path: string) => storageApi.createFolder(path),
    onSuccess: (res) => {
      setActivePrefix(res.folder.prefix);
      void refetch();
      showToast(`已创建路径「${formatPrefixLabel(res.folder.prefix)}」`);
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const handlePromptCreateFolder = useCallback(() => {
    const base = effectiveUploadPrefix;
    const name = window.prompt('新建路径前缀（支持多级如 blog/2026）', base);
    if (name && name.trim()) createFolderMut.mutate(name.trim());
  }, [createFolderMut, effectiveUploadPrefix]);

  const renameMut = useMutation({
    mutationFn: (p: { type: 'file' | 'folder'; oldPath: string; newPath: string }) =>
      storageApi.rename(p.type, p.oldPath, p.newPath),
    onSuccess: (_res, vars) => {
      setSelected(new Map());
      if (vars.type === 'folder' && focusedPrefix === vars.oldPath) {
        setFocusedPrefix(vars.newPath);
      }
      if (vars.type === 'folder' && activePrefix === vars.oldPath) {
        setActivePrefix(vars.newPath);
      }
      void refetch();
      showToast('已重命名');
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const dragMoveMut = useMutation({
    mutationFn: ({ items, targetFolder }: { items: PathItem[]; targetFolder: string }) =>
      storageApi.move(items, targetFolder),
    onSuccess: (res, vars) => {
      setSelected(new Map());
      void qc.invalidateQueries({ queryKey: ['storage'] });
      showToast(`已移动 ${res.movedCount} 个对象至「${formatPrefixLabel(vars.targetFolder)}」`);
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: (items: PathItem[]) => storageApi.remove(items),
    onSuccess: (res, items) => {
      setSelected(new Map());
      if (
        focusedPrefix &&
        items.some((it) => it.type === 'folder' && it.path === focusedPrefix)
      ) {
        setFocusedPrefix(null);
      }
      void refetch();
      showToast(`已删除 ${res.deletedCount} 个对象`);
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const handlePointerDropMove = useCallback(
    (targetPrefix: string, items: PathItem[]) => {
      const movable = items.filter((it) => {
        if (it.type === 'file') return getKeyParentPrefix(it.path) !== targetPrefix;
        return it.path !== targetPrefix;
      });
      if (movable.length === 0) return;
      dragMoveMut.mutate({ items: movable, targetFolder: targetPrefix });
    },
    [dragMoveMut],
  );

  // Pointer-event drag-to-move (supports both edge auto-scroll AND native mouse-wheel scrolling!)
  const pointerMove = useStoragePointerMove(handlePointerDropMove);

  const toggleSelect = useCallback((item: PathItem) => {
    const key = `${item.type}:${item.path}`;
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, item);
      return next;
    });
  }, []);

  const handleToggleSelectGroup = useCallback((prefix: string, files: FileEntry[]) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (files.length === 0) {
        if (prefix === '') return prev;
        const folderKey = `folder:${prefix}`;
        if (next.has(folderKey)) next.delete(folderKey);
        else next.set(folderKey, { type: 'folder', path: prefix });
        return next;
      }
      const allSelected = files.every((f) => next.has(`file:${f.key}`));
      if (allSelected) {
        for (const f of files) next.delete(`file:${f.key}`);
      } else {
        for (const f of files) {
          next.set(`file:${f.key}`, { type: 'file', path: f.key });
        }
      }
      return next;
    });
  }, []);

  const copyLink = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        setCopiedUrl(url);
        if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = window.setTimeout(() => {
          setCopiedUrl((cur) => (cur === url ? null : cur));
          copiedTimerRef.current = null;
        }, 1600);
        showToast('已复制直链');
      } catch {
        showToast('复制失败，请手动复制', 'error');
      }
    },
    [showToast],
  );

  const handleRenameFile = useCallback(
    (file: FileEntry) => {
      const nextName = window.prompt('重命名文件', file.name);
      if (!nextName || nextName.trim() === '' || nextName.trim() === file.name) return;
      const cleanName = nextName.trim();
      const dirPrefix = file.prefix ?? getKeyParentPrefix(file.key);
      renameMut.mutate({ type: 'file', oldPath: file.key, newPath: `${dirPrefix}${cleanName}` });
    },
    [renameMut],
  );

  const handleRenamePrefix = useCallback(
    (prefix: string) => {
      const trimmed = prefix.replace(/\/+$/, '');
      const nextPath = window.prompt('重命名路径前缀（支持多级如 blog/2026）', trimmed);
      if (!nextPath || nextPath.trim() === '' || nextPath.trim().replace(/^\/+|\/+$/g, '') === trimmed) {
        return;
      }
      const normalized = `${nextPath.trim().replace(/^\/+|\/+$/g, '')}/`;
      renameMut.mutate({ type: 'folder', oldPath: prefix, newPath: normalized });
    },
    [renameMut],
  );

  const handleUploadToPrefix = useCallback((targetPrefix: string) => {
    pickerTargetPrefixRef.current = targetPrefix;
    fileInputRef.current?.click();
  }, []);

  const handleDropFilesToPrefix = useCallback(
    (targetPrefix: string, files: FileList) => {
      void handleUploadFiles(files, targetPrefix);
    },
    [handleUploadFiles],
  );

  const handleActivatePrefix = useCallback((prefix: string) => {
    setActivePrefix(prefix);
    manualFocusScrollYRef.current = window.scrollY;
  }, []);

  const handleToggleFocus = useCallback((prefix: string) => {
    manualFocusScrollYRef.current = null;
    setFocusedPrefix((prev) => {
      const next = prev === prefix ? null : prefix;
      if (next !== null) setActivePrefix(next);
      return next;
    });
  }, []);

  const handleJumpToPrefix = useCallback(
    (prefix: string, hasSection: boolean) => {
      manualFocusScrollYRef.current = null;
      setActivePrefix(prefix);
      scrollSpyLockUntilRef.current = performance.now() + 550;
      setMobileNavOpen(false);

      if (!hasSection) {
        setFocusedPrefix(prefix);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      const isCurrentlyVisible =
        focusedPrefix === null ||
        (focusedPrefix === ''
          ? prefix === ''
          : prefix === focusedPrefix || prefix.startsWith(focusedPrefix));

      if (!isCurrentlyVisible) {
        pendingScrollPrefixRef.current = prefix;
        setFocusedPrefix(null);
        return;
      }

      const el = sectionRefsRef.current.get(prefix);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    [focusedPrefix],
  );

  const handleSelectBreadcrumb = useCallback(
    (prefix: string) => {
      if (prefix === '') {
        setFocusedPrefix(null);
        setActivePrefix('');
        scrollSpyLockUntilRef.current = performance.now() + 550;
        const rootEl = sectionRefsRef.current.get('');
        if (rootEl) rootEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const hasExact = allGroups.some((g) => g.prefix === prefix);
      if (hasExact) {
        handleJumpToPrefix(prefix, true);
      } else {
        setFocusedPrefix(prefix);
        setActivePrefix(prefix);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },
    [allGroups, handleJumpToPrefix],
  );

  const isInitialLoad = cfgLoading || (Boolean(cfg?.configured) && galleryLoading && !gallery);

  if (isInitialLoad) {
    return <LoadingState label="正在加载模块..." variant="module" />;
  }

  if (!cfg?.configured) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="yd-page-title">图床管理</h1>
        </div>
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
      </div>
    );
  }

  const activeLightbox = lightboxIdx !== null ? allVisibleImages[lightboxIdx] : null;
  const activeLightboxDims = activeLightbox
    ? getFileDimensions(activeLightbox, dimsMap)
    : undefined;

  return (
    <div
      className="space-y-4 relative min-h-[70vh]"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
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
          void handleUploadFiles(e.dataTransfer.files, effectiveUploadPrefix);
        }
      }}
    >
      {/* Page-level drag overlay (external OS file uploads outside a specific section) */}
      {dragging && (
        <div
          onDragLeave={() => setDragging(false)}
          className="fixed inset-0 z-40 bg-sky-50/50 backdrop-blur-[3px] flex items-center justify-center p-6 pointer-events-none"
        >
          <div className="rounded-2xl border border-dashed border-sky-300 bg-white px-10 py-8 text-center shadow-lg">
            <Upload className="h-7 w-7 mx-auto text-sky-500" />
            <div className="mt-2.5 text-sm font-medium text-zinc-800">
              松开上传至「{formatPrefixLabel(effectiveUploadPrefix)}」
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              也可直接拖放到任意路径分组上指定上传位置
            </div>
          </div>
        </div>
      )}

      {/* Hidden shared file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) {
            void handleUploadFiles(e.target.files, pickerTargetPrefixRef.current);
          }
          e.target.value = '';
        }}
      />

      {/* Compact Header Row (non-sticky — each prefix section pins its own breadcrumb at top as you scroll!) */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-zinc-200/70">
        <div className="flex items-center gap-2.5 min-w-0">
          <h1 className="yd-page-title shrink-0">图床管理</h1>
          <Tooltip content="修改上传模式或存储桶配置">
            <Link
              to="/settings?tab=storage"
              className="yd-badge yd-badge-neutral hover:bg-sky-50 hover:text-sky-700 transition-colors shrink-0"
            >
              {cfg.upload_mode === 'direct' ? '直传' : `中转 ≤${cfg.proxy_max_mb}MB`}
            </Link>
          </Tooltip>
          {gallery && (
            <span className="hidden md:inline text-xs text-zinc-400 tabular-nums shrink-0">
              {gallery.total_files} 项 · {allGroups.length} 路径
              {gallery.truncated ? '（已达单次展示上限）' : ''}
            </span>
          )}
          {focusedPrefix !== null && (
            <Tooltip content="点击退出聚焦，查看全桶">
              <button
                type="button"
                onClick={() => setFocusedPrefix(null)}
                className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-inset ring-sky-200/80 hover:bg-sky-100 transition-colors max-w-[180px]"
              >
                <span className="truncate font-mono">{formatPrefixLabel(focusedPrefix)}</span>
                <X className="h-3 w-3 shrink-0" />
              </button>
            </Tooltip>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {searchOpen || search ? (
            <div className="relative w-44 sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                ref={searchInputRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onBlur={() => {
                  if (!search.trim()) setSearchOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearch('');
                    setSearchOpen(false);
                  }
                }}
                placeholder="搜索文件名或路径..."
                className="yd-input-sm w-full pl-8 pr-7 bg-white"
              />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setSearch('');
                  setSearchOpen(false);
                }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-600"
                aria-label="关闭搜索"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <Tooltip content="搜索文件名或路径 (/)">
              <button
                type="button"
                onClick={handleOpenSearch}
                aria-label="搜索"
                className="yd-btn-secondary px-2 py-1.5"
              >
                <Search className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}

          <button
            type="button"
            onClick={handlePromptCreateFolder}
            className="yd-btn-secondary py-1.5 text-xs"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">新建路径</span>
          </button>

          <Tooltip content={`上传至当前焦点路径「${formatPrefixLabel(effectiveUploadPrefix)}」（支持 Ctrl+V）`}>
            <button
              type="button"
              onClick={() => handleUploadToPrefix(effectiveUploadPrefix)}
              className="yd-btn-primary py-1.5 text-xs"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>上传</span>
            </button>
          </Tooltip>

          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="lg:hidden yd-btn-secondary py-1.5 text-xs"
          >
            <Layers className="h-3.5 w-3.5 text-sky-500" />
            路径
          </button>
        </div>
      </div>

      {/* Main Two-Column Album Layout: Left Justified Sections + Right Minimal Sticky Path Rail */}
      <div className="flex items-start gap-7 pt-1">
        <div ref={galleryHostRef} className="min-w-0 flex-1 space-y-7">
          {galleryLoading ? (
            <LoadingState label="正在加载全桶相册..." variant="section" />
          ) : visibleGroups.length === 0 ? (
            <div className="yd-empty py-16 space-y-2">
              <p className="text-sm font-medium text-zinc-700">
                {search || focusedPrefix !== null ? '没有匹配当前筛选的文件或路径' : '存储桶为空'}
              </p>
              <p className="text-xs text-zinc-400">
                {search || focusedPrefix !== null
                  ? '试试清空搜索关键词或退出路径聚焦'
                  : '支持拖拽、Ctrl+V 粘贴截图或点击上方上传'}
              </p>
              {(search || focusedPrefix !== null) && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('');
                    setFocusedPrefix(null);
                  }}
                  className="yd-btn-secondary mt-2"
                >
                  显示全部路径
                </button>
              )}
            </div>
          ) : (
            <>
              {visibleGroups.map((group) => (
                <PrefixSection
                  key={group.prefix || '__root__'}
                  group={group}
                  containerWidth={galleryWidth}
                  dimsMap={dimsMap}
                  loadedUrls={loadedUrls}
                  selected={selected}
                  copiedUrl={copiedUrl}
                  isActive={effectiveUploadPrefix === group.prefix}
                  isPointerDropTarget={
                    pointerMove.dropTarget?.zone === 'section' &&
                    pointerMove.dropTarget.prefix === group.prefix
                  }
                  draggingKeys={pointerMove.draggingKeys}
                  sectionRef={getSectionRefCallback(group.prefix)}
                  onActivatePrefix={handleActivatePrefix}
                  onSelectBreadcrumb={handleSelectBreadcrumb}
                  onSectionDragEnter={() => setDragging(false)}
                  onUploadToPrefix={handleUploadToPrefix}
                  onDropFilesToPrefix={handleDropFilesToPrefix}
                  onToggleSelectGroup={handleToggleSelectGroup}
                  onRenamePrefix={handleRenamePrefix}
                  onToggleSelectFile={toggleSelect}
                  onTilePointerDown={pointerMove.handleTilePointerDown}
                  onOpenLightbox={(file) => setLightboxKey(file.key)}
                  onCopyLink={(url) => void copyLink(url)}
                  onRenameFile={handleRenameFile}
                  onOpenMobileActions={setMobileActionFile}
                  onImageLoaded={handleImageLoaded}
                />
              ))}

              {/* Exact dynamic overscroll spacer (zero extra margin from space-y-7) so the last section
                  stops flush at stickyTop with 0px of its images slipping under the breadcrumb pill. */}
              <div
                ref={bottomSpacerRef}
                className="!mt-0"
                style={{ height: `${bottomSpacerHeight}px` }}
                aria-hidden="true"
              />
            </>
          )}
        </div>

        {/* Desktop Right-Side Minimal Album Path Rail (Frameless, sticky right at top) */}
        <aside className="hidden lg:block w-52 xl:w-56 shrink-0 sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto py-0.5">
          <PathNavigatorContent
            nodes={pathTreeNodes}
            totalFiles={gallery?.total_files ?? 0}
            activePrefix={effectiveUploadPrefix}
            focusedPrefix={focusedPrefix}
            pointerDropPrefix={
              pointerMove.dropTarget?.zone === 'nav' ? pointerMove.dropTarget.prefix : null
            }
            onJumpToPrefix={handleJumpToPrefix}
            onToggleFocus={handleToggleFocus}
            onClearFocus={() => setFocusedPrefix(null)}
            onOpenSearch={handleOpenSearch}
            onCreateFolder={handlePromptCreateFolder}
          />
        </aside>
      </div>

      {/* Floating Drag Ghost Portal (Pointer-Event Drag-to-Move) */}
      {pointerMove.overlayPortal}

      {/* Mobile Path Navigator Sheet */}
      {mobileNavOpen && (
        <div
          onClick={() => setMobileNavOpen(false)}
          className="lg:hidden fixed inset-0 z-50 flex items-end bg-slate-900/25 backdrop-blur-[2px] yd-fade-in"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-h-[75dvh] overflow-y-auto rounded-t-2xl border-t border-zinc-200/90 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl space-y-3"
          >
            <div className="flex items-center justify-between pb-2 border-b border-zinc-100">
              <span className="text-sm font-semibold text-zinc-900">路径导航</span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="yd-btn-icon"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <PathNavigatorContent
              nodes={pathTreeNodes}
              totalFiles={gallery?.total_files ?? 0}
              activePrefix={effectiveUploadPrefix}
              focusedPrefix={focusedPrefix}
              onJumpToPrefix={handleJumpToPrefix}
              onToggleFocus={(p) => {
                handleToggleFocus(p);
                setMobileNavOpen(false);
              }}
              onClearFocus={() => {
                setFocusedPrefix(null);
                setMobileNavOpen(false);
              }}
            />
          </div>
        </div>
      )}

      {/* Floating Batch Selection Bar (Central place for Move & Delete) */}
      {selected.size > 0 && (
        <div className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] sm:bottom-6 inset-x-3 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 z-30 flex flex-wrap sm:flex-nowrap items-center justify-between sm:justify-start gap-2 rounded-2xl sm:rounded-full border border-zinc-200/90 bg-white/95 backdrop-blur-md px-3.5 sm:px-4 py-2 text-xs text-zinc-700 shadow-[0_8px_28px_rgba(15,23,42,0.1)]">
          <span className="px-1.5 font-medium text-zinc-800 tabular-nums">
            已选 {selected.size} 项
          </span>
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

      {/* Mobile File Action Sheet (Copy Link, Multi-select, Rename) */}
      {mobileActionFile && (
        <div
          onClick={() => setMobileActionFile(null)}
          className="sm:hidden fixed inset-0 z-50 flex items-end bg-slate-900/25 backdrop-blur-[2px] yd-fade-in"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full rounded-t-2xl border-t border-zinc-200/90 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl space-y-3"
          >
            <div className="flex items-start justify-between gap-3 pb-2 border-b border-zinc-100">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-zinc-900 break-all">
                  {mobileActionFile.name}
                </div>
                <div className="mt-0.5 text-xs text-zinc-400 inline-flex flex-wrap items-center gap-1.5 tabular-nums">
                  <span>{formatPrefixLabel(mobileActionFile.prefix ?? '')}</span>
                  <span>· {formatBytes(mobileActionFile.size)}</span>
                  {mobileActionFile.metadata_stripped && (
                    <span className="inline-flex items-center gap-0.5 text-emerald-600">
                      <ShieldCheck className="h-3 w-3" />
                      已清除 EXIF
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMobileActionFile(null)}
                className="yd-btn-icon shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-1">
              <button
                type="button"
                onClick={() => {
                  const target = mobileActionFile;
                  setMobileActionFile(null);
                  void copyLink(target.url);
                }}
                className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-zinc-700 active:bg-zinc-100"
              >
                <Link2 className="h-4 w-4 text-zinc-400" />
                复制直链
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = mobileActionFile;
                  setMobileActionFile(null);
                  toggleSelect({ type: 'file', path: target.key });
                }}
                className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-zinc-700 active:bg-zinc-100"
              >
                <Check className="h-4 w-4 text-sky-500" />
                {selected.has(`file:${mobileActionFile.key}`) ? '取消选择' : '加入多选'}
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = mobileActionFile;
                  setMobileActionFile(null);
                  handleRenameFile(target);
                }}
                className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-zinc-700 active:bg-zinc-100"
              >
                <Pencil className="h-4 w-4 text-zinc-400" />
                重命名
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen Album Lightbox (Zoom, Wheel-Zoom, Pan, Rotate, Checkerboard, Scroll Lock) */}
      {activeLightbox && lightboxIdx !== null && (
        <StorageLightbox
          image={activeLightbox}
          dims={activeLightboxDims}
          index={lightboxIdx}
          total={allVisibleImages.length}
          copiedUrl={copiedUrl}
          onClose={() => setLightboxKey(null)}
          onPrev={() => {
            if (lightboxIdx > 0) setLightboxKey(allVisibleImages[lightboxIdx - 1].key);
          }}
          onNext={() => {
            if (lightboxIdx < allVisibleImages.length - 1) {
              setLightboxKey(allVisibleImages[lightboxIdx + 1].key);
            }
          }}
          onCopyLink={(url) => void copyLink(url)}
        />
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
      className="fixed inset-0 z-50 bg-slate-900/15 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-0 sm:p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-zinc-200/90 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-5 space-y-4 shadow-xl"
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
            <LoadingState label="正在加载模块..." variant="compact" />
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
