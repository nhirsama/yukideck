import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, PlugZap } from 'lucide-react';
import { LoadingState } from '@/components/LoadingState';
import { useToast } from '@/components/Toast';
import { storageApi, type SaveStorageConfigPayload, type UploadMode } from './api';

const CORS_SNIPPET = JSON.stringify(
  [
    {
      AllowedOrigins: [typeof window !== 'undefined' ? window.location.origin : 'https://deck.example.com'],
      AllowedMethods: ['PUT', 'GET', 'HEAD'],
      AllowedHeaders: ['Content-Type', 'x-amz-meta-*'],
      MaxAgeSeconds: 3600,
    },
  ],
  null,
  2,
);

export default function StorageSettingsPanel() {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ['storage', 'config'],
    queryFn: storageApi.getConfig,
  });
  const cfg = data?.config;

  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('auto');
  const [bucket, setBucket] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [publicBaseURL, setPublicBaseURL] = useState('');
  const [hashLength, setHashLength] = useState(16);
  const [forcePathStyle, setForcePathStyle] = useState(false);
  const [uploadMode, setUploadMode] = useState<UploadMode>('direct');
  const [copiedCors, setCopiedCors] = useState(false);

  useEffect(() => {
    if (!cfg) return;
    setEndpoint(cfg.endpoint || '');
    setRegion(cfg.region || 'auto');
    setBucket(cfg.bucket || '');
    setAccessKey(cfg.access_key || '');
    setSecretKey('');
    setPublicBaseURL(cfg.public_base_url || '');
    setHashLength(cfg.hash_length || 16);
    setForcePathStyle(cfg.force_path_style);
    setUploadMode(cfg.upload_mode || 'direct');
  }, [cfg]);

  const saveMut = useMutation({
    mutationFn: (payload: SaveStorageConfigPayload) => storageApi.saveConfig(payload),
    onSuccess: () => {
      setSecretKey('');
      showToast('图床存储配置已保存');
      void qc.invalidateQueries({ queryKey: ['storage'] });
    },
    onError: (err: Error) => showToast(`保存失败：${err.message}`, 'error'),
  });

  const testMut = useMutation({
    mutationFn: storageApi.testConfig,
    onSuccess: () => showToast('存储桶连通性测试成功'),
    onError: (err: Error) => showToast(`连通性测试失败：${err.message}`, 'error'),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    saveMut.mutate({
      endpoint,
      region,
      bucket,
      access_key: accessKey,
      secret_key: secretKey,
      public_base_url: publicBaseURL,
      hash_length: hashLength,
      force_path_style: forcePathStyle,
      upload_mode: uploadMode,
    });
  };

  if (isLoading) {
    return <LoadingState label="正在加载模块..." variant="section" />;
  }

  return (
    <form onSubmit={handleSubmit} className="yd-card p-4 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-800">对象存储（S3 / Cloudflare R2）</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            使用自有公开存储桶，直链访问不经过服务器。
          </p>
        </div>
        {cfg?.configured && (
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block space-y-1.5">
          <span className="yd-label">S3 Endpoint</span>
          <input
            required
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://<account_id>.r2.cloudflarestorage.com"
            className="yd-input"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="yd-label">Bucket 名称</span>
          <input
            required
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            placeholder="my-images"
            className="yd-input"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="yd-label">公开访问基础 URL（直链前缀）</span>
          <input
            required
            value={publicBaseURL}
            onChange={(e) => setPublicBaseURL(e.target.value)}
            placeholder="https://img.example.com"
            className="yd-input"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="yd-label">Region</span>
          <input
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="auto"
            className="yd-input"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="yd-label">Access Key ID</span>
          <input
            required
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            className="yd-input font-mono"
          />
        </label>

        <label className="block space-y-1.5">
          <span className="yd-label">
            Secret Access Key{cfg?.has_secret_key ? `（已保存 ${cfg.secret_key_masked}）` : ''}
          </span>
          <input
            type="password"
            required={!cfg?.has_secret_key}
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            placeholder={cfg?.has_secret_key ? '留空保持不变' : '粘贴 Secret Access Key'}
            className="yd-input font-mono"
          />
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
        <label className="block space-y-1.5">
          <span className="yd-label">SHA-256 文件名长度 (8~64)</span>
          <input
            type="number"
            min={8}
            max={64}
            value={hashLength}
            onChange={(e) => setHashLength(Number(e.target.value))}
            className="yd-input"
          />
        </label>

        <label className="inline-flex items-center gap-2 text-xs text-zinc-700 sm:pt-5 cursor-pointer">
          <input
            type="checkbox"
            checked={forcePathStyle}
            onChange={(e) => setForcePathStyle(e.target.checked)}
          />
          启用 Path-Style（MinIO 等自建 S3 需开启）
        </label>
      </div>

      {/* Upload Mode Selector */}
      <div className="space-y-3 pt-4 border-t border-zinc-100">
        <div className="yd-label">上传模式</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label
            className={`cursor-pointer rounded-xl border p-3.5 transition-all ${
              uploadMode === 'direct'
                ? 'border-sky-300 bg-sky-50/40 ring-1 ring-sky-200/70'
                : 'border-zinc-200/80 hover:border-zinc-300'
            }`}
          >
            <div className="flex items-center gap-2">
              <input
                type="radio"
                name="upload_mode"
                checked={uploadMode === 'direct'}
                onChange={() => setUploadMode('direct')}
              />
              <span className="text-[13px] font-medium text-zinc-800">浏览器直传（推荐）</span>
            </div>
            <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed">
              去除 EXIF 后直传对象存储，不占服务器带宽且不限大小，需配置存储桶 CORS。
            </p>
          </label>

          <label
            className={`cursor-pointer rounded-xl border p-3.5 transition-all ${
              uploadMode === 'proxy'
                ? 'border-sky-300 bg-sky-50/40 ring-1 ring-sky-200/70'
                : 'border-zinc-200/80 hover:border-zinc-300'
            }`}
          >
            <div className="flex items-center gap-2">
              <input
                type="radio"
                name="upload_mode"
                checked={uploadMode === 'proxy'}
                onChange={() => setUploadMode('proxy')}
              />
              <span className="text-[13px] font-medium text-zinc-800">后端中转</span>
            </div>
            <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed">
              无需配置 CORS，经服务器转发，单文件上限{' '}
              <strong className="font-medium text-zinc-700">{cfg?.proxy_max_mb ?? 20} MB</strong>。
            </p>
          </label>
        </div>

        {uploadMode === 'direct' && (
          <div className="yd-panel-subtle p-3.5 space-y-2">
            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span>CORS 配置参考</span>
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(CORS_SNIPPET);
                  setCopiedCors(true);
                  setTimeout(() => setCopiedCors(false), 1500);
                }}
                className="yd-btn-secondary py-1 text-[11px]"
              >
                {copiedCors ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                复制 CORS JSON
              </button>
            </div>
            <pre className="text-[11px] font-mono text-zinc-600 overflow-x-auto leading-relaxed">
              {CORS_SNIPPET}
            </pre>
          </div>
        )}
      </div>

      <div className="flex justify-end pt-1">
        <button type="submit" disabled={saveMut.isPending} className="yd-btn-primary">
          {saveMut.isPending ? '保存中...' : '保存配置'}
        </button>
      </div>
    </form>
  );
}
