'use client';

import { useEffect, useRef, useCallback } from 'react';
import { SequenceBuffer } from '@/lib/ws/sequenceBuffer';
import type { ServerMessage, ClientMessage } from '@/lib/ws/types';
import { useAgent } from '@/store/agentStore';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4747/ws';

// Backoff schedule: 500ms, 1s, 2s, 4s, capped at 10s
const BACKOFF = [500, 1000, 2000, 4000, 10000];

function getBackoff(attempt: number): number {
  return BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
}

let traceIdCounter = 0;
function nextTraceId(): string {
  return `trace-${++traceIdCounter}`;
}

let msgIdCounter = 0;
function nextMsgId(): string {
  return `msg-${++msgIdCounter}`;
}

export function useAgentSocket() {
  const { state, dispatch } = useAgent();
  const wsRef = useRef<WebSocket | null>(null);
  const bufferRef = useRef(new SequenceBuffer());
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUnmountedRef = useRef(false);
  // For token trace batching
  const tokenBatchRef = useRef<{ event_id: string; start: number } | null>(null);
  // Mirror of connectionState as a ref so event handlers always see the current value
  const connectionStateRef = useRef(state.connectionState);
  connectionStateRef.current = state.connectionState;

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const processMessage = useCallback((msg: ServerMessage) => {
    const now = Date.now();

    switch (msg.type) {
      case 'TOKEN': {
        dispatch({ type: 'APPEND_TOKEN', stream_id: msg.stream_id, text: msg.text, seq: msg.seq });

        if (!tokenBatchRef.current) {
          const event_id = nextTraceId();
          tokenBatchRef.current = { event_id, start: now };
          dispatch({
            type: 'ADD_TRACE_EVENT',
            event: {
              id: event_id,
              seq: msg.seq,
              type: 'TOKEN',
              timestamp: now,
              payload: msg,
              stream_id: msg.stream_id,
              tokenCount: 1,
              tokenText: msg.text,
              durationMs: 0,
            },
          });
        } else {
          dispatch({
            type: 'BATCH_TOKEN_TRACE',
            event_id: tokenBatchRef.current.event_id,
            text: msg.text,
            durationMs: now - tokenBatchRef.current.start,
          });
        }
        break;
      }

      case 'TOOL_CALL': {
        tokenBatchRef.current = null; // end token batch
        dispatch({ type: 'FREEZE_STREAM', stream_id: msg.stream_id });
        dispatch({
          type: 'ADD_TOOL_CALL',
          entry: {
            call_id: msg.call_id,
            tool_name: msg.tool_name,
            args: msg.args,
            stream_id: msg.stream_id,
            seq: msg.seq,
            state: 'waiting_result',
          },
        });
        dispatch({
          type: 'ADD_TRACE_EVENT',
          event: {
            id: nextTraceId(),
            seq: msg.seq,
            type: 'TOOL_CALL',
            timestamp: now,
            payload: msg,
            stream_id: msg.stream_id,
            linked_id: msg.call_id,
          },
        });
        // TOOL_ACK is sent immediately on raw receipt (in ws.onmessage) before
        // the reorder buffer, so ACK always reaches the server within ms regardless
        // of how long chaos mode holds the TOOL_CALL in the buffer.
        break;
      }

      case 'TOOL_RESULT': {
        dispatch({
          type: 'COMPLETE_TOOL_CALL',
          call_id: msg.call_id,
          result: msg.result,
          result_seq: msg.seq,
        });
        dispatch({ type: 'RESUME_STREAM', stream_id: msg.stream_id });
        dispatch({
          type: 'ADD_TRACE_EVENT',
          event: {
            id: nextTraceId(),
            seq: msg.seq,
            type: 'TOOL_RESULT',
            timestamp: now,
            payload: msg,
            stream_id: msg.stream_id,
            linked_id: msg.call_id,
          },
        });
        break;
      }

      case 'CONTEXT_SNAPSHOT': {
        tokenBatchRef.current = null;
        dispatch({
          type: 'ADD_CONTEXT_SNAPSHOT',
          snapshot: { context_id: msg.context_id, data: msg.data, seq: msg.seq, timestamp: now },
        });
        dispatch({
          type: 'ADD_TRACE_EVENT',
          event: {
            id: nextTraceId(),
            seq: msg.seq,
            type: 'CONTEXT_SNAPSHOT',
            timestamp: now,
            payload: msg,
          },
        });
        break;
      }

      case 'PING': {
        // Handle corrupt heartbeat (empty challenge) without crashing
        const challenge = msg.challenge ?? '';
        send({ type: 'PONG', echo: challenge });
        dispatch({
          type: 'ADD_TRACE_EVENT',
          event: {
            id: nextTraceId(),
            seq: msg.seq,
            type: 'PING',
            timestamp: now,
            payload: msg,
          },
        });
        break;
      }

      case 'STREAM_END': {
        tokenBatchRef.current = null;
        dispatch({ type: 'END_STREAM', stream_id: msg.stream_id });
        dispatch({
          type: 'ADD_TRACE_EVENT',
          event: {
            id: nextTraceId(),
            seq: msg.seq,
            type: 'STREAM_END',
            timestamp: now,
            payload: msg,
            stream_id: msg.stream_id,
          },
        });
        // Force-flush any buffered out-of-order messages
        const flushed = bufferRef.current.forceFlush();
        flushed.forEach(processMessage);
        break;
      }

      case 'ERROR': {
        dispatch({
          type: 'ADD_TRACE_EVENT',
          event: {
            id: nextTraceId(),
            seq: msg.seq,
            type: 'ERROR',
            timestamp: now,
            payload: msg,
          },
        });
        break;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, send]);

  const connect = useCallback(() => {
    if (isUnmountedRef.current) return;

    const isReconnect = bufferRef.current.getLastProcessed() > 0;
    dispatch({ type: 'SET_CONNECTION', state: isReconnect ? 'reconnecting' : 'connecting' });

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (isUnmountedRef.current) { ws.close(); return; }
      reconnectAttemptRef.current = 0;
      bufferRef.current.resetForReconnection();

      if (isReconnect) {
        // RESUME must be the first message on reconnection
        const last_seq = bufferRef.current.getLastProcessed();
        // Note: resetForReconnection clears heap but preserves lastProcessed
        // We need to send RESUME before setting state to 'resuming'
        ws.send(JSON.stringify({ type: 'RESUME', last_seq } satisfies ClientMessage));
        dispatch({ type: 'SET_CONNECTION', state: 'resuming' });
      } else {
        dispatch({ type: 'SET_CONNECTION', state: 'connected' });
      }
    };

    ws.onmessage = (evt) => {
      if (isUnmountedRef.current) return;

      let raw: unknown;
      try {
        raw = JSON.parse(evt.data as string);
      } catch {
        // Malformed JSON — log and ignore
        console.warn('[ws] malformed JSON:', evt.data);
        return;
      }

      // Basic validation
      if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
      const msg = raw as ServerMessage;

      // Send TOOL_ACK immediately on receipt — BEFORE the reorder buffer.
      // The server waits up to 5s; a latency spike of 2–8s on an earlier
      // message can hold the TOOL_CALL in the buffer past that deadline.
      if (msg.type === 'TOOL_CALL') {
        send({ type: 'TOOL_ACK', call_id: msg.call_id });
      }

      // Use the ref (not the stale closure value of state) so the resuming →
      // connected transition fires correctly after reconnection.
      if (connectionStateRef.current === 'resuming') {
        dispatch({ type: 'SET_CONNECTION', state: 'connected' });
      }

      // If this message arrives with a seq gap, it will be held in the buffer.
      // Log a BUFFER_HOLD trace event immediately so the timeline shows the
      // out-of-order arrival, letting the demo demonstrate that reordering works.
      const expectedNext = bufferRef.current.getLastProcessed() + 1;
      if (msg.seq > expectedNext) {
        dispatch({
          type: 'ADD_TRACE_EVENT',
          event: {
            id: nextTraceId(),
            seq: msg.seq,
            type: 'BUFFER_HOLD',
            timestamp: Date.now(),
            payload: { type: 'BUFFER_HOLD', seq: msg.seq, waiting_for: expectedNext },
          },
        });
      }

      // Push into reorder buffer; process whatever comes out in order
      const ready = bufferRef.current.push(msg);
      ready.forEach(processMessage);
    };

    ws.onerror = () => {
      // onclose fires after onerror; handle reconnect there
    };

    ws.onclose = () => {
      if (isUnmountedRef.current) return;
      wsRef.current = null;
      dispatch({ type: 'SET_CONNECTION', state: 'reconnecting' });
      tokenBatchRef.current = null;

      const delay = getBackoff(reconnectAttemptRef.current++);
      reconnectTimerRef.current = setTimeout(connect, delay);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, processMessage]);

  useEffect(() => {
    isUnmountedRef.current = false;
    connect();
    return () => {
      isUnmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  // connect is stable (no deps that change)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stall-recovery: if the reorder buffer holds messages but can't make progress
  // (e.g. STREAM_END itself gets stuck in the chaos engine's reorder buffer and
  // is never delivered), force-flush after 4 seconds to prevent a permanent stall.
  useEffect(() => {
    const stallCheck = setInterval(() => {
      if (bufferRef.current.size() > 0) {
        const flushed = bufferRef.current.forceFlush();
        flushed.forEach(processMessage);
      }
    }, 4000);
    return () => clearInterval(stallCheck);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processMessage]);

  const sendMessage = useCallback((content: string) => {
    tokenBatchRef.current = null;
    const id = nextMsgId();
    dispatch({ type: 'ADD_USER_MESSAGE', id, content });
    dispatch({
      type: 'ADD_TRACE_EVENT',
      event: {
        id: nextTraceId(),
        seq: -1,
        type: 'USER_MESSAGE',
        timestamp: Date.now(),
        payload: { type: 'USER_MESSAGE', content },
      },
    });
    send({ type: 'USER_MESSAGE', content });
  }, [dispatch, send]);

  return { sendMessage };
}
