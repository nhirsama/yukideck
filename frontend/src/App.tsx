import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/core/auth';
import { useEnabledModules } from '@/core/module';
import { AppShell } from '@/core/layout/AppShell';
import { LoadingState } from '@/components/LoadingState';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { MessengerPage } from '@/pages/MessengerPage';
import { SettingsPage } from '@/pages/SettingsPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

function AppRoutes() {
  const { user, loading } = useAuth();
  const modules = useEnabledModules();

  if (loading) {
    return <LoadingState label="正在加载 YukiDeck..." variant="fullscreen" />;
  }

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="/messenger" element={<MessengerPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        {modules.flatMap((mod) =>
          mod.routes.map((r, idx) => (
            <Route key={`${mod.id}-${idx}`} path={r.path} element={r.element} />
          )),
        )}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
