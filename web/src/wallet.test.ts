import { Buffer } from 'buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Address, Cell } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';
import { keyPairFromSeed, sign } from '@ton/crypto';
import { TonWallet, createWalletContract } from './wallet';
import type { DeviceHint, QuickWalletBle } from './ble';
import { jettonTransferBody, type JettonHolding } from './tokens';

/** A fixed key, so these addresses are reproducible rather than random. */
const PUBKEY = Buffer.from(
  '2cf3b5f2c9e7b7b8bbbef8b25f3ce6e2d9e0ee6e4d3c6b1a09f8e7d6c5b4a392',
  'hex',
);

describe('createWalletContract', () => {
  it('builds a W5 (v5r1) wallet, not V4', () => {
    const wallet = createWalletContract('mainnet', PUBKEY);
    expect(wallet).toBeInstanceOf(WalletContractV5R1);
    expect(wallet.walletId.context).toEqual({
      workchain: 0,
      walletVersion: 'v5r1',
      subwalletNumber: 0,
    });
  });

  it('tags the wallet with the right network global id', () => {
    expect(createWalletContract('mainnet', PUBKEY).walletId.networkGlobalId).toBe(-239);
    expect(createWalletContract('testnet', PUBKEY).walletId.networkGlobalId).toBe(-3);
  });

  /**
   * Addresses pinned as literals rather than recomputed, so that changing
   * the contract version or the wallet id fails here loudly instead of
   * silently pointing the app at an account nobody can sign for. The V4
   * address the same key used to produce is listed for contrast — it is a
   * different account, and anything sitting at it stays there.
   *
   * Generated with @ton/ton's own encoder on 2026-09-05:
   *   V4 (previous): 0:d0eaaae40ea3a4492021afc1a78055696b7a8b557fc338a453fb31c96948d19d
   */
  it('derives the expected W5 address on each network', () => {
    expect(createWalletContract('mainnet', PUBKEY).address.toRawString()).toBe(
      '0:9c47520f740e1ae42a1fec6bef1f42ddb1d8ff8771006d80a6a1b257979449a9',
    );
    expect(createWalletContract('testnet', PUBKEY).address.toRawString()).toBe(
      '0:0aad9672d92e9e0e949b460e4eb7ca3c96b905677075c71efea527675ce3d8c6',
    );
  });

  /**
   * The defining difference from V4, and the one most likely to look like a
   * bug later: W5 folds the network id into the address, so the same key is
   * a different account on each network.
   */
  it('derives a different address per network from the same key', () => {
    const mainnet = createWalletContract('mainnet', PUBKEY).address;
    const testnet = createWalletContract('testnet', PUBKEY).address;
    expect(mainnet.equals(testnet)).toBe(false);
  });

  it('stays in the basechain', () => {
    expect(createWalletContract('mainnet', PUBKEY).address.workChain).toBe(0);
    expect(createWalletContract('testnet', PUBKEY).address.workChain).toBe(0);
  });
});

describe('buildAndSignJetton', () => {
  const holding = (extra: Partial<JettonHolding> = {}): JettonHolding => ({
    master: Address.parse('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'),
    wallet: Address.parseRaw(`0:${'cd'.repeat(32)}`),
    balance: 5_000_000_000n,
    symbol: 'USD\u20ae',
    name: 'Tether USD',
    decimals: 6,
    image: null,
    isScam: false,
    verified: true,
    decimalsDisputed: false,
    ...extra,
  });

  /**
   * The device shows the units it reads back through these decimals, so two
   * candidate scales mean the screen agrees with the app while the amount
   * that actually leaves is off by a factor of a thousand. Refused before
   * anything is fetched, let alone signed — which is also what makes this
   * testable without a node.
   */
  it('refuses a token the indexer and the pinned list disagree about the scale of', async () => {
    const wallet = new TonWallet('mainnet', PUBKEY);
    await expect(
      wallet.buildAndSignJetton({} as QuickWalletBle, {
        holding: holding({ decimalsDisputed: true }),
        to: 'UQAs87Xyyee3uLu--LJfPObi2eDubk08axoJ-OfWxbSjks8K',
        amount: '5',
      }),
    ).rejects.toThrow(/decimal point/);
  });
});

/**
 * Unkeyed toncenter answers about every other request with a 429 and each
 * retry waits 0.6 s and up, so the number of calls per send is what the
 * user feels. Counts them against a stand-in client: the wallet's own
 * account is read once and reused for balance, seqno, the fee estimate and
 * the broadcast.
 */
describe('request count per send', () => {
  const keys = keyPairFromSeed(Buffer.alloc(32, 7));

  function setup(deployed: boolean) {
    const wallet = new TonWallet('testnet', keys.publicKey);
    const calls: string[] = [];
    let sent: Buffer | undefined;
    const client = {
      getContractState: async (address: Address) => {
        calls.push(address.equals(wallet.address) ? 'getContractState(own)' : 'getContractState(dest)');
        return { balance: 10_000_000_000n, state: deployed ? 'active' : 'uninitialized' };
      },
      runMethod: async (_address: Address, name: string) => {
        calls.push(`runMethod(${name})`);
        return { stack: { readNumber: () => 5 } };
      },
      estimateExternalMessageFee: async () => {
        calls.push('estimateExternalMessageFee');
        return { source_fees: { in_fwd_fee: 1, storage_fee: 1, gas_fee: 1, fwd_fee: 1 } };
      },
      sendFile: async (boc: Buffer) => {
        calls.push('sendFile');
        sent = boc;
      },
    };
    Object.defineProperty(wallet, 'client', { value: client });
    const ble = {
      signTransaction: async (boc: Buffer) => sign(Cell.fromBoc(boc)[0].hash(), keys.secretKey),
    } as unknown as QuickWalletBle;
    return { wallet, ble, calls, sentBoc: () => sent };
  }

  const params = { to: '0QAs87Xyyee3uLu--LJfPObi2eDubk08axoJ-OfWxbSjknSA', amountTon: '1' };

  it('makes five requests for a TON transfer from a deployed wallet', async () => {
    const { wallet, ble, calls } = setup(true);
    const prepared = await wallet.buildAndSign(ble, params, undefined, async () => true);
    await wallet.broadcast(prepared);
    expect(prepared.seqno).toBe(5);
    expect(calls.sort()).toEqual(
      [
        'estimateExternalMessageFee',
        'getContractState(dest)',
        'getContractState(own)',
        'runMethod(seqno)',
        'sendFile',
      ].sort(),
    );
  });

  it('skips the seqno get-method and attaches the contract when the wallet is not deployed yet', async () => {
    const { wallet, ble, calls, sentBoc } = setup(false);
    const prepared = await wallet.buildAndSign(ble, params);
    await wallet.broadcast(prepared);
    expect(prepared.seqno).toBe(0);
    expect(calls).not.toContain('runMethod(seqno)');
    expect(calls.filter((c) => c === 'getContractState(own)')).toHaveLength(1);
    const message = Cell.fromBoc(sentBoc()!)[0];
    // The deploying message carries the wallet's StateInit, whose code cell is one of its refs.
    expect(message.refs.some((ref) => ref.hash().equals(wallet.wallet.init.code.hash()))).toBe(true);
  });
});

/**
 * A site hands over a finished jetton transfer and nothing about the token.
 * The app looks the addressed jetton wallet up so the device can put the
 * decimal point in, instead of showing 0.01 USD₮ as "10000".
 */
describe('token hint for a site\'s jetton transfer', () => {
  const keys = keyPairFromSeed(Buffer.alloc(32, 7));
  const JETTON_WALLET = Address.parseRaw('0:0000005cecbdc23e9fe415d530adee667ef35b4d3db4cc49088b4f319179a86f');
  const USDT = '0:B113A994B5024A16719F69139328EB759596C38A25F59028B146FECDC3621DFE';
  const indexed = {
    jetton_wallets: [{ address: JETTON_WALLET.toRawString().toUpperCase(), balance: '0', jetton: USDT }],
    metadata: { [USDT]: { token_info: [{ type: 'jetton_masters', symbol: 'USD₮', name: 'Tether USD', extra: { decimals: '6' } }] } },
  };

  afterEach(() => vi.unstubAllGlobals());

  async function hintFor(body: Cell | undefined, answer: unknown): Promise<DeviceHint | undefined> {
    const wallet = new TonWallet('mainnet', keys.publicKey);
    Object.defineProperty(wallet, 'client', {
      value: {
        getContractState: async () => ({ balance: 10_000_000_000n, state: 'active' }),
        runMethod: async () => ({ stack: { readNumber: () => 5 } }),
      },
    });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(answer), { status: 200 }));
    let hint: DeviceHint | undefined;
    const ble = {
      signTransaction: async (boc: Buffer, h: DeviceHint) => {
        hint = h;
        return sign(Cell.fromBoc(boc)[0].hash(), keys.secretKey);
      },
    } as unknown as QuickWalletBle;
    await wallet.buildAndSignDapp(ble, {
      validUntil: Math.floor(Date.now() / 1000) + 300,
      total: 50_000_000n,
      messages: [{ to: JETTON_WALLET, value: 50_000_000n, bounce: true, testOnly: false, body }],
    });
    return hint;
  }

  const transfer = jettonTransferBody({ amount: 10_000n, to: JETTON_WALLET, responseTo: JETTON_WALLET });

  it('names the token and its decimals, from the pinned registry where listed', async () => {
    expect((await hintFor(transfer, indexed))?.token).toEqual({ symbol: 'USD₮', decimals: 6 });
  });

  it('leaves plain units when the jetton wallet is unknown to the indexer, or it is not a jetton transfer', async () => {
    expect((await hintFor(transfer, { jetton_wallets: [], metadata: {} }))?.token).toBeUndefined();
    expect((await hintFor(undefined, indexed))?.token).toBeUndefined();
  });
});
