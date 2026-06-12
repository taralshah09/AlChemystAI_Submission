'use client';

import { createContext, useContext, useReducer, useRef, useCallback, type Dispatch } from 'react';
import type {
  ChatMessage,
  ContextSnapshot,
  MessageSegment,
  ToolCallEntry,
  TraceEvent,
  WsConnectionState,
} from '@/lib/ws/types';

// ── State ─────────────────────────────────────────────────────────────────────

export interface AgentState {
  connectionState: WsConnectionState;
  messages: ChatMessage[];
  toolCalls: Record<string, ToolCallEntry>;
  contextSnapshots: Record<string, ContextSnapshot[]>; // context_id → history
  traceEvents: TraceEvent[];
  // highlight: which element is currently focused (chat msg id or trace event id)
  highlightedId: string | null;
}

const initialState: AgentState = {
  connectionState: 'disconnected',
  messages: [],
  toolCalls: {},
  contextSnapshots: {},
  traceEvents: [],
  highlightedId: null,
};

// ── Actions ───────────────────────────────────────────────────────────────────

export type AgentAction =
  | { type: 'SET_CONNECTION'; state: WsConnectionState }
  | { type: 'ADD_USER_MESSAGE'; id: string; content: string }
  | { type: 'APPEND_TOKEN'; stream_id: string; text: string; seq: number }
  | { type: 'FREEZE_STREAM'; stream_id: string }
  | { type: 'RESUME_STREAM'; stream_id: string }
  | { type: 'ADD_TOOL_CALL'; entry: ToolCallEntry }
  | { type: 'COMPLETE_TOOL_CALL'; call_id: string; result: Record<string, unknown>; result_seq: number }
  | { type: 'END_STREAM'; stream_id: string }
  | { type: 'ADD_CONTEXT_SNAPSHOT'; snapshot: ContextSnapshot }
  | { type: 'ADD_TRACE_EVENT'; event: TraceEvent }
  | { type: 'BATCH_TOKEN_TRACE'; event_id: string; text: string; durationMs: number }
  | { type: 'SET_HIGHLIGHT'; id: string | null }
  | { type: 'RESET' };

// ── Reducer ───────────────────────────────────────────────────────────────────

function ensureAgentMessage(messages: ChatMessage[], stream_id: string): ChatMessage[] {
  if (messages.some(m => m.id === stream_id)) return messages;
  const newMsg: ChatMessage = {
    id: stream_id,
    role: 'agent',
    segments: [{ kind: 'tokens', chunks: [], frozen: false }],
    complete: false,
  };
  return [...messages, newMsg];
}

export function agentReducer(state: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case 'SET_CONNECTION':
      return { ...state, connectionState: action.state };

    case 'ADD_USER_MESSAGE': {
      const msg: ChatMessage = {
        id: action.id,
        role: 'user',
        content: action.content,
        segments: [],
        complete: true,
      };
      return { ...state, messages: [...state.messages, msg] };
    }

    case 'APPEND_TOKEN': {
      const messages = ensureAgentMessage(state.messages, action.stream_id);
      return {
        ...state,
        messages: messages.map(m => {
          if (m.id !== action.stream_id) return m;
          const segments = [...m.segments];
          const last = segments[segments.length - 1];
          if (last && last.kind === 'tokens' && !last.frozen) {
            segments[segments.length - 1] = {
              ...last,
              chunks: [...last.chunks, { text: action.text, seq: action.seq }],
            };
          } else {
            segments.push({ kind: 'tokens', chunks: [{ text: action.text, seq: action.seq }], frozen: false });
          }
          return { ...m, segments };
        }),
      };
    }

    case 'FREEZE_STREAM': {
      return {
        ...state,
        messages: state.messages.map(m => {
          if (m.id !== action.stream_id) return m;
          return {
            ...m,
            segments: m.segments.map(seg =>
              seg.kind === 'tokens' && !seg.frozen ? { ...seg, frozen: true } : seg
            ),
          };
        }),
      };
    }

    case 'RESUME_STREAM': {
      // Open a new tokens segment after tool call card
      return {
        ...state,
        messages: state.messages.map(m => {
          if (m.id !== action.stream_id) return m;
          const last = m.segments[m.segments.length - 1];
          if (last && last.kind === 'tokens' && !last.frozen) return m; // already open
          return {
            ...m,
            segments: [...m.segments, { kind: 'tokens', chunks: [], frozen: false }],
          };
        }),
      };
    }

    case 'ADD_TOOL_CALL': {
      const messages = ensureAgentMessage(state.messages, action.entry.stream_id);
      return {
        ...state,
        toolCalls: { ...state.toolCalls, [action.entry.call_id]: action.entry },
        messages: messages.map(m => {
          if (m.id !== action.entry.stream_id) return m;
          const seg: MessageSegment = { kind: 'tool_call', call_id: action.entry.call_id };
          return { ...m, segments: [...m.segments, seg] };
        }),
      };
    }

    case 'COMPLETE_TOOL_CALL': {
      const existing = state.toolCalls[action.call_id];
      if (!existing) return state;
      return {
        ...state,
        toolCalls: {
          ...state.toolCalls,
          [action.call_id]: {
            ...existing,
            state: 'completed',
            result: action.result,
            result_seq: action.result_seq,
          },
        },
      };
    }

    case 'END_STREAM': {
      return {
        ...state,
        messages: state.messages.map(m => {
          if (m.id !== action.stream_id) return m;
          return { ...m, complete: true };
        }),
      };
    }

    case 'ADD_CONTEXT_SNAPSHOT': {
      const { context_id } = action.snapshot;
      const existing = state.contextSnapshots[context_id] ?? [];
      return {
        ...state,
        contextSnapshots: {
          ...state.contextSnapshots,
          [context_id]: [...existing, action.snapshot],
        },
      };
    }

    case 'ADD_TRACE_EVENT':
      return { ...state, traceEvents: [...state.traceEvents, action.event] };

    case 'BATCH_TOKEN_TRACE': {
      // Update the last TOKEN trace event with accumulated count/text/duration
      const idx = state.traceEvents.findLastIndex(e => e.id === action.event_id);
      if (idx === -1) return state;
      const updated = {
        ...state.traceEvents[idx],
        tokenText: (state.traceEvents[idx].tokenText ?? '') + action.text,
        tokenCount: (state.traceEvents[idx].tokenCount ?? 0) + 1,
        durationMs: action.durationMs,
      };
      const events = [...state.traceEvents];
      events[idx] = updated;
      return { ...state, traceEvents: events };
    }

    case 'SET_HIGHLIGHT':
      return { ...state, highlightedId: action.id };

    case 'RESET':
      return initialState;

    default:
      return state;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

interface AgentContextValue {
  state: AgentState;
  dispatch: Dispatch<AgentAction>;
}

import { createElement } from 'react';

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
export const AgentContext = createContext<AgentContextValue>(null!);

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(agentReducer, initialState);
  return createElement(AgentContext.Provider, { value: { state, dispatch } }, children);
}

export function useAgent() {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used within AgentProvider');
  return ctx;
}
