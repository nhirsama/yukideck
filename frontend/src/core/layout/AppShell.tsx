import { Suspense, useEffect, useState, type DragEvent, type FocusEvent, type FormEvent, type MouseEvent } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Bell, LayoutGrid, LogIn, LogOut, Menu, Settings, UserRound, X } from 'lucide-react';
import { useAuth } from '@/core/auth';
import { useEnabledModules } from '@/core/module';
import { LoadingState } from '@/components/LoadingState';
import { Tooltip } from '@/components/Tooltip';
import { YukiDeckLogo } from '@/components/YukiDeckLogo';

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
  const location = useLocation();
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    setAvatarFailed(false);
  }, [user?.avatar_url]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!drawerOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [drawerOpen]);

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

  const renderNavLinks = (onNavigate?: () => void) => (
    <nav className="flex-1 px-2.5 py-2 space-y-6 overflow-y-auto">
      <div className="space-y-0.5">
        <NavLink to="/" end className={navClass} onClick={onNavigate}>
          <LayoutGrid className="h-4 w-4 opacity-80" />
          工作台
        </NavLink>
        <NavLink to="/messenger" className={navClass} onClick={onNavigate}>
          <Bell className="h-4 w-4 opacity-80" />
          消息与推送
        </NavLink>
        <NavLink to="/settings" className={navClass} onClick={onNavigate}>
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
              <NavLink key={mod.id} to={mod.basePath} className={navClass} onClick={onNavigate}>
                <Icon className="h-4 w-4 opacity-80" />
                {mod.name}
              </NavLink>
            );
          })}
        </div>
      )}
    </nav>
  );

  const renderAccountFooter = (extraClass = '') => (
    <div className={`p-2.5 border-t border-zinc-100 ${extraClass}`}>
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
              aria-label="退出登录"
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
            onClick={() => {
              setDrawerOpen(false);
              openLoginModal();
            }}
            className="yd-btn-primary px-2.5 py-1 text-xs shrink-0"
          >
            <LogIn className="h-3.5 w-3.5" />
            登录
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-[#f8fafc] text-zinc-800 text-sm">
      {/* Mobile / Tablet TopBar (< lg only; desktop >= lg untouched) */}
      <header className="lg:hidden sticky top-0 z-30 h-14 border-b border-zinc-200/70 bg-white/95 backdrop-blur-md px-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开导航菜单"
            className="yd-btn-icon h-9 w-9 text-zinc-600"
          >
            <Menu className="h-5 w-5" />
          </button>
          <NavLink to="/" end className="flex items-center gap-2 min-w-0">
            <YukiDeckLogo className="h-7 w-7 shrink-0" />
            <span className="text-[15px] font-semibold tracking-tight text-zinc-800 truncate">
              YukiDeck
            </span>
          </NavLink>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {isAuthenticated ? (
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="查看账号菜单"
              className="inline-flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-zinc-100/80 transition-colors"
            >
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
            </button>
          ) : (
            <button
              type="button"
              onClick={() => openLoginModal()}
              className="yd-btn-primary px-2.5 py-1 text-xs"
            >
              <LogIn className="h-3.5 w-3.5" />
              登录
            </button>
          )}
        </div>
      </header>

      {/* Mobile / Tablet Slide-over Navigation Drawer */}
      {drawerOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 flex bg-slate-900/25 backdrop-blur-[2px] yd-fade-in"
          onClick={() => setDrawerOpen(false)}
        >
          <aside
            onClick={(e) => e.stopPropagation()}
            className="h-full w-64 max-w-[82vw] bg-white border-r border-zinc-200/80 shadow-2xl flex flex-col"
          >
            <div className="h-14 px-4 flex items-center justify-between border-b border-zinc-100">
              <div className="flex items-center gap-2.5">
                <YukiDeckLogo className="h-7 w-7 shrink-0" />
                <span className="text-[15px] font-semibold tracking-tight text-zinc-800">
                  YukiDeck
                </span>
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="关闭导航菜单"
                className="yd-btn-icon"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {renderNavLinks(() => setDrawerOpen(false))}
            {renderAccountFooter('pb-[max(0.625rem,env(safe-area-inset-bottom))]')}
          </aside>
        </div>
      )}

      {/* Desktop Sidebar (identical to original at >= lg) */}
      <aside className="hidden lg:flex sticky top-0 h-screen w-56 shrink-0 border-r border-zinc-200/70 bg-white flex-col">
        <div className="h-14 px-4 flex items-center gap-2.5">
          <YukiDeckLogo className="h-7 w-7 shrink-0" />
          <span className="text-[15px] font-semibold tracking-tight text-zinc-800">YukiDeck</span>
        </div>

        {renderNavLinks()}
        {renderAccountFooter()}
      </aside>

      <main
        className="flex-1 min-w-0"
        onClickCapture={handleGuestClickCapture}
        onSubmitCapture={handleGuestSubmitCapture}
        onFocusCapture={handleGuestFocusCapture}
        onDragOverCapture={handleGuestDragOverCapture}
        onDropCapture={handleGuestDropCapture}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-8 py-5 sm:py-7">
          <Suspense fallback={<LoadingState label="正在加载模块..." variant="module" />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
