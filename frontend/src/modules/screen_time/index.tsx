import { lazy } from 'react';
import { Clock } from 'lucide-react';
import type { FrontendModule } from '@/core/module';

const ScreenTimePage = lazy(() => import('./ScreenTimePage'));
const ScreenTimeSettingsPanel = lazy(() => import('./ScreenTimeSettingsPanel'));

export const screenTimeModule: FrontendModule = {
  id: 'screen-time',
  name: '使用时间',
  description: '零侵入归档 WakaTime 编码记录，查看多维趋势、年度热力图与每日时间轴',
  icon: Clock,
  basePath: '/screen-time',
  routes: [{ path: '/screen-time', element: <ScreenTimePage /> }],
  settingsPanel: {
    label: '使用时间',
    component: ScreenTimeSettingsPanel,
  },
};
