import { lazy } from 'react';
import { BarChart3 } from 'lucide-react';
import type { FrontendModule } from '@/core/module';

const AIUsagePage = lazy(() => import('./AIUsagePage'));
const AIUsageSettingsPanel = lazy(() => import('./AIUsageSettingsPanel'));

export const aiUsageModule: FrontendModule = {
  id: 'ai-usage',
  name: 'AI 用量统计',
  description: '多设备、多 Agent 的 Token、费用与工具调用统计',
  icon: BarChart3,
  basePath: '/ai-usage',
  routes: [{ path: '/ai-usage', element: <AIUsagePage /> }],
  settingsPanel: {
    label: 'AI 用量配置',
    component: AIUsageSettingsPanel,
  },
};
