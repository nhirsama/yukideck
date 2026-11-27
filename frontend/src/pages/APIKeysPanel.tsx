import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronUp,
  Copy,
  KeyRound,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  X,
} from 'lucide-react';
import { LoadingState } from '@/components/LoadingState';
import { Select } from '@/components/Select';
import { useToast } from '@/components/Toast';
import { Tooltip } from '@/components/Tooltip';
import {
  coreApi,
  type APIKey,
  type PermissionSchemaItem,
  type PolicyRule,
  type UpsertAPIKeyPayload,
} from '@/core/api';

function formatTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function toDatetimeLocalValue(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addDaysToDatetimeLocal(days: number): string {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setSeconds(0, 0);
  return toDatetimeLocalValue(d.toISOString());
}

function resolveResourceNames(def: PermissionSchemaItem | undefined, ids: string[]): string {
  if (!def || def.resources.length === 0) return ids.join(', ');
  const nameMap = new Map(def.resources.map((r) => [r.id, r.name]));
  return ids.map((id) => nameMap.get(id) ?? id).join(', ');
}

let policyRowCounter = 0;
function nextRowUid(): string {
  policyRowCounter += 1;
  return `row-${policyRowCounter}`;
}

export function APIKeysPanel() {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [editing, setEditing] = useState<APIKey | 'new' | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [revealedKey, setRevealedKey] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openMenuId === null) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpenMenuId(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenuId(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenuId]);

  useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => {
      editorContainerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  const { data: schemaData } = useQuery({
    queryKey: ['auth', 'api-keys', 'schema'],
    queryFn: coreApi.getAPIKeySchema,
  });
  const permissions = schemaData?.permissions ?? [];
  const permMap = useMemo(() => {
    const map = new Map<string, PermissionSchemaItem>();
    for (const p of permissions) map.set(p.key, p);
    return map;
  }, [permissions]);

  const { data: keysData, isLoading } = useQuery({
    queryKey: ['auth', 'api-keys'],
    queryFn: coreApi.listAPIKeys,
  });
  const apiKeys = keysData?.api_keys ?? [];

  const filteredKeys = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return apiKeys;
    return apiKeys.filter((item) => {
      if (item.name.toLowerCase().includes(q)) return true;
      if (item.key_prefix.toLowerCase().includes(q)) return true;
      return item.policies.some((rule) => {
        if (rule.permission.toLowerCase().includes(q)) return true;
        const def = permMap.get(rule.permission);
        if (!def) return false;
        if (
          def.module_name.toLowerCase().includes(q) ||
          def.label.toLowerCase().includes(q)
        ) {
          return true;
        }
        if (def.resource_type && !rule.resources.includes('*')) {
          return resolveResourceNames(def, rule.resources).toLowerCase().includes(q);
        }
        return false;
      });
    });
  }, [apiKeys, searchQuery, permMap]);

  const toggleEnabledMut = useMutation({
    mutationFn: (item: APIKey) =>
      coreApi.updateAPIKey(item.id, {
        name: item.name,
        policies: item.policies,
        enabled: !item.enabled,
        expires_at: item.expires_at,
      }),
    onSuccess: (res) => {
      setEditing((cur) => (cur && cur !== 'new' && cur.id === res.api_key.id ? null : cur));
      void qc.invalidateQueries({ queryKey: ['auth', 'api-keys'] });
      showToast(res.api_key.enabled ? 'API Key 已启用' : 'API Key 已停用');
    },
    onError: (err: Error) => showToast(`操作失败：${err.message}`, 'error'),
  });

  const rotateMut = useMutation({
    mutationFn: (id: number) => coreApi.rotateAPIKey(id),
    onSuccess: (res) => {
      setRevealedKey({ name: res.api_key.name, key: res.plain_key });
      setCopied(false);
      void qc.invalidateQueries({ queryKey: ['auth', 'api-keys'] });
      showToast('密钥已轮换');
    },
    onError: (err: Error) => showToast(`轮换失败：${err.message}`, 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => coreApi.deleteAPIKey(id),
    onSuccess: (_, id) => {
      setEditing((cur) => (cur && cur !== 'new' && cur.id === id ? null : cur));
      void qc.invalidateQueries({ queryKey: ['auth', 'api-keys'] });
      showToast('API Key 已删除');
    },
    onError: (err: Error) => showToast(`删除失败：${err.message}`, 'error'),
  });

  const copyRevealed = async () => {
    if (!revealedKey) return;
    await navigator.clipboard.writeText(revealedKey.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const editingId = editing && editing !== 'new' ? editing.id : null;

  return (
    <div className="space-y-4">
      {/* Toolbar (Cloudflare DNS style) */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索名称、前缀或权限..."
              className="yd-input-sm w-full pl-8 pr-7"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:text-zinc-600"
                aria-label="清除搜索"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              setOpenMenuId(null);
              setEditing((cur) => (cur === 'new' ? null : 'new'));
            }}
            className="yd-btn-primary shrink-0"
          >
            {editing === 'new' ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" />
                收起新建
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" />
                新建 API Key
              </>
            )}
          </button>
        </div>

        <p className="text-xs text-zinc-500">
          通过 <code className="yd-code">Authorization: Bearer ydk_...</code> 鉴权，推送终结点另支持{' '}
          <code className="yd-code">?key=</code> 参数。
        </p>
      </div>

      {/* One-time revealed key banner */}
      {revealedKey && (
        <div className="rounded-xl border border-emerald-200/80 bg-emerald-50/50 p-4 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-900">
              <KeyRound className="h-3.5 w-3.5 shrink-0" />
              <span>已生成密钥「{revealedKey.name}」，明文仅展示本次，请立即保存</span>
            </div>
            <button
              type="button"
              onClick={() => setRevealedKey(null)}
              className="rounded-md p-1 text-emerald-700 hover:bg-emerald-100/60"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-white border border-emerald-200/80 px-3 py-2 font-mono text-xs text-zinc-800 break-all select-all">
              {revealedKey.key}
            </code>
            <button
              type="button"
              onClick={() => void copyRevealed()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-600 transition-colors shrink-0"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? '已复制' : '复制密钥'}
            </button>
          </div>
        </div>
      )}

      {/* Inline Create Panel (above the list, Cloudflare DNS style) */}
      {editing === 'new' && (
        <div
          ref={editorContainerRef}
          className="yd-card border-sky-200/90 shadow-[0_4px_16px_rgba(14,165,233,0.06)] p-5"
        >
          <APIKeyForm
            key="new"
            permissions={permissions}
            initial={null}
            onClose={() => setEditing(null)}
            onCreated={(res) => {
              setEditing(null);
              setRevealedKey({ name: res.api_key.name, key: res.plain_key });
              setCopied(false);
              void qc.invalidateQueries({ queryKey: ['auth', 'api-keys'] });
            }}
            onUpdated={() => {
              setEditing(null);
              void qc.invalidateQueries({ queryKey: ['auth', 'api-keys'] });
              showToast('API Key 已保存');
            }}
          />
        </div>
      )}

      {/* API Keys Table / Expandable List */}
      {isLoading ? (
        <LoadingState label="正在加载模块..." variant="section" />
      ) : apiKeys.length === 0 ? (
        <div className="yd-empty p-10 text-xs">暂无 API Key</div>
      ) : filteredKeys.length === 0 ? (
        <div className="yd-empty p-10 text-xs">没有匹配「{searchQuery.trim()}」的 API Key</div>
      ) : (
        <div className="yd-card">
          {/* Desktop table header */}
          <div className="hidden md:grid md:grid-cols-[minmax(170px,1.15fr)_minmax(240px,2fr)_80px_172px_100px] gap-4 items-center border-b border-zinc-200/75 bg-[#f8fafc] px-4 py-2.5 text-xs font-medium text-zinc-400 rounded-t-xl">
            <div>名称</div>
            <div>权限摘要</div>
            <div>状态</div>
            <div>使用与有效期</div>
            <div className="text-right">操作</div>
          </div>

          <div className="divide-y divide-zinc-100">
            {filteredKeys.map((item, idx) => {
              const isExpired = Boolean(
                item.expires_at && new Date(item.expires_at).getTime() <= Date.now(),
              );
              const isEditingThis = editingId === item.id;
              const menuOpen = openMenuId === item.id;
              const isLast = idx === filteredKeys.length - 1;

              return (
                <div key={item.id} className={isLast ? 'rounded-b-xl' : ''}>
                  {/* Summary Row */}
                  <div
                    className={`grid grid-cols-1 md:grid-cols-[minmax(170px,1.15fr)_minmax(240px,2fr)_80px_172px_100px] gap-3 md:gap-4 items-start md:items-center px-4 py-3.5 transition-colors ${
                      isEditingThis
                        ? 'bg-sky-50/45'
                        : 'hover:bg-[#f8fafc]/70'
                    } ${isLast && !isEditingThis ? 'rounded-b-xl' : ''}`}
                  >
                    {/* Name & Prefix */}
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[13px] font-medium text-zinc-900 truncate">
                          {item.name}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-zinc-400">
                        {item.key_prefix}••••••••
                      </div>
                    </div>

                    {/* Policy Summary */}
                    <div className="flex flex-wrap gap-1.5 min-w-0">
                      {item.policies.map((rule, ruleIdx) => {
                        const def = permMap.get(rule.permission);
                        const isAll = rule.resources.includes('*');
                        return (
                          <span
                            key={`${rule.permission}-${ruleIdx}`}
                            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200/80 bg-[#f8fafc] px-2 py-0.5 text-[11px] text-zinc-700 max-w-full"
                          >
                            <Shield className="h-3 w-3 text-zinc-400 shrink-0" />
                            <span className="font-medium truncate">
                              {def ? `${def.module_name} · ${def.label}` : rule.permission}
                            </span>
                            {def?.resource_type && (
                              <span className="rounded bg-white px-1.5 py-0 text-[10px] text-zinc-500 border border-zinc-200/75 truncate max-w-[160px]">
                                {isAll ? '全部资源' : resolveResourceNames(def, rule.resources)}
                              </span>
                            )}
                          </span>
                        );
                      })}
                    </div>

                    {/* Status */}
                    <div className="flex items-center gap-1.5">
                      {!item.enabled ? (
                        <span className="yd-badge yd-badge-amber">已停用</span>
                      ) : isExpired ? (
                        <span className="yd-badge yd-badge-red">已过期</span>
                      ) : (
                        <span className="yd-badge yd-badge-emerald">启用中</span>
                      )}
                    </div>

                    {/* Timestamps */}
                    <div className="space-y-0.5 text-[11px] text-zinc-400 tabular-nums">
                      <div className="truncate">
                        使用：<span className="font-mono text-zinc-500">{formatTime(item.last_used_at)}</span>
                      </div>
                      <div className="truncate">
                        过期：
                        <span className={item.expires_at ? 'font-mono text-zinc-500' : 'text-zinc-500'}>
                          {item.expires_at ? formatTime(item.expires_at) : '永不过期'}
                        </span>
                      </div>
                    </div>

                    {/* Actions: Edit + Planner-style MoreHorizontal menu */}
                    <div className="flex items-center justify-end gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenuId(null);
                          setEditing(isEditingThis ? null : item);
                        }}
                        className={
                          isEditingThis
                            ? 'inline-flex items-center gap-1 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-xs font-medium text-sky-700 transition-colors hover:bg-sky-100/70'
                            : 'yd-btn-secondary px-2.5 py-1.5 text-xs'
                        }
                      >
                        {isEditingThis ? (
                          <>
                            <ChevronUp className="h-3.5 w-3.5" />
                            收起
                          </>
                        ) : (
                          '编辑'
                        )}
                      </button>

                      <div className="relative" ref={menuOpen ? menuRef : undefined}>
                        <Tooltip content="更多操作" disabled={menuOpen}>
                          <button
                            type="button"
                            onClick={() => setOpenMenuId(menuOpen ? null : item.id)}
                            className="yd-btn-icon"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>

                        {menuOpen && (
                          <div className="absolute right-0 mt-1.5 w-32 rounded-xl border border-zinc-200/90 bg-white py-1 shadow-lg z-30">
                            <button
                              type="button"
                              disabled={toggleEnabledMut.isPending}
                              onClick={() => {
                                setOpenMenuId(null);
                                toggleEnabledMut.mutate(item);
                              }}
                              className="w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50 flex items-center gap-2 disabled:opacity-50"
                            >
                              {item.enabled ? (
                                <>
                                  <Pause className="h-3.5 w-3.5 text-zinc-400" />
                                  停用
                                </>
                              ) : (
                                <>
                                  <Play className="h-3.5 w-3.5 text-zinc-400" />
                                  启用
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              disabled={rotateMut.isPending}
                              onClick={() => {
                                setOpenMenuId(null);
                                if (
                                  window.confirm(
                                    `轮换后「${item.name}」的旧密钥将立即失效，确定继续？`,
                                  )
                                ) {
                                  rotateMut.mutate(item.id);
                                }
                              }}
                              className="w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50 flex items-center gap-2 disabled:opacity-50"
                            >
                              <RefreshCw className="h-3.5 w-3.5 text-zinc-400" />
                              轮换密钥
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuId(null);
                                if (window.confirm(`确定删除 API Key「${item.name}」吗？`)) {
                                  deleteMut.mutate(item.id);
                                }
                              }}
                              className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50/70 flex items-center gap-2"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              删除
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Inline Expanded Edit Panel (Cloudflare DNS style) */}
                  {isEditingThis && (
                    <div
                      ref={editorContainerRef}
                      className={`border-t border-sky-200/75 bg-[#f8fafc]/90 px-4 py-4 sm:px-5 sm:py-5 ${
                        isLast ? 'rounded-b-xl' : ''
                      }`}
                    >
                      <APIKeyForm
                        key={item.id}
                        permissions={permissions}
                        initial={item}
                        inline
                        onClose={() => setEditing(null)}
                        onCreated={(res) => {
                          setEditing(null);
                          setRevealedKey({ name: res.api_key.name, key: res.plain_key });
                          setCopied(false);
                          void qc.invalidateQueries({ queryKey: ['auth', 'api-keys'] });
                        }}
                        onUpdated={() => {
                          setEditing(null);
                          void qc.invalidateQueries({ queryKey: ['auth', 'api-keys'] });
                          showToast('API Key 已保存');
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

type PolicyDraftRow = {
  uid: string;
  moduleId: string;
  permissionKey: string;
  scopeMode: 'all' | 'selected';
  selectedResources: string[];
};

type ModuleGroup = {
  moduleId: string;
  moduleName: string;
  items: PermissionSchemaItem[];
};

function APIKeyForm({
  permissions,
  initial,
  inline = false,
  onClose,
  onCreated,
  onUpdated,
}: {
  permissions: PermissionSchemaItem[];
  initial: APIKey | null;
  inline?: boolean;
  onClose: () => void;
  onCreated: (res: { api_key: APIKey; plain_key: string }) => void;
  onUpdated: () => void;
}) {
  const permMap = useMemo(() => {
    const map = new Map<string, PermissionSchemaItem>();
    for (const p of permissions) map.set(p.key, p);
    return map;
  }, [permissions]);

  const moduleGroups = useMemo<ModuleGroup[]>(() => {
    const groups: ModuleGroup[] = [];
    const indexById = new Map<string, number>();
    for (const p of permissions) {
      const existing = indexById.get(p.module_id);
      if (existing !== undefined) {
        groups[existing].items.push(p);
      } else {
        indexById.set(p.module_id, groups.length);
        groups.push({
          moduleId: p.module_id,
          moduleName: p.module_name,
          items: [p],
        });
      }
    }
    return groups;
  }, [permissions]);

  const [name, setName] = useState(initial?.name ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [expiresLocal, setExpiresLocal] = useState(() => toDatetimeLocalValue(initial?.expires_at));
  const [rows, setRows] = useState<PolicyDraftRow[]>(() => {
    if (initial && initial.policies.length > 0) {
      return initial.policies.map((p) => {
        const def = permissions.find((item) => item.key === p.permission);
        const isAll = p.resources.includes('*');
        return {
          uid: nextRowUid(),
          moduleId: def?.module_id ?? '',
          permissionKey: p.permission,
          scopeMode: isAll ? 'all' : 'selected',
          selectedResources: isAll ? [] : p.resources,
        };
      });
    }
    return [
      {
        uid: nextRowUid(),
        moduleId: '',
        permissionKey: '',
        scopeMode: 'all',
        selectedResources: [],
      },
    ];
  });
  const [error, setError] = useState('');

  // Backfill moduleId if schema arrived after form mounted
  useEffect(() => {
    if (permissions.length === 0) return;
    setRows((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        if (!row.moduleId && row.permissionKey) {
          const def = permMap.get(row.permissionKey);
          if (def) {
            changed = true;
            return { ...row, moduleId: def.module_id };
          }
        }
        return row;
      });
      return changed ? next : prev;
    });
  }, [permissions, permMap]);

  const createMut = useMutation({
    mutationFn: (payload: UpsertAPIKeyPayload) => coreApi.createAPIKey(payload),
    onSuccess: onCreated,
    onError: (err: Error) => setError(err.message),
  });

  const updateMut = useMutation({
    mutationFn: (payload: UpsertAPIKeyPayload) => coreApi.updateAPIKey(initial!.id, payload),
    onSuccess: onUpdated,
    onError: (err: Error) => setError(err.message),
  });

  const isPending = createMut.isPending || updateMut.isPending;

  const selectedPermKeys = useMemo(
    () => new Set(rows.map((r) => r.permissionKey).filter(Boolean)),
    [rows],
  );
  const canAddMore = rows.length < permissions.length;

  const updateRow = (uid: string, updater: (row: PolicyDraftRow) => PolicyDraftRow) => {
    setRows((prev) => prev.map((r) => (r.uid === uid ? updater(r) : r)));
  };

  const handleModuleChange = (uid: string, moduleId: string) => {
    const usedByOthers = new Set(
      rows.filter((r) => r.uid !== uid && r.permissionKey).map((r) => r.permissionKey),
    );
    const group = moduleGroups.find((g) => g.moduleId === moduleId);
    const firstAvailable = group?.items.find((p) => !usedByOthers.has(p.key));
    updateRow(uid, (r) => ({
      ...r,
      moduleId,
      permissionKey: firstAvailable?.key ?? '',
      scopeMode: 'all',
      selectedResources: [],
    }));
  };

  const handlePermissionChange = (uid: string, permissionKey: string) => {
    const def = permMap.get(permissionKey);
    updateRow(uid, (r) => ({
      ...r,
      moduleId: def?.module_id ?? r.moduleId,
      permissionKey,
      scopeMode: 'all',
      selectedResources: [],
    }));
  };

  const handleScopeModeChange = (uid: string, scopeMode: 'all' | 'selected') => {
    updateRow(uid, (r) => ({ ...r, scopeMode }));
  };

  const handleToggleResource = (uid: string, resourceId: string) => {
    updateRow(uid, (r) => {
      const exists = r.selectedResources.includes(resourceId);
      return {
        ...r,
        selectedResources: exists
          ? r.selectedResources.filter((id) => id !== resourceId)
          : [...r.selectedResources, resourceId],
      };
    });
  };

  const handleAddRow = () => {
    setRows((prev) => [
      ...prev,
      {
        uid: nextRowUid(),
        moduleId: '',
        permissionKey: '',
        scopeMode: 'all',
        selectedResources: [],
      },
    ]);
  };

  const handleRemoveRow = (uid: string) => {
    setRows((prev) => {
      const remaining = prev.filter((r) => r.uid !== uid);
      if (remaining.length === 0) {
        return [
          {
            uid: nextRowUid(),
            moduleId: '',
            permissionKey: '',
            scopeMode: 'all',
            selectedResources: [],
          },
        ];
      }
      return remaining;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const filledRows = rows.filter((r) => Boolean(r.permissionKey));
    if (filledRows.length === 0) {
      setError('请至少添加并选择一项权限');
      return;
    }
    if (filledRows.length !== rows.length) {
      setError('请完善或移除未选择权限的策略行');
      return;
    }

    const policies: PolicyRule[] = [];
    const seen = new Set<string>();
    for (const row of filledRows) {
      if (seen.has(row.permissionKey)) {
        setError('存在重复的权限策略，请移除重复项');
        return;
      }
      seen.add(row.permissionKey);

      const def = permMap.get(row.permissionKey);
      if (def?.resource_type && row.scopeMode === 'selected') {
        if (row.selectedResources.length === 0) {
          setError(`「${def.label}」在指定资源模式下请至少勾选一个资源`);
          return;
        }
        policies.push({ permission: row.permissionKey, resources: row.selectedResources });
      } else {
        policies.push({ permission: row.permissionKey, resources: ['*'] });
      }
    }

    const payload: UpsertAPIKeyPayload = {
      name: name.trim(),
      policies,
      enabled,
      expires_at: expiresLocal ? new Date(expiresLocal).toISOString() : undefined,
    };

    if (initial) {
      updateMut.mutate(payload);
    } else {
      createMut.mutate(payload);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {!inline && (
        <div className="flex items-center justify-between pb-1 border-b border-zinc-100">
          <h3 className="text-sm font-medium text-zinc-800">新建 API Key</h3>
          <button type="button" onClick={onClose} className="yd-btn-icon" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {error && <div className="yd-notice-error">{error}</div>}

      {/* Section 1: Basic Info & TTL */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block space-y-1.5">
          <span className="yd-label">名称</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：MacBook 同步 / NAS 告警"
            className="yd-input"
          />
        </label>

        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="yd-label">过期时间</span>
            <div className="flex items-center gap-1 text-[11px]">
              <button
                type="button"
                onClick={() => setExpiresLocal('')}
                className={`rounded px-1.5 py-0.5 transition-colors ${
                  !expiresLocal
                    ? 'bg-sky-50 text-sky-700 font-medium'
                    : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700'
                }`}
              >
                永不过期
              </button>
              {[7, 30, 90].map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => setExpiresLocal(addDaysToDatetimeLocal(days))}
                  className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition-colors"
                >
                  {days} 天
                </button>
              ))}
            </div>
          </div>
          <input
            type="datetime-local"
            value={expiresLocal}
            onChange={(e) => setExpiresLocal(e.target.value)}
            className="yd-input"
          />
        </div>
      </div>

      {/* Section 2: Cloudflare API Tokens style Policy Rows */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="yd-label">权限策略</span>
          <span className="text-[11px] text-zinc-400 tabular-nums">
            已配置 {selectedPermKeys.size} 项权限
          </span>
        </div>

        {moduleGroups.length === 0 ? (
          <div className="yd-empty p-4 text-xs">当前暂无可用权限定义</div>
        ) : (
          <div className="space-y-2">
            {/* Column labels on desktop */}
            <div className="hidden sm:grid sm:grid-cols-[minmax(130px,1fr)_minmax(180px,1.4fr)_minmax(140px,1fr)_32px] gap-2.5 px-3 text-[11px] font-medium text-zinc-400">
              <div>模块</div>
              <div>权限</div>
              <div>资源范围</div>
              <div />
            </div>

            {rows.map((row) => {
              const usedByOthers = new Set(
                rows
                  .filter((r) => r.uid !== row.uid && r.permissionKey)
                  .map((r) => r.permissionKey),
              );
              const moduleOptions = moduleGroups
                .filter(
                  (g) =>
                    g.moduleId === row.moduleId ||
                    g.items.some((p) => !usedByOthers.has(p.key)),
                )
                .map((g) => ({ value: g.moduleId, label: g.moduleName }));

              const activeGroup = moduleGroups.find((g) => g.moduleId === row.moduleId);
              const permOptions = (activeGroup?.items ?? [])
                .filter((p) => p.key === row.permissionKey || !usedByOthers.has(p.key))
                .map((p) => ({
                  value: p.key,
                  label: p.label,
                  description: p.description,
                }));

              const currentPerm = row.permissionKey ? permMap.get(row.permissionKey) : undefined;
              const hasResources = Boolean(currentPerm?.resource_type);

              return (
                <div
                  key={row.uid}
                  className="rounded-xl border border-zinc-200/80 bg-white p-3 space-y-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.02)]"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-[minmax(130px,1fr)_minmax(180px,1.4fr)_minmax(140px,1fr)_32px] gap-2.5 items-center">
                    <Select
                      value={row.moduleId}
                      onChange={(val) => handleModuleChange(row.uid, val)}
                      options={moduleOptions}
                      placeholder="选择模块"
                      size="sm"
                      className="w-full"
                      ariaLabel="选择权限模块"
                    />

                    <Select
                      value={row.permissionKey}
                      onChange={(val) => handlePermissionChange(row.uid, val)}
                      options={permOptions}
                      disabled={!row.moduleId}
                      placeholder="选择权限"
                      size="sm"
                      className="w-full"
                      ariaLabel="选择具体权限"
                    />

                    {hasResources ? (
                      <Select
                        value={row.scopeMode}
                        onChange={(val) =>
                          handleScopeModeChange(row.uid, val as 'all' | 'selected')
                        }
                        options={[
                          { value: 'all', label: '全部资源' },
                          { value: 'selected', label: '指定资源' },
                        ]}
                        size="sm"
                        className="w-full"
                        ariaLabel="选择资源范围"
                      />
                    ) : (
                      <div className="rounded-lg border border-zinc-200/70 bg-[#f8fafc] px-2.5 py-1.5 text-[13px] text-zinc-400 truncate">
                        {currentPerm ? '全部适用' : '—'}
                      </div>
                    )}

                    <div className="flex justify-end">
                      <Tooltip content="移除该策略">
                        <button
                          type="button"
                          onClick={() => handleRemoveRow(row.uid)}
                          className="yd-btn-danger-icon"
                          aria-label="移除该策略"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </Tooltip>
                    </div>
                  </div>

                  {currentPerm?.description && (
                    <div className="flex flex-wrap items-center gap-2 px-0.5 text-[11px] text-zinc-400">
                      <span>{currentPerm.description}</span>
                      <span className="font-mono text-zinc-300">·</span>
                      <span className="font-mono text-zinc-400">{currentPerm.key}</span>
                    </div>
                  )}

                  {hasResources && row.scopeMode === 'selected' && currentPerm && (
                    <div className="rounded-lg border border-zinc-200/75 bg-[#f8fafc] p-2.5 space-y-2">
                      <div className="text-[11px] font-medium text-zinc-500">
                        选择允许访问的资源（已选 {row.selectedResources.length} 项）
                      </div>
                      {currentPerm.resources.length === 0 ? (
                        <div className="text-xs text-zinc-400">
                          暂无可选资源，请先在对应模块创建
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
                          {currentPerm.resources.map((res) => {
                            const checked = row.selectedResources.includes(res.id);
                            return (
                              <label
                                key={res.id}
                                className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs cursor-pointer transition-colors ${
                                  checked
                                    ? 'border-sky-200 bg-sky-50/50 text-sky-900'
                                    : 'border-zinc-200/75 bg-white text-zinc-700 hover:border-sky-200'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => handleToggleResource(row.uid, res.id)}
                                />
                                <span className="truncate">{res.name}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            <div className="pt-0.5">
              <button
                type="button"
                disabled={!canAddMore}
                onClick={handleAddRow}
                className="yd-btn-secondary text-xs py-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                {canAddMore ? '添加权限' : '已添加全部可用权限'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-zinc-200/70">
        <label className="inline-flex items-center gap-2 text-xs text-zinc-700 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>启用该 API Key</span>
        </label>

        <div className="flex items-center gap-2">
          <button type="button" onClick={onClose} className="yd-btn-secondary">
            取消
          </button>
          <button type="submit" disabled={isPending} className="yd-btn-primary">
            {isPending ? '保存中...' : initial ? '保存更改' : '生成 API Key'}
          </button>
        </div>
      </div>
    </form>
  );
}
