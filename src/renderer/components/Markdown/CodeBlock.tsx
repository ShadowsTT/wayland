/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChevronDown, ChevronUp, Copy } from 'lucide-react';
import { LightAsync as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vs, vs2015 } from 'react-syntax-highlighter/dist/esm/styles/hljs';

import katex from 'katex';

import { copyText } from '@/renderer/utils/ui/clipboard';
import { sanitizeMath } from '@/renderer/utils/sanitize';
import { Message } from '@arco-design/web-react';
import React, { lazy, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '@renderer/hooks/context/ThemeContext';
import { formatCode, getDiffLineStyle } from './markdownUtils';

// Lazy-load MermaidBlock so the mermaid library (~89 MB of source: d3 / dagre /
// cytoscape) only enters the bundle when a ```mermaid fence is actually rendered.
// Statically importing it pulled mermaid into the first-route chunk on every
// launch even when no diagram was ever shown (startup perf).
const MermaidBlock = lazy(() => import('./MermaidBlock'));

const PREVIEW_LINES = 3;
const EXPANDED_STATES_MAX_SIZE = 200;

// Persist expanded state across component remounts during streaming.
// Keyed by a fingerprint (language + first line) so state survives
// when ReactMarkdown recreates the component tree on each content update.
// Capped at EXPANDED_STATES_MAX_SIZE entries to prevent unbounded growth.
const expandedStates = new Map<string, boolean>();

function getBlockFingerprint(language: string, lines: string[]): string {
  const preview = lines.slice(0, PREVIEW_LINES).join('\n');
  const key = `${language}:${lines.length}:${preview}`;
  // Evict oldest entries when exceeding size limit
  if (!expandedStates.has(key) && expandedStates.size >= EXPANDED_STATES_MAX_SIZE) {
    const firstKey = expandedStates.keys().next().value;
    if (firstKey !== undefined) {
      expandedStates.delete(firstKey);
    }
  }
  return key;
}

type CodeBlockProps = {
  children: string;
  className?: string;
  node?: unknown;
  hiddenCodeCopyButton?: boolean;
  codeStyle?: React.CSSProperties;
  [key: string]: unknown;
};

function CodeBlock(props: CodeBlockProps) {
  const { t } = useTranslation();
  // Dummy counter to force re-render when expanded state changes in the Map
  const [, setRenderTick] = useState(0);
  // Shared theme (perf: one app-level observer instead of a MutationObserver per
  // code block on document.documentElement — dozens in a long transcript).
  const { theme: currentTheme } = useThemeContext();

  const {
    children,
    className,
    node: _node,
    hiddenCodeCopyButton: _hiddenCodeCopyButton,
    codeStyle: _codeStyle,
    ...rest
  } = props;

  const match = /language-(\w+)/.exec(className || '');
  const language = match?.[1] || 'text';
  const codeTheme = currentTheme === 'dark' ? vs2015 : vs;

  // Render latex/math code blocks as KaTeX display math
  // Skip full LaTeX documents (with \documentclass, \begin{document}, etc.) - KaTeX only handles math
  if (language === 'latex' || language === 'math' || language === 'tex') {
    const latexSource = String(children).replace(/\n$/, '');
    const isFullDocument = /\\(documentclass|begin\{document\}|usepackage)\b/.test(latexSource);
    if (!isFullDocument) {
      try {
        const html = katex.renderToString(latexSource, {
          displayMode: true,
          throwOnError: false,
        });
        return <div className='katex-display' dangerouslySetInnerHTML={{ __html: sanitizeMath(html) }} />;
      } catch {
        // Fall through to render as code block if KaTeX fails
      }
    }
  }

  if (language === 'mermaid') {
    return (
      <Suspense fallback={<pre style={props.codeStyle}>{formatCode(children)}</pre>}>
        <MermaidBlock code={formatCode(children)} style={props.codeStyle} />
      </Suspense>
    );
  }

  if (!String(children).includes('\n')) {
    return (
      <code
        {...rest}
        className={className}
        style={{
          fontWeight: 'bold',
        }}
      >
        {children}
      </code>
    );
  }

  const isDiff = language === 'diff';
  const formattedContent = formatCode(children);
  const allLines = formattedContent.split('\n');
  const diffLines = isDiff ? allLines : [];
  const totalLines = allLines.length;
  const canCollapse = totalLines > PREVIEW_LINES;

  const blockKey = getBlockFingerprint(language, allLines);
  const expanded = expandedStates.get(blockKey) ?? false;
  const setExpanded = (val: boolean) => {
    expandedStates.set(blockKey, val);
    setRenderTick((n) => n + 1);
  };
  const displayContent = expanded || !canCollapse ? formattedContent : allLines.slice(0, PREVIEW_LINES).join('\n');

  const syntaxHighlighterStyle: React.CSSProperties = {
    margin: '0',
    borderRadius: '0',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-primary)',
    overflowX: 'auto',
    maxWidth: '100%',
  };

  // Memoize the highlighted output. Syntax highlighting re-tokenizes the whole
  // block (O(code length)) on every render; ReactMarkdown passes a fresh `node`
  // each parse, so without this a re-render with unchanged code would re-tokenize
  // needlessly. Keyed on the actual inputs (content + language + theme) so it
  // only recomputes when they change — the single largest per-token CPU sink
  // during multi-agent streaming.
  const highlighted = useMemo(
    () => (
      <SyntaxHighlighter
        children={displayContent}
        language={language}
        style={codeTheme}
        PreTag='div'
        wrapLines={isDiff}
        lineProps={
          isDiff
            ? (lineNumber: number) => ({
                style: {
                  display: 'block',
                  ...getDiffLineStyle(diffLines[lineNumber - 1] || '', currentTheme === 'dark'),
                },
              })
            : undefined
        }
        customStyle={syntaxHighlighterStyle}
        codeTagProps={{ style: { color: 'var(--text-primary)' } }}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayContent, language, codeTheme, isDiff, currentTheme]
  );

  return (
    <div style={{ width: '100%', minWidth: 0, maxWidth: '100%', ...props.codeStyle }}>
      <div
        style={{
          border: '1px solid var(--bg-3)',
          borderRadius: '0.3rem',
          overflow: 'hidden',
          overflowX: 'auto',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: 'var(--bg-2)',
            borderTopLeftRadius: '0.3rem',
            borderTopRightRadius: '0.3rem',
            padding: '6px 10px',
            borderBottom: '1px solid var(--bg-3)',
          }}
        >
          <span
            style={{
              textDecoration: 'none',
              color: 'var(--text-secondary)',
              fontSize: '12px',
              lineHeight: '20px',
            }}
          >
            {'<' + language.toLocaleLowerCase() + '>'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Copy
              size={18}
              style={{ cursor: 'pointer' }}
              color='var(--text-secondary)'
              onClick={() => {
                void copyText(formattedContent)
                  .then(() => {
                    Message.success(t('common.copySuccess'));
                  })
                  .catch(() => {
                    Message.error(t('common.copyFailed'));
                  });
              }}
            />
            {canCollapse && expanded && (
              <ChevronUp
                size={20}
                style={{ cursor: 'pointer' }}
                color='var(--text-secondary)'
                onMouseDown={(e: React.MouseEvent) => {
                  if (e.button === 0) {
                    e.preventDefault();
                    setExpanded(false);
                  }
                }}
                aria-label={t('common.collapse', 'Collapse')}
              />
            )}
          </div>
        </div>

        {/* Code content - always visible (preview or full) */}
        {highlighted}

        {/* Footer: "View More" / collapse */}
        {canCollapse && (
          <div
            style={{
              display: 'flex',
              justifyContent: expanded ? 'flex-end' : 'center',
              alignItems: 'center',
              backgroundColor: 'var(--bg-2)',
              borderBottomLeftRadius: '0.3rem',
              borderBottomRightRadius: '0.3rem',
              padding: '4px 10px',
              borderTop: '1px solid var(--bg-3)',
              cursor: 'pointer',
            }}
            onMouseDown={(e) => {
              if (e.button === 0) {
                e.preventDefault();
                setExpanded(!expanded);
              }
            }}
          >
            {expanded ? (
              <ChevronUp size={20} color='var(--text-secondary)' aria-label={t('common.collapse', 'Collapse')} />
            ) : (
              <span style={{ color: 'var(--text-secondary)', fontSize: '12px', lineHeight: '20px' }}>
                {t('common.viewMoreLines', { count: totalLines - PREVIEW_LINES })}{' '}
                <ChevronDown size={14} color='var(--text-secondary)' />
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Custom comparator: ReactMarkdown recreates the `node` AST object (and other
 * transient props) on every parse, which would defeat a default shallow memo and
 * re-render every code block on each streaming tick. Compare only the props that
 * actually affect output; `codeStyle`/`hiddenCodeCopyButton` are stable
 * references (memoized by the parent's `components`). This lets already-complete
 * code blocks skip re-rendering while a later block streams.
 */
function areCodeBlockPropsEqual(prev: CodeBlockProps, next: CodeBlockProps): boolean {
  return (
    prev.children === next.children &&
    prev.className === next.className &&
    prev.hiddenCodeCopyButton === next.hiddenCodeCopyButton &&
    prev.codeStyle === next.codeStyle
  );
}

export default React.memo(CodeBlock, areCodeBlockPropsEqual);
