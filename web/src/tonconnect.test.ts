import { Buffer } from 'buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Address, beginCell, storeStateInit, toNano } from '@ton/core';
import { createWalletContract } from './wallet';
import {
  ERROR,
  TonConnectError,
  fetchManifest,
  isNewRequest,
  listen,
  markRequestAnswered,
  parseConnectLink,
  decodeTokenTransfer,
  parseSendTransaction,
  tonProofHash,
  type ConnectedApp,
} from './tonconnect';
import { SessionCrypto } from '@tonconnect/protocol';

const clientId = 'ab'.repeat(32);
const request = { manifestUrl: 'https://example.com/tonconnect-manifest.json', items: [{ name: 'ton_addr' }] };
const query = `v=2&id=${clientId}&r=${encodeURIComponent(JSON.stringify(request))}&ret=none`;

describe('parseConnectLink', () => {
  it('reads tc:// links, any wallet\'s universal link and a bare query alike', () => {
    for (const link of [`tc://?${query}`, `https://app.tonkeeper.com/ton-connect?${query}`, query]) {
      expect(parseConnectLink(link)).toEqual({ clientId, request });
    }
  });

  it('refuses what is not a v2 connect link', () => {
    expect(() => parseConnectLink('https://example.com')).toThrow(/not a TON Connect link/);
    expect(() => parseConnectLink(query.replace('v=2', 'v=1'))).toThrow(/version/);
    expect(() => parseConnectLink(`v=2&id=${clientId}&r=%7Bbroken`)).toThrow(/damaged/);
    const noAddr = encodeURIComponent(JSON.stringify({ ...request, items: [{ name: 'ton_proof', payload: 'x' }] }));
    expect(() => parseConnectLink(`v=2&id=${clientId}&r=${noAddr}`)).toThrow(/wallet address/);
  });

  it('refuses another wallet\'s link, whose site would wait on that wallet\'s bridge', () => {
    expect(() => parseConnectLink(`https://connect.mytonwallet.org?${query}`)).toThrow(/another wallet \(connect\.mytonwallet\.org\).*Tonkeeper/);
    expect(parseConnectLink(`https://app.tonkeeper.com/pro/ton-connect?${query}`).clientId).toBe(clientId);
  });
});

describe('request repeats', () => {
  it('lets through only ids above the last one answered', () => {
    const app = {} as ConnectedApp;
    expect(isNewRequest(app, '5')).toBe(true);
    markRequestAnswered(app, '5');
    expect(isNewRequest(app, '5')).toBe(false);
    expect(isNewRequest(app, '4')).toBe(false);
    expect(isNewRequest(app, '6')).toBe(true);
    markRequestAnswered(app, '3'); // never moves back
    expect(app.lastRequestId).toBe(5);
    expect(isNewRequest(app, 'not-a-number')).toBe(true);
  });
});

describe('listen', () => {
  class FakeSource extends EventTarget {
    static CLOSED = 2;
    static all: FakeSource[] = [];
    readyState = 0;
    closed = false;
    readonly url: string;
    constructor(url: string) {
      super();
      this.url = url;
      FakeSource.all.push(this);
    }
    close() {
      this.closed = true;
      this.readyState = 2;
    }
  }

  beforeEach(() => {
    FakeSource.all = [];
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeSource);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const site = new SessionCrypto();
  const app: ConnectedApp = {
    keyPair: new SessionCrypto().stringifyKeypair(),
    clientId: site.sessionId,
    manifest: { name: 'Site', url: 'https://site.example', domain: 'site.example' },
    network: 'testnet',
    address: '0:' + '00'.repeat(32),
    nextEventId: 1,
    lastEventId: '41',
  };

  it('hands over each request with its bridge event id, resuming after the last one dealt with', () => {
    const got: [string, string | undefined][] = [];
    listen(app, (request, eventId) => got.push([request.method, eventId]));
    expect(new URL(FakeSource.all[0].url).searchParams.get('last_event_id')).toBe('41');
    const ours = new SessionCrypto(app.keyPair);
    const sealed = site.encrypt(JSON.stringify({ method: 'disconnect', params: [], id: '7' }), Buffer.from(ours.sessionId, 'hex'));
    const data = JSON.stringify({ from: site.sessionId, message: Buffer.from(sealed).toString('base64') });
    FakeSource.all[0].dispatchEvent(new MessageEvent('message', { data, lastEventId: '42' }));
    expect(got).toEqual([['disconnect', '42']]);
  });

  it('reopens a stream the browser gave up on, and not one it will retry or one we closed', () => {
    const listener = listen(app, () => {});
    FakeSource.all[0].readyState = 0; // CONNECTING: the browser retries by itself
    FakeSource.all[0].dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(10_000);
    expect(FakeSource.all).toHaveLength(1);

    FakeSource.all[0].readyState = FakeSource.CLOSED;
    FakeSource.all[0].dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(10_000);
    expect(FakeSource.all).toHaveLength(2);

    listener.close();
    FakeSource.all[1].dispatchEvent(new Event('error'));
    vi.advanceTimersByTime(10_000);
    expect(FakeSource.all).toHaveLength(2);
  });
});

describe('fetchManifest', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the site by the manifest\'s host when the browser withholds it (CORS)', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(fetchManifest('https://app.ston.fi/tonconnect-manifest.json')).resolves.toEqual({
      name: 'app.ston.fi',
      url: 'https://app.ston.fi',
      domain: 'app.ston.fi',
      fromLink: true,
    });
  });

  it('still refuses a missing manifest and a non-https one', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 404 })));
    await expect(fetchManifest('https://example.com/m.json')).rejects.toThrow(/unavailable \(404\)/);
    await expect(fetchManifest('http://example.com/m.json')).rejects.toThrow(/Could not load/);
  });
});

describe('tonProofHash', () => {
  it('agrees with the device (firmware/test vector for this key)', () => {
    const wallet = createWalletContract('mainnet', Buffer.alloc(32, 7));
    const hash = tonProofHash(wallet.address, 'ton-connect.github.io', 1758620000, 'e5b4ee4c8a2e1a9c');
    expect(hash.toString('hex')).toBe('64d39a942cc82c25e34aa379208a3b827234e174433d9e920f9b88691b767642');
  });
});

describe('parseSendTransaction', () => {
  const own = createWalletContract('testnet', Buffer.alloc(32, 7));
  const ctx = { address: own.address, network: 'testnet' as const };
  const now = 1_800_000_000;
  const dest = Address.parseRaw(`0:${'aa'.repeat(32)}`);
  const parse = (tx: object) => parseSendTransaction(JSON.stringify(tx), ctx, now);
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return (err as TonConnectError).code;
    }
    return undefined;
  };

  it('keeps the flags the address carries and adds up the value', () => {
    const tx = parse({
      valid_until: now + 60,
      messages: [
        { address: dest.toString({ bounceable: false, testOnly: true }), amount: '5' },
        { address: dest.toRawString(), amount: toNano('1').toString(), payload: beginCell().storeUint(7, 32).endCell().toBoc().toString('base64') },
      ],
    });
    expect(tx.validUntil).toBe(now + 60);
    expect(tx.total).toBe(toNano('1') + 5n);
    expect(tx.messages[0]).toMatchObject({ bounce: false, testOnly: true, value: 5n });
    expect(tx.messages[1]).toMatchObject({ bounce: true, testOnly: false });
    expect(tx.messages[1].to.equals(dest)).toBe(true);
    expect(tx.messages[1].body).toBeDefined();
  });

  it('caps how long the signature stays valid', () => {
    expect(parse({ messages: [{ address: dest.toRawString(), amount: '1' }] }).validUntil).toBe(now + 300);
    expect(parse({ valid_until: now + 86_400, messages: [{ address: dest.toRawString(), amount: '1' }] }).validUntil).toBe(now + 300);
  });

  it('passes a state init through', () => {
    const init = beginCell().store(storeStateInit(own.init)).endCell().toBoc().toString('base64');
    const tx = parse({ messages: [{ address: dest.toRawString(), amount: '1', stateInit: init }] });
    expect(tx.messages[0].init?.code?.equals(own.init.code)).toBe(true);
    expect(tx.messages[0].init?.data?.equals(own.init.data)).toBe(true);
  });

  it('refuses what the wallet or the device cannot do faithfully', () => {
    const msg = { address: dest.toRawString(), amount: '1' };
    expect(codeOf(() => parse({ valid_until: now - 1, messages: [msg] }))).toBe(ERROR.BAD_REQUEST);
    expect(codeOf(() => parse({ network: '-239', messages: [msg] }))).toBe(ERROR.BAD_REQUEST);
    expect(codeOf(() => parse({ from: dest.toRawString(), messages: [msg] }))).toBe(ERROR.BAD_REQUEST);
    expect(codeOf(() => parse({ messages: [] }))).toBe(ERROR.BAD_REQUEST);
    expect(codeOf(() => parse({ messages: Array(5).fill(msg) }))).toBe(ERROR.BAD_REQUEST);
    expect(codeOf(() => parse({ messages: [{ ...msg, amount: '-1' }] }))).toBe(ERROR.BAD_REQUEST);
    expect(codeOf(() => parse({ messages: [{ ...msg, extra_currency: { 1: '5' } }] }))).toBe(ERROR.BAD_REQUEST);
    expect(codeOf(() => parse({ messages: [{ ...msg, payload: 'not a boc' }] }))).toBe(ERROR.BAD_REQUEST);
    expect(codeOf(() => parse({ items: [{ type: 'ton', address: msg.address, amount: '1' }] }))).toBe(ERROR.NOT_SUPPORTED);
  });

  it('refuses a token transfer the device could not read, and passes well-formed ones', () => {
    const payload = (c: ReturnType<typeof beginCell>) => ({ address: dest.toRawString(), amount: '1', payload: c.endCell().toBoc().toString('base64') });
    const addrVar = () => beginCell().storeUint(3, 2).storeBit(0).storeUint(256, 9).storeInt(0, 32).storeBuffer(Buffer.alloc(32, 0xdd));
    const jetton = () => beginCell().storeUint(0x0f8a7ea5, 32).storeUint(0, 64).storeCoins(5n).storeAddress(dest);
    const nft = () => beginCell().storeUint(0x5fcc3d14, 32).storeUint(0, 64).storeAddress(dest);
    const tail = (b: ReturnType<typeof beginCell>) => b.storeBit(0).storeCoins(1n);

    expect(parse({ messages: [payload(tail(jetton().storeAddress(dest)).storeBit(0))] }).messages).toHaveLength(1);
    expect(parse({ messages: [payload(tail(jetton().storeAddress(null)).storeBit(1).storeRef(beginCell().endCell()))] }).messages).toHaveLength(1);
    expect(parse({ messages: [payload(tail(nft().storeAddress(dest)).storeBit(0))] }).messages).toHaveLength(1);

    expect(codeOf(() => parse({ messages: [payload(tail(jetton().storeAddress(dest)).storeBit(1))] }))).toBe(ERROR.BAD_REQUEST);
    expect(codeOf(() => parse({ messages: [payload(tail(jetton().storeBuilder(addrVar())).storeBit(0))] }))).toBe(ERROR.BAD_REQUEST);
    expect(codeOf(() => parse({ messages: [payload(tail(nft().storeBuilder(addrVar())).storeBit(0))] }))).toBe(ERROR.BAD_REQUEST);
    expect(codeOf(() => parse({ messages: [payload(beginCell().storeUint(0x0f8a7ea5, 32))] }))).toBe(ERROR.BAD_REQUEST);
  });

  it('accepts its own address and network when the site names them', () => {
    const tx = parse({ network: '-3', from: own.address.toRawString(), messages: [{ address: dest.toRawString(), amount: '1' }] });
    expect(tx.messages).toHaveLength(1);
  });
});

describe('decodeTokenTransfer', () => {
  const to = Address.parseRaw(`0:${'aa'.repeat(32)}`);
  const tail = (b: ReturnType<typeof beginCell>) => b.storeAddress(null).storeBit(0).storeCoins(1n).storeBit(0).endCell();

  it('reads the amount and recipient of a jetton transfer', () => {
    const body = tail(beginCell().storeUint(0x0f8a7ea5, 32).storeUint(0, 64).storeCoins(2_500_000n).storeAddress(to));
    const t = decodeTokenTransfer(body);
    expect(t).toMatchObject({ kind: 'jetton', amount: 2_500_000n });
    expect(t && t.recipient.equals(to)).toBe(true);
  });

  it('reads the new owner of an NFT transfer', () => {
    const t = decodeTokenTransfer(tail(beginCell().storeUint(0x5fcc3d14, 32).storeUint(0, 64).storeAddress(to)));
    expect(t?.kind).toBe('nft');
    expect(t && t.recipient.equals(to)).toBe(true);
  });

  it('tells other bodies from broken transfers', () => {
    expect(decodeTokenTransfer(beginCell().storeUint(7, 32).endCell())).toBeUndefined();
    expect(decodeTokenTransfer(beginCell().storeUint(0x0f8a7ea5, 32).endCell())).toBeNull();
  });
});

