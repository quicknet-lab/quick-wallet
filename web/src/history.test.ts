import { describe, expect, it } from 'vitest';
import { Address } from '@ton/core';
import { parseHistory } from './history';

const OWN = Address.parseRaw(`0:${'11'.repeat(32)}`);
const OTHER = Address.parseRaw(`0:${'22'.repeat(32)}`);
const USDT = Address.parse('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs');
const SCAM_RAW = `0:${'ab'.repeat(32)}`;
const up = (a: Address) => a.toRawString().toUpperCase();

const base = { action_id: 'a', start_utime: 1_790_000_000, success: true, trace_external_hash: 'AAEC' };

describe('parseHistory', () => {
  it('reads sent and received GRAM, with the comment', () => {
    const { items, count } = parseHistory(
      {
        actions: [
          { ...base, type: 'ton_transfer', details: { source: up(OWN), destination: up(OTHER), value: '1500000000', comment: 'rent' } },
          { ...base, action_id: 'b', type: 'ton_transfer', details: { source: up(OTHER), destination: up(OWN), value: '2000000000', comment: null } },
        ],
      },
      OWN,
    );
    expect(count).toBe(2);
    expect(items[0]).toMatchObject({ kind: 'ton', outgoing: true, comment: 'rent', hash: '000102' });
    expect(items[0].legs).toEqual([{ symbol: 'GRAM', amount: '1.5', incoming: false, verified: true }]);
    expect(items[0].counterparty?.equals(OTHER)).toBe(true);
    expect(items[1]).toMatchObject({ outgoing: false });
    expect(items[1].legs[0]).toEqual({ symbol: 'GRAM', amount: '2', incoming: true, verified: true });
  });

  it('uses the pinned decimals for a known jetton and skips one flagged as a scam', () => {
    const { items } = parseHistory(
      {
        actions: [
          { ...base, type: 'jetton_transfer', details: { asset: up(USDT), sender: up(OWN), receiver: up(OTHER), amount: '2500000' } },
          { ...base, action_id: 'c', type: 'jetton_transfer', details: { asset: SCAM_RAW, sender: up(OTHER), receiver: up(OWN), amount: '1' } },
        ],
        metadata: {
          [up(USDT)]: { token_info: [{ type: 'jetton_masters', symbol: 'FAKE', extra: { decimals: '2' } }] },
          [SCAM_RAW.toUpperCase()]: { token_info: [{ type: 'jetton_masters', symbol: 'CLAIM', is_scam: true }] },
        },
      },
      OWN,
    );
    expect(items).toHaveLength(1);
    expect(items[0].legs).toEqual([{ symbol: 'USD₮', amount: '2.5', incoming: false, verified: true }]);
  });

  it('marks a look-alike of a pinned token as unverified', () => {
    const fake = Address.parseRaw(`0:${'cd'.repeat(32)}`).toRawString().toUpperCase();
    const { items } = parseHistory(
      {
        actions: [{ ...base, type: 'jetton_transfer', details: { asset: fake, sender: up(OTHER), receiver: up(OWN), amount: '5000000' } }],
        metadata: { [fake]: { token_info: [{ type: 'jetton_masters', symbol: 'USD₮', extra: { decimals: '6' } }] } },
      },
      OWN,
    );
    expect(items[0].legs).toEqual([{ symbol: 'USD₮', amount: '5', incoming: true, verified: false }]);
  });

  it('reads a swap as what was sent and what came back', () => {
    const { items } = parseHistory(
      {
        actions: [
          {
            ...base,
            type: 'jetton_swap',
            details: {
              dex_incoming_transfer: { asset: null, amount: '1000000000' },
              dex_outgoing_transfer: { asset: up(USDT), amount: '1518137' },
            },
          },
        ],
      },
      OWN,
    );
    expect(items[0].kind).toBe('swap');
    expect(items[0].legs).toEqual([
      { symbol: 'GRAM', amount: '1', incoming: false, verified: true },
      { symbol: 'USD₮', amount: '1.518137', incoming: true, verified: true },
    ]);
  });

  it('keeps NFT moves and own contract calls, drops the rest, and marks failures', () => {
    const { items, count } = parseHistory(
      {
        actions: [
          { ...base, type: 'nft_transfer', details: { old_owner: up(OTHER), new_owner: up(OWN), nft_item: up(OTHER) } },
          { ...base, action_id: 'd', type: 'call_contract', success: false, details: { source: up(OWN), destination: up(OTHER), value: '30000000' } },
          { ...base, action_id: 'e', type: 'call_contract', details: { source: up(OTHER), destination: up(OWN), value: '1' } },
          { ...base, action_id: 'f', type: 'jetton_mint', details: {} },
        ],
      },
      OWN,
    );
    expect(count).toBe(4);
    expect(items.map((i) => i.kind)).toEqual(['nft', 'call']);
    expect(items[0].outgoing).toBe(false);
    expect(items[1].success).toBe(false);
  });

  it('survives garbage', () => {
    expect(parseHistory(null, OWN)).toEqual({ items: [], count: 0 });
    expect(parseHistory({ actions: [null, 5, { type: 'ton_transfer' }] }, OWN).items).toEqual([]);
  });
});
