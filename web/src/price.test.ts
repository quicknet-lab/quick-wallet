import { describe, expect, it } from 'vitest';
import { formatUsdt, isRegularAsset, parseQueryPrices, totalInUsdt } from './price';

const GRAM = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

describe('isRegularAsset', () => {
  it('accepts an asset STON.fi lists as regular', () => {
    expect(isRegularAsset({ asset: { community: false, blacklisted: false, deprecated: false } })).toBe(true);
  });

  it('refuses community, blacklisted and deprecated assets, and anything unusable', () => {
    expect(isRegularAsset({ asset: { community: true } })).toBe(false);
    expect(isRegularAsset({ asset: { blacklisted: true } })).toBe(false);
    expect(isRegularAsset({ asset: { deprecated: true } })).toBe(false);
    expect(isRegularAsset(null)).toBe(false);
    expect(isRegularAsset({})).toBe(false);
  });
});

describe('parseQueryPrices', () => {
  it('keys the prices the way they were asked for, whatever form the reply uses', () => {
    const raw = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';
    const prices = parseQueryPrices(
      { asset_list: [{ contract_address: GRAM, dex_price_usd: '1.52' }, { contract_address: raw, dex_price_usd: '0.9997' }] },
      [GRAM, USDT],
    );
    expect(prices).toEqual(new Map([[GRAM, 1.52], [USDT, 0.9997]]));
  });

  it('ignores assets that were not asked for and prices that are unusable', () => {
    const other = 'EQBE_gBrU3mPI9hHjlJoR_kYyrhQgyCFD6EUWfa42W8T7EBP';
    const prices = parseQueryPrices(
      {
        asset_list: [
          { contract_address: other, dex_price_usd: '1000' },
          { contract_address: GRAM, dex_price_usd: null },
          { contract_address: USDT, dex_price_usd: '0' },
          { contract_address: 'junk', dex_price_usd: '1' },
        ],
      },
      [GRAM, USDT],
    );
    expect(prices.size).toBe(0);
    expect(parseQueryPrices(null, [GRAM]).size).toBe(0);
  });
});

describe('totalInUsdt', () => {
  it('adds holdings priced in USD, expressed in USD₮', () => {
    const total = totalInUsdt(
      [
        { amount: 1000, usd: 1.5 },
        { amount: 10, usd: 0.5 },
      ],
      0.995,
    );
    expect(formatUsdt(total)).toBe('1,512.56');
  });

  it('is zero for nothing', () => {
    expect(formatUsdt(totalInUsdt([], 1))).toBe('0.00');
  });
});
