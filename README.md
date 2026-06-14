# Agent Console

A Next.js frontend that connects to a mock AI agent backend over WebSockets and renders streaming responses correctly under out-of-order delivery, mid-stream connection drops, rapid tool calls, and oversized context payloads.

---

## Recording

[https://youtu.be/mOWjLlGElJ4](https://youtu.be/mOWjLlGElJ4)

| Scenario | What it proves |
|---|---|
| Connection drop mid-stream | Reconnect + RESUME with no visible state loss |
| Out-of-order seq delivery | Tokens reordered, text correct |
| Rapid sequential tool calls | Both cards appear, both results land |
| 500KB+ context snapshot | Context panel stays interactive |
| Corrupt PING (empty challenge) | App does not crash or disconnect |

---

## Architecture

[View on Eraser](https://app.eraser.io/workspace/Q1UQ4FkHO0yMPkTHfCLo?origin=share)

<img width="903" height="658" alt="image" src="https://github.com/user-attachments/assets/d8b92b8b-5f95-4440-9917-7fa7ecccecb8" />
<img width="912" height="407" alt="image" src="https://github.com/user-attachments/assets/75baef5e-5e7e-4892-841b-318b886273aa" />

Four strict layers, each with a single responsibility:

```
Layer 4 — Presentation
  ChatPanel · MessageBubble · ToolCallCard · TraceTimeline · ContextInspector

Layer 3 — Application State
  AgentContext (React Context + useReducer)
  agentReducer: 12 actions, pure, no side-effects

Layer 2 — Protocol / Reordering
  useAgentSocket: WebSocket lifecycle, backoff, PING/PONG, RESUME
  SequenceBuffer: min-heap + seen-set, absorbs out-of-order and duplicate frames

Layer 1 — Transport
  Browser native WebSocket, JSON text frames
```

---

## How It Works

### Inbound (server to UI)

Every server message carries a monotonically increasing `seq`. This is the pipeline each frame goes through:

```
ws.onmessage
  │
  ▼
JSON.parse + type-guard
  │
  ▼
Pre-buffer intercepts (before the heap)
  ├── TOOL_CALL   → send TOOL_ACK immediately (server has a 5s deadline)
  ├── resuming    → flip connectionState to 'connected'
  └── seq gap     → dispatch BUFFER_HOLD trace event at real arrival time
  │
  ▼
SequenceBuffer.push(msg)
  ├── duplicate seq   → seen-set hit, dropped
  ├── contiguous seq  → flush immediately, advance lastProcessed
  └── gap in seq      → held in min-heap until gap fills
  │
  ▼
processMessage for each released message (strict seq order)
  ├── TOKEN            → APPEND_TOKEN + batch into single trace row
  ├── TOOL_CALL        → FREEZE_STREAM, ADD_TOOL_CALL
  ├── TOOL_RESULT      → COMPLETE_TOOL_CALL, RESUME_STREAM
  ├── CONTEXT_SNAPSHOT → ADD_CONTEXT_SNAPSHOT
  ├── PING             → send PONG
  └── STREAM_END       → END_STREAM + forceFlush buffer
  │
  ▼
agentReducer (pure) → new AgentState → React re-render
```

### Outbound (UI to server)

```
User submits message
  → dispatch ADD_USER_MESSAGE (renders immediately, no server round-trip wait)
  → ws.send({ type: 'USER_MESSAGE', content })
```

### Connection Lifecycle

```
mount → connect()
  │
  ├── fresh:   SET_CONNECTION 'connected'
  └── resume:  send RESUME { last_seq } → SET_CONNECTION 'resuming'
                                        → 'connected' on first server message
ws.onclose → SET_CONNECTION 'reconnecting'
           → schedule connect() with backoff [500ms, 1s, 2s, 4s, 10s]
```

---

## Architectural Decisions

### SequenceBuffer: min-heap over array sort or Map

Messages arrive at 30-80ms intervals. Sorting an array on every push is O(n log n). A Map requires a separate minimum-key scan on each flush at O(k). The heap gives O(log k) insert and O(1) minimum access, where k is the buffer depth (usually 1-5 in chaos mode). A `Set<number>` alongside it gives O(1) deduplication for replayed frames.

`lastProcessed` tracks what the reducer has consumed, not what the socket received. On reconnect, this value is sent as `last_seq` in the RESUME message. `resetForReconnection()` clears the heap and seen-set but preserves `lastProcessed` so the RESUME carries the correct value.

### Frozen token segments prevent layout shift

Agent messages are stored as `segments: MessageSegment[]`, alternating between token blocks and tool call references. When TOOL_CALL arrives mid-stream:

1. The current token segment is marked `frozen: true` (React never touches those DOM nodes again)
2. A `{ kind: 'tool_call', call_id }` segment is appended below it
3. On TOOL_RESULT, a new unfrozen token segment opens after the card

Multiple sequential tool calls produce a stack of frozen-tokens / tool-card / frozen-tokens / tool-card / live-tokens with no reflow between them.

### Pre-buffer TOOL_ACK

The server starts a 5-second ACK timer the moment it sends TOOL_CALL. In chaos mode, the reorder buffer can hold messages for 2-8 seconds. If TOOL_ACK were sent after the heap flushes, the deadline would expire. TOOL_ACK is sent inside `ws.onmessage` before the message enters the heap.

### `connectionStateRef` instead of `connectionState` in callbacks

`ws.onmessage` is captured once in a stable `useCallback`. A `useRef` that mirrors `connectionState` on every render lets the callback read the current state without being recreated on every state change. Recreating the callback would reconstruct the socket.

### Depth-gated tree expansion in ContextInspector

`TreeNode` initialises as `useState(depth < 2)`. A 500KB context object with deeply nested keys renders only the top two levels on mount. Deeper subtrees are added to the DOM only when the user clicks. Without this, a single large snapshot would block the main thread during layout.

### forceFlush on STREAM_END plus a 4-second fallback timer

When STREAM_END arrives, `forceFlush()` releases any messages still held in the heap. If STREAM_END itself is reordered by the chaos engine and never arrives on the client, a `setInterval` calls `forceFlush()` every 4 seconds as a fallback. Both paths converge on the same outcome: no permanent stall.

---

## Running the App

### 1. Start the agent server

**Docker:**
```bash
cd agent-server
docker build -t agent-server .
docker run -p 4747:4747 agent-server              # normal mode
docker run -p 4747:4747 agent-server --mode chaos  # chaos mode
```

**Local:**
```bash
cd agent-server
npm install
npm run build
node dist/index.js                # normal mode
node dist/index.js --mode chaos   # chaos mode
```

Verify: `curl http://localhost:4747/health`

### 2. Start the frontend

```bash
cd agent-console
npm install
npm run dev       # http://localhost:3000
```

### 3. Verify protocol compliance

After a session, pull the server's client log:
```bash
curl -s http://localhost:4747/log | python3 -m json.tool
```
All entries should have `"verdict": "ok"`. Use `/reset` to clear the session.

### 4. Unit tests

```bash
cd agent-console
npm test
```

Tests cover: empty buffer, sequential delivery, out-of-order, fully reversed, duplicates, forceFlush, and reconnection state preservation.

---

## Trigger Keywords

Send these messages in the chat to trigger specific server responses:

| Keyword | Response |
|---|---|
| `hello` | Short token stream |
| `report` | Token stream with a single tool call |
| `analyze` | Token stream with two sequential tool calls |
| `search` | Token stream with rapid parallel tool calls |
| `large` | 500KB+ context snapshot |
| `document` | Long streaming response |
