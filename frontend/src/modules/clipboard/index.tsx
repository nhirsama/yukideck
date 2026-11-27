import { lazy } from 'react';
import { ClipboardList } from 'lucide-react';
import type { FrontendModule } from '@/core/module';

const ClipboardPage = lazy(() => import('./ClipboardPage'));
const ClipboardEditorPage = lazy(() => import('./ClipboardEditorPage'));

export const clipboardModule: FrontendModule = {
  id: 'clipboard',
  name: '剪切板',
  description: '跨设备云端纯文本剪切板、实时同步编辑与 Markdown 预览',
  icon: ClipboardList,
  basePath: '/clipboard',
  routes: [
    { path: '/clipboard', element: <ClipboardPage /> },
    { path: '/clipboard/:id', element: <ClipboardEditorPage /> },
  ],
};
