import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PowerOff, Settings } from 'lucide-react';
import { ApiError } from '@/core/api';
import { AuthProvider, useAuth } from '@/core/auth';
import { useAvailableModules, useEnabledModules, type FrontendModule } from '@/core/module';
import { AppShell } from '@/core/layout/AppShell';
import { LoadingState } from '@/components/LoadingState';
import { LoginModal } from '@/components/LoginModal';
import { ToastProvider } from '@/components/Toast';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { MessengerPage } from '@/pages/MessengerPage';
import { SettingsPage } from '@/pages/SettingsPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});

function ModuleDisabledNotice({ mod }: { mod: FrontendModule }) {
  return (
    <div className="yd-empty max-w-md mx-auto my-12 p-8 space-y-3 text-center">
      <div className="h-10 w-10 rounded-xl bg-zinc-100 text-zinc-400 flex items-center justify-center mx-auto">
        <PowerOff className="h-5 w-5" />
      </div>
      <h2 className="text-base font-medium text-zinc-800">「{mod.name}」模块已关闭</h2>
      <p className="text-xs text-zinc-500 leading-relaxed">
        你已在系统设置中隐藏此模块，原有数据完整保留。随时可前往通用设置重新开启。
      </p>
      <div className="pt-1">
        <Link to="/settings" className="yd-btn-primary">
          <Settings className="h-3.5 w-3.5" />
          前往通用设置开启
        </Link>
      </div>
    </div>
  );
}

function AppRoutes() {
  const { loading } = useAuth();
  const availableModules = useAvailableModules();
  const enabledModules = useEnabledModules();
  const enabledIDs = new Set(enabledModules.map((m) => m.id));

  if (loading) {
    return <LoadingState label="正在加载 YukiDeck..." variant="fullscreen" />;
  }

  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="/messenger" element={<MessengerPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {availableModules.flatMap((mod) =>
            mod.routes.map((r, idx) => (
              <Route
                key={`${mod.id}-${idx}`}
                path={r.path}
                element={enabledIDs.has(mod.id) ? r.element : <ModuleDisabledNotice mod={mod} />}
              />
            )),
          )}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <LoginModal />
    </>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
