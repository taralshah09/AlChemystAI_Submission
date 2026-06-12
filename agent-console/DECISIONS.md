# Architecture & Design Decisions

## 1. Seq-Based Ordering and Deduplication

**Data structure:** A min-heap (`SequenceBuffer` in `lib/ws/sequenceBuffer.ts`) paired with a `Set<number>` for seen sequence numbers.

**Why a heap, not an array sort or a map:**
- Messages arrive continuously at 30–80ms intervals. Sorting an array on every push is O(n log n) per message. A heap insert is O(log k) where k is the buffer depth (usually 1–5 in chaos mode), making it effectively O(1) in practice.
- A `Map<seq, msg>` would work but requires a separate "find lowest missing key" scan on every flush — O(k) per message. The heap always exposes the minimum at index 0, so the flush check is O(1).
- The `seen` Set gives O(1) deduplication — critical because chaos mode can replay the same seq twice in quick succession.

**Flush strategy:** After every push, drain the heap while `heap[0].seq === lastProcessed + 1`. This means out-of-order bursts are held in the buffer until the gap closes. On `STREAM_END`, `forceFlush()` releases everything regardless of gaps, preventing a stall when the server skips a seq in chaos mode.

**The RESUME contract:** `lastProcessed` tracks the highest seq that has been fully dispatched to the React reducer (i.e., rendered to the DOM), not merely received. On reconnection this value is sent verbatim as `last_seq` in the `RESUME` message. `resetForReconnection()` clears the heap and seen-set (so replayed messages are accepted again) but *preserves* `lastProcessed` so the RESUME value remains correct. This is the key invariant: received ≠ processed.

---

## 2. Layout Shift Prevention During Tool Call Interruptions

**The problem:** When `TOOL_CALL` arrives mid-stream, naively appending a card to the text would reflow the entire bubble, causing the preceding text to jump.

**The solution — immutable frozen segments:** Each agent message is a `segments: MessageSegment[]` array in the reducer. Every segment is either `{ kind: 'tokens', chunks: [], frozen: boolean }` or `{ kind: 'tool_call', call_id }`.

On `TOOL_CALL`:
1. `FREEZE_STREAM` marks the current tokens segment `frozen: true`. React renders it as a static `<span>` — no cursor, no updates.
2. A new `{ kind: 'tool_call', call_id }` segment is appended. The card renders *below* the frozen text.

On `TOOL_RESULT`:
1. The `toolCalls` record is updated in-place (same object identity for unchanged entries due to spread).
2. `RESUME_STREAM` opens a new `{ kind: 'tokens', frozen: false }` segment after the tool card.

Because frozen segments are never mutated, React's reconciler never touches those DOM nodes again. The text does not reflow. Multiple sequential tool calls produce a stack of alternating frozen-tokens → tool-card → frozen-tokens → tool-card → open-tokens.

**CSS discipline:** Token spans use `whitespace-pre-wrap` but no `height` or `line-height` transitions that could cause paint. Tool cards use `my-2` margin which is part of normal flow and does not reposition the preceding text.

---

## 3. Reconnection State Recovery

**The problem tutorials get wrong:** Most WebSocket reconnect examples call `socket.close()` and then immediately render a spinner, losing all in-flight state. The challenge is stitching replayed events into existing DOM state without the user seeing a jump.

**How this implementation tracks "consumed" vs "received":**
- `SequenceBuffer.lastProcessed` is the consumed marker — it only advances when the reducer `dispatch` has been called, not when the socket receives the raw bytes.
- The React state (`messages`, `toolCalls`) *is* the consumed state. If the socket drops mid-tool-call, `toolCalls[call_id]` still exists with `state: 'waiting_result'`. The card remains visible.
- On reconnect, the server replays everything after `last_seq`. Replayed `TOOL_CALL` events have the same `call_id`, so `ADD_TOOL_CALL` with the same key is idempotent (the reducer upserts into the Record). Replayed `TOOL_RESULT` events call `COMPLETE_TOOL_CALL`, which updates the already-visible card — the user sees the result appear without any flicker.
- Replayed `TOKEN` events push new chunks to the existing segment. The seen-set in `SequenceBuffer` deduplicates any tokens that were fully processed before the drop.

**Reconnect flow:**
```
onclose → state = 'reconnecting' → setTimeout(connect, backoff)
onopen  → RESUME sent FIRST (before any other message)
        → state = 'resuming'
        → server replays missed events
        → first real message → state = 'connected'
```

The UI stays interactive throughout — the chat panel is never unmounted or disabled; only the input is gated on `connectionState === 'connected' | 'resuming'`.

---

## 4. If This Needed 50 Concurrent Agent Streams (Operations Dashboard)

**Current architecture bottleneck:** A single `useReducer` holding all state means every token from every stream goes through one React reconciler cycle. At 50 streams × 30 tokens/sec = 1,500 dispatches/sec, this would cause constant full-subtree re-renders.

**What I would change:**
- **Split state by stream_id.** Each agent stream gets its own React context or Zustand slice. The chat panel for stream N subscribes only to stream N's state.
- **Move protocol handling off the main thread.** The WebSocket message handler, sequence buffer, and reducer would move to a Web Worker. The Worker sends batched UI updates to the main thread at 60fps via `postMessage`. This decouples protocol throughput from render throughput.
- **Virtualise the chat list.** With 50 streams open, a virtualised scroller (e.g. `@tanstack/virtual`) is mandatory — only visible stream panels are in the DOM.
- **Shared heartbeat manager.** One PING/PONG handler per WebSocket (already the case), not one per stream, but the manager would need to track timeouts across 50 connections.

---

## 5. If Agent Responses Were 100× Longer (Full Document Generation)

**Current bottleneck:** `chunks: TokenChunk[]` grows linearly. Rendering `message.segments.map(seg => seg.chunks.map(...).join(''))` on every token re-computes the full text string for every render. At 100× length (~50,000 tokens) this is ~5MB of string allocation per render cycle.

**What I would change:**
- **Accumulate text as a single string, not a chunk array.** Each segment stores `text: string` appended in-place. React only re-renders the segment that grew, not the full message.
- **Virtualise the token text.** For very long responses, only the visible portion of the text needs to be in the DOM. A virtualised text renderer (chunked into paragraphs, rendered lazily) would keep layout stable.
- **Defer context snapshot diffs.** The `diffObjects` function runs synchronously on every snapshot. For 500KB+ payloads at 100× scale, this should be moved to a Worker with the result streamed back as a diff patch.
- **IndexedDB persistence.** Long documents should survive a page refresh. The consumed state (messages, context snapshots) would be checkpointed to IndexedDB keyed by session ID.

---

## Protocol Race Condition: TOOL_ACK Timeout

The README hints at a race condition in the TOOL_ACK flow — and there is one:

**The race:** The server sends `TOOL_CALL` (seq N) and starts a 5-second timer waiting for `TOOL_ACK`. In chaos mode, the server may drop the connection *before* the client sends `TOOL_ACK`. The client reconnects and sends `RESUME { last_seq: N-1 }`. The server replays the `TOOL_CALL`. But the server's TOOL_ACK timer was started on the *old connection* and has already expired — so the server logs a protocol violation even though the client never had a chance to ACK on the original connection.

**The consequence:** This is not a client bug — it's an unavoidable race between the connection drop and the ACK deadline. The client does the right thing (replays RESUME, receives replayed TOOL_CALL, sends ACK on the new connection). But the server's log will show a "violation" for the original connection's missed ACK.

**What a more robust protocol would do:** The TOOL_ACK timer should reset on reconnection when the server replays the TOOL_CALL, not carry over from the dropped connection's timeout. Alternatively, the TOOL_ACK could be made idempotent across connections (the client sends it on every connection that receives the TOOL_CALL, and the server deduplicates).
