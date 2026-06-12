'use client';

import { useAgent } from '@/store/agentStore';
import type { ChatMessage } from '@/lib/ws/types';
import { ToolCallCard } from './ToolCallCard';

interface Props {
  message: ChatMessage;
}

export function MessageBubble({ message }: Props) {
  const { state, dispatch } = useAgent();

  if (message.role === 'user') {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[75%] rounded-2xl px-4 py-2 bg-blue-600 text-white text-sm">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div
      id={`msg-${message.id}`}
      className={`mb-4 transition-all ${state.highlightedId === message.id ? 'ring-1 ring-blue-500 rounded-lg' : ''}`}
    >
      <div className="flex gap-3">
        <div className="w-7 h-7 rounded-full bg-purple-600 flex items-center justify-center text-xs shrink-0 mt-0.5">
          AI
        </div>
        <div className="flex-1 min-w-0">
          {message.segments.map((seg, i) => {
            if (seg.kind === 'tokens') {
              const text = seg.chunks.map(c => c.text).join('');
              return (
                <span
                  key={i}
                  className="text-sm text-zinc-100 whitespace-pre-wrap"
                >
                  {text}
                  {!seg.frozen && !message.complete && (
                    <span className="inline-block w-0.5 h-4 bg-zinc-300 ml-0.5 animate-pulse align-text-bottom" />
                  )}
                </span>
              );
            }
            if (seg.kind === 'tool_call') {
              return (
                <ToolCallCard
                  key={seg.call_id}
                  call_id={seg.call_id}
                  highlighted={state.highlightedId === seg.call_id}
                  onHighlight={(id) => dispatch({ type: 'SET_HIGHLIGHT', id })}
                />
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}
