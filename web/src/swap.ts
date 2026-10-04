import { Buffer } from 'buffer';
import { Address, Cell, contractAddress, fromNano, loadStateInit, toNano } from '@ton/core';
import type { Quote, QuoteOfType } from '@ston-fi/omniston-sdk';
import { FEE_RESERVE_NANO } from './validation';
import type { OutMessage } from './wallet';

// Pure checks and decoding only. The Omniston client itself lives in
// omniston.ts, loaded on first visit to the SWAP tab: its SDK (rxjs,
// json-rpc, a WebSocket shim) is most of the bundle, and this file is
// imported by wallet.ts on every page load. Type imports from the SDK are
// erased at build time and pull none of that in.

/** A swap asset: TON itself, or a jetton identified by its master address. */
export type SwapAsset = { kind: 'native' } | { kind: 'jetton'; master: Address };

/** Same test as the SDK's own isSwapQuote, which can't be imported here without the SDK. */
export function isSwapQuote(quote: Quote): quote is QuoteOfType<'swap'> {
  return quote?.settlementData?.$case === 'swap';
}


/**
 * Turns Omniston's `TonMessage` wire shape (address, nanoTON amount, and a
 * hex-encoded BOC body/state-init) into the same `OutMessage` shape every
 * other transfer in this app is built from. Pure and synchronous — no
 * network access, and directly testable.
 */
export function decodeSwapMessage(msg: {
  targetAddress: string;
  sendAmount: string;
  payload: string;
  jettonWalletStateInit?: string;
}): OutMessage {
  const body = msg.payload ? Cell.fromBoc(Buffer.from(msg.payload, 'hex'))[0] : Cell.EMPTY;
  let init: { code?: Cell; data?: Cell } | undefined;
  if (msg.jettonWalletStateInit) {
    const stateInit = loadStateInit(
      Cell.fromBoc(Buffer.from(msg.jettonWalletStateInit, 'hex'))[0].beginParse(),
    );
    init = { code: stateInit.code ?? undefined, data: stateInit.data ?? undefined };
  }
  return {
    to: Address.parse(msg.targetAddress),
    value: BigInt(msg.sendAmount),
    bounce: true,
    body,
    init,
  };
}

/** Decodes every message of a built swap transaction and sums their TON value. */
export function decodeSwapTransaction(messages: {
  targetAddress: string;
  sendAmount: string;
  payload: string;
  jettonWalletStateInit?: string;
}[]): { messages: OutMessage[]; totalValue: bigint } {
  const decoded = messages.map(decodeSwapMessage);
  return { messages: decoded, totalValue: decoded.reduce((sum, m) => sum + m.value, 0n) };
}

/**
 * Most TON a single swap message may carry for gas on top of the swapped
 * amount itself. Real routes attach roughly 0.1-0.3 TON per message
 * (unspent gas comes back); anything above this is not gas.
 */
export const SWAP_MAX_GAS_PER_MESSAGE = toNano('0.5');

/**
 * What the ALL button swaps when the input is GRAM: the whole balance less the
 * quote's gas budget (Omniston attaches it on top of the input amount) and a
 * network-fee reserve, so the swap can still pay for itself. 0 when nothing is
 * left over.
 */
export function swapAllAmount(balance: bigint, gasBudget: bigint): bigint {
  // Twice the fee reserve: assertAffordable() wants that reserve left after
  // the whole message value, so the same amount again is the slack for a
  // route that attaches a little more than its budget.
  const left = balance - gasBudget - FEE_RESERVE_NANO * 2n;
  return left > 0n ? left : 0n;
}

/** Omniston's own default for a TON wallet (SwapSettlementParams.maxRoutes). */
export const SWAP_MAX_MESSAGES = 4;

const JETTON_TRANSFER_OP = 0x0f8a7ea5;
const NFT_TRANSFER_OP = 0x5fcc3d14;

/** The op code a body starts with, when it has 32 bits to start with. */
function bodyOp(body: OutMessage['body']): number | undefined {
  if (!(body instanceof Cell)) return undefined;
  const slice = body.beginParse();
  return slice.remainingBits >= 32 ? slice.preloadUint(32) : undefined;
}

function sameAsset(id: Quote['inputAsset'], asset: SwapAsset): boolean {
  if (id?.chain?.$case !== 'ton') return false;
  const kind = id.chain.value.kind;
  if (asset.kind === 'native') return kind?.$case === 'native';
  if (kind?.$case !== 'jetton') return false;
  try {
    return Address.parse(kind.value).equals(asset.master);
  } catch {
    return false;
  }
}

/** Refuses a quote for anything other than the amount and pair that was asked for. */
export function checkQuoteMatchesRequest(
  quote: Quote,
  request: { from: SwapAsset; to: SwapAsset; amountUnits: bigint },
): void {
  if (!sameAsset(quote.inputAsset, request.from) || !sameAsset(quote.outputAsset, request.to)) {
    throw new Error('The quote is for a different pair of assets than the one requested.');
  }
  if (BigInt(quote.inputUnits) !== request.amountUnits) {
    throw new Error('The quote is for a different amount than the one entered.');
  }
}

function jettonTransferOf(body: OutMessage['body']): { amount: bigint; destination: Address } {
  if (!(body instanceof Cell)) {
    throw new Error('A swap message to your jetton wallet carries no token transfer. Refusing to sign.');
  }
  try {
    const slice = body.beginParse();
    if (slice.loadUint(32) !== JETTON_TRANSFER_OP) throw new Error('not a transfer');
    slice.loadUintBig(64); // query_id
    const amount = slice.loadCoins();
    const destination = slice.loadAddress();
    return { amount, destination };
  } catch {
    throw new Error('A swap message to your jetton wallet is not a token transfer. Refusing to sign.');
  }
}

/**
 * Checks a transaction Omniston built against what the user actually asked
 * for, before it goes anywhere near the device.
 *
 * What this cannot check is who ends up with the funds: Omniston routes
 * through STON.fi, DeDust, Tonco, CoffeeSwap and whatever else it
 * aggregates, each with its own pools and vaults, so there is no fixed list
 * of contract addresses to pin. What it can check is that the transaction
 * spends no more than the amount entered, of the asset picked, plus bounded
 * gas, and that it moves nothing else the wallet holds. That turns "a
 * compromised relay (or SDK) can drain the wallet" into "can take at most the
 * amount being swapped".
 *
 * Returns the address the funds are handed to first — the swap contract,
 * not the wallet's own jetton wallet — for the device's confirm screen.
 */
export function checkSwapTransaction(
  tx: { messages: OutMessage[] },
  request: { from: SwapAsset; amountUnits: bigint; ownJettonWallet?: Address },
): { recipient: Address } {
  const { messages } = tx;
  if (messages.length === 0 || messages.length > SWAP_MAX_MESSAGES) {
    throw new Error(`The swap has ${messages.length} messages — expected 1 to ${SWAP_MAX_MESSAGES}. Refusing to sign.`);
  }
  // Recomputed here rather than taken from the caller: this is the number
  // the whole check rests on.
  const totalTon = messages.reduce((sum, m) => sum + m.value, 0n);
  const gasCap = SWAP_MAX_GAS_PER_MESSAGE * BigInt(messages.length);

  if (request.from.kind === 'native') {
    if (messages.some((m) => m.init)) {
      throw new Error('The swap tries to deploy a contract, which a TON swap never needs. Refusing to sign.');
    }
    // A TON swap hands TON to a pool; it never orders this wallet's own jetton
    // wallet or NFT item around. Without this the TON total is the only bound
    // there is, and it says nothing about what a body does: a message carrying
    // a token transfer of the whole balance costs a few cents of TON and would
    // pass every other check here.
    if (messages.some((m) => bodyOp(m.body) === JETTON_TRANSFER_OP || bodyOp(m.body) === NFT_TRANSFER_OP)) {
      throw new Error('The swap moves tokens out of this wallet, which a TON swap never does. Refusing to sign.');
    }
    if (totalTon > request.amountUnits + gasCap) {
      throw new Error(
        `The swap would send ${fromNano(totalTon)} GRAM for a ${fromNano(request.amountUnits)} GRAM swap — ` +
          'more than the swap plus gas. Refusing to sign.',
      );
    }
    return { recipient: messages[0].to };
  }

  const own = request.ownJettonWallet;
  if (!own) throw new Error('Your jetton wallet for this token could not be resolved.');
  if (totalTon > gasCap) {
    throw new Error(`The swap would attach ${fromNano(totalTon)} GRAM of gas — far more than a swap needs. Refusing to sign.`);
  }
  let sent = 0n;
  let recipient: Address | undefined;
  for (const message of messages) {
    if (!message.to.equals(own)) {
      throw new Error('A swap message is addressed somewhere other than your own jetton wallet. Refusing to sign.');
    }
    // A state init for a jetton wallet that already holds the balance is
    // redundant but harmless — as long as it is exactly that wallet's.
    if (message.init && !contractAddress(own.workChain, message.init).equals(own)) {
      throw new Error('The swap carries a contract deployment that is not your jetton wallet. Refusing to sign.');
    }
    const transfer = jettonTransferOf(message.body);
    sent += transfer.amount;
    recipient ??= transfer.destination;
  }
  if (sent !== request.amountUnits) {
    throw new Error(
      `The swap would send ${sent} token units, but ${request.amountUnits} were requested. Refusing to sign.`,
    );
  }
  return { recipient: recipient! };
}

export type { Quote };
