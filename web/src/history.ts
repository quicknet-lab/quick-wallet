import { Address } from '@ton/core';
import { asObject, clean, decimalsOf, findKnownMainnetJetton, formatUnits, tokenInfo } from './tokens';

// Transaction history from toncenter v3's `/actions`: the indexer has already
// grouped each trace into what happened (a transfer, a swap, an NFT move).
// This only reads it for display — nothing here is ever signed.

/** One amount in a row, already formatted. `verified`: GRAM, or a jetton
 * from the pinned registry — anything else may carry any name, "USD₮" too. */
export type HistoryLeg = { symbol: string; amount: string; incoming: boolean; verified: boolean };

export type HistoryItem = {
  id: string;
  kind: 'ton' | 'jetton' | 'nft' | 'swap' | 'call';
  /** For a transfer: whether it left this wallet. */
  outgoing: boolean;
  /** Unix seconds. */
  time: number;
  success: boolean;
  /** The other side of a transfer. */
  counterparty: Address | null;
  /** One leg for a transfer or call, two for a swap (sent, then received), none for an NFT. */
  legs: HistoryLeg[];
  /** An NFT's name, when the indexer knows it. */
  nftName: string | null;
  comment: string | null;
  /** Trace hash in hex, for the explorer link. */
  hash: string | null;
};

const NATIVE = { symbol: 'GRAM', decimals: 9, verified: true };

function parseAddress(value: unknown): Address | null {
  try {
    return typeof value === 'string' ? Address.parseRaw(value) : null;
  } catch {
    return null;
  }
}

/** Symbol and decimals for a jetton master, or null for an unreadable address or a token
 * flagged as a scam. A pinned registry entry wins over what the indexer says, as everywhere else. */
function jettonLabel(
  metadata: Record<string, unknown> | null,
  rawAsset: unknown,
): { symbol: string; decimals: number; verified: boolean } | null {
  const master = parseAddress(rawAsset);
  if (!master) return null;
  const info = tokenInfo(metadata, String(rawAsset), 'jetton_masters');
  if (info?.is_scam === true) return null;
  const pinned = findKnownMainnetJetton(master);
  return {
    symbol: pinned?.symbol ?? (clean(info?.symbol, 24) || '???'),
    decimals: pinned?.decimals ?? decimalsOf(asObject(info?.extra)) ?? 9,
    verified: pinned !== undefined,
  };
}

function amountOf(raw: unknown, decimals: number): string | null {
  try {
    return formatUnits(BigInt(String(raw)), decimals);
  } catch {
    return null;
  }
}

function toHex(base64: unknown): string | null {
  if (typeof base64 !== 'string' || base64 === '') return null;
  try {
    const bytes = Uint8Array.from(atob(base64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Reads a `/actions` response for `own`. `count` is how many records came back
 * before anything was skipped, which is what decides whether another page may
 * exist. Records of kinds not shown (mints, incoming contract calls),
 * transfers of tokens the indexer flags as scams, and anything malformed are
 * skipped.
 */
export function parseHistory(body: unknown, own: Address): { items: HistoryItem[]; count: number } {
  const root = asObject(body);
  const actions = root?.actions;
  if (!Array.isArray(actions)) return { items: [], count: 0 };
  const metadata = asObject(root?.metadata);
  const ownRaw = own.toRawString().toLowerCase();
  const isOwn = (value: unknown) => typeof value === 'string' && value.toLowerCase() === ownRaw;

  const items: HistoryItem[] = [];
  for (const raw of actions) {
    const action = asObject(raw);
    const details = asObject(action?.details);
    if (!action || !details) continue;
    try {
      const base = {
        id: String(action.action_id ?? `${action.trace_external_hash}:${action.start_lt}`),
        time: Number(action.start_utime),
        success: action.success !== false,
        hash: toHex(action.trace_external_hash),
        nftName: null as string | null,
        comment: null as string | null,
      };
      if (!Number.isFinite(base.time)) continue;

      if (action.type === 'ton_transfer') {
        const outgoing = isOwn(details.source);
        const amount = amountOf(details.value, NATIVE.decimals);
        if (amount === null) continue;
        items.push({
          ...base,
          kind: 'ton',
          outgoing,
          counterparty: parseAddress(outgoing ? details.destination : details.source),
          legs: [{ symbol: NATIVE.symbol, amount, incoming: !outgoing, verified: true }],
          comment: details.encrypted === true ? null : clean(details.comment, 120) || null,
        });
      } else if (action.type === 'jetton_transfer') {
        const label = jettonLabel(metadata, details.asset);
        if (!label) continue;
        const outgoing = isOwn(details.sender);
        const amount = amountOf(details.amount, label.decimals);
        if (amount === null) continue;
        items.push({
          ...base,
          kind: 'jetton',
          outgoing,
          counterparty: parseAddress(outgoing ? details.receiver : details.sender),
          legs: [{ symbol: label.symbol, amount, incoming: !outgoing, verified: label.verified }],
          comment: details.is_encrypted_comment === true ? null : clean(details.comment, 120) || null,
        });
      } else if (action.type === 'nft_transfer') {
        const outgoing = isOwn(details.old_owner);
        const name = clean(tokenInfo(metadata, String(details.nft_item), 'nft_items')?.name, 64);
        items.push({
          ...base,
          kind: 'nft',
          outgoing,
          counterparty: parseAddress(outgoing ? details.new_owner : details.old_owner),
          legs: [],
          nftName: name || null,
        });
      } else if (action.type === 'jetton_swap') {
        const inTransfer = asObject(details.dex_incoming_transfer);
        const outTransfer = asObject(details.dex_outgoing_transfer);
        const legOf = (t: Record<string, unknown> | null, incoming: boolean): HistoryLeg | null => {
          if (!t) return null;
          const label = t.asset === null || t.asset === undefined ? NATIVE : jettonLabel(metadata, t.asset);
          const amount = label ? amountOf(t.amount, label.decimals) : null;
          return label && amount !== null ? { symbol: label.symbol, amount, incoming, verified: label.verified } : null;
        };
        const sent = legOf(inTransfer, false);
        const received = legOf(outTransfer, true);
        if (!sent || !received) continue;
        items.push({ ...base, kind: 'swap', outgoing: true, counterparty: null, legs: [sent, received] });
      } else if (action.type === 'call_contract' && isOwn(details.source)) {
        const amount = amountOf(details.value, NATIVE.decimals);
        items.push({
          ...base,
          kind: 'call',
          outgoing: true,
          counterparty: parseAddress(details.destination),
          legs: amount === null ? [] : [{ symbol: NATIVE.symbol, amount, incoming: false, verified: true }],
        });
      }
    } catch {
      // One malformed record should not blank the list.
    }
  }
  return { items, count: actions.length };
}
