import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clock,
  Columns2,
  Copy,
  Download,
  Eye,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Star,
  Trash2,
} from 'lucide-react';
import { ApiError } from '@/core/api';
import { LoadingState } from '@/components/LoadingState';
import { Tooltip } from '@/components/Tooltip';
import { useToast } from '@/components/Toast';
import {
  DEFAULT_MAX_BYTES,
  SSE_INLINE_MAX_BYTES,
  clipboardApi,
  copyTextToClipboard,
  formatBytes,
  formatExpiryBadge,
  utf8ByteLength,
  type ClipboardEvent as ClipboardSSEEvent,
  type ClipboardItem,
} from './api';
import { CodeMirrorEditor } from './components/CodeMirrorEditor';
import { ExpiryModal } from './components/ExpiryModal';
import { MarkdownPreview } from './components/MarkdownPreview';
import { useClipboardEvents } from './realtime';

type EditorViewMode = 'edit' | 'split' | 'preview';
type SyncStatus = 'idle' | 'draft' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'oversize' | 'error';

export default function ClipboardEditorPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { showToast } = useToast();

  const isNewRoute = rawId === 'new';
  const parsedId = isNewRoute ? null : Number(rawId);
  const validNumericId = parsedId !== null && Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;

  const { data: meta } = useQuery({
    queryKey: ['clipboard', 'meta'],
    queryFn: clipboardApi.getMeta,
    staleTime: 300_000,
  });

  const maxBytes = meta?.max_bytes ?? DEFAULT_MAX_BYTES;
  const sseInlineMaxBytes = meta?.sse_inline_max_bytes ?? SSE_INLINE_MAX_BYTES;

  const [itemId, setItemId] = useState<number | null>(validNumericId);
  const [content, setContent] = useState('');
  const [externalSyncKey, setExternalSyncKey] = useState(0);
  const [starred, setStarred] = useState(false);
  const [expiresAt, setExpiresAt] = useState<string>(() =>
    new Date(Date.now() + 24 * 3_600_000).toISOString(),
  );
  const [viewMode, setViewMode] = useState<EditorViewMode>('edit');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(isNewRoute ? 'draft' : 'idle');
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expiryOpen, setExpiryOpen] = useState(false);
  const [metaSaving, setMetaSaving] = useState(false);
  const [initialLoading, setInitialLoading] = useState(!isNewRoute);
  const [notFoundErr, setNotFoundErr] = useState<string | null>(null);

  // Refs for race-free serialized autosave and SSE reconciliation.
  const itemIdRef = useRef<number | null>(validNumericId);
  const latestContentRef = useRef('');
  const savedContentRef = useRef('');
  const versionRef = useRef<number>(0);
  const starredRef = useRef(false);
  const expiresAtRef = useRef(expiresAt);
  const savingRef = useRef(false);
  const pendingResaveRef = useRef(false);
  const dirtyRef = useRef(false);
  const conflictRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  itemIdRef.current = itemId;
  starredRef.current = starred;
  expiresAtRef.current = expiresAt;

  // Close more menu on outside click.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Lock page scroll while web-fullscreen overlay is active; Esc exits when no modal/search panel is open.
  useEffect(() => {
    if (!isFullscreen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (expiryOpen) return;
      if (document.querySelector('.cm-search')) return;
      setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isFullscreen, expiryOpen]);

  // Load existing item on route mount / change.
  useEffect(() => {
    if (isNewRoute) {
      setItemId(null);
      itemIdRef.current = null;
      setContent('');
      latestContentRef.current = '';
      savedContentRef.current = '';
      versionRef.current = 0;
      setStarred(false);
      const defExp = new Date(Date.now() + 24 * 3_600_000).toISOString();
      setExpiresAt(defExp);
      expiresAtRef.current = defExp;
      dirtyRef.current = false;
      conflictRef.current = false;
      setSyncStatus('draft');
      setInitialLoading(false);
      setNotFoundErr(null);
      setExternalSyncKey((k) => k + 1);
      return;
    }

    // If we just auto-created this item in-place from /clipboard/new, keep live state without refetch flicker.
    if (validNumericId !== null && itemIdRef.current === validNumericId && versionRef.current > 0) {
      setInitialLoading(false);
      return;
    }

    if (validNumericId === null) {
      setNotFoundErr('无效的剪切板条目 ID');
      setInitialLoading(false);
      return;
    }

    let cancelled = false;
    setInitialLoading(true);
    setNotFoundErr(null);

    clipboardApi
      .getItem(validNumericId)
      .then((res) => {
        if (cancelled) return;
        const it = res.item;
        setItemId(it.id);
        itemIdRef.current = it.id;
        setContent(it.content);
        latestContentRef.current = it.content;
        savedContentRef.current = it.content;
        versionRef.current = it.version;
        setStarred(it.starred);
        setExpiresAt(it.expires_at);
        expiresAtRef.current = it.expires_at;
        dirtyRef.current = false;
        conflictRef.current = false;
        setSyncStatus('saved');
        setExternalSyncKey((k) => k + 1);
        setInitialLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setNotFoundErr(err instanceof Error ? err.message : '加载剪切板条目失败');
        setInitialLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isNewRoute, validNumericId]);

  // Clear pending autosave timer on unmount.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // Warn before closing tab if unsaved changes exist.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current || savingRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const applyServerSnapshot = useCallback((it: ClipboardItem) => {
    setItemId(it.id);
    itemIdRef.current = it.id;
    setContent(it.content);
    latestContentRef.current = it.content;
    savedContentRef.current = it.content;
    versionRef.current = it.version;
    setStarred(it.starred);
    setExpiresAt(it.expires_at);
    expiresAtRef.current = it.expires_at;
    dirtyRef.current = false;
    conflictRef.current = false;
    setSyncStatus('saved');
    setExternalSyncKey((k) => k + 1);
  }, []);

  const flushSave = useCallback(
    async (force = false) => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      const text = latestContentRef.current;
      const bytes = utf8ByteLength(text);
      if (bytes > maxBytes) {
        setSyncStatus('oversize');
        return;
      }

      const curId = itemIdRef.current;
      if (curId === null && text.length === 0) {
        dirtyRef.current = false;
        setSyncStatus('draft');
        return;
      }
      if (!force && curId !== null && text === savedContentRef.current) {
        dirtyRef.current = false;
        if (!conflictRef.current) setSyncStatus('saved');
        return;
      }
      if (!force && conflictRef.current) {
        return;
      }

      if (savingRef.current) {
        pendingResaveRef.current = true;
        return;
      }

      savingRef.current = true;
      setSyncStatus('saving');

      try {
        if (curId === null) {
          const res = await clipboardApi.createItem({
            content: text,
            starred: starredRef.current,
            expires_at: expiresAtRef.current,
          });
          const created = res.item;
          setItemId(created.id);
          itemIdRef.current = created.id;
          versionRef.current = created.version;
          savedContentRef.current = text;
          setExpiresAt(created.expires_at);
          expiresAtRef.current = created.expires_at;
          conflictRef.current = false;
          void qc.invalidateQueries({ queryKey: ['clipboard', 'items'] });
          navigate(`/clipboard/${created.id}`, { replace: true });
        } else {
          const res = await clipboardApi.updateItem(curId, {
            content: text,
            expected_version: force ? undefined : versionRef.current || undefined,
            force,
          });
          versionRef.current = res.item.version;
          savedContentRef.current = text;
          setStarred(res.item.starred);
          setExpiresAt(res.item.expires_at);
          expiresAtRef.current = res.item.expires_at;
          conflictRef.current = false;
          void qc.invalidateQueries({ queryKey: ['clipboard', 'items'] });
        }

        if (latestContentRef.current === savedContentRef.current) {
          dirtyRef.current = false;
          setSyncStatus('saved');
        } else {
          dirtyRef.current = true;
          pendingResaveRef.current = true;
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && err.code === 'version_conflict') {
          conflictRef.current = true;
          setSyncStatus('conflict');
        } else {
          setSyncStatus('error');
          showToast(err instanceof Error ? err.message : '保存失败', 'error');
        }
      } finally {
        savingRef.current = false;
        if (pendingResaveRef.current && !conflictRef.current) {
          pendingResaveRef.current = false;
          void flushSave(false);
        }
      }
    },
    [maxBytes, navigate, qc, showToast],
  );

  const handleEditorChange = useCallback(
    (nextText: string) => {
      setContent(nextText);
      latestContentRef.current = nextText;

      const bytes = utf8ByteLength(nextText);
      if (bytes > maxBytes) {
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        dirtyRef.current = true;
        setSyncStatus('oversize');
        return;
      }

      if (itemIdRef.current === null && nextText.length === 0) {
        dirtyRef.current = false;
        setSyncStatus('draft');
        return;
      }

      dirtyRef.current = true;
      if (!conflictRef.current) {
        setSyncStatus('dirty');
      }

      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      const debounceMs = bytes > sseInlineMaxBytes ? 800 : 350;
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void flushSave(false);
      }, debounceMs);
    },
    [flushSave, maxBytes, sseInlineMaxBytes],
  );

  // Live SSE sync for this item.
  const handleSSE = useCallback(
    async (ev: ClipboardSSEEvent) => {
      const curId = itemIdRef.current;
      if (curId === null || ev.item_id !== curId) return;

      if (ev.type === 'deleted') {
        showToast('该条目已在其他设备删除');
        void qc.invalidateQueries({ queryKey: ['clipboard', 'items'] });
        navigate('/clipboard', { replace: true });
        return;
      }

      if (ev.type === 'updated') {
        if (ev.meta_only && ev.item) {
          setStarred(ev.item.starred);
          setExpiresAt(ev.item.expires_at);
          expiresAtRef.current = ev.item.expires_at;
          return;
        }

        if (ev.version && ev.version <= versionRef.current) {
          return;
        }

        if (dirtyRef.current || savingRef.current) {
          conflictRef.current = true;
          setSyncStatus('conflict');
          return;
        }

        try {
          let incoming = ev.item;
          if (!incoming || ev.fetch_required || incoming.content_omitted) {
            const fetched = await clipboardApi.getItem(curId);
            incoming = fetched.item;
          }
          if (dirtyRef.current || savingRef.current) {
            conflictRef.current = true;
            setSyncStatus('conflict');
            return;
          }
          if (incoming.version > versionRef.current) {
            applyServerSnapshot(incoming);
          }
        } catch {
          // Ignore transient fetch errors; next event or manual reload will catch up.
        }
      }
    },
    [applyServerSnapshot, navigate, qc, showToast],
  );

  const { connected } = useClipboardEvents(
    (ev) => {
      void handleSSE(ev);
    },
    itemId !== null,
  );

  const handleReloadLatest = async () => {
    const curId = itemIdRef.current;
    if (curId === null) return;
    try {
      const res = await clipboardApi.getItem(curId);
      applyServerSnapshot(res.item);
      showToast('已同步最新版本');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加载最新版本失败', 'error');
    }
  };

  const handleToggleStar = async () => {
    const prevStar = starred;
    const nextStar = !prevStar;
    // Optimistically update immediately.
    setStarred(nextStar);
    starredRef.current = nextStar;
    if (itemIdRef.current === null) return;
    try {
      await clipboardApi.patchItem(itemIdRef.current, { starred: nextStar });
      void qc.invalidateQueries({ queryKey: ['clipboard', 'items'] });
    } catch (err) {
      setStarred(prevStar);
      starredRef.current = prevStar;
      showToast(err instanceof Error ? err.message : '更新星标失败', 'error');
    }
  };

  const handleUpdateExpiry = async (iso: string) => {
    const prevExpiry = expiresAt;
    setExpiresAt(iso);
    expiresAtRef.current = iso;
    setExpiryOpen(false);
    if (itemIdRef.current === null) {
      showToast('已设置到期时间（保存文本后生效）');
      return;
    }
    setMetaSaving(true);
    try {
      const res = await clipboardApi.patchItem(itemIdRef.current, { expires_at: iso });
      setExpiresAt(res.item.expires_at);
      expiresAtRef.current = res.item.expires_at;
      void qc.invalidateQueries({ queryKey: ['clipboard', 'items'] });
      showToast('已更新到期时间');
    } catch (err) {
      setExpiresAt(prevExpiry);
      expiresAtRef.current = prevExpiry;
      showToast(err instanceof Error ? err.message : '更新到期时间失败', 'error');
    } finally {
      setMetaSaving(false);
    }
  };

  const handleDelete = async () => {
    const curId = itemIdRef.current;
    if (curId === null) {
      navigate('/clipboard');
      return;
    }
    try {
      await clipboardApi.deleteItem(curId);
      void qc.invalidateQueries({ queryKey: ['clipboard', 'items'] });
      showToast('已删除');
      navigate('/clipboard', { replace: true });
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败', 'error');
    }
  };

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(latestContentRef.current);
      setCopied(true);
      showToast('已复制到剪贴板');
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '复制失败', 'error');
    }
  };

  const handleDownload = () => {
    const blob = new Blob([latestContentRef.current], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clipboard-${itemId ?? 'draft'}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const stats = useMemo(() => {
    const bytes = utf8ByteLength(content);
    const chars = Array.from(content).length;
    const lines = content === '' ? 0 : content.split('\n').length;
    return { bytes, chars, lines, overLimit: bytes > maxBytes };
  }, [content, maxBytes]);

  const expiryBadge = formatExpiryBadge(expiresAt);
  const expiryBadgeClass =
    expiryBadge.tone === 'red'
      ? 'yd-badge-red'
      : expiryBadge.tone === 'amber'
        ? 'yd-badge-amber'
        : 'yd-badge-neutral';

  const statusMeta = useMemo(() => {
    switch (syncStatus) {
      case 'saving':
        return { text: '同步中...', dot: 'bg-sky-500 animate-pulse', textCls: 'text-sky-600' };
      case 'saved':
        return { text: '已同步', dot: 'bg-emerald-500', textCls: 'text-zinc-500' };
      case 'dirty':
        return { text: '未保存', dot: 'bg-amber-400', textCls: 'text-amber-600' };
      case 'conflict':
        return { text: '版本冲突', dot: 'bg-red-500', textCls: 'text-red-600' };
      case 'oversize':
        return { text: '超出上限', dot: 'bg-red-500', textCls: 'text-red-600' };
      case 'error':
        return { text: '保存失败', dot: 'bg-red-500', textCls: 'text-red-600' };
      case 'draft':
        return { text: '输入即自动保存', dot: 'bg-zinc-300', textCls: 'text-zinc-400' };
      default:
        return { text: '就绪', dot: 'bg-zinc-300', textCls: 'text-zinc-400' };
    }
  }, [syncStatus]);

  if (initialLoading) {
    return <LoadingState label="正在加载编辑器..." variant="section" />;
  }

  if (notFoundErr) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => navigate('/clipboard')}
          className="yd-btn-ghost"
        >
          <ArrowLeft className="h-4 w-4" />
          返回剪切板
        </button>
        <div className="yd-empty p-10 space-y-2">
          <p className="text-sm text-zinc-600">{notFoundErr}</p>
          <button
            type="button"
            onClick={() => navigate('/clipboard')}
            className="yd-btn-primary mt-2"
          >
            回到列表
          </button>
        </div>
      </div>
    );
  }

  const iconModeBtnClass = (active: boolean) =>
    `inline-flex items-center justify-center rounded-lg p-1.5 transition-colors ${
      active
        ? 'bg-sky-50 text-sky-600'
        : 'text-zinc-400 hover:bg-zinc-100/80 hover:text-zinc-700'
    }`;

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-40 flex flex-col bg-white'
          : 'yd-card flex flex-col overflow-hidden h-[calc(100dvh-6rem)] lg:h-[calc(100dvh-3.5rem)] min-h-[480px]'
      }
    >
      {/* Unified Integrated Header Bar */}
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200/75 bg-[#fbfcfe] px-2.5 sm:px-3.5 h-12 shrink-0">
        {/* Left: Back + Quiet Status + Expiry */}
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          <Tooltip content="返回列表">
            <button
              type="button"
              onClick={() => {
                setIsFullscreen(false);
                if (dirtyRef.current && !stats.overLimit && !conflictRef.current) {
                  void flushSave(false).finally(() => navigate('/clipboard'));
                } else {
                  navigate('/clipboard');
                }
              }}
              className="yd-btn-icon text-zinc-600"
              aria-label="返回列表"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          </Tooltip>

          <div className="h-4 w-px bg-zinc-200/80 shrink-0" />

          <span className={`inline-flex items-center gap-1.5 text-xs whitespace-nowrap ${statusMeta.textCls}`}>
            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusMeta.dot}`} />
            <span className="hidden xs:inline sm:inline">{statusMeta.text}</span>
          </span>

          <Tooltip content="点击修改或延长到期时间">
            <button
              type="button"
              onClick={() => setExpiryOpen(true)}
              className={`yd-badge ${expiryBadgeClass} cursor-pointer transition-opacity hover:opacity-80 shrink-0`}
            >
              <Clock className="h-3 w-3" />
              <span className="truncate max-w-[110px] sm:max-w-none">{expiryBadge.text}</span>
            </button>
          </Tooltip>
        </div>

        {/* Right: Unified Icon-Only Action Strip (View Mode + Actions + Web Fullscreen + More) */}
        <div className="flex items-center gap-0.5 shrink-0">
          <Tooltip content="编辑模式">
            <button
              type="button"
              onClick={() => setViewMode('edit')}
              className={iconModeBtnClass(viewMode === 'edit')}
              aria-label="编辑模式"
            >
              <Pencil className="h-4 w-4" />
            </button>
          </Tooltip>

          <Tooltip content="分栏预览">
            <button
              type="button"
              onClick={() => setViewMode('split')}
              className={`hidden md:inline-flex ${iconModeBtnClass(viewMode === 'split')}`}
              aria-label="分栏预览"
            >
              <Columns2 className="h-4 w-4" />
            </button>
          </Tooltip>

          <Tooltip content="Markdown 预览">
            <button
              type="button"
              onClick={() => setViewMode('preview')}
              className={iconModeBtnClass(viewMode === 'preview')}
              aria-label="Markdown 预览"
            >
              <Eye className="h-4 w-4" />
            </button>
          </Tooltip>

          <div className="h-4 w-px bg-zinc-200/80 mx-1 shrink-0" />

          <Tooltip content={starred ? '取消星标' : '星标置顶'}>
            <button
              type="button"
              onClick={() => void handleToggleStar()}
              className={`yd-btn-icon ${
                starred ? 'text-amber-500 hover:bg-amber-50 hover:text-amber-600' : ''
              }`}
              aria-label={starred ? '取消星标' : '星标置顶'}
            >
              <Star className={`h-4 w-4 ${starred ? 'fill-amber-400' : ''}`} />
            </button>
          </Tooltip>

          <Tooltip content={copied ? '已复制' : '复制全文'}>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className={`yd-btn-icon ${
                copied ? 'text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700' : ''
              }`}
              aria-label="复制全文"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
          </Tooltip>

          <Tooltip content={isFullscreen ? '退出网页全屏 (Esc)' : '网页全屏'}>
            <button
              type="button"
              onClick={() => setIsFullscreen((v) => !v)}
              className={iconModeBtnClass(isFullscreen)}
              aria-label={isFullscreen ? '退出网页全屏' : '网页全屏'}
            >
              {isFullscreen ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </button>
          </Tooltip>

          <div className="relative" ref={menuRef}>
            <Tooltip content="更多操作" disabled={menuOpen}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                className="yd-btn-icon"
                aria-label="更多操作"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </Tooltip>

            {menuOpen && (
              <div className="absolute right-0 mt-1.5 w-40 rounded-xl border border-zinc-200/90 bg-white py-1 shadow-lg z-30">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setExpiryOpen(true);
                  }}
                  className="w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50 flex items-center gap-2"
                >
                  <Clock className="h-3.5 w-3.5 text-sky-500 shrink-0" />
                  更改到期时间
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    handleDownload();
                  }}
                  className="w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50 flex items-center gap-2"
                >
                  <Download className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                  下载为 .txt
                </button>
                {itemId !== null && (
                  <>
                    <div className="my-1 border-t border-zinc-100" />
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        void handleDelete();
                      }}
                      className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 flex items-center gap-2"
                    >
                      <Trash2 className="h-3.5 w-3.5 shrink-0" />
                      删除条目
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Inline Conflict Banner */}
      {syncStatus === 'conflict' && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-200/80 bg-red-50/75 px-3.5 py-2 text-xs text-red-600 shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>该条目已在其他设备更新，自动保存已暂停以防覆盖。</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleReloadLatest()}
              className="yd-btn-secondary py-1 text-xs"
            >
              <RefreshCw className="h-3 w-3" />
              加载最新版本
            </button>
            <button
              type="button"
              onClick={() => {
                conflictRef.current = false;
                void flushSave(true);
              }}
              className="yd-btn-primary py-1 text-xs"
            >
              用当前内容覆盖
            </button>
          </div>
        </div>
      )}

      {/* Inline Oversize Banner */}
      {stats.overLimit && (
        <div className="flex items-center gap-2 border-b border-red-200/80 bg-red-50/75 px-3.5 py-2 text-xs text-red-600 shrink-0">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            当前文本大小 {formatBytes(stats.bytes)} 超出服务器上限 {formatBytes(maxBytes)}
            ，请删减内容后自动恢复保存。
          </span>
        </div>
      )}

      {/* Main Editor / Preview Surface */}
      <div
        className={`flex-1 min-h-0 grid bg-white ${
          viewMode === 'split'
            ? 'grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-zinc-200/80'
            : 'grid-cols-1'
        }`}
      >
        {(viewMode === 'edit' || viewMode === 'split') && (
          <div className="min-h-0 h-full overflow-hidden">
            <CodeMirrorEditor
              value={content}
              externalSyncKey={externalSyncKey}
              autoFocus={isNewRoute}
              onChange={handleEditorChange}
              onSaveShortcut={() => void flushSave(false)}
            />
          </div>
        )}

        {(viewMode === 'preview' || viewMode === 'split') && (
          <div className="min-h-0 h-full overflow-y-auto bg-white">
            <MarkdownPreview content={content} />
          </div>
        )}
      </div>

      {/* Integrated Footer Status Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200/75 bg-[#fbfcfe] px-3.5 py-1.5 text-[11px] text-zinc-400 shrink-0 tabular-nums">
        <div className="flex items-center gap-3">
          <span>{stats.lines} 行</span>
          <span>{stats.chars} 字</span>
          <span className={stats.overLimit ? 'font-semibold text-red-600' : ''}>
            {formatBytes(stats.bytes)} / {formatBytes(maxBytes)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {itemId !== null && (
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  connected ? 'bg-emerald-500' : 'bg-zinc-300 animate-pulse'
                }`}
              />
              {connected ? '实时同步中' : '重连中'}
            </span>
          )}
          <span className="hidden sm:inline">Ctrl/Cmd + S 保存 · Ctrl/Cmd + F 查找</span>
        </div>
      </div>

      {/* Expiry Modal */}
      <ExpiryModal
        open={expiryOpen}
        currentExpiresAt={expiresAt}
        saving={metaSaving}
        onClose={() => setExpiryOpen(false)}
        onConfirm={(iso) => void handleUpdateExpiry(iso)}
      />
    </div>
  );
}
