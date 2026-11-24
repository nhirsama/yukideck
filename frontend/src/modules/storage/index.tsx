import { lazy } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import type { FrontendModule } from '@/core/module';

const StoragePage = lazy(() => import('./StoragePage'));
const StorageSettingsPanel = lazy(() => import('./StorageSettingsPanel'));

export const storageModule: FrontendModule = {
  id: 'storage',
  name: '图床管理',
  description: '直连自有 S3 / R2 存储桶的轻量相册与文件管理，支持直传不限大小与无损去 EXIF',
  icon: ImageIcon,
  basePath: '/storage',
  routes: [{ path: '/storage', element: <StoragePage /> }],
  settingsPanel: {
    label: '图床对象存储',
    component: StorageSettingsPanel,
  },
};
