import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  History,
  Loader2,
  PlugZap,
} from 'lucide-react';
import { LoadingState } from '@/components/LoadingState';
import { useToast } from '@/components/Toast';
import { formatDateTimeInTimezone, useUserTimezone } from '@/core/timezone';
import { screenTimeApi, type HistoryImportStatus } from './api';
import { formatBytes } from './format';

const DEFAULT_BASE_URL = 'https://wakatime.com/api/v1';
const WAKATIME_KEY_URL = 'https://wakatime.com/oauth';

function stageLabel(st: HistoryImportStatus): string {
  switch (st.stage) {
    case 'requesting':
      return '申请导出';
    case 'exporting':
      return '云端生成中';
    case 'downloading':
      return '下载解析中';
    case 'finalizing':
      return '收尾整理';
    case 'completed':
      return '已完成';
    case 'failed':
      return '导入失败';
    default:
      return '空闲';
  }
}

export default function ScreenTimeSettingsPanel() {
  const qc = useQueryClient();
  const userTimezone = useUserTimezone();
  const { showToast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['screen-time', 'config'],
    queryFn: () => screenTimeApi.getConfig(),
  });
  const cfg = data?.config;

  const { data: importStatus } = useQuery({
    queryKey: ['screen-time', 'history-import'],
    queryFn: () => screenTimeApi.getHistoryImportStatus(),
    enabled: Boolean(cfg?.configured),
    refetchInterval: (query) => (query.state.data?.running ? 1500 : false),
  });

  const [apiBaseURL, setApiBaseURL] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState('');
  const [showCompletedBanner, setShowCompletedBanner] = useState(false);
  const [dismissedFailedAt, setDismissedFailedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!cfg) return;
    setApiBaseURL(cfg.api_base_url || DEFAULT_BASE_URL);
    setApiKey('');
  }, [cfg]);

  // Notify once when a running history import finishes, then auto-hide the 100% progress bar
  const prevRunningRef = useRef<boolean>(false);
  useEffect(() => {
    const running = Boolean(importStatus?.running);
    if (prevRunningRef.current && !running && importStatus) {
      if (importStatus.stage === 'completed') {
        void qc.invalidateQueries({ queryKey: ['screen-time'] });
        showToast(importStatus.message || '历史数据同步完成');
        setShowCompletedBanner(true);
      } else if (importStatus.stage === 'failed') {
        setDismissedFailedAt(null);
        showToast(`历史数据同步失败：${importStatus.error || '请稍后重试'}`, 'error');
      }
    }
    prevRunningRef.current = running;
  }, [importStatus, qc, showToast]);

  useEffect(() => {
    if (!showCompletedBanner) return;
    const timer = window.setTimeout(() => setShowCompletedBanner(false), 4000);
    return () => window.clearTimeout(timer);
  }, [showCompletedBanner]);

  const saveMut = useMutation({
    mutationFn: (payload: { api_base_url: string; api_key?: string }) =>
      screenTimeApi.updateConfig(payload),
    onSuccess: (res) => {
      setApiKey('');
      qc.setQueryData(['screen-time', 'config'], res);
      void qc.invalidateQueries({ queryKey: ['screen-time'] });
      showToast('使用时间配置已保存');
    },
    onError: (err: Error) => showToast(`保存失败：${err.message}`, 'error'),
  });

  const testMut = useMutation({
    mutationFn: () =>
      screenTimeApi.testConfig({
        api_base_url: apiBaseURL.trim() || DEFAULT_BASE_URL,
        api_key: apiKey.trim() || undefined,
      }),
    onSuccess: (res) =>
      showToast(`连通性测试成功${res.username ? `（${res.username}）` : ''}`),
    onError: (err: Error) => showToast(`连通性测试失败：${err.message}`, 'error'),
  });

  const startImportMut = useMutation({
    mutationFn: () => screenTimeApi.startHistoryImport(),
    onSuccess: (st) => {
      prevRunningRef.current = st.running;
      setDismissedFailedAt(null);
      qc.setQueryData(['screen-time', 'history-import'], st);
      if (st.stage === 'completed') {
        void qc.invalidateQueries({ queryKey: ['screen-time'] });
        showToast(st.message || '历史数据同步完成');
        setShowCompletedBanner(true);
      } else {
        setShowCompletedBanner(false);
      }
    },
    onError: (err: Error) => showToast(`启动历史同步失败：${err.message}`, 'error'),
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    saveMut.mutate({
      api_base_url: apiBaseURL.trim() || DEFAULT_BASE_URL,
      api_key: apiKey.trim() || undefined,
    });
  };

  if (isLoading) {
    return <LoadingState label="正在加载模块..." variant="section" />;
  }

  const canTest = Boolean(apiKey.trim() || cfg?.configured);
  const importing = Boolean(importStatus?.running || startImportMut.isPending);
  const failedKey = importStatus?.finished_at || importStatus?.error || 'failed';
  const showImportProgress = Boolean(
    cfg?.configured &&
      importStatus &&
      (importStatus.running ||
        (importStatus.stage === 'completed' && showCompletedBanner) ||
        (importStatus.stage === 'failed' && dismissedFailedAt !== failedKey)),
  );
  const clampedPercent = Math.max(0, Math.min(100, Math.round(importStatus?.percent ?? 0)));

  return (
    <form onSubmit={handleSubmit} className="yd-card p-4 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-800">WakaTime 数据源</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            无需修改本地编辑器配置，兼容官方 WakaTime 及自托管 Wakapi。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {cfg?.configured && (
            <button
              type="button"
              disabled={importing}
              onClick={() => startImportMut.mutate()}
              title={
                cfg.history_imported_at
                  ? '检测并仅补齐本地缺失的历史日期空白'
                  : '首次导入账号创立至今的全量历史心跳'
              }
              className="yd-btn-secondary"
            >
              {importing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <History className="h-3.5 w-3.5" />
              )}
              {importing ? '同步历史中...' : '同步历史数据'}
            </button>
          )}
          {canTest && (
            <button
              type="button"
              disabled={testMut.isPending}
              onClick={() => testMut.mutate()}
              className="yd-btn-secondary"
            >
              <PlugZap className="h-3.5 w-3.5" />
              {testMut.isPending ? '测试中...' : '测试连通性'}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block space-y-1.5">
          <span className="yd-label">API Base URL</span>
          <input
            type="url"
            value={apiBaseURL}
            onChange={(e) => setApiBaseURL(e.target.value)}
            placeholder={DEFAULT_BASE_URL}
            className="yd-input font-mono"
          />
        </label>

        <label className="block space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="yd-label">
              WakaTime API Key{cfg?.configured ? `（已保存 ${cfg.api_key_hint}）` : ''}
            </span>
            <a
              href={WAKATIME_KEY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-sky-600 hover:text-sky-700 hover:underline shrink-0"
            >
              获取 API Key
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <input
            type="password"
            autoComplete="off"
            required={!cfg?.configured}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={cfg?.configured ? '留空保持不变' : '粘贴从 WakaTime OAuth 获取的密钥'}
            className="yd-input font-mono"
          />
        </label>
      </div>

      {cfg?.configured && (
        <div className="yd-panel-subtle p-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-zinc-500">
            <span>
              同步状态：
              {cfg.last_sync_status === 'ok' ? (
                <span className="text-emerald-600 font-medium">正常</span>
              ) : cfg.last_sync_status === 'auth_error' ? (
                <span className="text-red-600 font-medium">鉴权失败</span>
              ) : cfg.last_sync_status === 'error' ? (
                <span className="text-amber-600 font-medium">上次拉取异常</span>
              ) : (
                <span className="text-zinc-700">待同步</span>
              )}
            </span>
            {cfg.wakatime_username && (
              <span>
                账号：<span className="font-mono text-zinc-700">{cfg.wakatime_username}</span>
              </span>
            )}
            {cfg.last_synced_at && (
              <span className="tabular-nums">
                最近同步：{formatDateTimeInTimezone(cfg.last_synced_at, userTimezone)}
              </span>
            )}
            <span className="tabular-nums">
              历史归档：
              {cfg.history_imported_at ? (
                <span className="text-zinc-700">
                  已导入（{formatDateTimeInTimezone(cfg.history_imported_at, userTimezone)}）
                </span>
              ) : (
                <span className="text-zinc-500">未执行全量导入</span>
              )}
            </span>
            <span className="tabular-nums">
              超时参数：<span className="font-mono text-zinc-700">{cfg.timeout_minutes}m</span>
            </span>
          </div>

          {cfg.last_sync_error && (
            <div className="flex items-start gap-1.5 text-xs text-red-600">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span className="break-all">{cfg.last_sync_error}</span>
            </div>
          )}

          {showImportProgress && importStatus && (
            <div className="pt-2.5 border-t border-zinc-200/70 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-1.5 text-zinc-700 font-medium">
                  {importStatus.running ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600 shrink-0" />
                  ) : importStatus.stage === 'completed' ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5 text-red-600 shrink-0" />
                  )}
                  <span>
                    {importStatus.mode === 'gap' ? '空白缺口补齐' : '全量历史同步'} ·{' '}
                    {stageLabel(importStatus)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-zinc-600 tabular-nums">{clampedPercent}%</span>
                  {importStatus.stage === 'failed' && (
                    <button
                      type="button"
                      onClick={() => setDismissedFailedAt(failedKey)}
                      className="text-[11px] text-zinc-400 hover:text-zinc-600"
                    >
                      关闭
                    </button>
                  )}
                </div>
              </div>

              <div className="h-1.5 w-full rounded-full bg-zinc-200/80 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    importStatus.stage === 'failed'
                      ? 'bg-red-500'
                      : importStatus.stage === 'completed'
                        ? 'bg-emerald-500'
                        : 'bg-sky-500'
                  }`}
                  style={{ width: `${Math.max(importStatus.running ? 4 : 0, clampedPercent)}%` }}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-zinc-500 tabular-nums">
                <span className={importStatus.stage === 'failed' ? 'text-red-600 break-all' : ''}>
                  {importStatus.stage === 'failed'
                    ? importStatus.error || importStatus.message
                    : importStatus.message}
                </span>
                {(importStatus.days_processed > 0 || importStatus.bytes_downloaded > 0) && (
                  <span className="font-mono text-zinc-400 shrink-0">
                    {importStatus.bytes_downloaded > 0
                      ? `${formatBytes(importStatus.bytes_downloaded)}${
                          importStatus.total_bytes > 0
                            ? ` / ${formatBytes(importStatus.total_bytes)}`
                            : ''
                        } · `
                      : ''}
                    处理 {importStatus.days_processed} 天（写入 {importStatus.days_imported} / 跳过{' '}
                    {importStatus.days_skipped}）· {importStatus.heartbeats_imported} 条心跳
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end pt-1">
        <button type="submit" disabled={saveMut.isPending} className="yd-btn-primary">
          {saveMut.isPending ? '保存中...' : '保存配置'}
        </button>
      </div>
    </form>
  );
}
