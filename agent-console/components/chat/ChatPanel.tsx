'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAgent } from '@/store/agentStore';
import { useAgentSocket } from '@/hooks/useAgentSocket';
import { MessageBubble } from './MessageBubble';
import { ConnectionStatus } from '@/components/ui/ConnectionStatus';

export function ChatPanel() {
  const { state } = useAgent();
  const { sendMessage } = useAgentSocket();
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.messages.length, state.messages.at(-1)?.segments.length]);

  // Scroll chat panel to the highlighted element when timeline row is clicked (bidirectional)
  useEffect(() => {
    if (!state.highlightedId) return;
    const el =
      messagesRef.current?.querySelector<HTMLElement>(`#tool-${state.highlightedId}`) ??
      messagesRef.current?.querySelector<HTMLElement>(`#msg-${state.highlightedId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [state.highlightedId]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    sendMessage(trimmed);
    setInput('');
  };

  const isConnected = state.connectionState === 'connected' || state.connectionState === 'resuming';

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <h1 className="text-sm font-semibold text-zinc-100">Agent Console</h1>
        <ConnectionStatus state={state.connectionState} />
      </div>

      {/* Messages */}
      <div ref={messagesRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
        {state.messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-zinc-500 text-sm">
            {"Send a message to start. Try: \"hello\", \"report\", \"analyze\""}
          </div>
        )}
        {state.messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="px-4 py-3 border-t border-zinc-800">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={isConnected ? 'Type a message…' : 'Waiting for connection…'}
            disabled={!isConnected}
            className="
              flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2
              text-sm text-zinc-100 placeholder-zinc-500
              focus:outline-none focus:border-blue-500
              disabled:opacity-50 disabled:cursor-not-allowed
            "
          />
          <button
            type="submit"
            disabled={!isConnected || !input.trim()}
            className="
              px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium
              hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed
              transition-colors
            "
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
