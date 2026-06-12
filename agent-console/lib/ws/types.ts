// Protocol message types — strictly typed, no `any` except the documented escape hatch

// ── Server → Client ──────────────────────────────────────────────────────────

export interface TokenMsg {
  type: 'TOKEN';
  seq: number;
  text: string;
  stream_id: string;
}

export interface ToolCallMsg {
  type: 'TOOL_CALL';
  seq: number;
  call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  stream_id: string;
}

export interface ToolResultMsg {
  type: 'TOOL_RESULT';
  seq: number;
  call_id: string;
  result: Record<string, unknown>;
  stream_id: string;
}

export interface ContextSnapshotMsg {
  type: 'CONTEXT_SNAPSHOT';
  seq: number;
  context_id: string;
  data: Record<string, unknown>;
}

export interface PingMsg {
  type: 'PING';
  seq: number;
  challenge: string;
}

export interface StreamEndMsg {
  type: 'STREAM_END';
  seq: number;
  stream_id: string;
}

export interface ErrorMsg {
  type: 'ERROR';
  seq: number;
  code: string;
  message: string;
}

export type ServerMessage =
  | TokenMsg
  | ToolCallMsg
  | ToolResultMsg
  | ContextSnapshotMsg
  | PingMsg
  | StreamEndMsg
  | ErrorMsg;

// ── Client → Server ──────────────────────────────────────────────────────────

export interface UserMessageOut {
  type: 'USER_MESSAGE';
  content: string;
}

export interface PongOut {
  type: 'PONG';
  echo: string;
}

export interface ResumeOut {
  type: 'RESUME';
  last_seq: number;
}

export interface ToolAckOut {
  type: 'TOOL_ACK';
  call_id: string;
}

export type ClientMessage = UserMessageOut | PongOut | ResumeOut | ToolAckOut;

// ── Application state types ───────────────────────────────────────────────────

export type ToolCallState = 'pending' | 'waiting_result' | 'completed';

export interface ToolCallEntry {
  call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  stream_id: string;
  seq: number;
  state: ToolCallState;
  result?: Record<string, unknown>;
  result_seq?: number;
}

export interface TokenChunk {
  text: string;
  seq: number;
}

export type MessageSegment =
  | { kind: 'tokens'; chunks: TokenChunk[]; frozen: boolean }
  | { kind: 'tool_call'; call_id: string };

export interface ChatMessage {
  id: string; // stream_id
  role: 'user' | 'agent';
  content?: string; // for user messages
  segments: MessageSegment[]; // for agent messages
  complete: boolean;
}

export interface ContextSnapshot {
  context_id: string;
  data: Record<string, unknown>;
  seq: number;
  timestamp: number;
}

// Synthetic event added when a message arrives with a seq gap and is held in the buffer
export interface BufferHoldPayload {
  type: 'BUFFER_HOLD';
  seq: number;
  waiting_for: number;
}

export interface TraceEvent {
  id: string; // unique per event
  seq: number;
  type: ServerMessage['type'] | 'PONG' | 'USER_MESSAGE' | 'BUFFER_HOLD';
  timestamp: number;
  payload: ServerMessage | ClientMessage | BufferHoldPayload;
  // For token batching
  tokenCount?: number;
  tokenText?: string;
  durationMs?: number;
  // Linked IDs for cross-panel highlight
  linked_id?: string; // call_id for TOOL_CALL/TOOL_RESULT
  stream_id?: string;
}

export type WsConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'resuming';
