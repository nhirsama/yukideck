import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Bell, Link2, Puzzle } from 'lucide-react';
import { coreApi } from '@/core/api';
import { useAppMeta, useEnabledModules } from '@/core/module';

export function DashboardPage() {
  const { data: meta } = useAppMeta();
  const modules = useEnabledModules();

  const { data: channelsData } = useQuery({
    queryKey: ['messenger', 'channels', 'all'],
    queryFn: () => coreApi.listChannels(),
  });
  const { data: endpointsData } = useQuery({
    queryKey: ['messenger', 'push-endpoints'],
    queryFn: () => coreApi.listPushEndpoints(),
  });

  const channels = channelsData?.channels ?? [];
  const outboundCount = channels.filter((c) => c.enabled && c.enable_outbound).length;
  const inboundCount = channels.filter((c) => c.enabled && c.enable_inbound).length;
  const endpointCount = (endpointsData?.endpoints ?? []).filter((e) => e.enabled).length;

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">工作台</h1>
          <p className="text-sm text-slate-500 mt-1">
            YukiDeck {meta?.version ?? ''} · 模块化个人工具聚合底座
          </p>
        </div>
      </div>

      {/* Platform Core Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Link
          to="/messenger"
          className="rounded-xl border border-slate-200 bg-white p-5 hover:border-slate-300 transition-colors"
        >
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>消息渠道（发送 / 接收）</span>
            <Bell className="h-4 w-4" />
          </div>
          <div className="mt-3 text-2xl font-semibold text-slate-900">
            {outboundCount} <span className="text-sm font-normal text-slate-400">/ {inboundCount}</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">出站发送 / 入站双向交互</div>
        </Link>

        <Link
          to="/messenger"
          className="rounded-xl border border-slate-200 bg-white p-5 hover:border-slate-300 transition-colors"
        >
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>归一化 PushURL</span>
            <Link2 className="h-4 w-4" />
          </div>
          <div className="mt-3 text-2xl font-semibold text-slate-900">{endpointCount}</div>
          <div className="mt-1 text-xs text-slate-500">已启用的外部统一推送入口</div>
        </Link>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>已挂载业务模块</span>
            <Puzzle className="h-4 w-4" />
          </div>
          <div className="mt-3 text-2xl font-semibold text-slate-900">{modules.length}</div>
          <div className="mt-1 text-xs text-slate-500">支持按模块独立演进与热插拔</div>
        </div>
      </div>

      {/* Plugged-in Modules */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-700">工具模块</h2>
        {modules.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center space-y-2">
            <p className="text-sm font-medium text-slate-700">当前平台底座已就绪，尚未接入业务模块</p>
            <p className="text-xs text-slate-500">
              可先前往「消息中枢 & PushURL」配置自有 Telegram 双向渠道与归一化推送入口，后续逐个细化接入图床、物品价值计算、定时任务等模块。
            </p>
            <div className="pt-2">
              <Link
                to="/messenger"
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800"
              >
                配置消息中枢
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {modules.map((mod) => {
              const Icon = mod.icon;
              return (
                <Link
                  key={mod.id}
                  to={mod.basePath}
                  className="group rounded-xl border border-slate-200 bg-white p-5 hover:border-slate-900 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center group-hover:bg-slate-900 group-hover:text-white transition-colors">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="font-medium text-slate-900">{mod.name}</div>
                  </div>
                  <p className="mt-3 text-xs text-slate-500 leading-relaxed">{mod.description}</p>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
