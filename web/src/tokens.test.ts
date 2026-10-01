import { describe, expect, it } from 'vitest';
import { Address, Cell } from '@ton/core';
import {
  formatUnits,
  isKnownJetton,
  isJettonTransferBody,
  jettonTransferBody,
  nftTransferBody,
  parseJettonHoldings,
  parseJettonMasterLookup,
  parseNftItems,
  parseUnits,
} from './tokens';

const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const USDT_RAW = Address.parse(USDT_MASTER).toRawString();
/** A master that is deliberately not in the pinned registry. */
const UNLISTED_RAW = Address.parseRaw(`0:${'ab'.repeat(32)}`).toRawString();
const OWNER = Address.parse('UQAs87Xyyee3uLu--LJfPObi2eDubk08axoJ-OfWxbSjks8K');
const RECIPIENT = Address.parse('EQAs87Xyyee3uLu--LJfPObi2eDubk08axoJ-OfWxbSjkpLP');

describe('parseUnits', () => {
  it('scales by the token\'s own decimals', () => {
    expect(parseUnits('12.5', 6)).toBe(12_500_000n);
    expect(parseUnits('12.5', 9)).toBe(12_500_000_000n);
    expect(parseUnits('1', 0)).toBe(1n);
  });

  it('rejects more precision than the token has', () => {
    expect(() => parseUnits('1.0000001', 6)).toThrow(/6 decimals/);
    expect(() => parseUnits('1.5', 0)).toThrow(/indivisible/);
  });

  it('rejects anything that is not a positive number', () => {
    expect(() => parseUnits('', 9)).toThrow(/Enter an amount/);
    expect(() => parseUnits('-1', 9)).toThrow(/positive number/);
    expect(() => parseUnits('1e9', 9)).toThrow(/positive number/);
    expect(() => parseUnits('0', 9)).toThrow(/greater than zero/);
    expect(() => parseUnits('0.000', 6)).toThrow(/greater than zero/);
  });

  it('handles amounts past what a JS number could hold exactly', () => {
    expect(parseUnits('9007199254.740993', 9)).toBe(9_007_199_254_740_993_000n);
  });
});

describe('formatUnits', () => {
  it('is the inverse of parseUnits for representable amounts', () => {
    expect(formatUnits(12_500_000n, 6)).toBe('12.5');
    expect(formatUnits(1n, 9)).toBe('0.000000001');
    expect(formatUnits(0n, 6)).toBe('0');
    expect(formatUnits(1_000_000n, 6)).toBe('1');
    expect(formatUnits(42n, 0)).toBe('42');
  });
});

describe('isKnownJetton', () => {
  it('recognises a pinned mainnet master', () => {
    expect(isKnownJetton(Address.parse(USDT_MASTER), 'mainnet')).toBe(true);
  });

  it('trusts nothing on testnet, where no address is canonical', () => {
    expect(isKnownJetton(Address.parse(USDT_MASTER), 'testnet')).toBe(false);
  });

  it('does not recognise an unlisted master', () => {
    expect(isKnownJetton(RECIPIENT, 'mainnet')).toBe(false);
  });
});

/** Shaped after a real toncenter v3 /jetton/wallets response. */
const JETTON_RESPONSE = {
  jetton_wallets: [
    {
      address: '0:0000005CECBDC23E9FE415D530ADEE667EF35B4D3DB4CC49088B4F319179A86F',
      balance: '1250000000',
      owner: OWNER.toRawString().toUpperCase(),
      jetton: USDT_RAW.toUpperCase(),
    },
  ],
  metadata: {
    [USDT_RAW.toUpperCase()]: {
      token_info: [
        {
          type: 'jetton_masters',
          name: 'Tether USD',
          symbol: 'USD₮',
          image: 'https://tether.to/images/logoCircle.png',
          is_scam: false,
          extra: {
            decimals: '6',
            _image_small: 'https://proxy.toncenter.com/abc/pr:small/xyz',
          },
        },
      ],
    },
  },
};

/** The same response, for a master the registry doesn't pin. */
function unlisted(response: typeof JETTON_RESPONSE) {
  const other = structuredClone(response);
  other.jetton_wallets[0].jetton = UNLISTED_RAW.toUpperCase();
  other.metadata[UNLISTED_RAW.toUpperCase()] = other.metadata[USDT_RAW.toUpperCase()];
  return other;
}

describe('parseJettonHoldings', () => {
  it('reads balance, metadata and decimals out of a v3 response', () => {
    const [holding] = parseJettonHoldings(JETTON_RESPONSE, 'mainnet');
    expect(holding.symbol).toBe('USD₮');
    expect(holding.name).toBe('Tether USD');
    expect(holding.decimals).toBe(6);
    expect(holding.balance).toBe(1_250_000_000n);
    expect(formatUnits(holding.balance, holding.decimals)).toBe('1250');
    expect(holding.master.toRawString()).toBe(USDT_RAW);
    expect(holding.verified).toBe(true);
    expect(holding.isScam).toBe(false);
    expect(holding.decimalsDisputed).toBe(false);
  });

  it('keeps a pinned token\'s own decimals when the indexer claims others', () => {
    // The whole point of the pin: this lie would otherwise turn "5" into
    // 5000 USD₮, with the app and the device screen both reading "5".
    const lying = structuredClone(JETTON_RESPONSE);
    lying.metadata[USDT_RAW.toUpperCase()].token_info[0].extra.decimals = '9';
    const [holding] = parseJettonHoldings(lying, 'mainnet');
    expect(holding.decimals).toBe(6);
    expect(parseUnits('5', holding.decimals)).toBe(5_000_000n);
    expect(holding.decimalsDisputed).toBe(true);
  });

  it('takes an unlisted token\'s decimals from the indexer, with nothing to dispute', () => {
    const [holding] = parseJettonHoldings(unlisted(JETTON_RESPONSE), 'mainnet');
    expect(holding.verified).toBe(false);
    expect(holding.decimals).toBe(6);
    expect(holding.decimalsDisputed).toBe(false);
  });

  it('disputes nothing on testnet, where no master is pinned', () => {
    const lying = structuredClone(JETTON_RESPONSE);
    lying.metadata[USDT_RAW.toUpperCase()].token_info[0].extra.decimals = '9';
    const [holding] = parseJettonHoldings(lying, 'testnet');
    expect(holding.decimals).toBe(9);
    expect(holding.decimalsDisputed).toBe(false);
  });

  it('takes images only from toncenter\'s proxy, never the token\'s own URL', () => {
    const [proxied] = parseJettonHoldings(JETTON_RESPONSE, 'mainnet');
    expect(proxied.image).toBe('https://proxy.toncenter.com/abc/pr:small/xyz');

    const selfHosted = structuredClone(JETTON_RESPONSE);
    selfHosted.metadata[USDT_RAW.toUpperCase()].token_info[0].extra = {
      decimals: '6',
      _image_small: 'https://tracker.example.com/pixel.png',
    };
    expect(parseJettonHoldings(selfHosted, 'mainnet')[0].image).toBeNull();
  });

  it('falls back to placeholders and 9 decimals when metadata is missing', () => {
    const bare = { jetton_wallets: unlisted(JETTON_RESPONSE).jetton_wallets, metadata: {} };
    const [holding] = parseJettonHoldings(bare, 'mainnet');
    expect(holding.symbol).toBe('???');
    expect(holding.name).toBe('Unknown token');
    expect(holding.decimals).toBe(9);
    expect(holding.image).toBeNull();
  });

  it('keeps a pinned token\'s decimals even with no metadata at all — and calls that no dispute', () => {
    const bare = { jetton_wallets: JETTON_RESPONSE.jetton_wallets, metadata: {} };
    const [holding] = parseJettonHoldings(bare, 'mainnet');
    expect(holding.decimals).toBe(6);
    expect(holding.decimalsDisputed).toBe(false);
  });

  it('flattens and caps hostile names instead of passing them through', () => {
    const hostile = structuredClone(JETTON_RESPONSE);
    hostile.metadata[USDT_RAW.toUpperCase()].token_info[0].name =
      `Claim 5000 USDT\n\nat evil.example ${'x'.repeat(200)}`;
    // testnet: on mainnet this master's name comes from the registry instead.
    const [holding] = parseJettonHoldings(hostile, 'testnet');
    expect(holding.name).not.toContain('\n');
    expect(holding.name.length).toBe(64);
  });

  it('names a pinned jetton from the registry, whatever the indexer says', () => {
    const renamed = structuredClone(JETTON_RESPONSE);
    renamed.metadata[USDT_RAW.toUpperCase()].token_info[0].symbol = 'USDC';
    renamed.metadata[USDT_RAW.toUpperCase()].token_info[0].name = 'Something else';
    const [holding] = parseJettonHoldings(renamed, 'mainnet');
    expect(holding.symbol).toBe('USD₮');
    expect(holding.name).toBe('Tether USD');
  });

  it('marks a jetton the indexer flagged', () => {
    const flagged = structuredClone(JETTON_RESPONSE);
    flagged.metadata[USDT_RAW.toUpperCase()].token_info[0].is_scam = true;
    expect(parseJettonHoldings(flagged, 'mainnet')[0].isScam).toBe(true);
  });

  it('skips broken records but keeps the rest', () => {
    const mixed = {
      ...JETTON_RESPONSE,
      jetton_wallets: [
        { address: 'not-an-address', balance: '1', jetton: USDT_RAW.toUpperCase() },
        ...JETTON_RESPONSE.jetton_wallets,
      ],
    };
    expect(parseJettonHoldings(mixed, 'mainnet')).toHaveLength(1);
  });

  it('returns nothing for a response that is not a jetton list', () => {
    expect(parseJettonHoldings(null, 'mainnet')).toEqual([]);
    expect(parseJettonHoldings({}, 'mainnet')).toEqual([]);
    expect(parseJettonHoldings({ jetton_wallets: 'nope' }, 'mainnet')).toEqual([]);
  });
});

const NFT_ITEM_RAW = '0:6BE366AE463F1729F81C6BD5C30D457E5C01873A9C50F2C6F22B41E7D0FEA84D';
const NFT_COLLECTION_RAW = '0:0E41DC1DC3C9067ED24248580E12B3359818D83DEE0304FABCF80845EAFAFDB2';

const NFT_RESPONSE = {
  nft_items: [
    {
      address: NFT_ITEM_RAW,
      index: '9604597126395707131061539893145877846351090743386360682585099482167288',
      collection_address: NFT_COLLECTION_RAW,
      owner_address: OWNER.toRawString().toUpperCase(),
      on_sale: false,
    },
  ],
  metadata: {
    [NFT_ITEM_RAW]: {
      token_info: [
        {
          type: 'nft_items',
          name: '+888 0768 4929',
          is_scam: false,
          extra: { _image_small: 'https://proxy.toncenter.com/nft/pr:small/abc' },
        },
      ],
    },
    [NFT_COLLECTION_RAW]: {
      token_info: [
        { type: 'nft_collections', name: 'Anonymous Telegram Numbers', is_scam: false },
      ],
    },
  },
};

describe('parseNftItems', () => {
  it('reads the item and its collection name', () => {
    const [item] = parseNftItems(NFT_RESPONSE);
    expect(item.name).toBe('+888 0768 4929');
    expect(item.collection).toBe('Anonymous Telegram Numbers');
    expect(item.image).toBe('https://proxy.toncenter.com/nft/pr:small/abc');
    expect(item.address.toRawString()).toBe(NFT_ITEM_RAW.toLowerCase());
    expect(item.onSale).toBe(false);
  });

  it('falls back to the on-chain index when the item has no name', () => {
    const unnamed = structuredClone(NFT_RESPONSE);
    delete (unnamed.metadata as Record<string, unknown>)[NFT_ITEM_RAW];
    expect(parseNftItems(unnamed)[0].name).toMatch(/^#96045971/);
  });

  it('inherits the scam flag from the collection', () => {
    const flagged = structuredClone(NFT_RESPONSE);
    flagged.metadata[NFT_COLLECTION_RAW].token_info[0].is_scam = true;
    expect(parseNftItems(flagged)[0].isScam).toBe(true);
  });

  it('reports an item held by a sale contract', () => {
    const onSale = structuredClone(NFT_RESPONSE);
    onSale.nft_items[0].on_sale = true;
    expect(parseNftItems(onSale)[0].onSale).toBe(true);
  });

  it('handles a standalone item with no collection', () => {
    const standalone = structuredClone(NFT_RESPONSE);
    standalone.nft_items[0].collection_address = null as unknown as string;
    expect(parseNftItems(standalone)[0].collection).toBeNull();
  });
});

/** Re-reads a body cell the way the receiving contract would. */
function readTransferHeader(body: Cell) {
  const s = body.beginParse();
  return { op: s.loadUint(32), queryId: s.loadUintBig(64), slice: s };
}

describe('jettonTransferBody', () => {
  it('lays out a TEP-74 transfer the receiving jetton wallet can parse', () => {
    const body = jettonTransferBody({ amount: 12_500_000n, to: RECIPIENT, responseTo: OWNER });
    const { op, queryId, slice } = readTransferHeader(body);
    expect(op).toBe(0x0f8a7ea5);
    expect(queryId).toBe(0n);
    expect(slice.loadCoins()).toBe(12_500_000n);
    expect(slice.loadAddress().equals(RECIPIENT)).toBe(true);
    expect(slice.loadAddress().equals(OWNER)).toBe(true);
    expect(slice.loadBit()).toBe(false); // custom_payload: none
    expect(slice.loadCoins()).toBe(1n); // forward_ton_amount
    expect(slice.loadBit()).toBe(false); // forward_payload: empty, inline
  });

  it('is recognised by its op, and nothing else is', () => {
    expect(isJettonTransferBody(jettonTransferBody({ amount: 1n, to: RECIPIENT, responseTo: OWNER }))).toBe(true);
    expect(isJettonTransferBody(nftTransferBody({ newOwner: RECIPIENT, responseTo: OWNER }))).toBe(false);
    expect(isJettonTransferBody(Cell.EMPTY)).toBe(false);
    expect(isJettonTransferBody('a comment')).toBe(false);
    expect(isJettonTransferBody(undefined)).toBe(false);
  });

  it('carries a comment as a referenced text payload', () => {
    const body = jettonTransferBody({
      amount: 1n,
      to: RECIPIENT,
      responseTo: OWNER,
      comment: 'rent',
    });
    const { slice } = readTransferHeader(body);
    slice.loadCoins();
    slice.loadAddress();
    slice.loadAddress();
    slice.loadBit();
    slice.loadCoins();
    expect(slice.loadBit()).toBe(true); // payload is a ref
    const payload = slice.loadRef().beginParse();
    expect(payload.loadUint(32)).toBe(0); // text comment opcode
    expect(payload.loadStringTail()).toBe('rent');
  });
});

describe('nftTransferBody', () => {
  it('lays out a TEP-62 transfer the item contract can parse', () => {
    const body = nftTransferBody({ newOwner: RECIPIENT, responseTo: OWNER });
    const { op, slice } = readTransferHeader(body);
    expect(op).toBe(0x5fcc3d14);
    expect(slice.loadAddress().equals(RECIPIENT)).toBe(true);
    expect(slice.loadAddress().equals(OWNER)).toBe(true);
    expect(slice.loadBit()).toBe(false);
    expect(slice.loadCoins()).toBe(1n);
    expect(slice.loadBit()).toBe(false);
  });
});

describe('parseJettonMasterLookup', () => {
  const body = (image: string) => ({
    jetton_masters: [{}],
    metadata: {
      [UNLISTED_RAW]: {
        token_info: [{ type: 'jetton_masters', symbol: 'ABC', name: 'Abc coin', extra: { decimals: '6', _image_small: image } }],
      },
    },
  });

  it('returns the logo when it comes through toncenter\'s proxy', () => {
    const url = 'https://proxy.toncenter.com/image/abc.png';
    expect(parseJettonMasterLookup(body(url), UNLISTED_RAW)).toEqual({ symbol: 'ABC', name: 'Abc coin', decimals: 6, image: url });
  });

  it('finds the entry when the indexer keys it in upper case', () => {
    const url = 'https://proxy.toncenter.com/image/abc.png';
    const upper = body(url);
    upper.metadata = { [UNLISTED_RAW.toUpperCase()]: upper.metadata[UNLISTED_RAW] } as typeof upper.metadata;
    expect(parseJettonMasterLookup(upper, UNLISTED_RAW)?.symbol).toBe('ABC');
  });

  it('drops a logo hosted anywhere else', () => {
    expect(parseJettonMasterLookup(body('https://evil.example/x.png'), UNLISTED_RAW)?.image).toBeNull();
  });
});
