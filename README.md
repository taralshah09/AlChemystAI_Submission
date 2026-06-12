# Agent Console

A Next.js application that connects to a mock AI agent backend over WebSockets, renders streaming responses with mid-stream tool call interruptions, displays a live agent trace timeline, and survives chaos-mode connection drops and out-of-order delivery without losing state.

---

## Architectural Approach

Protocol handling and rendering are strictly separated: a `SequenceBuffer` (min-heap + seen-set) absorbs and reorders incoming WebSocket frames before anything touches React state, while a single `useReducer` acts as the application's state machine — transitions are exhaustively typed and side-effect-free. The WebSocket lifecycle (connect → connected → reconnecting → resuming → connected) is managed in a single `useAgentSocket` hook; the UI never inspects the raw socket, only the derived `AgentState`.

---

**Recording link:** 
https://youtu.be/mOWjLlGElJ4

Scenarios shown in the recording:
1. Connection drop mid-stream → seamless reconnect + resume
2. Out-of-order seq delivery → tokens reordered, text correct
3. Rapid sequential tool calls → both cards appear, both results land
4. 500KB+ context snapshot → context panel stays interactive
5. Corrupt PING (empty challenge) → app does not crash or disconnect

---

## WebSocket State Machine

```
                ┌──────────────────────────────────────────────────────┐
                │                   CLIENT STATES                      │
                └──────────────────────────────────────────────────────┘

  app mount
      │
      ▼
 ┌────────────┐   socket opens    ┌───────────────┐
 │ connecting │──────────────────▶│   connected   │◀──────────────────┐
 └────────────┘                   └───────────────┘                   │
                                        │   │                         │
                          USER_MESSAGE  │   │ TOKEN / TOOL_CALL /     │
                                        │   │ TOOL_RESULT / PING      │
                                        ▼   ▼                         │
                                  ┌─────────────────┐                 │
                                  │    streaming    │                 │
                                  │  (in-progress   │                 │
                                  │   response)     │                 │
                                  └────────┬────────┘                 │
                                           │                          │
                                 STREAM_END│   socket.onclose         │
                                           │         │                │
                                           │         ▼                │
                                           │   ┌─────────────┐        │
                                           │   │ reconnecting│        │
                                           │   └──────┬──────┘        │
                                           │          │ backoff timer │
                                           │          ▼               │
                                           │   ┌─────────────┐        │
                                           │   │  resuming   │        │
                                           │   │ (RESUME sent│        │
                                           │   │  as first   │        │
                                           │   │  message)   │        │
                                           │   └──────┬──────┘        │
                                           │          │ server replays│
                                           │          └───────────────┘
                                           │
                                           ▼
                                    ┌────────────┐
                                    │ disconnected│  (only on unmount)
                                    └────────────┘


  Message segment state machine (per agent response):

  open-tokens  ──TOOL_CALL──▶  frozen-tokens + tool_card(waiting)
                                     │
                               TOOL_RESULT
                                     │
                                     ▼
                               tool_card(completed) + open-tokens
                                     │
                               TOOL_CALL (again)
                                     │
                                     ▼
                               frozen-tokens + tool_card(waiting) ...
                                     │
                               STREAM_END
                                     │
                                     ▼
                               all segments frozen, message.complete = true
```

---

## Running the App

### 1. Start the agent server

**Docker (recommended):**
```bash
cd agent-server
docker build -t agent-server .
docker run -p 4747:4747 agent-server           # normal mode
docker run -p 4747:4747 agent-server --mode chaos  # chaos mode
```

**Local (no Docker):**
```bash
cd agent-server
npm install
npm run build
node dist/index.js                             # normal mode
node dist/index.js --mode chaos                # chaos mode
```

Verify it's up: `curl http://localhost:4747/health`

### 2. Start the frontend

```bash
cd agent-console
npm install
npm run dev        # development — http://localhost:3000
# or
npm run build && npm start   # production build
```

### 3. Verify protocol compliance

After a session, check the server's client log:
```bash
curl -s http://localhost:4747/log | python3 -m json.tool
```
All entries should have `"verdict": "ok"`. The `/reset` endpoint clears the session.

### 4. Run unit tests
```bash
cd agent-console
npm test
```

---

## Try These Messages

| Message | What it exercises |
|---|---|
| `hello` | Basic streaming, no tool calls |
| `report` | One tool call mid-stream + context diff |
| `analyze` | Two sequential tool calls |
| `search` | Tool call before any tokens |
| `large` | 500KB+ context snapshot |
| `document` | Long streaming response |

---

## Project Structure
```
agent-console/
├── app/
│   ├── layout.tsx          — root layout (dark theme)
│   └── page.tsx            — main page: AgentProvider + 3-panel layout
├── lib/ws/
│   ├── types.ts            — all protocol types (zero any)
│   └── sequenceBuffer.ts   — min-heap reorder + dedup buffer
├── hooks/
│   └── useAgentSocket.ts   — WS lifecycle, reconnect, PING/PONG, TOOL_ACK
├── store/
│   └── agentStore.ts       — useReducer state machine + React context
├── components/
│   ├── chat/
│   │   ├── ChatPanel.tsx   — scrollable chat + input form
│   │   ├── MessageBubble.tsx — renders token segments + tool call cards
│   │   └── ToolCallCard.tsx  — tool call with waiting/completed states
│   ├── timeline/
│   │   └── TraceTimeline.tsx — live event log, token batching, filter bar
│   ├── context/
│   │   └── ContextInspector.tsx — JSON diff tree + history scrubber
│   └── ui/
│       └── ConnectionStatus.tsx — connection state badge
└── __tests__/
    └── sequenceBuffer.test.ts  — 10 unit tests for the reorder buffer
```