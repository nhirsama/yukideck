import { lazy } from 'react';
import { Package } from 'lucide-react';
import type { FrontendModule } from '@/core/module';

const AssetsPage = lazy(() => import('./AssetsPage'));

export const assetsModule: FrontendModule = {
  id: 'assets',
  name: '物品资产',
  description: '个人物品与资产管理、多币种折算、日均成本与两级分类整理',
  icon: Package,
  basePath: '/assets',
  routes: [{ path: '/assets', element: <AssetsPage /> }],
};
