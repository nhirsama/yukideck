import { Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useAppMeta, useEnabledModules } from '@/core/module';
import { LoadingState } from '@/components/LoadingState';
import { APIKeysPanel } from './APIKeysPanel';
import { GeneralSettingsPanel } from './GeneralSettingsPanel';

const GITHUB_REPO = 'nhirsama/yukideck';
const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO}`;

interface RemoteReleaseInfo {
  tag: string;
  url: string;
}

function parseSemver(raw?: string): [number, number, number] | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^v/i, '').split(/[-+]/)[0];
  const parts = cleaned.split('.');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return [nums[0], nums[1], nums[2] ?? 0];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function formatVersion(raw?: string): string {
  const v = (raw || 'dev').trim();
  if (!v || v === 'dev') return 'dev';
  return /^v/i.test(v) ? v : `v${v}`;
}

async function fetchLatestGitHubVersion(): Promise<RemoteReleaseInfo | null> {
  const headers = { Accept: 'application/vnd.github+json' };
  const relRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers,
  });
  if (relRes.ok) {
    const data = (await relRes.json()) as { tag_name?: string; html_url?: string };
    if (data.tag_name) {
      return {
        tag: data.tag_name,
        url: data.html_url || `${GITHUB_REPO_URL}/releases/tag/${data.tag_name}`,
      };
    }
  }
  if (relRes.status !== 404) return null;

  const tagRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=1`, {
    headers,
  });
  if (!tagRes.ok) return null;
  const tags = (await tagRes.json()) as Array<{ name?: string }>;
  const latestTag = tags[0]?.name;
  if (!latestTag) return null;
  return {
    tag: latestTag,
    url: `${GITHUB_REPO_URL}/releases/tag/${latestTag}`,
  };
}

export function SettingsPage() {
  const { data: meta } = useAppMeta();
  const modules = useEnabledModules();
  const modulePanels = modules.filter((m) => Boolean(m.settingsPanel));
  const [searchParams, setSearchParams] = useSearchParams();

  const rawTab = searchParams.get('tab');
  const activeTab = !rawTab ? 'general' : rawTab;

  const selectTab = (tab: string) => {
    if (tab === 'general') setSearchParams({}, { replace: true });
    else setSearchParams({ tab }, { replace: true });
  };

  const activeModule = modulePanels.find((m) => m.id === activeTab);

  return (
    <div className="space-y-6">
      <h1 className="yd-page-title">系统设置</h1>

      <div className="yd-tabs">
        <button
          type="button"
          onClick={() => selectTab('general')}
          className={`yd-tab ${activeTab === 'general' ? 'yd-tab-active' : 'yd-tab-idle'}`}
        >
          通用
        </button>
        <button
          type="button"
          onClick={() => selectTab('api-keys')}
          className={`yd-tab ${activeTab === 'api-keys' ? 'yd-tab-active' : 'yd-tab-idle'}`}
        >
          API Keys
        </button>
        {modulePanels.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => selectTab(m.id)}
            className={`yd-tab ${activeTab === m.id ? 'yd-tab-active' : 'yd-tab-idle'}`}
          >
            {m.settingsPanel!.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => selectTab('about')}
          className={`yd-tab ${activeTab === 'about' ? 'yd-tab-active' : 'yd-tab-idle'}`}
        >
          关于
        </button>
      </div>

      {activeTab === 'general' ? (
        <GeneralSettingsPanel />
      ) : activeTab === 'about' ? (
        <AboutPanel
          appName={meta?.app ?? 'YukiDeck'}
          version={meta?.version ?? 'dev'}
          uiEnabled={Boolean(meta?.ui_enabled)}
          moduleCount={modules.length}
        />
      ) : activeTab === 'api-keys' ? (
        <APIKeysPanel />
      ) : activeModule?.settingsPanel ? (
        <Suspense fallback={<LoadingState label="正在加载模块..." variant="section" />}>
          <activeModule.settingsPanel.component />
        </Suspense>
      ) : (
        <GeneralSettingsPanel />
      )}
    </div>
  );
}

function AboutPanel({
  appName,
  version,
  uiEnabled,
  moduleCount,
}: {
  appName: string;
  version: string;
  uiEnabled: boolean;
  moduleCount: number;
}) {
  const { data: remote } = useQuery({
    queryKey: ['about', 'github-latest-release'],
    queryFn: fetchLatestGitHubVersion,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });

  const currentSemver = parseSemver(version);
  const latestSemver = parseSemver(remote?.tag);
  const hasUpdate = Boolean(
    remote &&
      ((currentSemver && latestSemver && compareSemver(latestSemver, currentSemver) > 0) ||
        (!currentSemver && remote.tag && formatVersion(version) !== formatVersion(remote.tag))),
  );
  const isUpToDate = Boolean(
    remote && currentSemver && latestSemver && compareSemver(latestSemver, currentSemver) <= 0,
  );

  return (
    <div className="yd-card p-4 sm:p-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <div className="space-y-1.5">
          <div className="text-xs text-zinc-400">应用版本</div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] font-medium text-zinc-800 hover:text-sky-600 transition-colors tabular-nums"
            >
              {appName} <span className="font-mono">{formatVersion(version)}</span>
            </a>
            {hasUpdate && remote ? (
              <a
                href={remote.url}
                target="_blank"
                rel="noopener noreferrer"
                className="yd-badge yd-badge-sky hover:bg-sky-100 transition-colors"
              >
                可更新 <span className="font-mono">{formatVersion(remote.tag)}</span>
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : isUpToDate ? (
              <span className="yd-badge yd-badge-emerald">已是最新</span>
            ) : null}
          </div>
        </div>

        <div>
          <div className="text-xs text-zinc-400">托管模式</div>
          <div className="text-[13px] font-medium text-zinc-800 mt-1.5">
            {uiEnabled ? '单二进制内嵌' : '前后端分离'}
          </div>
        </div>

        <div>
          <div className="text-xs text-zinc-400">已启用模块</div>
          <div className="text-[13px] font-medium text-zinc-800 mt-1.5 tabular-nums">
            {moduleCount} 个
          </div>
        </div>
      </div>
    </div>
  );
}
