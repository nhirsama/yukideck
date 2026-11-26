import { Suspense, useEffect, useState, type DragEvent, type FocusEvent, type FormEvent, type MouseEvent } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Bell, LayoutGrid, LogIn, LogOut, Settings, Layers, UserRound } from 'lucide-react';
import { useAuth } from '@/core/auth';
import { useEnabledModules } from '@/core/module';
import { LoadingState } from '@/components/LoadingState';
import { Tooltip } from '@/components/Tooltip';

const GUEST_INTERACTIVE_SELECTOR =
  'button, input, textarea, select, [role="button"], [contenteditable="true"], .fc-daygrid-day, .fc-timegrid-slot';

function isGuestAllowedControl(target: Element): boolean {
  if (target.closest('[data-guest-allow]')) return true;
  // Pure navigation links and view/tab switchers remain usable while browsing as guest.
  if (target.closest('a[href]')) return true;
  if (target.closest('.yd-tab, .yd-segment-btn, .fc-button')) return true;
  return false;
}

function resolveInteractiveElement(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  if (isGuestAllowedControl(target)) return null;

  const direct = target.closest(GUEST_INTERACTIVE_SELECTOR);
  if (direct) return direct;

  const label = target.closest('label');
  if (label && (label.htmlFor || label.querySelector('input, textarea, select, button'))) {
    return label;
  }
  return null;
}

function buildGuestPromptReason(el: Element): string {
  const rawLabel = (el.getAttribute('aria-label') || el.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (rawLabel.length > 0 && rawLabel.length <= 16 && !el.matches('.fc-daygrid-day, .fc-timegrid-slot')) {
    return `请先登录后再进行「${rawLabel}」操作`;
  }
  return '请先登录 YukiDeck 账号以使用交互功能';
}

export function AppShell() {
  const { user, isAuthenticated, logout, openLoginModal } = useAuth();
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

  // Unified guest interaction guard: allows reading layouts & switching views/tabs,
  // while prompting login immediately before any mutating or interactive action.
  const handleGuestClickCapture = (e: MouseEvent<HTMLElement>) => {
    if (isAuthenticated) return;
    const interactive = resolveInteractiveElement(e.target);
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    openLoginModal(buildGuestPromptReason(interactive));
  };

  const handleGuestSubmitCapture = (e: FormEvent<HTMLElement>) => {
    if (isAuthenticated) return;
    e.preventDefault();
    e.stopPropagation();
    openLoginModal('请先登录 YukiDeck 账号后再提交');
  };

  const handleGuestFocusCapture = (e: FocusEvent<HTMLElement>) => {
    if (isAuthenticated) return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('[data-guest-allow]')) return;
    if (target.matches('input, textarea, select, [contenteditable="true"]')) {
      target.blur();
      openLoginModal('请先登录 YukiDeck 账号后再输入或编辑');
    }
  };

  const handleGuestDragOverCapture = (e: DragEvent<HTMLElement>) => {
    if (isAuthenticated) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const handleGuestDropCapture = (e: DragEvent<HTMLElement>) => {
    if (isAuthenticated) return;
    e.preventDefault();
    e.stopPropagation();
    openLoginModal('请先登录 YukiDeck 账号后再上传文件');
  };

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
          {isAuthenticated ? (
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
              <Tooltip content="退出登录">
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="yd-btn-icon shrink-0"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="h-7 w-7 rounded-full bg-[#f3f6fa] border border-zinc-200/80 text-zinc-400 flex items-center justify-center shrink-0">
                  <UserRound className="h-3.5 w-3.5" />
                </div>
                <span className="text-[13px] font-medium text-zinc-600 truncate">未登录</span>
              </div>
              <button
                type="button"
                onClick={() => openLoginModal()}
                className="yd-btn-primary px-2.5 py-1 text-xs shrink-0"
              >
                <LogIn className="h-3.5 w-3.5" />
                登录
              </button>
            </div>
          )}
        </div>
      </aside>

      <main
        className="flex-1 min-w-0"
        onClickCapture={handleGuestClickCapture}
        onSubmitCapture={handleGuestSubmitCapture}
        onFocusCapture={handleGuestFocusCapture}
        onDragOverCapture={handleGuestDragOverCapture}
        onDropCapture={handleGuestDropCapture}
      >
        <div className="max-w-7xl mx-auto px-6 sm:px-8 py-7">
          <Suspense fallback={<LoadingState label="正在加载模块..." variant="module" />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
