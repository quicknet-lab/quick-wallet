import { Address, beginCell, toNano, type Cell } from '@ton/core';
import type { Network } from './validation';

/**
 * Jettons (TEP-74) and NFTs (TEP-62): everything that is pure logic —
 * amount arithmetic at arbitrary decimals, reading the indexer's answers,
 * and building the two transfer message bodies. No network access here, so
 * all of it is directly testable.
 *
 * The device is not involved in any of this: a jetton or NFT transfer is an
 * ordinary wallet message whose body happens to be a token transfer, and
 * what gets signed is the same 32-byte hash as for a plain TON transfer.
 */

// ---------------------------------------------------------------- amounts

/**
 * Parses a human amount ("12.5") into the token's smallest units. Unlike
 * TON's fixed 9 decimals, jettons declare their own — USD₮ on TON has 6, so
 * "12.5" is 12_500_000 there and 12_500_000_000 for a 9-decimal token.
 */
export function parseUnits(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error('Enter an amount.');
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!m) {
    throw new Error('Amount must be a positive number.');
  }
  const frac = m[2] ?? '';
  if (frac.length > decimals) {
    throw new Error(
      decimals === 0
        ? 'This token is indivisible — enter a whole number.'
        : `This token has ${decimals} decimals, but ${frac.length} were given.`,
    );
  }
  const units = BigInt(m[1] + frac.padEnd(decimals, '0'));
  if (units <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }
  return units;
}

/** Renders smallest units back as a human amount, without trailing zeros. */
export function formatUnits(value: bigint, decimals: number): string {
  if (decimals <= 0) return value.toString();
  const digits = value.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals);
  const frac = digits.slice(-decimals).replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
}

/**
 * A decimal amount as the user sees it: at most four digits after the point,
 * cut rather than rounded so a balance is never overstated. A non-zero amount
 * too small for that reads "<0.0001" instead of a misleading 0.
 */
export function shortAmount(amount: string): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(amount);
  if (!m) return amount;
  const frac = (m[2] ?? '').slice(0, 4).replace(/0+$/, '');
  if (frac === '' && /^0+$/.test(m[1]) && /[1-9]/.test(m[2] ?? '')) return '<0.0001';
  return frac === '' ? m[1] : `${m[1]}.${frac}`;
}

// --------------------------------------------------------------- registry

/**
 * Jetton masters pinned in source. The point is not to be a complete token
 * list — it is that these particular addresses cannot be changed by whatever
 * the indexer returns at runtime, so a token calling itself "USD₮" either is
 * the master below or is shown as unverified. Every entry was checked
 * against toncenter's index on 2026-09-05 (symbol and decimals matched).
 *
 * Mainnet only: on testnet nothing is canonical, so everything is unverified.
 */
export const KNOWN_MAINNET_JETTONS = [
  // The device knows this one too (firmware/main/ton_jetton.c): it names and
  // scales USD₮ transfers itself and refuses a label that disagrees.
  { symbol: 'USD₮', name: 'Tether USD', decimals: 6, master: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' },
];

const KNOWN_MAINNET_BY_MASTER = new Map(
  KNOWN_MAINNET_JETTONS.map((jetton) => [Address.parse(jetton.master).toRawString(), jetton]),
);

/** The pinned registry entry for a mainnet jetton master, if it has one. */
export function findKnownMainnetJetton(master: Address): (typeof KNOWN_MAINNET_JETTONS)[number] | undefined {
  return KNOWN_MAINNET_BY_MASTER.get(master.toRawString());
}

export function isKnownJetton(master: Address, network: Network): boolean {
  return network === 'mainnet' && KNOWN_MAINNET_BY_MASTER.has(master.toRawString());
}

// ------------------------------------------------------------------ types

export type JettonHolding = {
  master: Address;
  /** Our own jetton wallet for this token, as the indexer reported it. The
   * transfer is addressed here, so it is re-derived from the master before
   * signing rather than trusted — see TonWallet.resolveJettonWallet. */
  wallet: Address;
  balance: bigint;
  symbol: string;
  name: string;
  /** Where the decimal point goes — from the pinned registry for a master
   * listed there, from the indexer otherwise. This number scales everything:
   * what the user types becomes units with it, and the device screen renders
   * those units back through it, so the two always agree and a wrong one
   * moves the real amount by a factor of ten or more without anything on
   * screen changing. Hence pinned wherever it can be. */
  decimals: number;
  /** Only ever a toncenter proxy URL — see pickImage(). */
  image: string | null;
  /** The indexer's own scam flag. */
  isScam: boolean;
  /** Present in the pinned registry above. */
  verified: boolean;
  /** The indexer's decimals differ from the pinned ones. Whichever side is
   * wrong, the scale of this token can't be established here, so it isn't
   * sent — see TonWallet.buildAndSignJetton. */
  decimalsDisputed: boolean;
};

export type NftItem = {
  address: Address;
  name: string;
  collection: string | null;
  image: string | null;
  isScam: boolean;
  /** Owned by a sale contract rather than by the wallet directly, so it
   * cannot be transferred until the sale is cancelled. */
  onSale: boolean;
};

// ---------------------------------------------------- indexer response

type Json = Record<string, unknown>;

export function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/**
 * Token names and symbols are written by whoever deployed the token, which
 * on TON routinely means an attacker: airdropped jettons carry names like
 * "Claim 5000 USDT at …". They are always rendered as text, never as markup,
 * but they still get collapsed to one line and capped so a deliberately
 * enormous name cannot push the rest of the row off screen.
 */
export function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Images are taken only from toncenter's own proxy, never from the URL the
 * token itself declares. Loading the declared URL would hand the wallet
 * owner's IP and browsing moment to whatever host a stranger's airdropped
 * token points at — a tracking pixel with extra steps. toncenter already
 * sees the address being queried, so its proxy leaks nothing new.
 */
function pickImage(extra: Json | null): string | null {
  for (const key of ['_image_small', '_image_medium', '_image_big']) {
    const url = extra?.[key];
    if (typeof url === 'string' && url.startsWith('https://proxy.toncenter.com/')) {
      return url;
    }
  }
  return null;
}

/** Pulls the token_info entry of the requested type out of v3's metadata map. */
export function tokenInfo(metadata: Json | null, rawAddress: string, type: string): Json | null {
  // A single-address lookup comes back keyed in upper case ("0:B113…") while
  // the address we ask with is lower case, so match the key without case.
  const key = metadata ? Object.keys(metadata).find((k) => k.toLowerCase() === rawAddress.toLowerCase()) : undefined;
  const entry = asObject(metadata && key !== undefined ? metadata[key] : null);
  const infos = entry?.token_info;
  if (!Array.isArray(infos)) return null;
  for (const info of infos) {
    const obj = asObject(info);
    if (obj?.type === type) return obj;
  }
  return null;
}

/** What the indexer says, or undefined when it says nothing usable. Kept
 * apart from the 9-decimal fallback below so that "didn't say" isn't read as
 * a disagreement with the pinned registry. */
export function decimalsOf(extra: Json | null): number | undefined {
  const raw = Number(extra?.decimals);
  return extra?.decimals !== undefined && Number.isInteger(raw) && raw >= 0 && raw <= 30
    ? raw
    : undefined;
}

/** What almost every jetton uses, and all this module can assume when
 * neither the registry nor the indexer gives a number. */
const DEFAULT_DECIMALS = 9;

/**
 * Reads toncenter v3's `/jetton/wallets` response. Records that don't parse
 * are skipped rather than failing the whole list: one malformed token in a
 * wallet holding twenty should not blank the balance screen.
 */
export function parseJettonHoldings(body: unknown, network: Network): JettonHolding[] {
  const root = asObject(body);
  const wallets = root?.jetton_wallets;
  if (!Array.isArray(wallets)) return [];
  const metadata = asObject(root?.metadata);

  const holdings: JettonHolding[] = [];
  for (const raw of wallets) {
    const record = asObject(raw);
    if (!record) continue;
    try {
      const master = Address.parseRaw(String(record.jetton));
      const info = tokenInfo(metadata, String(record.jetton), 'jetton_masters');
      const extra = asObject(info?.extra);
      // A pinned master's decimals come from the registry above, not from the
      // indexer: it is the one number in this record that silently multiplies
      // what actually leaves the wallet.
      const verified = isKnownJetton(master, network);
      const pinned = verified ? KNOWN_MAINNET_BY_MASTER.get(master.toRawString()) : undefined;
      const reported = decimalsOf(extra);
      holdings.push({
        master,
        wallet: Address.parseRaw(String(record.address)),
        balance: BigInt(String(record.balance)),
        symbol: pinned?.symbol ?? (clean(info?.symbol, 24) || '???'),
        name: pinned?.name ?? (clean(info?.name, 64) || 'Unknown token'),
        decimals: pinned?.decimals ?? reported ?? DEFAULT_DECIMALS,
        image: pickImage(extra),
        isScam: info?.is_scam === true,
        verified,
        decimalsDisputed: pinned !== undefined && reported !== undefined && pinned.decimals !== reported,
      });
    } catch {
      // Unparseable address or balance — drop this one, keep the rest.
    }
  }
  return holdings;
}

/**
 * Reads toncenter v3's `/jetton/masters` response for a single-address
 * lookup — used to add a jetton by contract address that isn't in the
 * pinned registry and that this wallet may not hold. Returns null if
 * nothing was found at that address (not a jetton master).
 */
export function parseJettonMasterLookup(
  body: unknown,
  rawAddress: string,
): { symbol: string; name: string; decimals: number; image: string | null } | null {
  const root = asObject(body);
  const masters = root?.jetton_masters;
  if (!Array.isArray(masters) || masters.length === 0) return null;
  const info = tokenInfo(asObject(root?.metadata), rawAddress, 'jetton_masters');
  const extra = asObject(info?.extra);
  return {
    symbol: clean(info?.symbol, 24) || '???',
    name: clean(info?.name, 64) || 'Unknown token',
    decimals: decimalsOf(extra) ?? DEFAULT_DECIMALS,
    image: pickImage(extra),
  };
}

/** Reads toncenter v3's `/nft/items` response, with the same skip-on-error rule. */
export function parseNftItems(body: unknown): NftItem[] {
  const root = asObject(body);
  const items = root?.nft_items;
  if (!Array.isArray(items)) return [];
  const metadata = asObject(root?.metadata);

  const parsed: NftItem[] = [];
  for (const raw of items) {
    const record = asObject(raw);
    if (!record) continue;
    try {
      const address = Address.parseRaw(String(record.address));
      const info = tokenInfo(metadata, String(record.address), 'nft_items');
      const collectionRaw =
        typeof record.collection_address === 'string' ? record.collection_address : null;
      const collectionInfo = collectionRaw
        ? tokenInfo(metadata, collectionRaw, 'nft_collections')
        : null;
      parsed.push({
        address,
        name: clean(info?.name, 64) || `#${clean(record.index, 24) || '?'}`,
        collection: clean(collectionInfo?.name, 64) || null,
        image: pickImage(asObject(info?.extra)),
        isScam: info?.is_scam === true || collectionInfo?.is_scam === true,
        onSale: record.on_sale === true,
      });
    } catch {
      // Same as above — a broken record shouldn't hide the rest.
    }
  }
  return parsed;
}

// -------------------------------------------------------- message bodies

/** TEP-74 `transfer`. */
const JETTON_TRANSFER_OP = 0x0f8a7ea5;

/** A message body that opens with the TEP-74 `transfer` op. */
export function isJettonTransferBody(body: Cell | string | undefined): boolean {
  if (body === undefined || typeof body === 'string') return false;
  const slice = body.beginParse();
  return slice.remainingBits >= 32 && slice.loadUint(32) === JETTON_TRANSFER_OP;
}
/** TEP-62 `transfer`. */
const NFT_TRANSFER_OP = 0x5fcc3d14;

/**
 * TON attached to a jetton or NFT transfer to pay for the chain of internal
 * messages it sets off. Whatever isn't consumed comes back to
 * `response_destination`, which is always this wallet, so being generous
 * here costs nothing but briefly locked-up balance. 0.05 TON is what the
 * TON docs suggest for a jetton transfer.
 */
export const TOKEN_TRANSFER_GAS = toNano('0.05');

/**
 * Forwarded on to the recipient. Anything above zero makes the receiving
 * side get a `transfer_notification` — which is what carries the comment and
 * what wallet apps show as an incoming transfer. One nanoton is the amount
 * every other TON wallet uses for this.
 */
const FORWARD_TON = 1n;

/** `(Either Cell ^Cell)` — an empty payload inline, or a text comment by ref. */
function storeForwardPayload(builder: ReturnType<typeof beginCell>, comment?: string) {
  if (!comment) {
    builder.storeBit(0);
    return;
  }
  builder.storeBit(1);
  builder.storeRef(beginCell().storeUint(0, 32).storeStringTail(comment).endCell());
}

/**
 * Body of a jetton transfer. Note this is sent to *our own* jetton wallet,
 * not to the recipient: `to` here is the new owner, and their jetton wallet
 * is created by the token's own contracts if it doesn't exist yet.
 */
export function jettonTransferBody(params: {
  amount: bigint;
  to: Address;
  /** Where leftover gas goes — this wallet. */
  responseTo: Address;
  comment?: string;
}): Cell {
  const builder = beginCell()
    .storeUint(JETTON_TRANSFER_OP, 32)
    .storeUint(0, 64) // query_id
    .storeCoins(params.amount)
    .storeAddress(params.to)
    .storeAddress(params.responseTo)
    .storeBit(0) // custom_payload: none
    .storeCoins(FORWARD_TON);
  storeForwardPayload(builder, params.comment);
  return builder.endCell();
}

/** Body of an NFT transfer, sent to the NFT item contract itself. */
export function nftTransferBody(params: {
  newOwner: Address;
  responseTo: Address;
  comment?: string;
}): Cell {
  const builder = beginCell()
    .storeUint(NFT_TRANSFER_OP, 32)
    .storeUint(0, 64) // query_id
    .storeAddress(params.newOwner)
    .storeAddress(params.responseTo)
    .storeBit(0) // custom_payload: none
    .storeCoins(FORWARD_TON);
  storeForwardPayload(builder, params.comment);
  return builder.endCell();
}
