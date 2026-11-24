import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, coreApi, type User } from './api';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  logout: () => Promise<void>;
  loginUrl: string;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
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
    staleTime: 60_000,
  });

  const logout = async () => {
    await coreApi.logout();
    qc.setQueryData(['core', 'me'], null);
    qc.clear();
  };

  return (
    <AuthContext.Provider
      value={{
        user: data ?? null,
        loading: isLoading,
        logout,
        loginUrl: coreApi.loginUrl(),
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
