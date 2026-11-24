import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, PlugZap } from 'lucide-react';
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
  const [message, setMessage] = useState('');
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
      setMessage('图床存储配置已保存');
      void qc.invalidateQueries({ queryKey: ['storage'] });
    },
    onError: (err: Error) => setMessage(`保存失败：${err.message}`),
  });

  const testMut = useMutation({
    mutationFn: storageApi.testConfig,
    onSuccess: () => setMessage('存储桶连通性测试成功'),
    onError: (err: Error) => setMessage(`连通性测试失败：${err.message}`),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setMessage('');
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
    return <div className="text-sm text-slate-500">加载配置中...</div>;
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">图床对象存储（S3 / Cloudflare R2）</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            填写你自己的公开存储桶凭证；直链直接指向公开访问域名，浏览流量完全不经过 YukiDeck。
          </p>
        </div>
        {cfg?.configured && (
          <button
            type="button"
            disabled={testMut.isPending}
            onClick={() => testMut.mutate()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <PlugZap className="h-3.5 w-3.5" />
            {testMut.isPending ? '测试中...' : '测试连通性'}
          </button>
        )}
      </div>

      {message && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs text-slate-700">
          {message}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-700">S3 Endpoint</span>
          <input
            required
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://<account_id>.r2.cloudflarestorage.com"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-700">Bucket 名称</span>
          <input
            required
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            placeholder="my-images"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-700">公开访问基础 URL（直链前缀）</span>
          <input
            required
            value={publicBaseURL}
            onChange={(e) => setPublicBaseURL(e.target.value)}
            placeholder="https://img.example.com"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-700">Region</span>
          <input
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder="auto"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-700">Access Key ID</span>
          <input
            required
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-700">
            Secret Access Key {cfg?.has_secret_key ? `（已保存 ${cfg.secret_key_masked}，留空不变）` : ''}
          </span>
          <input
            type="password"
            required={!cfg?.has_secret_key}
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            placeholder={cfg?.has_secret_key ? '留空保持原有密钥' : '粘贴 Secret Access Key'}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono"
          />
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-slate-700">SHA-256 文件名长度 (8~64)</span>
          <input
            type="number"
            min={8}
            max={64}
            value={hashLength}
            onChange={(e) => setHashLength(Number(e.target.value))}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>

        <label className="inline-flex items-center gap-2 text-xs text-slate-700 pt-5">
          <input
            type="checkbox"
            checked={forcePathStyle}
            onChange={(e) => setForcePathStyle(e.target.checked)}
          />
          使用 Path-Style 地址（MinIO 等自建 S3 通常需开启，R2 默认关闭）
        </label>
      </div>

      {/* Upload Mode Selector */}
      <div className="space-y-2.5 pt-2 border-t border-slate-100">
        <div className="text-xs font-medium text-slate-700">Web 上传模式</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label
            className={`cursor-pointer rounded-xl border p-3.5 transition-colors ${
              uploadMode === 'direct' ? 'border-slate-900 bg-slate-50' : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <div className="flex items-center gap-2">
              <input
                type="radio"
                name="upload_mode"
                checked={uploadMode === 'direct'}
                onChange={() => setUploadMode('direct')}
              />
              <span className="text-sm font-medium text-slate-900">浏览器直传（推荐）</span>
            </div>
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
              浏览器内无损去 EXIF 后通过预签名 URL 直传对象存储，<strong>零服务器带宽占用，不限制单文件大小</strong>（需在存储桶配置一条 CORS 规则）。
            </p>
          </label>

          <label
            className={`cursor-pointer rounded-xl border p-3.5 transition-colors ${
              uploadMode === 'proxy' ? 'border-slate-900 bg-slate-50' : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <div className="flex items-center gap-2">
              <input
                type="radio"
                name="upload_mode"
                checked={uploadMode === 'proxy'}
                onChange={() => setUploadMode('proxy')}
              />
              <span className="text-sm font-medium text-slate-900">后端中转上传</span>
            </div>
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
              无需给存储桶配 CORS；因文件流经过服务器，受服务端安全上限保护（当前上限：<strong>{cfg?.proxy_max_mb ?? 20} MB</strong>）。
            </p>
          </label>
        </div>

        {uploadMode === 'direct' && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>R2 / S3 存储桶 CORS 配置参考（允许当前站点直传）</span>
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(CORS_SNIPPET);
                  setCopiedCors(true);
                  setTimeout(() => setCopiedCors(false), 1500);
                }}
                className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-[11px] hover:bg-slate-50"
              >
                {copiedCors ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                复制 CORS JSON
              </button>
            </div>
            <pre className="text-[11px] font-mono text-slate-600 overflow-x-auto">{CORS_SNIPPET}</pre>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saveMut.isPending}
          className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
        >
          {saveMut.isPending ? '保存中...' : '保存配置'}
        </button>
      </div>
    </form>
  );
}
