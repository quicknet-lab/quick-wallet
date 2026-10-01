import { Omniston, type Quote, type QuoteRequest } from '@ston-fi/omniston-sdk';
import type { Address } from '@ton/core';
import { decodeSwapTransaction, type SwapAsset } from './swap';
import type { OutMessage } from './wallet';

// The Omniston client: everything that needs the SDK at runtime. Loaded with
// import() from main.ts on first visit to the SWAP tab, so the SDK stays out
// of the main chunk. The checks that decide whether a built swap may be
// signed are in swap.ts, not here.

/**
 * Omniston (STON.fi's swap-quoting protocol) only runs on TON mainnet — its
 * WebSocket relay has no testnet counterpart, unlike toncenter. The Swap tab
 * is disabled outright on testnet rather than pretending to support it.
 */
export const OMNISTON_WS_URL = 'wss://omni-ws.ston.fi';

function assetId(asset: SwapAsset) {
  return {
    chain: {
      $case: 'ton' as const,
      value: {
        kind:
          asset.kind === 'native'
            ? { $case: 'native' as const, value: {} }
            : { $case: 'jetton' as const, value: asset.master.toString({ bounceable: true }) },
      },
    },
  };
}

/** 1% expressed in the protocol's pips (1 pip = 1/1,000,000 = 0.0001%) — STON.fi's own default. */
const DEFAULT_SLIPPAGE_PIPS = 10_000;

function quoteRequest(params: {
  from: SwapAsset;
  to: SwapAsset;
  amountUnits: bigint;
  slippagePips?: number;
}): QuoteRequest {
  return {
    inputAsset: assetId(params.from),
    outputAsset: assetId(params.to),
    amount: { $case: 'inputUnits', value: params.amountUnits.toString() },
    settlementParams: [
      {
        params: {
          $case: 'swap',
          value: { maxPriceSlippagePips: params.slippagePips ?? DEFAULT_SLIPPAGE_PIPS },
        },
      },
    ],
  };
}

/**
 * Subscribes to Omniston's live quote stream for one request, the way the
 * STON.fi app does: the relay pushes a fresh quote (new quote id, current
 * price) about every ten seconds for as long as the subscription is open.
 * Returns the function that closes it.
 */
export function watchQuotes(
  omniston: Omniston,
  params: { from: SwapAsset; to: SwapAsset; amountUnits: bigint; slippagePips?: number },
  handlers: { onQuote: (quote: Quote) => void; onNoQuote: () => void; onError: (err: Error) => void },
): () => void {
  const subscription = omniston.requestForQuote(quoteRequest(params)).subscribe({
    next: (event) => {
      if (event.$case === 'quoteUpdated') handlers.onQuote(event.value);
      else if (event.$case === 'noQuote') handlers.onNoQuote();
    },
    error: (err: unknown) => handlers.onError(err instanceof Error ? err : new Error(String(err))),
  });
  return () => subscription.unsubscribe();
}

export function createOmniston(): Omniston {
  return new Omniston({ apiUrl: OMNISTON_WS_URL });
}

/**
 * Asks Omniston to build the on-chain transaction for a quote, addressed
 * from and back to this wallet (both source and destination of the swap),
 * and decodes it into messages ready for `TonWallet.buildAndSignSwap`.
 */
export async function buildSwapTransaction(
  omniston: Omniston,
  quoteId: string,
  walletAddress: Address,
  /** Take Omniston's recommended slippage for this quote; otherwise the cap the quote was requested with. */
  autoSlippage: boolean,
): Promise<{ messages: OutMessage[]; totalValue: bigint }> {
  const wallet = { chain: { $case: 'ton' as const, value: walletAddress.toString({ bounceable: true }) } };
  const { messages } = await omniston.tonBuildSwap({
    quoteId,
    transferSrcAddress: wallet,
    useRecommendedSlippage: autoSlippage,
  });
  return decodeSwapTransaction(messages);
}

export type { Omniston };
