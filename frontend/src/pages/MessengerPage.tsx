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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">消息与推送</h1>
        <p className="text-sm text-slate-500 mt-1">
          平台级消息基础设施：配置对称能力的出站/入站消息渠道，并定义路径分流的自定义推送终结点。
        </p>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        <button
          type="button"
          onClick={() => setTab('channels')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'channels'
              ? 'border-slate-900 text-slate-900'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          消息渠道
        </button>
        <button
          type="button"
          onClick={() => setTab('push-endpoints')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'push-endpoints'
              ? 'border-slate-900 text-slate-900'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          自定义推送终结点
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
    onSuccess: () => setFeedback('测试消息已发送，请检查对应客户端。'),
    onError: (err: Error) => setFeedback(`测试失败：${err.message}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(
            [
              ['all', '全部渠道'],
              ['outbound', '具备发送能力 (outbound)'],
              ['inbound', '具备接收能力 (inbound)'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setCapFilter(key)}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                capFilter === key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'
              }`}
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
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800"
        >
          <Plus className="h-3.5 w-3.5" />
          新增渠道
        </button>
      </div>

      {feedback && (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-700">
          {feedback}
        </div>
      )}

      {editing && drivers.length > 0 && (
        <ChannelForm
          drivers={drivers}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(ch) => {
            setEditing(null);
            setFeedback(ch.webhook_warning ? `已保存（提示：${ch.webhook_warning}）` : '渠道已保存');
            void qc.invalidateQueries({ queryKey: ['messenger', 'channels'] });
          }}
        />
      )}

      {isLoading ? (
        <div className="text-sm text-slate-500">加载中...</div>
      ) : channels.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          当前筛选条件下暂无消息渠道。点击右上角「新增渠道」接入你自己的 Telegram Bot。
        </div>
      ) : (
        <div className="space-y-3">
          {channels.map((ch) => (
            <div
              key={ch.id}
              className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div className="space-y-1.5 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">{ch.name}</span>
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                    {ch.type}
                  </span>
                  {ch.enable_outbound && (
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                      <ArrowUpRight className="h-3 w-3" />
                      发送
                    </span>
                  )}
                  {ch.enable_inbound && (
                    <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                      <ArrowDownLeft className="h-3 w-3" />
                      接收
                    </span>
                  )}
                  {ch.is_default_outbound && (
                    <span className="rounded bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-white">
                      默认出站
                    </span>
                  )}
                  {!ch.enabled && (
                    <span className="rounded bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                      已停用
                    </span>
                  )}
                </div>
                {ch.webhook_url && ch.enable_inbound && (
                  <div className="text-xs text-slate-400 truncate">Webhook: {ch.webhook_url}</div>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {ch.enable_outbound && (
                  <button
                    type="button"
                    disabled={testMut.isPending}
                    onClick={() => testMut.mutate(ch.id)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Send className="h-3.5 w-3.5" />
                    测试
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setEditing(ch)}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`确定删除渠道「${ch.name}」吗？`)) {
                      deleteMut.mutate(ch.id);
                    }
                  }}
                  className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:text-red-600 hover:border-red-200"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
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
    <form onSubmit={handleSubmit} className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">{initial ? '编辑消息渠道' : '新增消息渠道'}</h3>
        <button type="button" onClick={onClose} className="text-xs text-slate-500 hover:text-slate-900">
          取消
        </button>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-700">渠道类型</span>
          <select
            value={type}
            disabled={Boolean(initial)}
            onChange={(e) => setType(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white disabled:bg-slate-50"
          >
            {drivers.map((d) => (
              <option key={d.type} value={d.type}>
                {d.display_name} ({d.capabilities.join(' / ')})
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-700">渠道名称</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：我的 Telegram Bot"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {driver.fields.map((f) => (
          <label key={f.key} className="block space-y-1">
            <span className="text-xs font-medium text-slate-700">
              {f.label} {f.secret && initial ? '（留空保持不变）' : ''}
            </span>
            <input
              type={f.secret ? 'password' : 'text'}
              required={f.required && !(f.secret && initial)}
              value={fields[f.key] ?? ''}
              onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-5 pt-1 text-xs text-slate-700">
        {supportsOut && (
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={enableOutbound}
              onChange={(e) => setEnableOutbound(e.target.checked)}
            />
            启用发送能力 (outbound)
          </label>
        )}
        {supportsIn && (
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={enableInbound}
              onChange={(e) => setEnableInbound(e.target.checked)}
            />
            启用接收能力 (inbound 双向交互)
          </label>
        )}
        {supportsOut && enableOutbound && (
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={isDefaultOutbound}
              onChange={(e) => setIsDefaultOutbound(e.target.checked)}
            />
            设为默认出站渠道
          </label>
        )}
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用该渠道
        </label>
      </div>

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
          disabled={saveMut.isPending}
          className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
        >
          {saveMut.isPending ? '保存中...' : '保存渠道'}
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
        <p className="text-xs text-slate-500">
          每个自定义终结点定义一条转发路由规则，鉴权统一复用全局 API Key（支持 Header Bearer 与{' '}
          <code className="font-mono text-slate-700">?key=ydk_...</code> 查询参数）。
        </p>
        <div className="flex items-center gap-2">
          <Link
            to="/settings?tab=api-keys"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <KeyRound className="h-3.5 w-3.5" />
            管理 API Key
          </Link>
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800"
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
        <div className="text-sm text-slate-500">加载中...</div>
      ) : endpoints.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          尚未创建自定义推送终结点。创建后可配合具备 <code className="font-mono">messenger:push</code> 权限的 API Key 调用。
        </div>
      ) : (
        <div className="space-y-3">
          {endpoints.map((ep) => {
            const curlSnippet = `curl -X POST "${ep.push_url}" -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" -d '{"title":"通知","content":"Hello from YukiDeck"}'`;
            const queryTemplate = `${ep.push_url}?key=YOUR_API_KEY&title=通知&content=Hello`;
            return (
              <div key={ep.id} className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900">{ep.name}</span>
                    <code className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-700">
                      {ep.slug}
                    </code>
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                      {ep.target_mode === 'default'
                        ? '路由：默认出站渠道'
                        : `路由：${ep.target_channel_ids.length} 个指定出站渠道`}
                    </span>
                    {!ep.enabled && (
                      <span className="rounded bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                        已停用
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void copyText(`url-${ep.id}`, ep.push_url)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      {copiedId === `url-${ep.id}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      复制路径
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyText(`query-${ep.id}`, queryTemplate)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      {copiedId === `query-${ep.id}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      复制 ?key 模板
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyText(`curl-${ep.id}`, curlSnippet)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      {copiedId === `curl-${ep.id}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      复制 curl
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(ep)}
                      className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`确定删除推送终结点「${ep.name}」吗？`)) {
                          deleteMut.mutate(ep.id);
                        }
                      }}
                      className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600 break-all">
                  {ep.push_url}
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
    <form onSubmit={handleSubmit} className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">
          {initial ? '编辑自定义推送终结点' : '新建自定义推送终结点'}
        </h3>
        <button type="button" onClick={onClose} className="text-xs text-slate-500">
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
            placeholder="例如：服务器监控告警 / NAS 备份通知"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-700">终结点标识 (slug)</span>
          <input
            required
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            pattern="^[a-z0-9][a-z0-9_-]{0,63}$"
            placeholder="例如：default、alert、nas"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono"
          />
          <span className="text-[11px] text-slate-400 font-mono">
            /api/v1/messenger/push/{userID || '{uid}'}/{slug || '{slug}'}
          </span>
        </label>
      </div>

      <div className="space-y-2">
        <span className="text-xs font-medium text-slate-700">出站转发目标（仅展示具备发送能力的渠道）</span>
        <div className="flex gap-4 text-xs">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              checked={targetMode === 'default'}
              onChange={() => setTargetMode('default')}
            />
            转发至默认出站渠道
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              checked={targetMode === 'selected'}
              onChange={() => setTargetMode('selected')}
            />
            指定出站渠道（支持多选扇出）
          </label>
        </div>

        {targetMode === 'selected' && (
          <div className="rounded-lg border border-slate-200 p-3 space-y-2">
            {outboundChannels.length === 0 ? (
              <div className="text-xs text-slate-500">暂无具备发送能力 (outbound) 的渠道，请先添加。</div>
            ) : (
              outboundChannels.map((ch) => (
                <label key={ch.id} className="flex items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={selectedIDs.includes(ch.id)}
                    onChange={() => toggleID(ch.id)}
                  />
                  <span>{ch.name}</span>
                  <span className="text-slate-400">({ch.type})</span>
                </label>
              ))
            )}
          </div>
        )}
      </div>

      <label className="inline-flex items-center gap-2 text-xs text-slate-700">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        启用该推送终结点
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
          disabled={saveMut.isPending}
          className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
        >
          {saveMut.isPending ? '保存中...' : '保存'}
        </button>
      </div>
    </form>
  );
}
