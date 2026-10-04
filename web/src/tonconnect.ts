import { Buffer } from 'buffer';
import {
  Base64,
  CHAIN,
  SessionCrypto,
  hexToByteArray,
  type AppRequest,
  type ConnectRequest,
  type DeviceInfo,
  type KeyPair,
  type RpcMethod,
  type WalletEvent,
  type WalletResponse,
} from '@tonconnect/protocol';
import { Address, Cell, loadStateInit } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import type { Network } from './validation';
import type { OutMessage } from './wallet';

/**
 * TON Connect, wallet side. A site talks to this app through a public HTTP
 * bridge: every message is end-to-end encrypted between the site's session
 * key and ours (NaCl box), so the bridge only relays ciphertext. The link a
 * site shows ("Copy link" or its QR code) carries the site's session key and
 * its connect request; nothing about it depends on which wallet's name is in
 * front of the query string, so any wallet's link works here.
 *
 * Nothing in this module signs anything. Signatures come from the device,
 * over BLE, for requests the user has approved in the app first.
 *
 * @see https://github.com/ton-blockchain/ton-connect/tree/main/spec
 */

/** The bridge Tonkeeper runs, which most sites and wallets use. */
export const BRIDGE_URL = 'https://bridge.tonapi.io/bridge';
/** Hosts of the universal links of wallets on that bridge (Tonkeeper and
 * Tonkeeper Pro in ton-connect/wallets-list, checked 2026-09-28). */
const TONKEEPER_BRIDGE_LINK_HOSTS = ['app.tonkeeper.com'];
/** How long to wait before reopening a bridge stream the browser gave up on. */
const LISTEN_RETRY_MS = 3000;

/** How long the bridge holds a message for a peer that isn't listening. */
const BRIDGE_TTL_SECONDS = 300;

/** TON_TX_MAX_MESSAGES in firmware/main/ton_tx.h. */
export const MAX_MESSAGES = 4;

/** At most this far ahead: a signature is only useful to whoever holds it
 * until then, and a site has no need for one to last longer. */
const MAX_VALID_FOR_SECONDS = 5 * 60;

const CHAIN_ID: Record<Network, CHAIN> = { mainnet: CHAIN.MAINNET, testnet: CHAIN.TESTNET };

export const DEVICE_INFO: DeviceInfo = {
  platform: 'browser',
  appName: 'quickwallet',
  appVersion: '1.0.0',
  maxProtocolVersion: 2,
  features: ['SendTransaction', { name: 'SendTransaction', maxMessages: MAX_MESSAGES }],
};

/** A request a site sent that it should hear a specific error code for. */
export class TonConnectError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
/** Error codes shared by connect and every RPC method. */
export const ERROR = {
  UNKNOWN: 0,
  BAD_REQUEST: 1,
  MANIFEST_NOT_FOUND: 2,
  MANIFEST_CONTENT: 3,
  USER_REJECTS: 300,
  NOT_SUPPORTED: 400,
};

// ---------------------------------------------------------------- linking

export type ConnectLink = { clientId: string; request: ConnectRequest };

/**
 * Reads a connect link: `tc://?v=2&id=…&r=…`, a wallet's universal link with
 * the same query, or just the query itself. Throws a message meant for the
 * user.
 */
export function parseConnectLink(text: string): ConnectLink {
  const trimmed = text.trim();
  const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?') + 1) : trimmed;
  const params = new URLSearchParams(query);
  const clientId = params.get('id') ?? '';
  const raw = params.get('r');
  if (!/^[0-9a-f]{64}$/i.test(clientId) || raw === null) {
    throw new Error('That is not a TON Connect link. On the site, open "Connect wallet" and use "Copy link".');
  }
  // A wallet's universal link tells the site which bridge to wait on. This
  // app answers on Tonkeeper's, so another wallet's link would leave the site
  // waiting for an answer that goes elsewhere.
  if (/^https?:\/\//i.test(trimmed)) {
    let host = '';
    try {
      host = new URL(trimmed).host;
    } catch {
      // Not a URL after all: nothing to tell from its host.
    }
    if (host && !TONKEEPER_BRIDGE_LINK_HOSTS.includes(host)) {
      throw new Error(
        `That link is for another wallet (${host}). On the site pick Tonkeeper in the wallet list, then "Copy link".`,
      );
    }
  }
  if (params.get('v') !== '2') {
    throw new Error('This site uses a TON Connect version this app does not speak.');
  }
  let request: ConnectRequest;
  try {
    request = JSON.parse(raw) as ConnectRequest;
  } catch {
    throw new Error('The connect request in that link is damaged.');
  }
  if (typeof request?.manifestUrl !== 'string' || !Array.isArray(request.items)) {
    throw new Error('The connect request in that link is damaged.');
  }
  if (!request.items.some((item) => item?.name === 'ton_addr')) {
    throw new Error('The site did not ask for a wallet address, so there is nothing to connect.');
  }
  return { clientId: clientId.toLowerCase(), request };
}

/**
 * What a site says about itself. Only the domain goes into a signature.
 * fromLink: the browser would not hand over the manifest, so all three come
 * from the manifest's own address (see fetchManifest).
 */
export type AppManifest = { name: string; url: string; domain: string; fromLink?: boolean };

/**
 * Fetches the site's tonconnect-manifest.json. The domain signed into a
 * ton_proof is the host of the manifest's `url`, which is what the site's
 * backend checks against — and the one thing the device shows before
 * signing in.
 */
export async function fetchManifest(manifestUrl: string): Promise<AppManifest> {
  let url: URL;
  try {
    url = new URL(manifestUrl);
    if (url.protocol !== 'https:') throw new Error();
  } catch {
    throw new TonConnectError(ERROR.MANIFEST_NOT_FOUND, 'Could not load the site\'s TON Connect manifest.');
  }
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    // The browser withheld the response — in practice a manifest served
    // without CORS headers (app.ston.fi), which native wallets never notice.
    // Its address came in the same link, from the same site, as its content
    // would have, so naming the site by that host trusts nothing new.
    return { name: url.host, url: url.origin, domain: url.host, fromLink: true };
  }
  if (!res.ok) {
    throw new TonConnectError(ERROR.MANIFEST_NOT_FOUND, `The site's manifest is unavailable (${res.status}).`);
  }
  const body = (await res.json().catch(() => null)) as { name?: unknown; url?: unknown } | null;
  try {
    const appUrl = new URL(String(body?.url));
    if (typeof body?.name !== 'string' || !/^https?:$/.test(appUrl.protocol)) throw new Error();
    return { name: body.name.slice(0, 64), url: appUrl.origin, domain: appUrl.host };
  } catch {
    throw new TonConnectError(ERROR.MANIFEST_CONTENT, 'The site\'s manifest is not valid.');
  }
}

// ---------------------------------------------------------------- ton_proof

/**
 * What the device signs for a ton_proof (see firmware/main/ton_proof.h).
 * Computed here too so the signature that comes back can be checked before
 * it is handed to the site.
 */
export function tonProofHash(address: Address, domain: string, timestamp: number, payload: string): Buffer {
  const wc = Buffer.alloc(4);
  wc.writeInt32BE(address.workChain, 0);
  const domainBytes = Buffer.from(domain, 'utf8');
  const domainLen = Buffer.alloc(4);
  domainLen.writeUInt32LE(domainBytes.length, 0);
  const ts = Buffer.alloc(8);
  ts.writeUInt32LE(timestamp % 2 ** 32, 0);
  ts.writeUInt32LE(Math.floor(timestamp / 2 ** 32), 4);
  const message = Buffer.concat([
    Buffer.from('ton-proof-item-v2/'),
    wc,
    address.hash,
    domainLen,
    domainBytes,
    ts,
    Buffer.from(payload, 'utf8'),
  ]);
  return sha256_sync(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), sha256_sync(message)]));
}

// ---------------------------------------------------------------- sendTransaction

export type DappTransaction = {
  /** Unix time the signed message stops being valid, already capped. */
  validUntil: number;
  messages: (OutMessage & { testOnly: boolean })[];
  total: bigint;
};

/**
 * Checks a sendTransaction payload against what this wallet can sign and
 * show, and turns it into messages for TonWallet. Everything refused here is
 * refused with the error code the site should get.
 */
const JETTON_TRANSFER_OP = 0x0f8a7ea5;
const NFT_TRANSFER_OP = 0x5fcc3d14;

/** What a jetton or NFT transfer body moves, read the way the device reads it. */
export type TokenTransfer =
  | { kind: 'jetton'; amount: bigint; recipient: Address }
  | { kind: 'nft'; recipient: Address };

/**
 * Reads a TEP-74 jetton or TEP-62 NFT transfer body the way the device does
 * (firmware/main/ton_tx.c). `undefined` for any other body; `null` for one
 * with a transfer's op that doesn't parse as that transfer — the device
 * refuses those, since token contracts read them leniently and would likely
 * still carry them out.
 */
export function decodeTokenTransfer(body: Cell): TokenTransfer | null | undefined {
  if (body.isExotic) return undefined;
  const s = body.beginParse();
  if (s.remainingBits < 32) return undefined;
  const op = s.loadUint(32);
  if (op !== JETTON_TRANSFER_OP && op !== NFT_TRANSFER_OP) return undefined;
  // addr_std$10 without anycast, in the base or masterchain.
  const stdAddress = () => {
    if (s.preloadUint(3) !== 0b100) throw new Error();
    const a = s.loadAddress();
    if (a.workChain !== 0 && a.workChain !== -1) throw new Error();
    return a;
  };
  try {
    s.loadUintBig(64); // query_id
    const amount = op === JETTON_TRANSFER_OP ? s.loadCoins() : 0n;
    const recipient = stdAddress();
    if (s.preloadUint(2) !== 0) stdAddress(); // response_destination
    else s.skip(2);
    s.loadMaybeRef(); // custom_payload
    s.loadCoins(); // forward amount
    if (s.loadBit()) s.loadRef(); // forward_payload by ref
    return op === JETTON_TRANSFER_OP ? { kind: 'jetton', amount, recipient } : { kind: 'nft', recipient };
  } catch {
    return null;
  }
}

/**
 * False for a body that has a jetton or NFT transfer's op but doesn't parse
 * as one (see decodeTokenTransfer). Checked here too so the site hears no
 * before the user is asked anything.
 */
export function isReadableTokenTransfer(body: Cell): boolean {
  return decodeTokenTransfer(body) !== null;
}

export function parseSendTransaction(
  param: string,
  own: { address: Address; network: Network },
  now = Math.floor(Date.now() / 1000),
): DappTransaction {
  const bad = (message: string) => new TonConnectError(ERROR.BAD_REQUEST, message);
  let tx: {
    valid_until?: unknown;
    network?: unknown;
    from?: unknown;
    messages?: unknown;
    items?: unknown;
  };
  try {
    tx = JSON.parse(param);
  } catch {
    throw bad('Request is not valid JSON.');
  }
  if (tx.items !== undefined) {
    throw new TonConnectError(ERROR.NOT_SUPPORTED, 'Structured items are not supported; send raw messages.');
  }
  if (tx.network !== undefined && String(tx.network) !== CHAIN_ID[own.network]) {
    throw bad(`The wallet is connected to ${own.network}; the site asked for another network.`);
  }
  if (tx.from !== undefined) {
    let from: Address;
    try {
      from = Address.parse(String(tx.from));
    } catch {
      throw bad('The "from" address is not valid.');
    }
    if (!from.equals(own.address)) throw bad('The site asked to send from a different wallet.');
  }
  let validUntil = now + MAX_VALID_FOR_SECONDS;
  if (tx.valid_until !== undefined) {
    const requested = Number(tx.valid_until);
    if (!Number.isFinite(requested)) throw bad('"valid_until" is not a number.');
    if (requested <= now) throw bad('The request has already expired.');
    validUntil = Math.min(validUntil, Math.floor(requested));
  }
  if (!Array.isArray(tx.messages) || tx.messages.length === 0) {
    throw bad('The request has no messages.');
  }
  if (tx.messages.length > MAX_MESSAGES) {
    throw bad(`The device can sign at most ${MAX_MESSAGES} messages at once.`);
  }

  const messages = tx.messages.map((m: Record<string, unknown>, i: number) => {
    const where = `Message ${i + 1}`;
    let to: Address;
    let bounce: boolean;
    let testOnly: boolean;
    const addr = String(m?.address ?? '');
    try {
      const friendly = Address.parseFriendly(addr);
      ({ address: to, isBounceable: bounce, isTestOnly: testOnly } = friendly);
    } catch {
      try {
        to = Address.parseRaw(addr);
        bounce = true;
        testOnly = false;
      } catch {
        throw bad(`${where}: the address is not valid.`);
      }
    }
    if (testOnly && own.network === 'mainnet') throw bad(`${where}: a testnet address on mainnet.`);
    if (typeof m.amount !== 'string' || !/^\d+$/.test(m.amount)) throw bad(`${where}: the amount is not valid.`);
    if (m.extra_currency !== undefined && Object.keys(m.extra_currency as object).length > 0) {
      throw bad(`${where}: extra currencies are not supported.`);
    }
    let body: Cell | undefined;
    if (m.payload !== undefined) {
      try {
        body = Cell.fromBase64(String(m.payload));
      } catch {
        throw bad(`${where}: the payload is not a valid cell.`);
      }
      if (!isReadableTokenTransfer(body)) throw bad(`${where}: a malformed token transfer.`);
    }
    let init: OutMessage['init'];
    if (m.stateInit !== undefined) {
      try {
        const state = loadStateInit(Cell.fromBase64(String(m.stateInit)).beginParse());
        if (state.splitDepth != null || state.special != null || (state.libraries?.size ?? 0) > 0) throw new Error();
        init = { code: state.code ?? undefined, data: state.data ?? undefined };
      } catch {
        throw bad(`${where}: the state init is not one this wallet can send.`);
      }
    }
    return { to, bounce, testOnly, value: BigInt(m.amount), body, init };
  });
  return { validUntil, messages, total: messages.reduce((sum, m) => sum + m.value, 0n) };
}

// ---------------------------------------------------------------- sessions

/** A site this wallet is connected to, as kept between visits. */
export type ConnectedApp = {
  /** Our side of the session: the site knows us by keyPair.publicKey. */
  keyPair: KeyPair;
  clientId: string;
  manifest: AppManifest;
  network: Network;
  /** Raw form of the wallet address the session belongs to. */
  address: string;
  /** Next id for an event we send (connect, disconnect). */
  nextEventId: number;
  /** Last bridge event dealt with — recorded once the site has its answer,
   * not on arrival, so a request cut short by closing the page is delivered
   * again (the bridge keeps it for its TTL) instead of left unanswered. */
  lastEventId?: string;
  /** Highest request id answered. Site request ids only grow, so anything
   * at or below it is a repeat — a redelivery of one already dealt with. */
  lastRequestId?: number;
};

/** False for a request this session has already answered (see lastRequestId). */
export function isNewRequest(app: ConnectedApp, id: string): boolean {
  const n = Number(id);
  return !Number.isSafeInteger(n) || app.lastRequestId === undefined || n > app.lastRequestId;
}

/** Records a request as answered (see lastRequestId). */
export function markRequestAnswered(app: ConnectedApp, id: string): void {
  const n = Number(id);
  if (Number.isSafeInteger(n) && (app.lastRequestId === undefined || n > app.lastRequestId)) {
    app.lastRequestId = n;
  }
}

const STORAGE_KEY = 'cw-tonconnect-apps';

/** The session keys only let whoever holds them talk to the site as this
 * wallet; they can't sign anything, and every request still needs the
 * device. localStorage is where the rest of the app's state lives too. */
export function loadApps(): ConnectedApp[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveApps(apps: ConnectedApp[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(apps));
  } catch {
    // Storage unavailable: the session lasts until the page closes.
  }
}

async function post(app: ConnectedApp, message: WalletEvent | WalletResponse<RpcMethod>, topic?: string) {
  const session = new SessionCrypto(app.keyPair);
  const sealed = session.encrypt(JSON.stringify(message), hexToByteArray(app.clientId));
  const url = new URL(`${BRIDGE_URL}/message`);
  url.searchParams.set('client_id', session.sessionId);
  url.searchParams.set('to', app.clientId);
  url.searchParams.set('ttl', String(BRIDGE_TTL_SECONDS));
  if (topic) url.searchParams.set('topic', topic);
  const res = await fetch(url, { method: 'POST', body: Base64.encode(sealed), credentials: 'omit' });
  if (!res.ok) throw new Error(`The TON Connect bridge refused the message (${res.status}).`);
}

export function sendEvent(app: ConnectedApp, event: WalletEvent): Promise<void> {
  return post(app, event);
}

export function sendResponse(app: ConnectedApp, response: WalletResponse<RpcMethod>): Promise<void> {
  return post(app, response);
}

export function errorResponse(id: string, err: unknown): WalletResponse<RpcMethod> {
  const code = err instanceof TonConnectError ? err.code : ERROR.UNKNOWN;
  return { id, error: { code, message: (err as Error)?.message ?? String(err) } } as WalletResponse<RpcMethod>;
}

/**
 * Listens for one session's requests on the bridge until close() is called.
 * onLastEventId lets the caller persist where it got to.
 */
export function listen(
  app: ConnectedApp,
  onRequest: (request: AppRequest<RpcMethod>, eventId: string | undefined) => void,
): { close(): void } {
  const session = new SessionCrypto(app.keyPair);
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const open = () => {
    const url = new URL(`${BRIDGE_URL}/events`);
    url.searchParams.set('client_id', session.sessionId);
    if (app.lastEventId) url.searchParams.set('last_event_id', app.lastEventId);
    const current = new EventSource(url);
    source = current;
    current.addEventListener('open', () => console.info('[tonconnect] listening for', app.manifest.domain));
    // A dropped connection is retried by the browser itself (and the bridge
    // resumes from its Last-Event-ID). Only an answer it can't retry leaves
    // the stream CLOSED for good — without this, requests stop arriving
    // with nothing on screen to say so.
    current.addEventListener('error', () => {
      if (closed || current.readyState !== EventSource.CLOSED) return;
      console.warn('[tonconnect] bridge stream closed, reopening for', app.manifest.domain);
      retry = setTimeout(open, LISTEN_RETRY_MS);
    });
    current.addEventListener('message', (event: MessageEvent<string>) => {
      try {
        const envelope = JSON.parse(event.data) as { from?: string; message?: string };
        // Anyone can post to our client id; only the site's key can seal a
        // message that opens with it, and anything else is dropped.
        if (envelope.from !== app.clientId || typeof envelope.message !== 'string') return;
        const plain = session.decrypt(Base64.decode(envelope.message).toUint8Array(), hexToByteArray(app.clientId));
        const request = JSON.parse(plain) as AppRequest<RpcMethod>;
        if (typeof request?.method === 'string' && (typeof request.id === 'string' || typeof request.id === 'number')) {
          onRequest({ ...request, id: String(request.id) } as AppRequest<RpcMethod>, event.lastEventId || undefined);
        }
      } catch (err) {
        console.warn('[tonconnect] dropped an unreadable bridge message', err);
      }
    });
  };

  open();
  return {
    close: () => {
      closed = true;
      clearTimeout(retry);
      source?.close();
    },
  };
}
