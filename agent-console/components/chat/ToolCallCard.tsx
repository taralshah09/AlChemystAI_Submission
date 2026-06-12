'use client';

import { useAgent } from '@/store/agentStore';

interface Props {
  call_id: string;
  highlighted?: boolean;
  onHighlight?: (id: string) => void;
}

export function ToolCallCard({ call_id, highlighted, onHighlight }: Props) {
  const { state } = useAgent();
  const entry = state.toolCalls[call_id];
  if (!entry) return null;

  const isWaiting = entry.state !== 'completed';

  return (
    <div
      id={`tool-${call_id}`}
      onClick={() => onHighlight?.(call_id)}
      className={`
        my-2 rounded-lg border text-xs font-mono cursor-pointer transition-all
        ${highlighted ? 'border-blue-500 bg-blue-950/40' : 'border-zinc-700 bg-zinc-900/60'}
      `}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-700">
        <span className="text-purple-400 font-semibold">⚙ {entry.tool_name}</span>
        {isWaiting ? (
          <span className="text-yellow-400 animate-pulse">● waiting</span>
        ) : (
          <span className="text-green-400">✓ completed</span>
        )}
      </div>
      <div className="px-3 py-2">
        <div className="text-zinc-400 mb-1">args</div>
        <pre className="text-zinc-200 whitespace-pre-wrap break-all">
          {JSON.stringify(entry.args, null, 2)}
        </pre>
      </div>
      {!isWaiting && entry.result && (
        <div className="px-3 py-2 border-t border-zinc-700">
          <div className="text-zinc-400 mb-1">result</div>
          <pre className="text-green-300 whitespace-pre-wrap break-all">
            {JSON.stringify(entry.result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
