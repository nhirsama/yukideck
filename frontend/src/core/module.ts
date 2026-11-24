import type { ComponentType, LazyExoticComponent } from 'react';
import type { RouteObject } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { coreApi } from './api';
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
 * Returns registered frontend modules filtered by backend /api/v1/meta enabled list.
 */
export function useEnabledModules(): FrontendModule[] {
  const { data } = useAppMeta();
  if (!data) return [];
  const enabledIDs = new Set(data.modules.map((m) => m.id));
  return registeredModules.filter((m) => enabledIDs.has(m.id));
}
