import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, configureApiAuthBridge, coreApi, type User } from './api';
import { setActiveUserTimezone } from './timezone';

interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  loading: boolean;
  logout: () => Promise<void>;
  loginUrl: (next?: string) => string;
  loginModalOpen: boolean;
  loginModalReason: string | null;
  openLoginModal: (reason?: string) => void;
  closeLoginModal: () => void;
  requireAuth: (action: () => void, reason?: string) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [loginModalReason, setLoginModalReason] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['core', 'me'],
    queryFn: async () => {
      try {
        const res = await coreApi.getMe();
        return res.user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          return null;
        }
        throw err;
      }
    },
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const user = data ?? null;
  const isAuthenticated = Boolean(user);
  // Keep synchronous module-level timezone snapshot updated before children render.
  setActiveUserTimezone(user?.timezone ?? null);

  const openLoginModal = useCallback((reason?: string) => {
    setLoginModalReason(reason ?? null);
    setLoginModalOpen(true);
  }, []);

  const closeLoginModal = useCallback(() => {
    setLoginModalOpen(false);
    setLoginModalReason(null);
  }, []);

  const hydratedRef = useRef(false);
  const prevUserIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (isLoading) return;
    const curId = user?.id ?? null;
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      prevUserIdRef.current = curId;
      return;
    }
    if (prevUserIdRef.current !== curId) {
      if (prevUserIdRef.current === null && curId !== null) {
        // Logged in (e.g. from another tab): refresh all module queries automatically.
        void qc.invalidateQueries({
          predicate: (query) => query.queryKey[0] !== 'core',
        });
      } else if (prevUserIdRef.current !== null && curId === null) {
        // Logged out (e.g. from another tab): clear cached user-scoped module data.
        qc.removeQueries({
          predicate: (query) => query.queryKey[0] !== 'core',
        });
      }
      prevUserIdRef.current = curId;
    }
  }, [isLoading, user?.id, qc]);

  const isAuthRef = useRef(isAuthenticated);
  isAuthRef.current = isAuthenticated;

  const onUnauthorizedRef = useRef<(ctx: { path: string; method: string; expired: boolean }) => void>(
    () => {},
  );
  onUnauthorizedRef.current = ({ expired }) => {
    if (expired) {
      qc.setQueryData(['core', 'me'], null);
      openLoginModal('当前登录会话已失效，请重新登录以继续操作');
    } else {
      openLoginModal('请先登录后再进行此操作');
    }
  };

  // Register bridge synchronously so initial child renders see the exact auth status before any query fires.
  const bridgeRegisteredRef = useRef(false);
  if (!bridgeRegisteredRef.current) {
    bridgeRegisteredRef.current = true;
    configureApiAuthBridge({
      isAuthenticated: () => isAuthRef.current,
      onUnauthorized: (ctx) => onUnauthorizedRef.current(ctx),
    });
  }

  useEffect(() => {
    configureApiAuthBridge({
      isAuthenticated: () => isAuthRef.current,
      onUnauthorized: (ctx) => onUnauthorizedRef.current(ctx),
    });
    return () => {
      bridgeRegisteredRef.current = false;
      configureApiAuthBridge(null);
    };
  }, []);

  const logout = useCallback(async () => {
    await coreApi.logout();
    isAuthRef.current = false;
    qc.setQueryData(['core', 'me'], null);
    qc.removeQueries({
      predicate: (query) => query.queryKey[0] !== 'core',
    });
  }, [qc]);

  const requireAuth = useCallback(
    (action: () => void, reason?: string) => {
      if (isAuthRef.current) {
        action();
      } else {
        openLoginModal(reason);
      }
    },
    [openLoginModal],
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated,
        loading: isLoading,
        logout,
        loginUrl: coreApi.loginUrl,
        loginModalOpen,
        loginModalReason,
        openLoginModal,
        closeLoginModal,
        requireAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
