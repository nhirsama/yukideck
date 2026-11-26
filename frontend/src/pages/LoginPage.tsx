import { Link, Navigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { LoginCard } from '@/components/LoginModal';
import { useAuth } from '@/core/auth';

export function LoginPage() {
  const { isAuthenticated } = useAuth();

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden bg-[#f8fafc] px-4 py-10">
      <div className="yd-dot-grid pointer-events-none absolute inset-0 opacity-65" />
      <div className="pointer-events-none absolute -top-24 left-1/2 h-72 w-[540px] -translate-x-1/2 rounded-full bg-sky-200/30 blur-3xl" />

      <div className="relative w-full max-w-[368px] space-y-4">
        <LoginCard />

        <div className="text-center">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:bg-white/80 hover:text-zinc-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回工作台
          </Link>
        </div>
      </div>
    </div>
  );
}
