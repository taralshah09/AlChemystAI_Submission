'use client';

import { useState, useMemo, useCallback } from 'react';
import { useAgent } from '@/store/agentStore';
import type { ContextSnapshot } from '@/lib/ws/types';

// ── JSON diff ─────────────────────────────────────────────────────────────────

type DiffKind = 'added' | 'removed' | 'changed' | 'same';

interface DiffNode {
  key: string;
  kind: DiffKind;
  oldVal?: unknown;
  newVal?: unknown;
  children?: DiffNode[];
}

function diffObjects(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
  depth = 0
): DiffNode[] {
  const keys = new Set([...Object.keys(next), ...(prev ? Object.keys(prev) : [])]);
  const nodes: DiffNode[] = [];
  for (const key of keys) {
    const inPrev = prev !== null && key in prev;
    const inNext = key in next;
    if (!inPrev) {
      nodes.push({ key, kind: 'added', newVal: next[key] });
    } else if (!inNext) {
      nodes.push({ key, kind: 'removed', oldVal: prev![key] });
    } else {
      const pv = prev![key];
      const nv = next[key];
      if (
        depth < 3 &&
        pv !== null && nv !== null &&
        typeof pv === 'object' && typeof nv === 'object' &&
        !Array.isArray(pv) && !Array.isArray(nv)
      ) {
        const children = diffObjects(
          pv as Record<string, unknown>,
          nv as Record<string, unknown>,
          depth + 1
        );
        const hasChange = children.some(c => c.kind !== 'same');
        nodes.push({ key, kind: hasChange ? 'changed' : 'same', children });
      } else {
        const changed = JSON.stringify(pv) !== JSON.stringify(nv);
        nodes.push({ key, kind: changed ? 'changed' : 'same', oldVal: pv, newVal: nv });
      }
    }
  }
  return nodes;
}

// ── Tree node renderer ────────────────────────────────────────────────────────

const KIND_STYLES: Record<DiffKind, string> = {
  added:   'bg-green-950/50 border-l-2 border-green-500',
  removed: 'bg-red-950/50 border-l-2 border-red-500',
  changed: 'bg-yellow-950/30 border-l-2 border-yellow-500',
  same:    '',
};

const KIND_LABELS: Record<DiffKind, string> = {
  added: '+ ', removed: '- ', changed: '~ ', same: '  ',
};

function TreeNode({ node, showDiff, depth = 0 }: { node: DiffNode; showDiff: boolean; depth?: number }) {
  // Auto-expand only the top two levels; deeper nodes are collapsed by default
  // so a 500KB+ context object doesn't paint thousands of DOM nodes on mount.
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children && node.children.length > 0;
  const style = showDiff ? KIND_STYLES[node.kind] : '';

  return (
    <div className={`pl-2 ${style} my-0.5`}>
      <div
        className="flex items-start gap-1 cursor-pointer hover:bg-zinc-800/30 rounded px-1 py-0.5"
        onClick={() => hasChildren && setOpen(o => !o)}
      >
        {hasChildren && (
          <span className="text-zinc-500 select-none">{open ? '▾' : '▸'}</span>
        )}
        <span className="text-zinc-400 font-mono text-xs">{showDiff && KIND_LABELS[node.kind]}</span>
        <span className="text-cyan-300 text-xs font-mono">{node.key}:</span>
        {!hasChildren && (
          <span className="text-xs font-mono ml-1">
            {node.kind === 'changed' && showDiff ? (
              <>
                <span className="text-red-400 line-through">{formatVal(node.oldVal)}</span>
                <span className="text-green-400 ml-2">{formatVal(node.newVal)}</span>
              </>
            ) : node.kind === 'removed' && showDiff ? (
              <span className="text-red-400">{formatVal(node.oldVal)}</span>
            ) : (
              <span className="text-zinc-200">{formatVal(node.newVal ?? node.oldVal)}</span>
            )}
          </span>
        )}
      </div>
      {hasChildren && open && (
        <div className="ml-3">
          {node.children!.map((child, i) => (
            <TreeNode key={`${child.key}-${i}`} node={child} showDiff={showDiff} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function formatVal(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return `"${v.slice(0, 200)}"`;
  if (typeof v === 'object') return Array.isArray(v) ? `[…${(v as unknown[]).length}]` : '{…}';
  return String(v);
}

// ── Context Inspector ─────────────────────────────────────────────────────────

export function ContextInspector() {
  const { state } = useAgent();
  const contextIds = Object.keys(state.contextSnapshots);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [step, setStep] = useState<number>(0);

  const activeId = selectedId ?? contextIds[0] ?? null;
  const history: ContextSnapshot[] = activeId ? (state.contextSnapshots[activeId] ?? []) : [];

  // Clamp step when history grows
  const clampedStep = Math.min(step, Math.max(0, history.length - 1));

  const current = history[clampedStep];
  const prev = clampedStep > 0 ? history[clampedStep - 1] : null;
  const showDiff = prev !== null;

  const diffNodes = useMemo(() => {
    if (!current) return [];
    return diffObjects(prev?.data ?? null, current.data);
  }, [current, prev]);

  return (
    <div className="flex flex-col h-full bg-zinc-950 border-l border-zinc-800">
      <div className="px-3 py-2 border-b border-zinc-800">
        <div className="text-xs font-semibold text-zinc-300 mb-2">Context Inspector</div>
        {contextIds.length > 0 && (
          <select
            value={activeId ?? ''}
            onChange={e => { setSelectedId(e.target.value); setStep(0); }}
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none"
          >
            {contextIds.map(id => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        )}
      </div>

      {history.length > 1 && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
          <button
            disabled={clampedStep === 0}
            onClick={() => setStep(s => Math.max(0, s - 1))}
            className="text-xs px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 disabled:opacity-40 hover:bg-zinc-800"
          >
            ←
          </button>
          <span className="text-xs text-zinc-400 font-mono flex-1 text-center">
            snapshot {clampedStep + 1} / {history.length}
            {showDiff && ' (diff from prev)'}
          </span>
          <button
            disabled={clampedStep >= history.length - 1}
            onClick={() => setStep(s => Math.min(history.length - 1, s + 1))}
            className="text-xs px-2 py-0.5 rounded border border-zinc-700 text-zinc-300 disabled:opacity-40 hover:bg-zinc-800"
          >
            →
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {!activeId || !current ? (
          <div className="text-xs text-zinc-500 text-center mt-8">No context snapshots yet.</div>
        ) : (
          <div className="font-mono text-xs">
            {diffNodes.map((node, i) => (
              <TreeNode key={`${node.key}-${i}`} node={node} showDiff={showDiff} />
            ))}
          </div>
        )}
      </div>

      {current && (
        <div className="px-3 py-1.5 border-t border-zinc-800 text-[10px] text-zinc-600 font-mono">
          seq#{current.seq} · {new Date(current.timestamp).toISOString().slice(11, 23)}
        </div>
      )}
    </div>
  );
}
