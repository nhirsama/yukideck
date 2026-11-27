import { useEffect, useRef } from 'react';
import { Annotation, EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';

const remoteSyncAnnotation = Annotation.define<boolean>();

const ydHighlightStyle = HighlightStyle.define([
  { tag: t.heading, color: '#0f172a', fontWeight: '600' },
  { tag: t.heading1, fontSize: '1.25em' },
  { tag: t.heading2, fontSize: '1.12em' },
  { tag: [t.emphasis], fontStyle: 'italic', color: '#334155' },
  { tag: [t.strong], fontWeight: '600', color: '#0f172a' },
  { tag: [t.strikethrough], textDecoration: 'line-through', color: '#94a3b8' },
  { tag: [t.link, t.url], color: '#0284c7', textDecoration: 'underline' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: '#0369a1' },
  { tag: [t.string, t.special(t.string)], color: '#0f766e' },
  { tag: [t.number, t.bool, t.atom], color: '#b45309' },
  { tag: [t.comment, t.quote], color: '#94a3b8', fontStyle: 'italic' },
  { tag: [t.variableName, t.propertyName], color: '#334155' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#7c3aed' },
  { tag: [t.typeName, t.className, t.tagName], color: '#0284c7' },
  { tag: [t.attributeName], color: '#b45309' },
  { tag: [t.monospace], color: '#0f172a', backgroundColor: '#f1f5f9', borderRadius: '3px' },
  { tag: [t.meta, t.processingInstruction], color: '#64748b' },
]);

const ydEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    backgroundColor: '#ffffff',
    color: '#27272a',
    fontFamily: 'var(--font-mono)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.65',
  },
  '.cm-content': {
    padding: '16px 12px 48px',
    caretColor: '#0284c7',
  },
  '.cm-gutters': {
    backgroundColor: '#f8fafc',
    color: '#94a3b8',
    borderRight: '1px solid #eef2f6',
    paddingRight: '4px',
    userSelect: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#f0f9ff',
    color: '#0284c7',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(240, 249, 255, 0.55)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(14, 165, 233, 0.18)',
  },
  '.cm-cursor': {
    borderLeftColor: '#0284c7',
    borderLeftWidth: '1.5px',
  },
  '.cm-placeholder': {
    color: '#a1a1aa',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-panels': {
    backgroundColor: '#f8fafc',
    borderTop: '1px solid #e6ebf1',
    color: '#27272a',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(250, 204, 21, 0.35)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(14, 165, 233, 0.3)',
  },
});

/**
 * Computes minimal single-range change between current and next strings
 * so remote SSE updates preserve cursor & scroll position cleanly.
 */
function computeMinimalChange(
  current: string,
  next: string,
): { from: number; to: number; insert: string } | null {
  if (current === next) return null;

  let start = 0;
  const minLen = Math.min(current.length, next.length);
  while (start < minLen && current.charCodeAt(start) === next.charCodeAt(start)) {
    start++;
  }

  let currentEnd = current.length;
  let nextEnd = next.length;
  while (
    currentEnd > start &&
    nextEnd > start &&
    current.charCodeAt(currentEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    currentEnd--;
    nextEnd--;
  }

  return {
    from: start,
    to: currentEnd,
    insert: next.slice(start, nextEnd),
  };
}

interface CodeMirrorEditorProps {
  value: string;
  /** Incrementing token whenever value is updated externally (initial load / SSE / conflict reload). */
  externalSyncKey: number;
  placeholder?: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onSaveShortcut?: () => void;
  className?: string;
}

export function CodeMirrorEditor({
  value,
  externalSyncKey,
  placeholder = '在此输入或粘贴文本，支持 Markdown 与常见代码块高亮，输入后自动保存并实时同步...',
  autoFocus = false,
  onChange,
  onSaveShortcut,
  className = '',
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSaveShortcut);
  const lastSyncKeyRef = useRef(externalSyncKey);

  onChangeRef.current = onChange;
  onSaveRef.current = onSaveShortcut;

  // Mount CodeMirror 6 once.
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        markdown({ codeLanguages: languages }),
        syntaxHighlighting(ydHighlightStyle, { fallback: true }),
        ydEditorTheme,
        cmPlaceholder(placeholder),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const isRemote = update.transactions.some((tr) => tr.annotation(remoteSyncAnnotation));
          if (isRemote) return;
          onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: host,
    });
    viewRef.current = view;
    if (autoFocus) {
      view.focus();
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply external updates (initial fetch / SSE / reload) via minimal diff without resetting scroll/cursor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (externalSyncKey === lastSyncKeyRef.current) return;
    lastSyncKeyRef.current = externalSyncKey;

    const current = view.state.doc.toString();
    const change = computeMinimalChange(current, value);
    if (!change) return;

    view.dispatch({
      changes: change,
      annotations: remoteSyncAnnotation.of(true),
    });
  }, [value, externalSyncKey]);

  return <div ref={containerRef} className={`h-full w-full overflow-hidden ${className}`} />;
}
