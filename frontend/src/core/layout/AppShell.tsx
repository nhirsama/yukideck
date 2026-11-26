import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Bell, LayoutGrid, LogOut, Settings, Layers } from 'lucide-react';
import { useAuth } from '@/core/auth';
import { useEnabledModules } from '@/core/module';

export function AppShell() {
  const { user, logout } = useAuth();
  const modules = useEnabledModules();
  const [avatarFailed, setAvatarFailed] = useState(false);

  useEffect(() => {
    setAvatarFailed(false);
  }, [user?.avatar_url]);

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
      isActive
        ? 'bg-sky-50/90 text-sky-700 font-medium'
        : 'text-zinc-600 hover:bg-zinc-100/75 hover:text-zinc-800'
    }`;

  const displayName = user?.username || (user?.email ? user.email.split('@')[0] : '用户');
  const initials = displayName.slice(0, 1).toUpperCase();
  const showAvatar = Boolean(user?.avatar_url && !avatarFailed);

  return (
    <div className="min-h-screen flex bg-[#f8fafc] text-zinc-800 text-sm">
      <aside className="sticky top-0 h-screen w-56 shrink-0 border-r border-zinc-200/70 bg-white flex flex-col">
        <div className="h-14 px-4 flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-lg bg-sky-50 border border-sky-200/70 text-sky-600 flex items-center justify-center">
            <Layers className="h-4 w-4" />
          </div>
          <span className="text-[15px] font-semibold tracking-tight text-zinc-800">YukiDeck</span>
        </div>

        <nav className="flex-1 px-2.5 py-2 space-y-6 overflow-y-auto">
          <div className="space-y-0.5">
            <NavLink to="/" end className={navClass}>
              <LayoutGrid className="h-4 w-4 opacity-80" />
              工作台
            </NavLink>
            <NavLink to="/messenger" className={navClass}>
              <Bell className="h-4 w-4 opacity-80" />
              消息与推送
            </NavLink>
            <NavLink to="/settings" className={navClass}>
              <Settings className="h-4 w-4 opacity-80" />
              系统设置
            </NavLink>
          </div>

          {modules.length > 0 && (
            <div className="space-y-0.5">
              <div className="px-2.5 pb-1 text-xs font-medium text-zinc-400">模块</div>
              {modules.map((mod) => {
                const Icon = mod.icon;
                return (
                  <NavLink key={mod.id} to={mod.basePath} className={navClass}>
                    <Icon className="h-4 w-4 opacity-80" />
                    {mod.name}
                  </NavLink>
                );
              })}
            </div>
          )}
        </nav>

        <div className="p-2.5 border-t border-zinc-100">
          <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5">
            <div className="flex items-center gap-2.5 min-w-0">
              {showAvatar ? (
                <img
                  src={user!.avatar_url}
                  alt={displayName}
                  referrerPolicy="no-referrer"
                  onError={() => setAvatarFailed(true)}
                  className="h-7 w-7 rounded-full object-cover border border-zinc-200/80 shrink-0"
                />
              ) : (
                <div className="h-7 w-7 rounded-full bg-sky-50 border border-sky-100 text-sky-600 text-xs font-medium flex items-center justify-center shrink-0">
                  {initials}
                </div>
              )}
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-zinc-800 truncate">{displayName}</div>
                {user?.email && <div className="text-xs text-zinc-400 truncate">{user.email}</div>}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              title="退出登录"
              className="yd-btn-icon shrink-0"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 min-w-0">
        <div className="max-w-7xl mx-auto px-6 sm:px-8 py-7">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
