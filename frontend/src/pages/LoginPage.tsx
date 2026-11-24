import { Layers, LogIn } from 'lucide-react';
import { useAuth } from '@/core/auth';

export function LoginPage() {
  const { loginUrl } = useAuth();

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm text-center space-y-6">
        <div className="mx-auto h-12 w-12 rounded-xl bg-slate-900 text-white flex items-center justify-center">
          <Layers className="h-6 w-6" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold text-slate-900">YukiDeck</h1>
          <p className="text-sm text-slate-500">使用已有 OIDC SSO 账号登录你的个人工具工作台</p>
        </div>
        <a
          href={loginUrl}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 transition-colors"
        >
          <LogIn className="h-4 w-4" />
          通过 OIDC SSO 登录
        </a>
      </div>
    </div>
  );
}
