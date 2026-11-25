import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Bell, Link2, Puzzle } from 'lucide-react';
import { coreApi } from '@/core/api';
import { useEnabledModules } from '@/core/module';

export function DashboardPage() {
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
    <div className="space-y-7">
      <h1 className="yd-page-title">工作台</h1>

      {/* Platform Core Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Link to="/messenger" className="yd-card-interactive p-5 block">
          <div className="flex items-center justify-between text-zinc-500 text-xs">
            <span>消息渠道</span>
            <Bell className="h-3.5 w-3.5 text-zinc-400" />
          </div>
          <div className="mt-2.5 font-mono text-2xl font-semibold tracking-tight text-zinc-800 tabular-nums">
            {outboundCount}{' '}
            <span className="text-sm font-normal text-zinc-400">/ {inboundCount}</span>
          </div>
          <div className="mt-1 text-xs text-zinc-400">发送 / 接收</div>
        </Link>

        <Link to="/messenger" className="yd-card-interactive p-5 block">
          <div className="flex items-center justify-between text-zinc-500 text-xs">
            <span>推送终结点</span>
            <Link2 className="h-3.5 w-3.5 text-zinc-400" />
          </div>
          <div className="mt-2.5 font-mono text-2xl font-semibold tracking-tight text-zinc-800 tabular-nums">
            {endpointCount}
          </div>
          <div className="mt-1 text-xs text-zinc-400">已启用</div>
        </Link>

        <div className="yd-card p-5">
          <div className="flex items-center justify-between text-zinc-500 text-xs">
            <span>已启用模块</span>
            <Puzzle className="h-3.5 w-3.5 text-zinc-400" />
          </div>
          <div className="mt-2.5 font-mono text-2xl font-semibold tracking-tight text-zinc-800 tabular-nums">
            {modules.length}
          </div>
          <div className="mt-1 text-xs text-zinc-400">当前可用</div>
        </div>
      </div>

      {/* Plugged-in Modules */}
      <section className="space-y-3">
        <h2 className="text-xs font-medium text-zinc-500">工具模块</h2>
        {modules.length === 0 ? (
          <div className="yd-empty p-10 space-y-2.5">
            <p className="text-sm font-medium text-zinc-700">暂无已启用模块</p>
            <p className="text-xs text-zinc-500">可先前往消息与推送配置通知渠道。</p>
            <div className="pt-1">
              <Link to="/messenger" className="yd-btn-primary">
                配置消息渠道
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
                  className="group yd-card-interactive p-5 flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="h-8 w-8 rounded-lg bg-[#f3f6fa] text-zinc-600 flex items-center justify-center group-hover:bg-sky-50 group-hover:text-sky-600 transition-colors">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="text-sm font-medium text-zinc-800">{mod.name}</div>
                      </div>
                      <ArrowRight className="h-3.5 w-3.5 text-zinc-300 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-sky-500" />
                    </div>
                    <p className="mt-3 text-xs text-zinc-500 leading-relaxed">{mod.description}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
