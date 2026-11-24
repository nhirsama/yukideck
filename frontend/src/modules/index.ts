import type { FrontendModule } from '@/core/module';

/**
 * Single frontend module registry.
 * Adding a new tool module only requires creating src/modules/<name>/ and adding it below.
 */
export const registeredModules: FrontendModule[] = [
  // Stage 2: storageModule,
  // Stage 3: assetsModule,
  // Stage 4: cronModule,
];
