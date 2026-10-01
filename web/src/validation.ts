import { Address, fromNano, toNano } from '@ton/core';

export type Network = 'testnet' | 'mainnet';

export type Destination = {
  address: Address;
  /** Taken from the address the user actually pasted, not guessed from the
   * workchain — a non-bounceable (UQ/0Q) address means "keep the coins even
   * if nothing is deployed there", and honouring that is the difference
   * between a transfer arriving and bouncing back minus fees. Raw addresses
   * ("0:abc…") carry no such flag, so they default to bounceable, matching
   * every other TON wallet. */
  bounceable: boolean;
  /** Friendly addresses carry a testnet-only flag; raw ones don't. */
  testOnly: boolean;
};

/**
 * Accepts both friendly (EQ…/UQ…/kQ…/0Q…) and raw ("0:hex") forms, keeping
 * whatever flags the friendly form carried. Throws a message meant to be
 * shown to the user as-is.
 */
export function parseDestination(input: string): Destination {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error('Enter a destination address.');
  }

  try {
    const { address, isBounceable, isTestOnly } = Address.parseFriendly(trimmed);
    return { address, bounceable: isBounceable, testOnly: isTestOnly };
  } catch {
    // Not a friendly address — fall through to the raw form.
  }

  try {
    return { address: Address.parseRaw(trimmed), bounceable: true, testOnly: false };
  } catch {
    throw new Error('That is not a valid TON address.');
  }
}

/**
 * Refuses a testnet-flagged address while mainnet is selected — the one
 * direction that reliably means a mistake with real money. The reverse
 * (an un-flagged address on testnet) is normal: plenty of tooling prints
 * addresses without the flag, and raw addresses never carry one.
 */
export function assertNetworkMatches(dest: Destination, network: Network): void {
  if (dest.testOnly && network === 'mainnet') {
    throw new Error('That is a testnet address, but mainnet is selected.');
  }
}

/** TON has 9 decimals; more than that isn't representable in nanotons. */
const AMOUNT_RE = /^\d+(\.\d{1,9})?$/;

/** Parses a human "0.05" into nanotons, with errors meant for the user. */
export function parseAmountTon(input: string): bigint {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error('Enter an amount.');
  }
  if (!AMOUNT_RE.test(trimmed)) {
    throw new Error('Amount must be a positive number with at most 9 decimals.');
  }
  const nano = toNano(trimmed);
  if (nano <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }
  return nano;
}

/**
 * Headroom left for network fees when checking affordability. Fees come out
 * of the remaining balance (SendMode.PAY_GAS_SEPARATELY), so a transfer of
 * exactly the full balance always fails on-chain — this catches it before
 * the user walks over to the device and presses the button. A simple
 * transfer costs well under this; the reserve is deliberately generous.
 */
export const FEE_RESERVE_NANO = toNano('0.05');

export function assertAffordable(
  amountNano: bigint,
  balanceNano: bigint,
  reserveNano: bigint = FEE_RESERVE_NANO,
): void {
  if (balanceNano === 0n) {
    throw new Error('This wallet has no balance yet.');
  }
  if (amountNano + reserveNano > balanceNano) {
    throw new Error(
      `Not enough balance to cover this amount plus network fees. Leave at least ${fromNano(reserveNano)} GRAM for fees.`,
    );
  }
}

/**
 * Reserve for a plain TON transfer, and what the SEND form's ALL button
 * leaves behind. A transfer costs about 0.001 TON, so this is ten times
 * that: tight enough not to strand real money, loose enough that the
 * estimate being a little off can't turn "send all" into a skipped message
 * (IGNORE_ERRORS) with the fee still burned.
 */
export const SEND_ALL_RESERVE_NANO = toNano('0.01');

/**
 * Renders the wallet's own address for display and for handing out to
 * senders: non-bounceable, because an address people copy to receive coins
 * should accept them even before the wallet contract is deployed, and
 * flagged test-only on testnet so it can't be mistaken for a mainnet one.
 */
export function formatOwnAddress(address: Address, network: Network): string {
  return address.toString({ bounceable: false, testOnly: network === 'testnet' });
}

/**
 * Compares firmware versions like "1.2.3" or "v1.2.3-dirty". Returns a
 * negative number if `a` is older than `b`, 0 if equal, positive if newer.
 * Anything unparseable sorts as equal so a weird version string can never
 * silently look like an available "upgrade".
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] | null => {
    const m = v.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
