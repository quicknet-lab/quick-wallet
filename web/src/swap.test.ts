import { describe, expect, it } from 'vitest';
import { Address, beginCell, Cell, contractAddress, toNano } from '@ton/core';
import type { Quote } from '@ston-fi/omniston-sdk';
import {
  SWAP_MAX_GAS_PER_MESSAGE,
  checkQuoteMatchesRequest,
  checkSwapTransaction,
  decodeSwapMessage,
  decodeSwapTransaction,
  isSwapQuote,
  swapAllAmount,
} from './swap';
import { jettonTransferBody, nftTransferBody } from './tokens';
import type { OutMessage } from './wallet';

const ROUTER = 'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT';

/** A distinct workchain-0 address per byte, e.g. addr('aa') = 0:aaaa…aa. */
const addr = (byte: string) => Address.parseRaw(`0:${byte.repeat(32)}`);

describe('decodeSwapMessage', () => {
  it('turns a TonMessage into an OutMessage with the same address, value and body', () => {
    const body = beginCell().storeUint(0x0f8a7ea5, 32).storeUint(0, 64).endCell();
    const message = decodeSwapMessage({
      targetAddress: ROUTER,
      sendAmount: '150000000',
      payload: body.toBoc().toString('hex'),
    });

    expect(message.to.equals(Address.parse(ROUTER))).toBe(true);
    expect(message.value).toBe(150_000_000n);
    expect(message.bounce).toBe(true);
    expect(message.init).toBeUndefined();
    expect((message.body as Cell).equals(body)).toBe(true);
  });

  it('leaves the message body empty when Omniston sends no payload', () => {
    const message = decodeSwapMessage({ targetAddress: ROUTER, sendAmount: '1', payload: '' });
    expect((message.body as Cell).equals(Cell.EMPTY)).toBe(true);
  });

  it('decodes an attached jetton-wallet state init into code/data cells', () => {
    const code = beginCell().storeUint(1, 8).endCell();
    const data = beginCell().storeUint(2, 8).endCell();
    const stateInit = beginCell()
      .storeBit(0) // split_depth
      .storeBit(0) // special
      .storeBit(1) // code present
      .storeRef(code)
      .storeBit(1) // data present
      .storeRef(data)
      .storeBit(0) // library
      .endCell();

    const message = decodeSwapMessage({
      targetAddress: ROUTER,
      sendAmount: '50000000',
      payload: beginCell().endCell().toBoc().toString('hex'),
      jettonWalletStateInit: stateInit.toBoc().toString('hex'),
    });

    expect(message.init?.code?.equals(code)).toBe(true);
    expect(message.init?.data?.equals(data)).toBe(true);
  });
});

describe('decodeSwapTransaction', () => {
  it('sums the TON value across every message', () => {
    const payload = beginCell().endCell().toBoc().toString('hex');
    const { messages, totalValue } = decodeSwapTransaction([
      { targetAddress: ROUTER, sendAmount: '100000000', payload },
      { targetAddress: ROUTER, sendAmount: '50000000', payload },
    ]);
    expect(messages).toHaveLength(2);
    expect(totalValue).toBe(150_000_000n);
  });
});

describe('isSwapQuote', () => {
  it('is true only for a swap-settlement quote, not an order-settlement one', () => {
    const swapQuote = { settlementData: { $case: 'swap', value: {} } } as Parameters<typeof isSwapQuote>[0];
    const orderQuote = { settlementData: { $case: 'order', value: {} } } as Parameters<typeof isSwapQuote>[0];
    expect(isSwapQuote(swapQuote)).toBe(true);
    expect(isSwapQuote(orderQuote)).toBe(false);
  });
});

describe('checkQuoteMatchesRequest', () => {
  const master = addr('cc');
  const tonId = { chain: { $case: 'ton', value: { kind: { $case: 'native', value: {} } } } };
  const jettonId = (a: Address) => ({
    chain: { $case: 'ton', value: { kind: { $case: 'jetton', value: a.toString({ bounceable: true }) } } },
  });
  const quote = (input: unknown, output: unknown, inputUnits: string) =>
    ({ inputAsset: input, outputAsset: output, inputUnits }) as unknown as Quote;
  const request = { from: { kind: 'native' } as const, to: { kind: 'jetton', master } as const, amountUnits: 100n };

  it('accepts the pair and amount that were asked for', () => {
    expect(() => checkQuoteMatchesRequest(quote(tonId, jettonId(master), '100'), request)).not.toThrow();
  });

  it('refuses another amount or another pair', () => {
    expect(() => checkQuoteMatchesRequest(quote(tonId, jettonId(master), '101'), request)).toThrow(/amount/);
    const other = addr('ee');
    expect(() => checkQuoteMatchesRequest(quote(tonId, jettonId(other), '100'), request)).toThrow(/pair/);
    expect(() => checkQuoteMatchesRequest(quote(jettonId(master), tonId, '100'), request)).toThrow(/pair/);
  });
});

describe('checkSwapTransaction', () => {
  const pool = addr('aa');
  const ownJettonWallet = addr('bb');
  const me = addr('dd');
  const native = { kind: 'native' } as const;
  const jetton = { kind: 'jetton', master: addr('cc') } as const;

  const tonMessage = (value: bigint, extra: Partial<OutMessage> = {}): OutMessage => ({
    to: pool,
    value,
    bounce: true,
    body: Cell.EMPTY,
    ...extra,
  });
  const jettonMessage = (amount: bigint, extra: Partial<OutMessage> = {}): OutMessage => ({
    to: ownJettonWallet,
    value: toNano('0.3'),
    bounce: true,
    body: jettonTransferBody({ amount, to: pool, responseTo: me }),
    ...extra,
  });

  it('accepts a TON swap spending the amount plus gas, and names where it goes', () => {
    const { recipient } = checkSwapTransaction(
      { messages: [tonMessage(toNano('10.25'))] },
      { from: native, amountUnits: toNano('10') },
    );
    expect(recipient.equals(pool)).toBe(true);
  });

  it('refuses a TON swap sending more than the amount plus gas', () => {
    const messages = [tonMessage(toNano('10') + SWAP_MAX_GAS_PER_MESSAGE + 1n)];
    expect(() => checkSwapTransaction({ messages }, { from: native, amountUnits: toNano('10') })).toThrow(
      /more than the swap plus gas/,
    );
  });

  it('refuses a contract deployment in a TON swap', () => {
    const messages = [tonMessage(toNano('1'), { init: { code: Cell.EMPTY, data: Cell.EMPTY } })];
    expect(() => checkSwapTransaction({ messages }, { from: native, amountUnits: toNano('1') })).toThrow(/deploy/);
  });

  it('refuses a TON swap whose body moves tokens out of this wallet', () => {
    // The bound on TON says nothing about what a body does: this costs a few
    // cents of gas and would otherwise walk off with the whole jetton balance.
    const drainJettons = [
      tonMessage(toNano('0.05'), {
        to: ownJettonWallet,
        body: jettonTransferBody({ amount: 1_000_000_000n, to: pool, responseTo: me }),
      }),
    ];
    expect(() =>
      checkSwapTransaction({ messages: drainJettons }, { from: native, amountUnits: toNano('10') }),
    ).toThrow(/moves tokens out of this wallet/);

    const stealNft = [
      tonMessage(toNano('0.05'), { body: nftTransferBody({ newOwner: pool, responseTo: me }) }),
    ];
    expect(() => checkSwapTransaction({ messages: stealNft }, { from: native, amountUnits: toNano('10') })).toThrow(
      /moves tokens out of this wallet/,
    );

    // Still accepted: a body the pool reads, which is what a real TON swap is.
    const realSwap = [tonMessage(toNano('10.1'), { body: beginCell().storeUint(0x25938561, 32).endCell() })];
    expect(() =>
      checkSwapTransaction({ messages: realSwap }, { from: native, amountUnits: toNano('10') }),
    ).not.toThrow();

    // And a body too short to carry an op code at all.
    const stub = [tonMessage(toNano('10.1'), { body: beginCell().storeUint(1, 8).endCell() })];
    expect(() => checkSwapTransaction({ messages: stub }, { from: native, amountUnits: toNano('10') })).not.toThrow();
  });

  it('refuses no messages, or more than a wallet sends at once', () => {
    expect(() => checkSwapTransaction({ messages: [] }, { from: native, amountUnits: 1n })).toThrow(/expected 1 to 4/);
    const five = Array.from({ length: 5 }, () => tonMessage(1n));
    expect(() => checkSwapTransaction({ messages: five }, { from: native, amountUnits: 5n })).toThrow(/expected 1 to 4/);
  });

  it('accepts a jetton swap from your own jetton wallet, and names the swap contract', () => {
    const { recipient } = checkSwapTransaction(
      { messages: [jettonMessage(60n), jettonMessage(40n)] },
      { from: jetton, amountUnits: 100n, ownJettonWallet },
    );
    expect(recipient.equals(pool)).toBe(true);
  });

  it('refuses a jetton swap message addressed anywhere but your jetton wallet', () => {
    const messages = [jettonMessage(100n, { to: pool })];
    expect(() => checkSwapTransaction({ messages }, { from: jetton, amountUnits: 100n, ownJettonWallet })).toThrow(
      /other than your own jetton wallet/,
    );
  });

  it('refuses a jetton amount other than the one requested', () => {
    const messages = [jettonMessage(101n)];
    expect(() => checkSwapTransaction({ messages }, { from: jetton, amountUnits: 100n, ownJettonWallet })).toThrow(
      /101 token units, but 100/,
    );
  });

  it('refuses a message to your jetton wallet that is not a transfer', () => {
    const messages = [jettonMessage(100n, { body: Cell.EMPTY })];
    expect(() => checkSwapTransaction({ messages }, { from: jetton, amountUnits: 100n, ownJettonWallet })).toThrow(
      /not a token transfer/,
    );
  });

  it('refuses a jetton swap attaching more TON than gas', () => {
    const messages = [jettonMessage(100n, { value: SWAP_MAX_GAS_PER_MESSAGE + 1n })];
    expect(() => checkSwapTransaction({ messages }, { from: jetton, amountUnits: 100n, ownJettonWallet })).toThrow(
      /gas/,
    );
  });

  it('accepts a state init only when it is your jetton wallet', () => {
    const init = { code: beginCell().storeUint(1, 8).endCell(), data: beginCell().storeUint(2, 8).endCell() };
    const deployed = contractAddress(0, init);
    const ok = [jettonMessage(100n, { to: deployed, init })];
    expect(() =>
      checkSwapTransaction({ messages: ok }, { from: jetton, amountUnits: 100n, ownJettonWallet: deployed }),
    ).not.toThrow();

    const foreign = [jettonMessage(100n, { init })];
    expect(() => checkSwapTransaction({ messages: foreign }, { from: jetton, amountUnits: 100n, ownJettonWallet })).toThrow(
      /not your jetton wallet/,
    );
  });
});

describe('swapAllAmount', () => {
  it('leaves the gas budget and the fee reserve', () => {
    expect(swapAllAmount(toNano('10'), toNano('0.1'))).toBe(toNano('9.8'));
  });

  it('is zero when the balance cannot cover them', () => {
    expect(swapAllAmount(toNano('0.2'), toNano('0.1'))).toBe(0n);
    expect(swapAllAmount(toNano('0.05'), toNano('0.1'))).toBe(0n);
  });
});
