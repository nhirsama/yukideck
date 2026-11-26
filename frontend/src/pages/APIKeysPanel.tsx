import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus, RefreshCw, Shield, Trash2, X } from 'lucide-react';
import { LoadingState } from '@/components/LoadingState';
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
  return d.toLocaleString('zh-CN', { hour12: false });
}

function toDatetimeLocalValue(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function resolveResourceNames(def: PermissionSchemaItem | undefined, ids: string[]): string {
  if (!def || def.resources.length === 0) return ids.join(', ');
  const nameMap = new Map(def.resources.map((r) => [r.id, r.name]));
  return ids.map((id) => nameMap.get(id) ?? id).join(', ');
}

export function APIKeysPanel() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<APIKey | 'new' | null>(null);
  const [revealedKey, setRevealedKey] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

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

  const rotateMut = useMutation({
    mutationFn: (id: number) => coreApi.rotateAPIKey(id),
    onSuccess: (res) => {
      setRevealedKey({ name: res.api_key.name, key: res.plain_key });
      setCopied(false);
      void qc.invalidateQueries({ queryKey: ['auth', 'api-keys'] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => coreApi.deleteAPIKey(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['auth', 'api-keys'] }),
  });

  const copyRevealed = async () => {
    if (!revealedKey) return;
    await navigator.clipboard.writeText(revealedKey.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          通过 <code className="yd-code">Authorization: Bearer ydk_...</code> 鉴权，推送终结点另支持{' '}
          <code className="yd-code">?key=</code> 参数。
        </p>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="yd-btn-primary shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          新建 API Key
        </button>
      </div>

      {revealedKey && (
        <div className="rounded-xl border border-emerald-200/80 bg-emerald-50/50 p-4 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-900">
              <KeyRound className="h-3.5 w-3.5" />
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

      {editing && (
        <APIKeyForm
          permissions={permissions}
          initial={editing === 'new' ? null : editing}
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
          }}
        />
      )}

      {isLoading ? (
        <LoadingState label="正在加载模块..." variant="section" />
      ) : apiKeys.length === 0 ? (
        <div className="yd-empty p-10 text-xs">暂无 API Key</div>
      ) : (
        <div className="space-y-3">
          {apiKeys.map((item) => {
            const isExpired = Boolean(
              item.expires_at && new Date(item.expires_at).getTime() <= Date.now(),
            );
            return (
              <div key={item.id} className="yd-card p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-medium text-zinc-900">{item.name}</span>
                      <code className="yd-code">{item.key_prefix}••••••••</code>
                      {!item.enabled && <span className="yd-badge yd-badge-amber">已停用</span>}
                      {isExpired && <span className="yd-badge yd-badge-red">已过期</span>}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-400 tabular-nums">
                      <span>
                        最近使用：<span className="font-mono">{formatTime(item.last_used_at)}</span>
                      </span>
                      <span>
                        过期时间：
                        <span className={item.expires_at ? 'font-mono' : ''}>
                          {item.expires_at ? formatTime(item.expires_at) : '永不过期'}
                        </span>
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <Tooltip content="轮换密钥">
                      <button
                        type="button"
                        disabled={rotateMut.isPending}
                        onClick={() => {
                          if (window.confirm(`轮换后「${item.name}」的旧密钥将立即失效，确定继续？`)) {
                            rotateMut.mutate(item.id);
                          }
                        }}
                        className="yd-btn-icon"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                    <button
                      type="button"
                      onClick={() => setEditing(item)}
                      className="yd-btn-secondary"
                    >
                      编辑
                    </button>
                    <Tooltip content="删除">
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`确定删除 API Key「${item.name}」吗？`)) {
                            deleteMut.mutate(item.id);
                          }
                        }}
                        className="yd-btn-danger-icon"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {item.policies.map((rule, idx) => {
                    const def = permMap.get(rule.permission);
                    const isAll = rule.resources.includes('*');
                    return (
                      <div
                        key={`${rule.permission}-${idx}`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200/80 bg-zinc-50/70 px-2.5 py-1 text-xs"
                      >
                        <Shield className="h-3 w-3 text-zinc-400 shrink-0" />
                        <span className="font-medium text-zinc-700">
                          {def ? `${def.module_name} · ${def.label}` : rule.permission}
                        </span>
                        {def?.resource_type && (
                          <span className="rounded bg-white px-1.5 py-0.5 text-[11px] text-zinc-500 border border-zinc-200/80">
                            {isAll ? '全部资源' : resolveResourceNames(def, rule.resources)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type SelectedPermState = {
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
  onClose,
  onCreated,
  onUpdated,
}: {
  permissions: PermissionSchemaItem[];
  initial: APIKey | null;
  onClose: () => void;
  onCreated: (res: { api_key: APIKey; plain_key: string }) => void;
  onUpdated: () => void;
}) {
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
  const [selectedMap, setSelectedMap] = useState<Record<string, SelectedPermState>>(() => {
    const init: Record<string, SelectedPermState> = {};
    if (initial) {
      for (const p of initial.policies) {
        const isAll = p.resources.includes('*');
        init[p.permission] = {
          scopeMode: isAll ? 'all' : 'selected',
          selectedResources: isAll ? [] : p.resources,
        };
      }
    }
    return init;
  });

  const [activeModuleId, setActiveModuleId] = useState<string>(() => {
    if (initial && initial.policies.length > 0) {
      const firstPerm = permissions.find((p) => p.key === initial.policies[0].permission);
      if (firstPerm) return firstPerm.module_id;
    }
    return moduleGroups[0]?.moduleId ?? '';
  });
  const [error, setError] = useState('');

  const currentModule =
    moduleGroups.find((g) => g.moduleId === activeModuleId) ?? moduleGroups[0] ?? null;

  const selectedEntries = useMemo(() => {
    const list: Array<{ def: PermissionSchemaItem; state: SelectedPermState }> = [];
    for (const p of permissions) {
      const st = selectedMap[p.key];
      if (st) list.push({ def: p, state: st });
    }
    return list;
  }, [permissions, selectedMap]);

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

  const togglePermission = (permKey: string) => {
    setSelectedMap((prev) => {
      const next = { ...prev };
      if (next[permKey]) {
        delete next[permKey];
      } else {
        next[permKey] = { scopeMode: 'all', selectedResources: [] };
      }
      return next;
    });
  };

  const toggleModuleAll = (group: ModuleGroup) => {
    const allChecked = group.items.every((p) => Boolean(selectedMap[p.key]));
    setSelectedMap((prev) => {
      const next = { ...prev };
      for (const p of group.items) {
        if (allChecked) {
          delete next[p.key];
        } else if (!next[p.key]) {
          next[p.key] = { scopeMode: 'all', selectedResources: [] };
        }
      }
      return next;
    });
  };

  const updateScopeMode = (permKey: string, scopeMode: 'all' | 'selected') => {
    setSelectedMap((prev) => {
      const cur = prev[permKey];
      if (!cur) return prev;
      return { ...prev, [permKey]: { ...cur, scopeMode } };
    });
  };

  const toggleResource = (permKey: string, resourceID: string) => {
    setSelectedMap((prev) => {
      const cur = prev[permKey];
      if (!cur) return prev;
      const exists = cur.selectedResources.includes(resourceID);
      return {
        ...prev,
        [permKey]: {
          ...cur,
          selectedResources: exists
            ? cur.selectedResources.filter((id) => id !== resourceID)
            : [...cur.selectedResources, resourceID],
        },
      };
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (selectedEntries.length === 0) {
      setError('请至少勾选一项权限');
      return;
    }

    const policies: PolicyRule[] = [];
    for (const { def, state } of selectedEntries) {
      if (def.resource_type && state.scopeMode === 'selected') {
        if (state.selectedResources.length === 0) {
          setError(`「${def.label}」在指定资源模式下请至少勾选一个资源`);
          return;
        }
        policies.push({ permission: def.key, resources: state.selectedResources });
      } else {
        policies.push({ permission: def.key, resources: ['*'] });
      }
    }

    const payload: UpsertAPIKeyPayload = {
      name,
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
    <form onSubmit={handleSubmit} className="yd-card p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-800">
          {initial ? '编辑 API Key' : '新建 API Key'}
        </h3>
        <button type="button" onClick={onClose} className="yd-btn-ghost">
          取消
        </button>
      </div>

      {error && <div className="yd-notice-error">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

        <label className="block space-y-1.5">
          <span className="yd-label">
            过期时间 <span className="font-normal text-zinc-400">（留空永不过期）</span>
          </span>
          <input
            type="datetime-local"
            value={expiresLocal}
            onChange={(e) => setExpiresLocal(e.target.value)}
            className="yd-input"
          />
        </label>
      </div>

      {/* Module-grouped Permission Strategy */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="yd-label">权限策略</span>
          <span className="text-[11px] text-zinc-400 tabular-nums">
            {selectedEntries.length > 0 ? `已选 ${selectedEntries.length} 项权限` : '选择模块后勾选权限'}
          </span>
        </div>

        {moduleGroups.length === 0 ? (
          <div className="yd-empty p-4 text-xs">当前暂无可用权限定义</div>
        ) : (
          <div className="space-y-3">
            {/* Module category selector */}
            <div className="flex flex-wrap gap-2">
              {moduleGroups.map((group) => {
                const isActive = currentModule?.moduleId === group.moduleId;
                const count = group.items.filter((p) => Boolean(selectedMap[p.key])).length;
                return (
                  <button
                    key={group.moduleId}
                    type="button"
                    onClick={() => setActiveModuleId(group.moduleId)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                      isActive
                        ? 'border-sky-300 bg-sky-50/90 text-sky-700 shadow-[0_1px_2px_rgba(14,165,233,0.08)]'
                        : count > 0
                          ? 'border-sky-200/80 bg-white text-zinc-700 hover:border-sky-300'
                          : 'border-zinc-200/85 bg-white text-zinc-500 hover:border-zinc-300 hover:text-zinc-800'
                    }`}
                  >
                    <span>{group.moduleName}</span>
                    {count > 0 && (
                      <span
                        className={`rounded-full px-1.5 py-0 text-[10px] font-mono leading-4 ${
                          isActive
                            ? 'bg-sky-500 text-white'
                            : 'bg-sky-100 text-sky-700'
                        }`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Permissions inside selected module */}
            {currentModule && (
              <div className="yd-panel-subtle p-3.5 space-y-2.5">
                <div className="flex items-center justify-between gap-2 px-0.5">
                  <span className="text-xs font-medium text-zinc-700">
                    {currentModule.moduleName}
                  </span>
                  {currentModule.items.length > 1 && (
                    <button
                      type="button"
                      onClick={() => toggleModuleAll(currentModule)}
                      className="text-[11px] text-sky-600 hover:text-sky-700 transition-colors"
                    >
                      {currentModule.items.every((p) => Boolean(selectedMap[p.key]))
                        ? '取消全选'
                        : '全选该模块'}
                    </button>
                  )}
                </div>

                <div className="space-y-2">
                  {currentModule.items.map((perm) => {
                    const st = selectedMap[perm.key];
                    const checked = Boolean(st);
                    return (
                      <div
                        key={perm.key}
                        className={`rounded-lg border px-3.5 py-2.5 transition-colors ${
                          checked
                            ? 'border-sky-200/90 bg-white shadow-[0_1px_2px_rgba(14,165,233,0.04)]'
                            : 'border-zinc-200/70 bg-white/75 hover:border-zinc-300/80'
                        }`}
                      >
                        <label className="flex items-start gap-2.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePermission(perm.key)}
                            className="mt-0.5"
                          />
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-medium text-zinc-800">
                                {perm.label}
                              </span>
                              <span className="font-mono text-[11px] text-zinc-400">
                                {perm.key}
                              </span>
                            </div>
                            {perm.description && (
                              <p className="text-[11px] text-zinc-500 leading-relaxed">
                                {perm.description}
                              </p>
                            )}
                          </div>
                        </label>

                        {checked && perm.resource_type && st && (
                          <div className="mt-2.5 ml-6 pt-2.5 border-t border-zinc-100 space-y-2">
                            <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-700">
                              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="radio"
                                  name={`scope-${perm.key}`}
                                  checked={st.scopeMode === 'all'}
                                  onChange={() => updateScopeMode(perm.key, 'all')}
                                />
                                <span>全部资源</span>
                              </label>
                              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="radio"
                                  name={`scope-${perm.key}`}
                                  checked={st.scopeMode === 'selected'}
                                  onChange={() => updateScopeMode(perm.key, 'selected')}
                                />
                                <span>指定资源</span>
                              </label>
                            </div>

                            {st.scopeMode === 'selected' && (
                              <div className="rounded-lg border border-zinc-200/75 bg-[#f8fafc] p-2.5 space-y-1.5">
                                {perm.resources.length === 0 ? (
                                  <div className="text-xs text-zinc-400">
                                    暂无可选资源，请先在对应模块创建
                                  </div>
                                ) : (
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                    {perm.resources.map((res) => (
                                      <label
                                        key={res.id}
                                        className="flex items-center gap-2 rounded-md bg-white border border-zinc-200/70 px-2.5 py-1.5 text-xs text-zinc-700 cursor-pointer hover:border-sky-200 transition-colors"
                                      >
                                        <input
                                          type="checkbox"
                                          checked={st.selectedResources.includes(res.id)}
                                          onChange={() => toggleResource(perm.key, res.id)}
                                        />
                                        <span className="truncate">{res.name}</span>
                                      </label>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Selected summary across all modules */}
            {selectedEntries.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {selectedEntries.map(({ def, state }) => (
                  <span
                    key={def.key}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200/80 bg-sky-50/60 px-2.5 py-1 text-[11px] text-sky-800"
                  >
                    <button
                      type="button"
                      onClick={() => setActiveModuleId(def.module_id)}
                      className="hover:underline"
                    >
                      {def.module_name} · {def.label}
                      {def.resource_type
                        ? state.scopeMode === 'all'
                          ? ' · 全部资源'
                          : state.selectedResources.length > 0
                            ? ` · ${state.selectedResources.length} 个资源`
                            : ' · 待选资源'
                        : ''}
                    </button>
                    <Tooltip content="移除该权限">
                      <button
                        type="button"
                        onClick={() => togglePermission(def.key)}
                        className="text-sky-500 hover:text-sky-800 transition-colors"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Tooltip>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-zinc-100">
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
