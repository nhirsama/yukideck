import { Layers, LogIn } from 'lucide-react';
import { useAuth } from '@/core/auth';

export function LoginPage() {
  const { loginUrl } = useAuth();

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f8fafc] px-4">
      <div className="yd-card w-full max-w-[360px] p-8 text-center space-y-6">
        <div className="mx-auto h-11 w-11 rounded-xl bg-sky-50 border border-sky-200/70 text-sky-600 flex items-center justify-center">
          <Layers className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-800">YukiDeck</h1>
          <p className="text-[13px] text-zinc-500">个人工具工作台</p>
        </div>
        <a href={loginUrl} className="yd-btn-primary w-full py-2.5 text-[13px]">
          <LogIn className="h-4 w-4" />
          通过 OIDC 登录
        </a>
      </div>
    </div>
  );
}
