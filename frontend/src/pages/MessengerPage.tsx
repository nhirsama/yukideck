import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Copy,
  KeyRound,
  Plus,
  Send,
  Trash2,
} from 'lucide-react';
import { LoadingState } from '@/components/LoadingState';
import { Select } from '@/components/Select';
import { Tooltip } from '@/components/Tooltip';
import {
  coreApi,
  type Capability,
  type Channel,
  type DriverInfo,
  type PushEndpoint,
  type UpsertChannelPayload,
  type UpsertPushEndpointPayload,
} from '@/core/api';
import { useAuth } from '@/core/auth';

type TabKey = 'channels' | 'push-endpoints';
type CapFilter = 'all' | Capability;

export function MessengerPage() {
  const [tab, setTab] = useState<TabKey>('channels');

  return (
    <div className="space-y-6">
      <h1 className="yd-page-title">消息与推送</h1>

      <div className="yd-tabs">
        <button
          type="button"
          onClick={() => setTab('channels')}
          className={`yd-tab ${tab === 'channels' ? 'yd-tab-active' : 'yd-tab-idle'}`}
        >
          消息渠道
        </button>
        <button
          type="button"
          onClick={() => setTab('push-endpoints')}
          className={`yd-tab ${tab === 'push-endpoints' ? 'yd-tab-active' : 'yd-tab-idle'}`}
        >
          推送终结点
        </button>
      </div>

      {tab === 'channels' ? <ChannelsSection /> : <PushEndpointsSection />}
    </div>
  );
}

function ChannelsSection() {
  const qc = useQueryClient();
  const [capFilter, setCapFilter] = useState<CapFilter>('all');
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [feedback, setFeedback] = useState<string>('');

  const { data: driversData } = useQuery({
    queryKey: ['messenger', 'drivers'],
    queryFn: coreApi.listDrivers,
  });
  const drivers = driversData?.drivers ?? [];

  const { data: channelsData, isLoading } = useQuery({
    queryKey: ['messenger', 'channels', capFilter],
    queryFn: () => coreApi.listChannels(capFilter === 'all' ? undefined : capFilter),
  });
  const channels = channelsData?.channels ?? [];

  const deleteMut = useMutation({
    mutationFn: (id: number) => coreApi.deleteChannel(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['messenger', 'channels'] }),
  });

  const testMut = useMutation({
    mutationFn: (id: number) => coreApi.testChannel(id),
    onSuccess: () => setFeedback('测试消息已发送'),
    onError: (err: Error) => setFeedback(`测试失败：${err.message}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="yd-segment">
          {(
            [
              ['all', '全部'],
              ['outbound', '发送'],
              ['inbound', '接收'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setCapFilter(key)}
              className={`yd-segment-btn ${capFilter === key ? 'yd-segment-active' : 'yd-segment-idle'}`}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            setFeedback('');
            setEditing('new');
          }}
          className="yd-btn-primary"
        >
          <Plus className="h-3.5 w-3.5" />
          新增渠道
        </button>
      </div>

      {feedback && <div className="yd-notice">{feedback}</div>}

      {editing && drivers.length > 0 && (
        <ChannelForm
          drivers={drivers}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(ch) => {
            setEditing(null);
            setFeedback(ch.webhook_warning ? `已保存（${ch.webhook_warning}）` : '渠道已保存');
            void qc.invalidateQueries({ queryKey: ['messenger', 'channels'] });
          }}
        />
      )}

      {isLoading ? (
        <LoadingState label="正在加载模块..." variant="section" />
      ) : channels.length === 0 ? (
        <div className="yd-empty p-10 text-xs">暂无消息渠道。</div>
      ) : (
        <div className="space-y-2.5">
          {channels.map((ch) => (
            <div
              key={ch.id}
              className="yd-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div className="space-y-1.5 min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-medium text-zinc-800 mr-0.5">{ch.name}</span>
                  <span className="yd-badge yd-badge-neutral font-mono">{ch.type}</span>
                  {ch.enable_outbound && (
                    <span className="yd-badge yd-badge-emerald">
                      <ArrowUpRight className="h-3 w-3" />
                      发送
                    </span>
                  )}
                  {ch.enable_inbound && (
                    <span className="yd-badge yd-badge-sky">
                      <ArrowDownLeft className="h-3 w-3" />
                      接收
                    </span>
                  )}
                  {ch.is_default_outbound && <span className="yd-badge yd-badge-dark">默认出站</span>}
                  {!ch.enabled && <span className="yd-badge yd-badge-amber">已停用</span>}
                </div>
                {ch.webhook_url && ch.enable_inbound && (
                  <div className="text-[11px] font-mono text-zinc-400 truncate">
                    Webhook: {ch.webhook_url}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {ch.enable_outbound && (
                  <button
                    type="button"
                    disabled={testMut.isPending}
                    onClick={() => testMut.mutate(ch.id)}
                    className="yd-btn-secondary"
                  >
                    <Send className="h-3.5 w-3.5" />
                    测试
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setEditing(ch)}
                  className="yd-btn-secondary"
                >
                  编辑
                </button>
                <Tooltip content="删除">
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`确定删除渠道「${ch.name}」吗？`)) {
                        deleteMut.mutate(ch.id);
                      }
                    }}
                    className="yd-btn-danger-icon"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelForm({
  drivers,
  initial,
  onClose,
  onSaved,
}: {
  drivers: DriverInfo[];
  initial: Channel | null;
  onClose: () => void;
  onSaved: (ch: Channel) => void;
}) {
  const [type, setType] = useState(initial?.type ?? drivers[0].type);
  const driver = drivers.find((d) => d.type === type) ?? drivers[0];
  const supportsOut = driver.capabilities.includes('outbound');
  const supportsIn = driver.capabilities.includes('inbound');

  const [name, setName] = useState(initial?.name ?? '');
  const [enableOutbound, setEnableOutbound] = useState(initial ? initial.enable_outbound : supportsOut);
  const [enableInbound, setEnableInbound] = useState(initial ? initial.enable_inbound : supportsIn);
  const [isDefaultOutbound, setIsDefaultOutbound] = useState(initial?.is_default_outbound ?? true);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const f of driver.fields) {
      if (!f.secret && initial?.config?.[f.key] != null) {
        out[f.key] = String(initial.config[f.key]);
      } else {
        out[f.key] = '';
      }
    }
    return out;
  });
  const [error, setError] = useState('');

  const saveMut = useMutation({
    mutationFn: (payload: UpsertChannelPayload) =>
      initial ? coreApi.updateChannel(initial.id, payload) : coreApi.createChannel(payload),
    onSuccess: (res) => onSaved(res.channel),
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    saveMut.mutate({
      type,
      name,
      enable_outbound: supportsOut && enableOutbound,
      enable_inbound: supportsIn && enableInbound,
      is_default_outbound: supportsOut && enableOutbound && isDefaultOutbound,
      enabled,
      config: fields,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="yd-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-800">
          {initial ? '编辑渠道' : '新增渠道'}
        </h3>
        <button type="button" onClick={onClose} className="yd-btn-ghost">
          取消
        </button>
      </div>

      {error && <div className="yd-notice-error">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="block space-y-1.5">
          <span className="yd-label">渠道类型</span>
          <Select
            value={type}
            disabled={Boolean(initial)}
            onChange={setType}
            options={drivers.map((d) => ({
              value: d.type,
              label: `${d.display_name} (${d.capabilities.join(' / ')})`,
            }))}
            size="md"
            className="w-full"
            ariaLabel="选择渠道类型"
          />
        </div>

        <label className="block space-y-1.5">
          <span className="yd-label">名称</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：我的 Telegram Bot"
            className="yd-input"
          />
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {driver.fields.map((f) => (
          <label key={f.key} className="block space-y-1.5">
            <span className="yd-label">
              {f.label} {f.secret && initial ? '（留空不变）' : ''}
            </span>
            <input
              type={f.secret ? 'password' : 'text'}
              required={f.required && !(f.secret && initial)}
              value={fields[f.key] ?? ''}
              onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              className="yd-input"
            />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-5 pt-1 text-xs text-zinc-700">
        {supportsOut && (
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enableOutbound}
              onChange={(e) => setEnableOutbound(e.target.checked)}
            />
            启用发送
          </label>
        )}
        {supportsIn && (
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enableInbound}
              onChange={(e) => setEnableInbound(e.target.checked)}
            />
            启用接收（双向交互）
          </label>
        )}
        {supportsOut && enableOutbound && (
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isDefaultOutbound}
              onChange={(e) => setIsDefaultOutbound(e.target.checked)}
            />
            设为默认出站
          </label>
        )}
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用
        </label>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className="yd-btn-secondary">
          取消
        </button>
        <button type="submit" disabled={saveMut.isPending} className="yd-btn-primary">
          {saveMut.isPending ? '保存中...' : '保存'}
        </button>
      </div>
    </form>
  );
}

function PushEndpointsSection() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [editing, setEditing] = useState<PushEndpoint | 'new' | null>(null);
  const [copiedId, setCopiedId] = useState<string>('');

  const { data: outboundData } = useQuery({
    queryKey: ['messenger', 'channels', 'outbound'],
    queryFn: () => coreApi.listChannels('outbound'),
  });
  const outboundChannels = outboundData?.channels ?? [];

  const { data: endpointsData, isLoading } = useQuery({
    queryKey: ['messenger', 'push-endpoints'],
    queryFn: coreApi.listPushEndpoints,
  });
  const endpoints = endpointsData?.endpoints ?? [];

  const deleteMut = useMutation({
    mutationFn: (id: number) => coreApi.deletePushEndpoint(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['messenger', 'push-endpoints'] });
      void qc.invalidateQueries({ queryKey: ['auth', 'api-keys', 'schema'] });
    },
  });

  const copyText = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(key);
    setTimeout(() => setCopiedId(''), 1500);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          鉴权复用全局 API Key，支持 Bearer Token 或 <code className="yd-code">?key=</code> 参数。
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Link to="/settings?tab=api-keys" className="yd-btn-secondary">
            <KeyRound className="h-3.5 w-3.5" />
            API Keys
          </Link>
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="yd-btn-primary"
          >
            <Plus className="h-3.5 w-3.5" />
            新建终结点
          </button>
        </div>
      </div>

      {editing && (
        <PushEndpointForm
          userID={user?.id ?? 0}
          outboundChannels={outboundChannels}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ['messenger', 'push-endpoints'] });
            void qc.invalidateQueries({ queryKey: ['auth', 'api-keys', 'schema'] });
          }}
        />
      )}

      {isLoading ? (
        <LoadingState label="正在加载模块..." variant="section" />
      ) : endpoints.length === 0 ? (
        <div className="yd-empty p-10 text-xs">
          暂无推送终结点。创建后可配合 <code className="yd-code">messenger:push</code> 权限密钥调用。
        </div>
      ) : (
        <div className="space-y-3">
          {endpoints.map((ep) => {
            const curlSnippet = `curl -X POST "${ep.push_url}" -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" -d '{"title":"通知","content":"Hello from YukiDeck"}'`;
            const queryTemplate = `${ep.push_url}?key=YOUR_API_KEY&title=通知&content=Hello`;
            return (
              <div key={ep.id} className="yd-card p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-medium text-zinc-800 mr-0.5">{ep.name}</span>
                    <code className="yd-code">{ep.slug}</code>
                    <span className="yd-badge yd-badge-neutral">
                      {ep.target_mode === 'default'
                        ? '默认出站'
                        : `${ep.target_channel_ids.length} 个指定渠道`}
                    </span>
                    {!ep.enabled && <span className="yd-badge yd-badge-amber">已停用</span>}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setEditing(ep)}
                      className="yd-btn-secondary"
                    >
                      编辑
                    </button>
                    <Tooltip content="删除">
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`确定删除推送终结点「${ep.name}」吗？`)) {
                            deleteMut.mutate(ep.id);
                          }
                        }}
                        className="yd-btn-danger-icon"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#f7f9fc] border border-zinc-200/65 px-3 py-2">
                  <span className="font-mono text-xs text-zinc-600 break-all select-all">
                    {ep.push_url}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void copyText(`url-${ep.id}`, ep.push_url)}
                      className="yd-btn-ghost py-1 px-2 text-[11px]"
                    >
                      {copiedId === `url-${ep.id}` ? (
                        <Check className="h-3 w-3 text-emerald-500" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      路径
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyText(`query-${ep.id}`, queryTemplate)}
                      className="yd-btn-ghost py-1 px-2 text-[11px]"
                    >
                      {copiedId === `query-${ep.id}` ? (
                        <Check className="h-3 w-3 text-emerald-500" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      ?key
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyText(`curl-${ep.id}`, curlSnippet)}
                      className="yd-btn-ghost py-1 px-2 text-[11px]"
                    >
                      {copiedId === `curl-${ep.id}` ? (
                        <Check className="h-3 w-3 text-emerald-500" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      curl
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PushEndpointForm({
  userID,
  outboundChannels,
  initial,
  onClose,
  onSaved,
}: {
  userID: number;
  outboundChannels: Channel[];
  initial: PushEndpoint | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [targetMode, setTargetMode] = useState<'default' | 'selected'>(initial?.target_mode ?? 'default');
  const [selectedIDs, setSelectedIDs] = useState<number[]>(initial?.target_channel_ids ?? []);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState('');

  const saveMut = useMutation({
    mutationFn: (payload: UpsertPushEndpointPayload) =>
      initial ? coreApi.updatePushEndpoint(initial.id, payload) : coreApi.createPushEndpoint(payload),
    onSuccess: onSaved,
    onError: (err: Error) => setError(err.message),
  });

  const toggleID = (id: number) => {
    setSelectedIDs((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    saveMut.mutate({
      name,
      slug: slug.trim().toLowerCase(),
      target_mode: targetMode,
      target_channel_ids: targetMode === 'selected' ? selectedIDs : [],
      enabled,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="yd-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-800">
          {initial ? '编辑推送终结点' : '新建推送终结点'}
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
            placeholder="例如：服务器告警 / NAS 备份"
            className="yd-input"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="yd-label">路径标识 (slug)</span>
          <input
            required
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            pattern="^[a-z0-9][a-z0-9_-]{0,63}$"
            placeholder="例如：default、alert、nas"
            className="yd-input font-mono"
          />
          <span className="block text-[11px] text-zinc-400 font-mono">
            /api/v1/messenger/push/{userID || '{uid}'}/{slug || '{slug}'}
          </span>
        </label>
      </div>

      <div className="space-y-2">
        <span className="yd-label">转发目标</span>
        <div className="flex flex-wrap gap-4 text-xs text-zinc-700">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              checked={targetMode === 'default'}
              onChange={() => setTargetMode('default')}
            />
            默认出站渠道
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              checked={targetMode === 'selected'}
              onChange={() => setTargetMode('selected')}
            />
            指定渠道（可多选）
          </label>
        </div>

        {targetMode === 'selected' && (
          <div className="yd-panel-subtle p-3 space-y-2">
            {outboundChannels.length === 0 ? (
              <div className="text-xs text-zinc-400">暂无可用发送渠道，请先添加。</div>
            ) : (
              outboundChannels.map((ch) => (
                <label key={ch.id} className="flex items-center gap-2 text-xs text-zinc-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedIDs.includes(ch.id)}
                    onChange={() => toggleID(ch.id)}
                  />
                  <span>{ch.name}</span>
                  <span className="text-zinc-400">({ch.type})</span>
                </label>
              ))
            )}
          </div>
        )}
      </div>

      <label className="inline-flex items-center gap-2 text-xs text-zinc-700 cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用
      </label>

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className="yd-btn-secondary">
          取消
        </button>
        <button type="submit" disabled={saveMut.isPending} className="yd-btn-primary">
          {saveMut.isPending ? '保存中...' : '保存'}
        </button>
      </div>
    </form>
  );
}
