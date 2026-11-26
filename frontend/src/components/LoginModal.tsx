import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { ArrowRight, Layers, Lock, LogIn, X } from 'lucide-react';
import { useAuth } from '@/core/auth';
import { useAppMeta } from '@/core/module';

function formatVersionBadge(raw?: string): string | null {
  const v = (raw || '').trim();
  if (!v) return null;
  if (v === 'dev') return 'dev';
  return /^v/i.test(v) ? v : `v${v}`;
}

export function LoginCard({
  reason,
  onClose,
}: {
  reason?: string | null;
  onClose?: () => void;
}) {
  const { loginUrl } = useAuth();
  const { data: meta } = useAppMeta();
  const location = useLocation();

  const currentNext =
    location.pathname && location.pathname !== '/login'
      ? `${location.pathname}${location.search}`
      : '/';
  const versionBadge = formatVersionBadge(meta?.version);

  return (
    <div className="relative w-full max-w-[368px] overflow-hidden rounded-2xl border border-zinc-200/85 bg-white shadow-[0_24px_60px_rgba(15,23,42,0.12)]">
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭登录窗口"
          className="absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/80 hover:text-zinc-700"
        >
          <X className="h-4 w-4" />
        </button>
      )}

      {/* Brand Hero */}
      <div className="relative overflow-hidden border-b border-zinc-100 bg-gradient-to-b from-sky-50/85 via-sky-50/25 to-white px-7 pt-8 pb-6 text-center">
        <div className="yd-dot-grid pointer-events-none absolute inset-0 opacity-60" />
        <div className="pointer-events-none absolute -top-16 left-1/2 h-36 w-52 -translate-x-1/2 rounded-full bg-sky-300/20 blur-2xl" />

        <div className="relative space-y-3">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-sky-200/80 bg-white text-sky-600 shadow-[0_8px_24px_rgba(14,165,233,0.14)]">
            <Layers className="h-5 w-5" />
          </div>

          <div className="space-y-1">
            <div className="inline-flex items-center justify-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight text-zinc-800">
                {meta?.app ?? 'YukiDeck'}
              </h1>
              {versionBadge && (
                <span className="rounded-md border border-sky-200/70 bg-white/90 px-1.5 py-0.5 font-mono text-[10px] font-medium text-sky-600">
                  {versionBadge}
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-500">个人工具工作台</p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="p-6 space-y-4">
        {reason && (
          <div className="flex items-start gap-2 rounded-xl border border-sky-200/75 bg-sky-50/60 px-3 py-2.5 text-xs text-sky-800">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-500" />
            <span className="leading-relaxed">{reason}</span>
          </div>
        )}

        <div className="space-y-2">
          <a
            href={loginUrl(currentNext)}
            className="group inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-sky-500 px-4 text-[13px] font-medium text-white shadow-[0_6px_18px_rgba(14,165,233,0.24)] transition-all hover:bg-sky-600 hover:shadow-[0_8px_22px_rgba(14,165,233,0.3)] active:bg-sky-700"
          >
            <LogIn className="h-4 w-4" />
            <span>使用 OIDC 登录</span>
            <ArrowRight className="h-3.5 w-3.5 opacity-80 transition-transform duration-150 group-hover:translate-x-0.5" />
          </a>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-xl py-2 text-xs font-medium text-zinc-400 transition-colors hover:bg-zinc-100/80 hover:text-zinc-700"
            >
              暂不登录
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function LoginModal() {
  const { loginModalOpen, loginModalReason, closeLoginModal, isAuthenticated } = useAuth();

  useEffect(() => {
    if (isAuthenticated && loginModalOpen) {
      closeLoginModal();
    }
  }, [isAuthenticated, loginModalOpen, closeLoginModal]);

  useEffect(() => {
    if (!loginModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeLoginModal();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [loginModalOpen, closeLoginModal]);

  if (!loginModalOpen) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="登录 YukiDeck"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/25 p-4 backdrop-blur-[3px] yd-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeLoginModal();
      }}
    >
      <div className="w-full max-w-[368px] yd-modal-in">
        <LoginCard reason={loginModalReason} onClose={closeLoginModal} />
      </div>
    </div>,
    document.body,
  );
}
