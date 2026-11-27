import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: true,
});

interface MarkdownPreviewProps {
  content: string;
  className?: string;
}

export function MarkdownPreview({ content, className = '' }: MarkdownPreviewProps) {
  const html = useMemo(() => {
    if (!content.trim()) return '';
    const rendered = marked.parse(content, { async: false });
    const clean = DOMPurify.sanitize(typeof rendered === 'string' ? rendered : '', {
      USE_PROFILES: { html: true },
    });
    // Ensure external links open safely in a new tab.
    return clean.replace(/<a\s+/gi, '<a target="_blank" rel="noopener noreferrer" ');
  }, [content]);

  if (!content.trim()) {
    return (
      <div className={`flex items-center justify-center p-8 text-xs text-zinc-400 ${className}`}>
        暂无内容可预览
      </div>
    );
  }

  return (
    <div
      className={`yd-md-preview p-4 sm:p-5 text-sm leading-7 text-zinc-800 ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
