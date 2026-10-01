import { Address } from '@ton/core';
import { KNOWN_MAINNET_JETTONS } from './tokens';

/** STON.fi's public asset index — carries a USD price per asset, no key needed. */
const STON_ASSETS = 'https://api.ston.fi/v1/assets/';
/** The same index queried for many assets at once. */
const STON_ASSETS_QUERY = 'https://api.ston.fi/v1/assets/query';
/** STON.fi's address for the native coin. */
export const GRAM_ASSET = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
export const USDT_ASSET = KNOWN_MAINNET_JETTONS.find((j) => j.symbol === 'USD₮')!.master;
/** Most tokens priced in one go, so a wallet stuffed with airdrops can't fire off hundreds of requests. */
const MAX_PRICED = 25;

/**
 * Whether one `/v1/assets/{address}` response describes an asset whose price
 * can be trusted. Anyone can deploy a token and seed a pool at any price, so
 * a token counts only if STON.fi itself lists it as a regular asset — not
 * user-submitted ("community"), blacklisted or deprecated.
 */
export function isRegularAsset(body: unknown): boolean {
  const asset = (body as { asset?: Record<string, unknown> } | null)?.asset;
  return !!asset && asset.community !== true && asset.blacklisted !== true && asset.deprecated !== true;
}

/**
 * USD prices out of one `/v1/assets/query` response, keyed the way `assets`
 * spells them. That response carries no community flag, so it is only ever
 * asked about assets already found regular; anything else in it is ignored.
 */
export function parseQueryPrices(body: unknown, assets: string[]): Map<string, number> {
  const byRaw = new Map(assets.map((a) => [Address.parse(a).toRawString(), a]));
  const prices = new Map<string, number>();
  const list = (body as { asset_list?: unknown } | null)?.asset_list;
  if (!Array.isArray(list)) return prices;
  for (const item of list as Record<string, unknown>[]) {
    let asset: string | undefined;
    try {
      asset = byRaw.get(Address.parse(String(item?.contract_address)).toRawString());
    } catch {
      continue;
    }
    const price = Number(item.dex_price_usd);
    if (asset !== undefined && item.dex_price_usd != null && Number.isFinite(price) && price > 0) prices.set(asset, price);
  }
  return prices;
}

/** Regular-or-not per asset, asked once a session: a listing rarely
 * changes, prices do. A failed lookup isn't remembered and is asked again. */
const regular = new Map<string, boolean>();

/** USD prices for the given assets (as STON.fi addresses them); those without a trusted price are left out.
 * After the first call for a set of assets this is one request, however many there are. */
export async function fetchUsdPrices(assets: string[]): Promise<Map<string, number>> {
  const wanted = [...new Set(assets)].slice(0, MAX_PRICED + 2);
  // Those lookups carry a price too, so a first call that looked up every
  // asset it prices needs no query on top.
  const fresh = new Map<string, number>();
  let lookedUpAll = true;
  await Promise.all(
    wanted.map(async (asset) => {
      if (regular.has(asset)) {
        lookedUpAll = false;
        return;
      }
      try {
        const res = await fetch(STON_ASSETS + asset);
        if (!res.ok) return;
        const body = await res.json();
        regular.set(asset, isRegularAsset(body));
        const price = Number((body as { asset: Record<string, unknown> }).asset.dex_usd_price);
        if (regular.get(asset) && Number.isFinite(price) && price > 0) fresh.set(asset, price);
      } catch {
        // One failed lookup leaves that token unpriced until the next refresh.
      }
    }),
  );
  const trusted = wanted.filter((asset) => regular.get(asset) === true);
  if (trusted.length === 0) return new Map();
  if (lookedUpAll) return fresh;
  const res = await fetch(STON_ASSETS_QUERY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unconditional_assets: trusted }),
  });
  if (!res.ok) throw new Error(`STON.fi asset query: HTTP ${res.status}`);
  return parseQueryPrices(await res.json(), trusted);
}

/** Sum of holdings (amount already in whole units, price in USD) expressed in USD₮. */
export function totalInUsdt(holdings: { amount: number; usd: number }[], usdtUsd: number): number {
  return holdings.reduce((sum, h) => sum + (h.amount * h.usd) / usdtUsd, 0);
}

/** A USD₮ figure to cents. */
export function formatUsdt(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
