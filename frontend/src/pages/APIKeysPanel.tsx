import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus, RefreshCw, Shield, Trash2, X } from 'lucide-react';
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
        <p className="text-xs text-slate-500">
          全局细粒度 API Key：按模块能力与资源范围授权。常规接口仅支持{' '}
          <code className="font-mono text-slate-700">Authorization: Bearer ydk_...</code>；仅消息推送自定义终结点额外支持{' '}
          <code className="font-mono text-slate-700">?key=</code> 查询参数。
        </p>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" />
          新建 API Key
        </button>
      </div>

      {revealedKey && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
              <KeyRound className="h-4 w-4" />
              <span>已生成密钥「{revealedKey.name}」——明文仅显示这一次，请立即保存</span>
            </div>
            <button
              type="button"
              onClick={() => setRevealedKey(null)}
              className="text-emerald-700 hover:text-emerald-900"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-white border border-emerald-200 px-3 py-2 font-mono text-xs text-slate-800 break-all">
              {revealedKey.key}
            </code>
            <button
              type="button"
              onClick={() => void copyRevealed()}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-800 shrink-0"
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
        <div className="text-sm text-slate-500">加载中...</div>
      ) : apiKeys.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          尚未创建 API Key。创建一个按模块与资源授权的 Key，即可用于 CLI 同步或外部推送终结点调用。
        </div>
      ) : (
        <div className="space-y-3">
          {apiKeys.map((item) => {
            const isExpired = Boolean(item.expires_at && new Date(item.expires_at).getTime() <= Date.now());
            return (
              <div key={item.id} className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">{item.name}</span>
                      <code className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600">
                        {item.key_prefix}••••••••
                      </code>
                      {!item.enabled && (
                        <span className="rounded bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                          已停用
                        </span>
                      )}
                      {isExpired && (
                        <span className="rounded bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
                          已过期
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                      <span>最近使用：{formatTime(item.last_used_at)}</span>
                      <span>过期时间：{item.expires_at ? formatTime(item.expires_at) : '永不过期'}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      title="轮换密钥"
                      disabled={rotateMut.isPending}
                      onClick={() => {
                        if (window.confirm(`轮换后「${item.name}」的旧密钥将立即失效，确定继续？`)) {
                          rotateMut.mutate(item.id);
                        }
                      }}
                      className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:text-slate-900"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(item)}
                      className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`确定删除 API Key「${item.name}」吗？`)) {
                          deleteMut.mutate(item.id);
                        }
                      }}
                      className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:text-red-600 hover:border-red-200"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {item.policies.map((rule, idx) => {
                    const def = permMap.get(rule.permission);
                    const isAll = rule.resources.includes('*');
                    return (
                      <div
                        key={`${rule.permission}-${idx}`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs"
                      >
                        <Shield className="h-3 w-3 text-slate-500" />
                        <span className="font-medium text-slate-800">
                          {def ? `${def.module_name} · ${def.label}` : rule.permission}
                        </span>
                        {def?.resource_type && (
                          <span className="rounded bg-white px-1.5 py-0.5 text-[11px] text-slate-600 border border-slate-200">
                            {isAll ? '全部资源 (*)' : rule.resources.join(', ')}
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

type DraftRule = {
  permission: string;
  scopeMode: 'all' | 'selected';
  selectedResources: string[];
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
  const permMap = useMemo(() => {
    const map = new Map<string, PermissionSchemaItem>();
    for (const p of permissions) map.set(p.key, p);
    return map;
  }, [permissions]);

  const [name, setName] = useState(initial?.name ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [expiresLocal, setExpiresLocal] = useState(() => toDatetimeLocalValue(initial?.expires_at));
  const [rules, setRules] = useState<DraftRule[]>(() => {
    if (initial && initial.policies.length > 0) {
      return initial.policies.map((p) => {
        const isAll = p.resources.includes('*');
        return {
          permission: p.permission,
          scopeMode: isAll ? 'all' : 'selected',
          selectedResources: isAll ? [] : p.resources,
        };
      });
    }
    if (permissions.length > 0) {
      return [{ permission: permissions[0].key, scopeMode: 'all', selectedResources: [] }];
    }
    return [];
  });
  const [error, setError] = useState('');

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

  const addRule = () => {
    const used = new Set(rules.map((r) => r.permission));
    const next = permissions.find((p) => !used.has(p.key)) ?? permissions[0];
    if (!next) return;
    setRules((prev) => [...prev, { permission: next.key, scopeMode: 'all', selectedResources: [] }]);
  };

  const removeRule = (index: number) => {
    setRules((prev) => prev.filter((_, i) => i !== index));
  };

  const updateRulePermission = (index: number, permKey: string) => {
    setRules((prev) =>
      prev.map((r, i) => (i === index ? { permission: permKey, scopeMode: 'all', selectedResources: [] } : r)),
    );
  };

  const updateRuleScopeMode = (index: number, scopeMode: 'all' | 'selected') => {
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, scopeMode } : r)));
  };

  const toggleRuleResource = (index: number, resourceID: string) => {
    setRules((prev) =>
      prev.map((r, i) => {
        if (i !== index) return r;
        const exists = r.selectedResources.includes(resourceID);
        return {
          ...r,
          selectedResources: exists
            ? r.selectedResources.filter((id) => id !== resourceID)
            : [...r.selectedResources, resourceID],
        };
      }),
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (rules.length === 0) {
      setError('至少需要添加一条权限策略');
      return;
    }

    const policies: PolicyRule[] = [];
    for (const rule of rules) {
      const def = permMap.get(rule.permission);
      if (def?.resource_type && rule.scopeMode === 'selected') {
        if (rule.selectedResources.length === 0) {
          setError(`权限「${def.label}」在指定资源模式下至少需要勾选一个资源`);
          return;
        }
        policies.push({ permission: rule.permission, resources: rule.selectedResources });
      } else {
        policies.push({ permission: rule.permission, resources: ['*'] });
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
    <form onSubmit={handleSubmit} className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">
          {initial ? '编辑 API Key' : '新建 API Key（Cloudflare 策略模式）'}
        </h3>
        <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:text-slate-900">
          取消
        </button>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-700">名称</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：主力 MacBook 同步 / NAS 告警推送"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-700">过期时间（可选，留空永不过期）</span>
          <input
            type="datetime-local"
            value={expiresLocal}
            onChange={(e) => setExpiresLocal(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-700">权限策略（按模块与资源范围授权）</span>
          <button
            type="button"
            disabled={permissions.length === 0}
            onClick={addRule}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Plus className="h-3.5 w-3.5" />
            添加策略
          </button>
        </div>

        {rules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 p-4 text-xs text-slate-500">
            当前暂无可用权限定义。
          </div>
        ) : (
          <div className="space-y-2.5">
            {rules.map((rule, idx) => {
              const def = permMap.get(rule.permission);
              return (
                <div key={idx} className="rounded-lg border border-slate-200 bg-slate-50/70 p-3 space-y-2.5">
                  <div className="flex items-center gap-2">
                    <select
                      value={rule.permission}
                      onChange={(e) => updateRulePermission(idx, e.target.value)}
                      className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-800"
                    >
                      {permissions.map((p) => (
                        <option key={p.key} value={p.key}>
                          [{p.module_name}] {p.label} ({p.key})
                        </option>
                      ))}
                    </select>
                    {rules.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeRule(idx)}
                        className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-400 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {def?.description && <div className="text-[11px] text-slate-500">{def.description}</div>}

                  {def?.resource_type && (
                    <div className="space-y-2 pt-1 border-t border-slate-200/80">
                      <div className="flex flex-wrap gap-4 text-xs text-slate-700">
                        <label className="inline-flex items-center gap-1.5">
                          <input
                            type="radio"
                            checked={rule.scopeMode === 'all'}
                            onChange={() => updateRuleScopeMode(idx, 'all')}
                          />
                          全部资源 (*)
                        </label>
                        <label className="inline-flex items-center gap-1.5">
                          <input
                            type="radio"
                            checked={rule.scopeMode === 'selected'}
                            onChange={() => updateRuleScopeMode(idx, 'selected')}
                          />
                          仅指定资源
                        </label>
                      </div>

                      {rule.scopeMode === 'selected' && (
                        <div className="rounded-lg border border-slate-200 bg-white p-2.5 space-y-1.5">
                          {def.resources.length === 0 ? (
                            <div className="text-xs text-slate-500">
                              暂无可选资源，请先在对应模块中创建资源后再回来勾选。
                            </div>
                          ) : (
                            def.resources.map((res) => (
                              <label key={res.id} className="flex items-center gap-2 text-xs text-slate-700">
                                <input
                                  type="checkbox"
                                  checked={rule.selectedResources.includes(res.id)}
                                  onChange={() => toggleRuleResource(idx, res.id)}
                                />
                                <span>{res.name}</span>
                              </label>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <label className="inline-flex items-center gap-2 text-xs text-slate-700">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用该 API Key
      </label>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700"
        >
          取消
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
        >
          {isPending ? '保存中...' : initial ? '保存更改' : '生成 API Key'}
        </button>
      </div>
    </form>
  );
}
