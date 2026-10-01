import { Buffer } from 'buffer';
import {
  Address,
  TonClient,
  WalletContractV5R1,
  beginCell,
  external,
  internal,
  storeMessage,
  fromNano,
  SendMode,
  type Cell,
} from '@ton/ton';
import { signVerify } from '@ton/crypto';
import { QuickWalletBle, WalletStatus, type DeviceHint } from './ble';
import {
  SEND_ALL_RESERVE_NANO,
  assertAffordable,
  assertNetworkMatches,
  parseAmountTon,
  parseDestination,
  type Network,
} from './validation';
import { parseHistory, type HistoryItem } from './history';
import {
  TOKEN_TRANSFER_GAS,
  formatUnits,
  isJettonTransferBody,
  jettonTransferBody,
  nftTransferBody,
  parseJettonHoldings,
  parseJettonMasterLookup,
  parseNftItems,
  parseUnits,
  type JettonHolding,
  type NftItem,
} from './tokens';
import { checkSwapTransaction, type SwapAsset } from './swap';
import type { DappTransaction } from './tonconnect';

export type { Network };

// toncenter goes through the site's own proxy (functions/api/toncenter), which
// adds the API key server-side; on the dev server vite.config.ts does the same.
const ENDPOINTS: Record<Network, string> = {
  testnet: '/api/toncenter/testnet/api/v2/jsonRPC',
  mainnet: '/api/toncenter/mainnet/api/v2/jsonRPC',
};

/**
 * Token and NFT holdings can't be discovered from a plain RPC node — there
 * is no "list what this address owns" call, only "read this specific
 * contract". That needs an index, and toncenter's v3 API is the one already
 * trusted for balances here, under the same API key, so using it adds no new
 * party to the picture. What it can do is lie about *which* tokens you hold;
 * what it cannot do is affect what gets signed.
 */
const INDEXER: Record<Network, string> = {
  testnet: '/api/toncenter/testnet/api/v3',
  mainnet: '/api/toncenter/mainnet/api/v3',
};

/**
 * TON's network global id, which W5 mixes into its `wallet_id` and therefore
 * into the wallet's own address. This is a real behavioural difference from
 * V4: the same public key gives *different* addresses on testnet and
 * mainnet, and a message signed with the wrong id is rejected by the
 * contract. Values are fixed by the network itself.
 */
const NETWORK_GLOBAL_ID: Record<Network, number> = {
  mainnet: -239,
  testnet: -3,
};

/**
 * Builds the wallet contract this app derives addresses from and signs for.
 *
 * W5 (v5r1), matching what Tonkeeper and the other current TON wallets
 * create by default — so the 24-word phrase from this device restores to
 * the same address elsewhere without changing any wallet-version setting.
 * Switching this constant changes the address for every existing key, so it
 * is not a cosmetic choice.
 */
export function createWalletContract(network: Network, pubkey: Buffer): WalletContractV5R1 {
  return WalletContractV5R1.create({
    walletId: {
      networkGlobalId: NETWORK_GLOBAL_ID[network],
      context: { workchain: 0, walletVersion: 'v5r1', subwalletNumber: 0 },
    },
    publicKey: pubkey,
  });
}

export function explorerAddressUrl(network: Network, address: string): string {
  const base = network === 'testnet' ? 'https://testnet.tonscan.org' : 'https://tonscan.org';
  return `${base}/address/${address}`;
}

/**
 * Retries a toncenter call through rate limiting. Unkeyed endpoints allow
 * roughly one request per second and a single connect-and-send cycle makes
 * several, so 429s are the expected case rather than an edge one. Only
 * 429 and network-level failures are retried; anything
 * else (a malformed request, a rejected message) is a real error and is
 * rethrown immediately.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let delayMs = 600;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      const retryable = message.includes('429') || message.toLowerCase().includes('rate limit');
      if (!retryable || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
}

export type PreparedTransfer = {
  signed: Cell;
  /** seqno the transfer was built against — broadcast is confirmed by
   * watching for the wallet to move past it. */
  seqno: number;
  /** Whether the wallet contract was deployed when this was built; if not,
   * the external message has to carry its code and data. */
  walletDeployed: boolean;
};

/** This wallet's own account, as read once at the start of an operation. */
export type OwnState = {
  balance: bigint;
  deployed: boolean;
};

export type PreparedTonTransfer = PreparedTransfer & {
  /** What was actually sent on the wire, after forcing non-bounceable for
   * an undeployed destination — not just what the address asked for. */
  bounce: boolean;
  destinationDeployed: boolean;
};

/** One outgoing internal message, before it is wrapped and signed. */
export type OutMessage = {
  to: Address;
  value: bigint;
  bounce: boolean;
  body?: Cell | string;
  init?: { code?: Cell; data?: Cell };
};

/**
 * Shown to the user (address, amount, estimated network fee) before the
 * hardware wallet is even asked to sign — a chance to back out of a
 * transfer without a trip to the device. Returning false aborts the send.
 */
export type ConfirmFee = (feeNano: bigint, info: { amount: string; address: string }) => Promise<boolean>;

/** Thrown when the user declines a ConfirmFee prompt. Not a failure — the
 * caller should treat this as a quiet cancel, not an error to report. */
export class SendCancelledError extends Error {
  constructor() {
    super('Cancelled by user.');
    this.name = 'SendCancelledError';
  }
}

/**
 * Token transfers spend TON for gas regardless of the token balance, so a
 * wallet holding jettons but no TON cannot move them. Checked before the
 * device is involved, same as every other pre-flight test.
 */
function assertGasAffordable(own: OwnState): void {
  if (own.balance < TOKEN_TRANSFER_GAS * 2n) {
    throw new Error(
      `Token transfers cost GRAM for gas — keep at least ${fromNano(TOKEN_TRANSFER_GAS * 2n)} GRAM in the wallet.`,
    );
  }
}

export class TonWallet {
  readonly network: Network;
  readonly client: TonClient;
  readonly wallet: WalletContractV5R1;

  constructor(network: Network, pubkey: Buffer) {
    this.network = network;
    // The API key is added by the proxy behind ENDPOINTS, never here.
    this.client = new TonClient({ endpoint: ENDPOINTS[network] });
    this.wallet = createWalletContract(network, pubkey);
  }

  get address(): Address {
    return this.wallet.address;
  }

  /**
   * Balance and deployment state from one request. Every operation reads
   * this once and passes it along: TonClient's own helpers (getBalance,
   * the contract's getSeqno, isContractDeployed, sendExternalMessage) each
   * fetch the same account again, and unkeyed toncenter answers about every
   * other request with a 429.
   */
  async getOwnState(): Promise<OwnState> {
    const state = await withRetry(() => this.client.getContractState(this.address));
    return { balance: state.balance, deployed: state.state === 'active' };
  }

  /** An undeployed wallet has no get-methods to run, and its first message goes out with seqno 0. */
  async getSeqno(own: OwnState): Promise<number> {
    return own.deployed ? this.runSeqno() : 0;
  }

  private async runSeqno(): Promise<number> {
    const result = await withRetry(() => this.client.runMethod(this.address, 'seqno'));
    return result.stack.readNumber();
  }

  // ------------------------------------------------------- discovery

  private async indexerGet(path: string, params: Record<string, string>): Promise<unknown> {
    const url = `${INDEXER[this.network]}${path}?${new URLSearchParams(params)}`;
    return withRetry(async () => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`toncenter responded ${res.status}`);
      }
      return res.json();
    });
  }

  /** Every jetton this wallet holds a non-zero balance of, newest metadata included. */
  async getJettons(): Promise<JettonHolding[]> {
    const body = await this.indexerGet('/jetton/wallets', {
      owner_address: this.address.toRawString(),
      exclude_zero_balance: 'true',
      limit: '100',
    });
    return parseJettonHoldings(body, this.network);
  }

  /**
   * Looks up an arbitrary jetton master's symbol/name/decimals — for adding
   * a token by contract address that isn't in the pinned registry and that
   * this wallet doesn't (yet) hold, so it can't come from getJettons().
   */
  async getJettonMaster(
    master: Address,
  ): Promise<{ symbol: string; name: string; decimals: number; image: string | null } | null> {
    const body = await this.indexerGet('/jetton/masters', {
      address: master.toRawString(),
      limit: '1',
    });
    return parseJettonMasterLookup(body, master.toRawString());
  }

  /** One page of the wallet's transaction history, newest first. */
  async getHistory(offset: number, limit: number): Promise<{ items: HistoryItem[]; hasMore: boolean }> {
    const body = await this.indexerGet('/actions', {
      account: this.address.toRawString(),
      limit: String(limit),
      offset: String(offset),
      sort: 'desc',
    });
    const { items, count } = parseHistory(body, this.address);
    return { items, hasMore: count >= limit };
  }

  async getNfts(): Promise<NftItem[]> {
    const body = await this.indexerGet('/nft/items', {
      owner_address: this.address.toRawString(),
      limit: '100',
    });
    return parseNftItems(body);
  }

  // --------------------------------------------------------- signing

  /**
   * Hands the wallet's signing message to the hardware wallet over BLE —
   * the whole message, which the device reads and hashes itself, not just
   * its hash — waits for the physical confirm, and returns the signed
   * external message ready to broadcast. Does not send it.
   */
  private async signTransfer(
    ble: QuickWalletBle,
    own: OwnState,
    messages: OutMessage[],
    deviceHint: DeviceHint,
    onStatus?: (s: WalletStatus) => void,
    displayInfo?: { amount: string; address: string },
    confirmFee?: ConfirmFee,
    /** Unix time the message stops being valid; the library's default otherwise. */
    validUntil?: number,
  ): Promise<PreparedTransfer> {
    const seqno = await this.getSeqno(own);

    if (confirmFee) {
      const feeNano = await this.estimateFee(seqno, messages, own.deployed);
      if (!(await confirmFee(feeNano, displayInfo ?? { amount: '', address: '' }))) {
        throw new SendCancelledError();
      }
    }

    const signed = await this.wallet.createTransfer({
      seqno,
      timeout: validUntil,
      signer: async (payload) => {
        const sig = await ble.signTransaction(payload.toBoc({ idx: false, crc32: false }), deviceHint, onStatus);
        // The device signs the hash of what it parsed. If that isn't this
        // payload's hash it read different bytes than the ones about to be
        // broadcast — the wallet contract would refuse it anyway, but this
        // way it fails here, with a reason.
        if (!signVerify(payload.hash(), sig, this.wallet.publicKey)) {
          throw new Error('The device signed something other than this transaction. Not sending it.');
        }
        return sig;
      },
      // PAY_GAS_SEPARATELY: network fees come out of the wallet's remaining
      // balance, not out of this message's value — without it (mode 0,
      // the library default) the recipient gets `value` minus fees, so a
      // "send 0.1 TON" arrives short (observed: 0.0999...).
      sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
      messages: messages.map((m) => internal(m)),
    });
    return { signed, seqno, walletDeployed: own.deployed };
  }

  /**
   * Asks toncenter what this exact message would cost, without touching the
   * device: same transfer, built with a throwaway all-zero signature
   * (`ignoreSignature: true` tells the node not to check it) instead of a
   * real one. Only meant for a pre-flight estimate shown to the user —
   * the real signed message is built separately, from a fresh seqno if
   * this one turns out to be stale.
   */
  private async estimateFee(seqno: number, messages: OutMessage[], deployed: boolean): Promise<bigint> {
    const body = await this.wallet.createTransfer({
      seqno,
      signer: async () => Buffer.alloc(64),
      sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
      messages: messages.map((m) => internal(m)),
    });
    // Deployment state changes what has to be included in the external
    // message (the wallet contract's code+data, once) — the same choice the
    // real send makes, so the estimate reflects the actual message size.
    const result = await withRetry(() =>
      this.client.estimateExternalMessageFee(this.address, {
        body,
        initCode: deployed ? null : this.wallet.init.code,
        initData: deployed ? null : this.wallet.init.data,
        ignoreSignature: true,
      }),
    );
    const fees = result.source_fees;
    return (
      BigInt(Math.round(fees.in_fwd_fee)) +
      BigInt(Math.round(fees.storage_fee)) +
      BigInt(Math.round(fees.gas_fee)) +
      BigInt(Math.round(fees.fwd_fee))
    );
  }

  /**
   * A plain TON transfer.
   *
   * Everything that can fail without the device is checked first, on
   * purpose: a bad address or an unaffordable amount should not send
   * someone walking over to press a physical button only to find out
   * afterwards.
   */
  async buildAndSign(
    ble: QuickWalletBle,
    params: { to: string; amountTon: string; comment?: string },
    onStatus?: (s: WalletStatus) => void,
    confirmFee?: ConfirmFee,
  ): Promise<PreparedTonTransfer> {
    const destination = parseDestination(params.to);
    assertNetworkMatches(destination, this.network);
    const amountNano = parseAmountTon(params.amountTon);

    const [own, state] = await Promise.all([
      this.getOwnState(),
      withRetry(() => this.client.getContractState(destination.address)),
    ]);
    assertAffordable(amountNano, own.balance, SEND_ALL_RESERVE_NANO);

    // A bounceable message to an address with no contract deployed comes
    // straight back, minus fees — which is exactly what "send to a fresh
    // wallet" looks like. Honour the flag the user's address carried, but
    // never bounce into an account that cannot accept it.
    const destinationDeployed = state.state === 'active';
    const bounce = destination.bounceable && destinationDeployed;

    const prepared = await this.signTransfer(
      ble,
      own,
      [
        {
          to: destination.address,
          value: amountNano,
          bounce,
          body: params.comment ?? undefined,
        },
      ],
      { bounceable: destination.bounceable, testOnly: destination.testOnly },
      onStatus,
      {
        amount: `${fromNano(amountNano)} GRAM`,
        address: destination.address.toString({ bounceable: destination.bounceable, testOnly: destination.testOnly }),
      },
      confirmFee,
    );
    return { ...prepared, bounce, destinationDeployed };
  }

  /**
   * Asks the jetton master which jetton wallet belongs to this address,
   * instead of taking the indexer's word for it. That address is where the
   * transfer message is actually sent, so getting it wrong would mean
   * ordering a stranger's jetton wallet around (it would refuse, and the
   * gas would be gone) — the one thing in this flow where a lying indexer
   * could otherwise cost money.
   */
  async resolveJettonWallet(master: Address): Promise<Address> {
    const result = await withRetry(() =>
      this.client.runMethod(master, 'get_wallet_address', [
        { type: 'slice', cell: beginCell().storeAddress(this.address).endCell() },
      ]),
    );
    return result.stack.readAddress();
  }

  /**
   * A jetton (TEP-74) transfer. The message goes to our own jetton wallet
   * carrying `TOKEN_TRANSFER_GAS` in TON; the token amount rides in the
   * body, and unspent gas comes back to this wallet.
   *
   * The device reads the units and the recipient out of what it signs, but
   * the decimal point that turns those units into the figure on its screen
   * comes from here — so it is pinned in source for the tokens that can be
   * (see JettonHolding.decimals), and a token whose scale is in dispute is
   * not sent at all.
   */
  async buildAndSignJetton(
    ble: QuickWalletBle,
    params: { holding: JettonHolding; to: string; amount: string; comment?: string },
    onStatus?: (s: WalletStatus) => void,
    confirmFee?: ConfirmFee,
  ): Promise<PreparedTransfer> {
    const { holding } = params;
    if (holding.decimalsDisputed) {
      // The device renders the units it reads back through these decimals, so
      // with two candidate scales in play the screen can't be trusted to show
      // what is actually leaving the wallet — and one of the two sources is
      // lying or stale either way.
      throw new Error(
        `The indexer and this app's own token list disagree about where ${holding.symbol}'s decimal point goes. Refusing to send until that is resolved.`,
      );
    }
    const destination = parseDestination(params.to);
    assertNetworkMatches(destination, this.network);
    const amount = parseUnits(params.amount, holding.decimals);

    if (amount > holding.balance) {
      throw new Error(
        `Not enough ${holding.symbol} — this wallet holds ${formatUnits(holding.balance, holding.decimals)}.`,
      );
    }
    const [own, jettonWallet] = await Promise.all([this.getOwnState(), this.resolveJettonWallet(holding.master)]);
    assertGasAffordable(own);
    if (!jettonWallet.equals(holding.wallet)) {
      throw new Error(
        'The token contract disagrees with the indexer about which jetton wallet is yours. Refusing to send.',
      );
    }

    return this.signTransfer(
      ble,
      own,
      [
        {
          to: jettonWallet,
          value: TOKEN_TRANSFER_GAS,
          // Our own jetton wallet is deployed (it holds the balance), and a
          // bounce returns the gas if the transfer is somehow rejected.
          bounce: true,
          body: jettonTransferBody({
            amount,
            to: destination.address,
            responseTo: this.address,
            comment: params.comment,
          }),
        },
      ],
      {
        bounceable: destination.bounceable,
        testOnly: destination.testOnly,
        token: { symbol: holding.symbol, decimals: holding.decimals },
      },
      onStatus,
      {
        amount: `${formatUnits(amount, holding.decimals)} ${holding.symbol}`,
        address: destination.address.toString({ bounceable: destination.bounceable, testOnly: destination.testOnly }),
      },
      confirmFee,
    );
  }

  /** An NFT (TEP-62) transfer. The message goes to the item contract itself. */
  async buildAndSignNft(
    ble: QuickWalletBle,
    params: { item: NftItem; to: string; comment?: string },
    onStatus?: (s: WalletStatus) => void,
    confirmFee?: ConfirmFee,
  ): Promise<PreparedTransfer> {
    const destination = parseDestination(params.to);
    assertNetworkMatches(destination, this.network);
    const [own] = await Promise.all([this.getOwnState(), this.assertNftOwned(params.item.address)]);
    assertGasAffordable(own);

    return this.signTransfer(
      ble,
      own,
      [
        {
          to: params.item.address,
          value: TOKEN_TRANSFER_GAS,
          bounce: true,
          body: nftTransferBody({
            newOwner: destination.address,
            responseTo: this.address,
            comment: params.comment,
          }),
        },
      ],
      { bounceable: destination.bounceable, testOnly: destination.testOnly },
      onStatus,
      {
        amount: params.item.name,
        address: destination.address.toString({ bounceable: destination.bounceable, testOnly: destination.testOnly }),
      },
      confirmFee,
    );
  }

  /**
   * Signs a swap built elsewhere (see swap.ts) from a STON.fi Omniston quote.
   * The messages arrive fully formed from a third party, so before anything
   * else they are held against what the user asked for — `from` and
   * `amountUnits` — by checkSwapTransaction, which also names the contract
   * the funds really go to for the device screen. The jetton wallet that
   * check compares against is asked of the token's own master contract,
   * not taken from the indexer or from Omniston.
   *
   * On the device, swap contracts are written in the bounceable form their
   * explorers use, and `token` labels the amount when swapping from a jetton.
   */
  async buildAndSignSwap(
    ble: QuickWalletBle,
    params: {
      messages: OutMessage[];
      totalValue: bigint;
      from: SwapAsset;
      amountUnits: bigint;
      display: { amount: string };
      token?: { symbol: string; decimals: number };
    },
    onStatus?: (s: WalletStatus) => void,
    confirmFee?: ConfirmFee,
  ): Promise<PreparedTransfer> {
    const [own, ownJettonWallet] = await Promise.all([
      this.getOwnState(),
      params.from.kind === 'jetton' ? this.resolveJettonWallet(params.from.master) : undefined,
    ]);
    const { recipient } = checkSwapTransaction(params, {
      from: params.from,
      amountUnits: params.amountUnits,
      ownJettonWallet,
    });
    assertAffordable(params.totalValue, own.balance);
    return this.signTransfer(
      ble,
      own,
      params.messages,
      { bounceable: true, testOnly: this.network === 'testnet', token: params.token },
      onStatus,
      { amount: params.display.amount, address: recipient.toString() },
      confirmFee,
    );
  }

  /**
   * Signs what a site asked for over TON Connect (already checked by
   * parseSendTransaction and approved in the app). The messages are the
   * site's own, bodies and all: the device reads out what it can of them,
   * and shows the rest as a contract call.
   */
  async buildAndSignDapp(
    ble: QuickWalletBle,
    tx: DappTransaction,
    onStatus?: (s: WalletStatus) => void,
  ): Promise<PreparedTransfer> {
    const [own, token] = await Promise.all([this.getOwnState(), this.dappTokenHint(tx.messages)]);
    assertAffordable(tx.total, own.balance);
    const first = tx.messages[0];
    return this.signTransfer(
      ble,
      own,
      tx.messages.map(({ to, value, bounce, body, init }) => ({ to, value, bounce, body, init })),
      { bounceable: first.bounce, testOnly: first.testOnly, token },
      onStatus,
      undefined,
      undefined,
      tx.validUntil,
    );
  }

  /**
   * Names the token a site's jetton transfer moves, so the device can put the
   * decimal point in: a site sends a finished message, and without this the
   * screen shows raw units (0.01 USD₮ as "10000"). Asks the indexer which
   * jetton the addressed jetton wallet holds — display only, the device marks
   * it with a '?' and signs the same bytes either way. Nothing on any failure,
   * an undeployed jetton wallet, or a disputed scale: plain units then.
   * The device drops it by itself if several jetton wallets are addressed.
   */
  private async dappTokenHint(messages: OutMessage[]): Promise<DeviceHint['token']> {
    const transfer = messages.find((m) => isJettonTransferBody(m.body));
    if (!transfer) return undefined;
    try {
      const body = await this.indexerGet('/jetton/wallets', { address: transfer.to.toRawString(), limit: '1' });
      const holding = parseJettonHoldings(body, this.network).find((h) => h.wallet.equals(transfer.to));
      if (!holding || holding.decimalsDisputed) return undefined;
      return { symbol: holding.symbol, decimals: holding.decimals };
    } catch {
      return undefined;
    }
  }

  /**
   * Confirms with the item contract that this wallet is still the owner.
   * The item address came from the indexer and real TON is about to be sent
   * to it, so this is both an ownership check and a sanity check that the
   * address is an NFT at all — without it a stale or invented listing costs
   * the gas and a trip to the device before failing on-chain.
   */
  private async assertNftOwned(item: Address): Promise<void> {
    let owner: Address;
    try {
      const result = await withRetry(() => this.client.runMethod(item, 'get_nft_data'));
      result.stack.skip(2); // init?, index
      result.stack.readAddressOpt(); // collection — absent for standalone items
      owner = result.stack.readAddress();
    } catch {
      throw new Error('That NFT could not be read from the chain. Refresh the list and try again.');
    }
    if (!owner.equals(this.address)) {
      throw new Error('This wallet is no longer the owner of that NFT.');
    }
  }

  /**
   * Sends a signed transfer and returns the external message's exact bytes
   * as base64 — a TON Connect site tracks the transaction by them. Builds
   * the message the way TonClient.sendExternalMessage does, but from the
   * deployment state the transfer was built against instead of fetching it
   * again.
   */
  async broadcast(prepared: PreparedTransfer): Promise<string> {
    const message = external({
      to: this.address,
      init: prepared.walletDeployed ? undefined : this.wallet.init,
      body: prepared.signed,
    });
    const boc = beginCell().store(storeMessage(message)).endCell().toBoc();
    await withRetry(() => this.client.sendFile(boc));
    return boc.toString('base64');
  }

  /**
   * Waits for the wallet's seqno to move past the one the transfer was
   * built against, which is what actually proves the network accepted it —
   * a successful POST to toncenter only means the message was handed off.
   * Resolves false on timeout: that is "not confirmed yet", not "failed",
   * and the caller should say so rather than claim either outcome.
   */
  async waitForConfirmation(seqno: number, timeoutMs = 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        if ((await this.runSeqno()) > seqno) return true;
      } catch {
        // Transient RPC failure while polling, or a first transfer that has
        // not deployed the wallet yet — keep waiting out the window.
      }
    }
    return false;
  }
}

export { fromNano };
