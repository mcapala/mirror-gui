import React from 'react';
import type { Change } from 'diff';

const YAML_DIFF_STYLES = `
.yaml-diff {
  font-family: var(--pf-t--global--font--family--mono, "Red Hat Mono", "Liberation Mono", monospace);
  font-size: 0.875rem;
  line-height: 1.6;
  background: var(--pf-t--global--background--color--primary--default, #fff);
  color: var(--pf-t--global--text--color--regular, #151515);
  padding: 1rem;
  overflow-x: auto;
  border: 1px solid var(--pf-t--global--border--color--default, #d2d2d2);
  border-radius: var(--pf-t--global--border--radius--small, 3px);
  white-space: pre;
  tab-size: 2;
  margin: 0;
}
.yaml-diff .diff-line { display: block; }
.yaml-diff .diff-added { background: #e6ffec; }
.yaml-diff .diff-removed { background: #ffebe9; }
.pf-v6-theme-dark .yaml-diff .diff-added { background: rgba(46, 160, 67, 0.2); }
.pf-v6-theme-dark .yaml-diff .diff-removed { background: rgba(248, 81, 73, 0.2); }
`;

interface YamlDiffProps {
  parts: Change[];
}

const YamlDiff: React.FC<YamlDiffProps> = ({ parts }) => {
  let key = 0;
  return (
    <>
      <style>{YAML_DIFF_STYLES}</style>
      <pre className="yaml-diff" aria-label="ISC change preview">
        {parts.flatMap(part => {
          const lines = part.value.replace(/\n$/, '').split('\n');
          const cls = part.added
            ? 'diff-line diff-added'
            : part.removed
              ? 'diff-line diff-removed'
              : 'diff-line';
          const gutter = part.added ? '+ ' : part.removed ? '- ' : '  ';
          return lines.map(line => (
            <span key={key++} className={cls}>
              {gutter}
              {line}
            </span>
          ));
        })}
      </pre>
    </>
  );
};

export default YamlDiff;
