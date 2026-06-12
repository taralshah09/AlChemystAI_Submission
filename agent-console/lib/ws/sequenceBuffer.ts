import type { ServerMessage } from './types';

/**
 * Reordering + deduplication buffer for WebSocket messages.
 *
 * In normal mode messages arrive in order. In chaos mode seq values may be
 * shuffled or duplicated. This buffer holds messages until they can be released
 * in strict seq order.
 *
 * Design: min-heap ordered by seq with a seen-set for O(1) dedup.
 * Flush strategy: release all contiguous messages starting from lastProcessed+1.
 */
export class SequenceBuffer {
  private heap: ServerMessage[] = [];
  private seen: Set<number> = new Set();
  // lastProcessed tracks the highest seq we have dispatched to the application
  private lastProcessed: number = 0;

  getLastProcessed(): number {
    return this.lastProcessed;
  }

  setLastProcessed(seq: number): void {
    this.lastProcessed = seq;
  }

  /**
   * Push a raw message from the socket. Returns messages ready to process in
   * order, or an empty array if none are ready yet.
   */
  push(msg: ServerMessage): ServerMessage[] {
    if (this.seen.has(msg.seq)) return [];
    this.seen.add(msg.seq);
    heapInsert(this.heap, msg);
    return this.flush();
  }

  /**
   * Force-flush everything remaining (e.g. on STREAM_END to avoid stalls).
   * Used when we detect the server may have skipped a seq in chaos mode.
   */
  forceFlush(): ServerMessage[] {
    const out: ServerMessage[] = [];
    while (this.heap.length > 0) {
      const msg = heapPop(this.heap)!;
      if (msg.seq > this.lastProcessed) {
        this.lastProcessed = msg.seq;
        out.push(msg);
      }
    }
    return out;
  }

  /**
   * Flush contiguous messages from lastProcessed+1 upward.
   */
  private flush(): ServerMessage[] {
    const out: ServerMessage[] = [];
    while (this.heap.length > 0 && this.heap[0].seq === this.lastProcessed + 1) {
      const msg = heapPop(this.heap)!;
      this.lastProcessed = msg.seq;
      out.push(msg);
    }
    return out;
  }

  /**
   * After reconnection + replay, clear the seen set of old seqs so replayed
   * messages that arrive with the same seq are accepted. We keep lastProcessed
   * so RESUME sends the correct value.
   */
  resetForReconnection(): void {
    this.heap = [];
    this.seen = new Set();
    // lastProcessed is preserved — that's what we send in RESUME
  }

  size(): number {
    return this.heap.length;
  }
}

// ── Min-heap helpers ──────────────────────────────────────────────────────────

function heapInsert(heap: ServerMessage[], msg: ServerMessage): void {
  heap.push(msg);
  siftUp(heap, heap.length - 1);
}

function heapPop(heap: ServerMessage[]): ServerMessage | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    siftDown(heap, 0);
  }
  return top;
}

function siftUp(heap: ServerMessage[], i: number): void {
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent].seq <= heap[i].seq) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}

function siftDown(heap: ServerMessage[], i: number): void {
  const n = heap.length;
  while (true) {
    let smallest = i;
    const l = 2 * i + 1;
    const r = 2 * i + 2;
    if (l < n && heap[l].seq < heap[smallest].seq) smallest = l;
    if (r < n && heap[r].seq < heap[smallest].seq) smallest = r;
    if (smallest === i) break;
    [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
    i = smallest;
  }
}
