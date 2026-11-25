import { NavLink, Outlet } from 'react-router-dom';
import { Bell, LayoutGrid, LogOut, Settings, Layers } from 'lucide-react';
import { useAuth } from '@/core/auth';
import { useEnabledModules } from '@/core/module';

export function AppShell() {
  const { user, logout } = useAuth();
  const modules = useEnabledModules();

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      isActive
        ? 'bg-slate-900 text-white'
        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
    }`;

  return (
    <div className="min-h-screen flex bg-slate-50">
      <aside className="w-60 shrink-0 border-r border-slate-200 bg-white flex flex-col">
        <div className="h-14 px-4 flex items-center gap-2.5 border-b border-slate-200">
          <div className="h-8 w-8 rounded-lg bg-slate-900 text-white flex items-center justify-center">
            <Layers className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight text-slate-900">YukiDeck</div>
            <div className="text-[11px] text-slate-500">Modular Personal Deck</div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-5 overflow-y-auto">
          <div className="space-y-1">
            <NavLink to="/" end className={navClass}>
              <LayoutGrid className="h-4 w-4" />
              工作台
            </NavLink>
            <NavLink to="/messenger" className={navClass}>
              <Bell className="h-4 w-4" />
              消息与推送
            </NavLink>
            <NavLink to="/settings" className={navClass}>
              <Settings className="h-4 w-4" />
              系统设置
            </NavLink>
          </div>

          {modules.length > 0 && (
            <div className="space-y-1">
              <div className="px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                已启用模块
              </div>
              {modules.map((mod) => {
                const Icon = mod.icon;
                return (
                  <NavLink key={mod.id} to={mod.basePath} className={navClass}>
                    <Icon className="h-4 w-4" />
                    {mod.name}
                  </NavLink>
                );
              })}
            </div>
          )}
        </nav>

        <div className="p-3 border-t border-slate-200 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-900 truncate">{user?.username}</div>
            {user?.email && <div className="text-xs text-slate-500 truncate">{user.email}</div>}
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            title="退出登录"
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
