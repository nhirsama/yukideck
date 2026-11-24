import type { FrontendModule } from '@/core/module';
import { storageModule } from './storage';
import { plannerModule } from './planner';

/**
 * Single frontend module registry.
 * Adding a new tool module only requires creating src/modules/<name>/ and adding it below.
 */
export const registeredModules: FrontendModule[] = [
  storageModule,
  plannerModule,
];
