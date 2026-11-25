import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAppMeta, useEnabledModules } from '@/core/module';
import { APIKeysPanel } from './APIKeysPanel';

export function SettingsPage() {
  const { data: meta } = useAppMeta();
  const modules = useEnabledModules();
  const modulePanels = modules.filter((m) => Boolean(m.settingsPanel));
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') || 'general';
  const [activeTab, setActiveTab] = useState<string>(initialTab);

  useEffect(() => {
    const param = searchParams.get('tab');
    if (param && param !== activeTab) {
      setActiveTab(param);
    }
  }, [searchParams, activeTab]);

  const selectTab = (tab: string) => {
    setActiveTab(tab);
    if (tab === 'general') setSearchParams({});
    else setSearchParams({ tab });
  };

  const activeModule = modulePanels.find((m) => m.id === activeTab);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">系统设置</h1>
        <p className="text-sm text-slate-500 mt-1">
          管理平台概览、全局 API Key 权限策略以及各已启用模块的配置面板。
        </p>
      </div>

      <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
        <button
          type="button"
          onClick={() => selectTab('general')}
          className={`px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap ${
            activeTab === 'general'
              ? 'border-slate-900 text-slate-900'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          平台概览
        </button>
        <button
          type="button"
          onClick={() => selectTab('api-keys')}
          className={`px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap ${
            activeTab === 'api-keys'
              ? 'border-slate-900 text-slate-900'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          API Keys
        </button>
        {modulePanels.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => selectTab(m.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap ${
              activeTab === m.id
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {m.settingsPanel!.label}
          </button>
        ))}
      </div>

      {activeTab === 'general' ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-4 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-slate-500">应用版本</div>
              <div className="font-medium text-slate-900 mt-0.5">
                {meta?.app ?? 'YukiDeck'} v{meta?.version ?? '0.1.0'}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">前端托管模式</div>
              <div className="font-medium text-slate-900 mt-0.5">
                {meta?.ui_enabled ? 'Go 内嵌单二进制模式' : '前后端分离部署模式'}
              </div>
            </div>
          </div>
          <div className="pt-2 border-t border-slate-100 text-xs text-slate-500">
            每个新业务模块只需在 <code className="font-mono text-slate-700">FrontendModule.settingsPanel</code>{' '}
            声明配置组件，即可自动出现在本页面标签栏中。
          </div>
        </div>
      ) : activeTab === 'api-keys' ? (
        <APIKeysPanel />
      ) : activeModule?.settingsPanel ? (
        <Suspense fallback={<div className="text-sm text-slate-500">加载模块配置...</div>}>
          <activeModule.settingsPanel.component />
        </Suspense>
      ) : null}
    </div>
  );
}
