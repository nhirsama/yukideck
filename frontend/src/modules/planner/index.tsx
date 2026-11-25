import { lazy } from 'react';
import { CalendarCheck2 } from 'lucide-react';
import type { FrontendModule } from '@/core/module';

const PlannerPage = lazy(() => import('./PlannerPage'));

export const plannerModule: FrontendModule = {
  id: 'planner',
  name: '日程与提醒',
  description: '待办、公历/农历日程与多时间点提醒推送',
  icon: CalendarCheck2,
  basePath: '/planner',
  routes: [{ path: '/planner', element: <PlannerPage /> }],
};
