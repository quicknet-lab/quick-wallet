import { Buffer } from 'buffer';
import { describe, expect, it } from 'vitest';
import { TX_REQUEST_MAX_BYTES, encodeProofRequest, encodeTxRequest } from './ble';

describe('encodeTxRequest', () => {
  it('frames a request as BEGIN, DATA chunks that fit one write, and COMMIT', () => {
    const boc = Buffer.from(Array.from({ length: 500 }, (_, i) => i & 0xff));
    const writes = encodeTxRequest(boc, { bounceable: true, testOnly: false });

    // length 500 = 0x01f4, bounceable flag, no token label, empty symbol
    expect([...writes[0]]).toEqual([0x01, 0x01, 0xf4, 0x01, 0xff, 0x00]);
    const data = writes.slice(1, -1);
    expect(data.every((w) => w[0] === 0x02 && w.length <= 244)).toBe(true);
    expect(Buffer.concat(data.map((w) => w.subarray(1))).equals(boc)).toBe(true);
    expect([...writes[writes.length - 1]]).toEqual([0x03]);
  });

  it('labels jetton amounts with the decimals and an ASCII symbol', () => {
    const [begin] = encodeTxRequest(Buffer.alloc(1), {
      bounceable: false,
      testOnly: true,
      token: { symbol: 'USD₮', decimals: 6 },
    });
    expect(begin[3]).toBe(0x02);
    expect(begin[4]).toBe(6);
    expect(begin[5]).toBe(4);
    expect(Buffer.from(begin.subarray(6)).toString('latin1')).toBe('USDT');
  });

  it('cuts a long symbol to what the device takes', () => {
    const [begin] = encodeTxRequest(Buffer.alloc(1), {
      bounceable: false,
      testOnly: false,
      token: { symbol: 'VERYLONGSYMBOLNAME', decimals: 9 },
    });
    expect(Buffer.from(begin.subarray(6)).toString('latin1')).toBe('VERYLONGSY');
  });

  it('leaves amounts unlabelled when the decimals are out of range', () => {
    const [begin] = encodeTxRequest(Buffer.alloc(1), {
      bounceable: false,
      testOnly: false,
      token: { symbol: 'X', decimals: 40 },
    });
    expect([begin[4], begin[5], begin.length]).toEqual([0xff, 0, 6]);
  });

  it('refuses an empty or oversized request', () => {
    const hint = { bounceable: true, testOnly: false };
    expect(() => encodeTxRequest(Buffer.alloc(0), hint)).toThrow(/at most/);
    expect(() => encodeTxRequest(Buffer.alloc(TX_REQUEST_MAX_BYTES + 1), hint)).toThrow(/at most/);
    expect(() => encodeTxRequest(Buffer.alloc(TX_REQUEST_MAX_BYTES), hint)).not.toThrow();
  });
});

describe('encodeProofRequest', () => {
  it('frames [flags][timestamp BE][domain length][domain][payload]', () => {
    const writes = encodeProofRequest({ domain: 'app.example', timestamp: 0x01020304, payload: 'nonce', testnet: true });
    const record = Buffer.concat(writes.slice(1, -1).map((w) => w.subarray(1)));
    expect([...writes[0]]).toEqual([0x01, 0x00, record.length]);
    expect([...record.subarray(0, 10)]).toEqual([0x01, 0, 0, 0, 0, 1, 2, 3, 4, 11]);
    expect(Buffer.from(record.subarray(10)).toString('latin1')).toBe('app.examplenonce');
    expect([...writes[writes.length - 1]]).toEqual([0x03]);
  });

  it('refuses a domain the device could not show', () => {
    expect(() => encodeProofRequest({ domain: 'App.Example', timestamp: 0, payload: '', testnet: false })).toThrow();
    expect(() => encodeProofRequest({ domain: 'x'.repeat(129), timestamp: 0, payload: '', testnet: false })).toThrow();
    expect(() => encodeProofRequest({ domain: 'a.b', timestamp: 0, payload: 'p'.repeat(257), testnet: false })).toThrow();
  });
});
