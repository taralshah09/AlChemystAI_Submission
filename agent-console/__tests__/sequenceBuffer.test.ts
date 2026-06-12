import { SequenceBuffer } from '../lib/ws/sequenceBuffer';
import type { ServerMessage } from '../lib/ws/types';

function token(seq: number, text = `t${seq}`): ServerMessage {
  return { type: 'TOKEN', seq, text, stream_id: 's1' };
}

describe('SequenceBuffer', () => {
  let buf: SequenceBuffer;

  beforeEach(() => { buf = new SequenceBuffer(); });

  test('empty buffer — returns nothing', () => {
    expect(buf.size()).toBe(0);
    expect(buf.getLastProcessed()).toBe(0);
  });

  test('single in-order message', () => {
    const out = buf.push(token(1));
    expect(out).toHaveLength(1);
    expect(out[0].seq).toBe(1);
    expect(buf.getLastProcessed()).toBe(1);
  });

  test('sequential messages all flush immediately', () => {
    const out1 = buf.push(token(1));
    const out2 = buf.push(token(2));
    const out3 = buf.push(token(3));
    expect(out1.map(m => m.seq)).toEqual([1]);
    expect(out2.map(m => m.seq)).toEqual([2]);
    expect(out3.map(m => m.seq)).toEqual([3]);
  });

  test('out-of-order — buffers until gap fills', () => {
    const out3 = buf.push(token(3)); // gap: missing 1, 2
    expect(out3).toHaveLength(0);
    expect(buf.size()).toBe(1);

    const out2 = buf.push(token(2)); // still missing 1
    expect(out2).toHaveLength(0);

    const out1 = buf.push(token(1)); // fills gap → flush 1,2,3
    expect(out1.map(m => m.seq)).toEqual([1, 2, 3]);
    expect(buf.size()).toBe(0);
    expect(buf.getLastProcessed()).toBe(3);
  });

  test('fully reversed sequence flushes in order', () => {
    buf.push(token(5));
    buf.push(token(4));
    buf.push(token(3));
    buf.push(token(2));
    const out = buf.push(token(1));
    expect(out.map(m => m.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test('duplicate seq — ignored after first', () => {
    const out1 = buf.push(token(1));
    const out1dup = buf.push(token(1, 'duplicate'));
    expect(out1).toHaveLength(1);
    expect(out1dup).toHaveLength(0);
    expect(buf.getLastProcessed()).toBe(1);
  });

  test('duplicate out-of-order — only first instance kept', () => {
    buf.push(token(2));
    buf.push(token(2, 'dup')); // ignored
    const out = buf.push(token(1));
    expect(out.map(m => m.seq)).toEqual([1, 2]);
    expect(out[1]).toMatchObject({ text: 't2' }); // original, not dup
  });

  test('forceFlush releases remaining buffered messages', () => {
    buf.push(token(3));
    buf.push(token(5));
    // gap at 1,2,4 — nothing flushed yet
    const out = buf.forceFlush();
    expect(out.map(m => m.seq).sort((a, b) => a - b)).toEqual([3, 5]);
  });

  test('setLastProcessed / resetForReconnection preserves lastProcessed', () => {
    buf.push(token(1));
    buf.push(token(2));
    expect(buf.getLastProcessed()).toBe(2);
    buf.resetForReconnection();
    expect(buf.getLastProcessed()).toBe(2); // preserved for RESUME
    expect(buf.size()).toBe(0);
  });

  test('messages after reconnection (seq restarts) handled correctly', () => {
    buf.push(token(1));
    buf.push(token(2));
    buf.resetForReconnection();
    buf.setLastProcessed(0); // simulate server replaying from 0
    const out = buf.push(token(1));
    expect(out).toHaveLength(1);
  });
});
