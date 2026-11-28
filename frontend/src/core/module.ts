import type { ComponentType, LazyExoticComponent } from 'react';
import type { RouteObject } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { coreApi } from './api';
import { useAuth } from './auth';
import { registeredModules } from '@/modules';

/**
 * FrontendModule is the symmetrical counterpart to backend module.Module.
 * Each pluggable tool module exports one manifest and registers it in src/modules/index.ts.
 */
export interface FrontendModule {
  id: string;
  name: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  basePath: string;
  routes: RouteObject[];
  settingsPanel?: {
    label: string;
    component: LazyExoticComponent<ComponentType>;
  };
}

export function useAppMeta() {
  return useQuery({
    queryKey: ['core', 'meta'],
    queryFn: coreApi.getMeta,
    staleTime: 5 * 60_000,
  });
}

/**
 * Returns all frontend modules enabled at the deployment level (/api/v1/meta),
 * before applying per-user disabled_modules preferences.
 */
export function useAvailableModules(): FrontendModule[] {
  const { data } = useAppMeta();
  if (!data) return [];
  const enabledIDs = new Set(data.modules.map((m) => m.id));
  return registeredModules.filter((m) => enabledIDs.has(m.id));
}

/**
 * Returns registered frontend modules filtered by both backend /api/v1/meta
 * and the signed-in user's disabled_modules preferences.
 */
export function useEnabledModules(): FrontendModule[] {
  const available = useAvailableModules();
  const { user } = useAuth();
  const disabled = user?.disabled_modules;
  if (!disabled || disabled.length === 0) return available;
  const disabledSet = new Set(disabled);
  return available.filter((m) => !disabledSet.has(m.id));
}
