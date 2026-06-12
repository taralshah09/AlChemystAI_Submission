'use client';

import { useState, useRef, useEffect, useMemo, memo } from 'react';
import { useAgent } from '@/store/agentStore';
import type { TraceEvent } from '@/lib/ws/types';

const TYPE_COLORS: Record<string, string> = {
  TOKEN:            'text-zinc-400',
  TOOL_CALL:        'text-purple-400',
  TOOL_RESULT:      'text-green-400',
  CONTEXT_SNAPSHOT: 'text-cyan-400',
  PING:             'text-yellow-600',
  STREAM_END:       'text-blue-400',
  ERROR:            'text-red-400',
  USER_MESSAGE:     'text-blue-300',
  PONG:             'text-yellow-500',
  BUFFER_HOLD:      'text-orange-400',
};

const TYPE_LABELS: Record<string, string> = {
  TOKEN:            'TOKEN',
  TOOL_CALL:        'TOOL_CALL',
  TOOL_RESULT:      'TOOL_RESULT',
  CONTEXT_SNAPSHOT: 'CONTEXT',
  PING:             'PING',
  STREAM_END:       'STREAM_END',
  ERROR:            'ERROR',
  USER_MESSAGE:     'USER_MSG',
  PONG:             'PONG',
  BUFFER_HOLD:      'BUFFERED',
};

const EVENT_TYPES = ['TOKEN','TOOL_CALL','TOOL_RESULT','CONTEXT_SNAPSHOT','PING','STREAM_END','ERROR','USER_MESSAGE','BUFFER_HOLD'];

type LinkStyle = 'call-start' | 'call-end' | 'none';

const TraceRow = memo(function TraceRow({
  event,
  highlighted,
  linkStyle,
  onClick,
}: {
  event: TraceEvent;
  highlighted: boolean;
  linkStyle: LinkStyle;
  onClick: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = TYPE_COLORS[event.type] ?? 'text-zinc-300';
  const label = TYPE_LABELS[event.type] ?? event.type;
  const time = new Date(event.timestamp).toISOString().slice(11, 23);

  const isTokenBatch = event.type === 'TOKEN';
  const summary = isTokenBatch
    ? `Streamed ${event.tokenCount ?? 1} token${(event.tokenCount ?? 1) !== 1 ? 's' : ''} (${event.durationMs ?? 0}ms)`
    : getEventSummary(event);

  // Connector line borders for linked tool call pairs
  const connectorClass =
    linkStyle === 'call-start' ? 'border-l-2 border-purple-500/70' :
    linkStyle === 'call-end'   ? 'border-l-2 border-purple-500/70' :
    '';

  return (
    <div
      id={`trace-row-${event.id}`}
      className={`
        border-b border-zinc-800/50 cursor-pointer select-none relative
        ${highlighted ? 'bg-blue-950/50' : 'hover:bg-zinc-800/30'}
        ${connectorClass}
      `}
      onClick={() => { onClick(); setExpanded(e => isTokenBatch ? !e : e); }}
    >
      {/* Vertical connector line between TOOL_CALL and TOOL_RESULT */}
      {linkStyle === 'call-start' && (
        <span className="absolute left-[-1px] bottom-0 w-0.5 h-1/2 bg-purple-500/70 block" />
      )}
      {linkStyle === 'call-end' && (
        <span className="absolute left-[-1px] top-0 w-0.5 h-1/2 bg-purple-500/70 block" />
      )}

      <div className={`flex items-center gap-2 py-1.5 text-xs font-mono ${linkStyle === 'call-end' ? 'pl-5 pr-3' : 'px-3'}`}>
        <span className="text-zinc-600 w-20 shrink-0">{time}</span>
        <span className={`w-24 shrink-0 font-semibold ${color}`}>
          {linkStyle === 'call-end' && <span className="text-purple-500/70 mr-1">└</span>}
          {label}
        </span>
        <span className="text-zinc-400 truncate flex-1">{summary}</span>
        {event.seq > 0 && (
          <span className="text-zinc-600 shrink-0">#{event.seq}</span>
        )}
      </div>

      {expanded && isTokenBatch && event.tokenText && (
        <div className="px-3 pb-2 text-xs text-zinc-300 whitespace-pre-wrap font-mono pl-[112px]">
          {event.tokenText}
        </div>
      )}
    </div>
  );
});

function getEventSummary(event: TraceEvent): string {
  const p = event.payload;
  switch (p.type) {
    case 'TOOL_CALL': return `${p.tool_name} (${p.call_id})`;
    case 'TOOL_RESULT': return `result for ${p.call_id}`;
    case 'CONTEXT_SNAPSHOT': return `ctx:${p.context_id}`;
    case 'PING': return `challenge: ${p.challenge || '(empty)'}`;
    case 'STREAM_END': return `stream:${p.stream_id}`;
    case 'ERROR': return `[${p.code}] ${p.message}`;
    case 'USER_MESSAGE': return p.content;
    case 'BUFFER_HOLD': return `seq #${p.seq} arrived early — waiting for #${p.waiting_for}`;
    default: return '';
  }
}

export function TraceTimeline() {
  const { state, dispatch } = useAgent();
  const [filter, setFilter] = useState<Set<string>>(new Set(EVENT_TYPES));
  const [search, setSearch] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevHighlightRef = useRef<string | null>(null);

  // Auto-scroll unless user has scrolled up
  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [state.traceEvents.length]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  };

  // Scroll timeline to the TOOL_CALL row when a chat tool card is clicked (bidirectional)
  useEffect(() => {
    const id = state.highlightedId;
    if (!id || id === prevHighlightRef.current) return;
    prevHighlightRef.current = id;

    // Find the TOOL_CALL trace event whose linked_id matches the call_id
    const target =
      state.traceEvents.find(ev => ev.linked_id === id && ev.type === 'TOOL_CALL') ??
      state.traceEvents.find(ev => ev.id === id);

    if (!target) return;

    const el = document.getElementById(`trace-row-${target.id}`);
    if (!el) return;

    // Pause auto-scroll while we programmatically scroll to the target
    autoScrollRef.current = false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [state.highlightedId, state.traceEvents]);

  // Deduplicate TOKEN events: show only the batch row (one per contiguous batch)
  const filteredEvents = useMemo(() => {
    const seenTokenBatches = new Set<string>();
    return state.traceEvents.filter(ev => {
      if (!filter.has(ev.type)) return false;
      if (search) {
        const hay = JSON.stringify(ev.payload).toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      if (ev.type === 'TOKEN') {
        if (seenTokenBatches.has(ev.id)) return false;
        seenTokenBatches.add(ev.id);
      }
      return true;
    });
  }, [state.traceEvents, filter, search]);

  // call_ids that have both a TOOL_CALL and a TOOL_RESULT visible in the filtered list
  const linkedCallIds = useMemo(() => {
    const hasCalls = new Set<string>();
    const hasResults = new Set<string>();
    for (const ev of filteredEvents) {
      if (ev.type === 'TOOL_CALL' && ev.linked_id) hasCalls.add(ev.linked_id);
      if (ev.type === 'TOOL_RESULT' && ev.linked_id) hasResults.add(ev.linked_id);
    }
    return new Set([...hasCalls].filter(id => hasResults.has(id)));
  }, [filteredEvents]);

  const getLinkStyle = (ev: TraceEvent): LinkStyle => {
    if (ev.type === 'TOOL_CALL' && ev.linked_id && linkedCallIds.has(ev.linked_id)) return 'call-start';
    if (ev.type === 'TOOL_RESULT' && ev.linked_id && linkedCallIds.has(ev.linked_id)) return 'call-end';
    return 'none';
  };

  const toggleType = (t: string) => {
    setFilter(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full bg-zinc-950 border-l border-zinc-800">
      <div className="px-3 py-2 border-b border-zinc-800">
        <div className="text-xs font-semibold text-zinc-300 mb-2">Trace Timeline</div>
        <input
          type="text"
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500 mb-2"
        />
        <div className="flex flex-wrap gap-1">
          {EVENT_TYPES.map(t => (
            <button
              key={t}
              onClick={() => toggleType(t)}
              className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                filter.has(t)
                  ? `${TYPE_COLORS[t]} border-current bg-current/10`
                  : 'text-zinc-600 border-zinc-700'
              }`}
            >
              {TYPE_LABELS[t] ?? t}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {filteredEvents.map(ev => (
          <TraceRow
            key={ev.id}
            event={ev}
            highlighted={state.highlightedId === ev.id || state.highlightedId === ev.linked_id}
            linkStyle={getLinkStyle(ev)}
            onClick={() => dispatch({ type: 'SET_HIGHLIGHT', id: ev.linked_id ?? ev.id })}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="px-3 py-1.5 border-t border-zinc-800 text-[10px] text-zinc-600 font-mono">
        {filteredEvents.length} / {state.traceEvents.length} events
      </div>
    </div>
  );
}
