import { describe, expect, it } from 'vitest';
import { toNano } from '@ton/core';
import {
  SEND_ALL_RESERVE_NANO,
  assertAffordable,
  assertNetworkMatches,
  compareVersions,
  formatOwnAddress,
  parseAmountTon,
  parseDestination,
} from './validation';

/* One account, written four ways — generated with @ton/core's own encoder,
 * so these double as a check that we read back the same flags it wrote. */
const RAW = '0:2cf3b5f2c9e7b7b8bbbef8b25f3ce6e2d9e0ee6e4d3c6b1a09f8e7d6c5b4a392';
const EQ = 'EQAs87Xyyee3uLu--LJfPObi2eDubk08axoJ-OfWxbSjkpLP'; // bounceable, mainnet
const UQ = 'UQAs87Xyyee3uLu--LJfPObi2eDubk08axoJ-OfWxbSjks8K'; // non-bounceable, mainnet
const KQ = 'kQAs87Xyyee3uLu--LJfPObi2eDubk08axoJ-OfWxbSjkilF'; // bounceable, testnet

describe('parseDestination', () => {
  it('keeps the bounceable flag from a friendly address', () => {
    expect(parseDestination(EQ).bounceable).toBe(true);
    expect(parseDestination(UQ).bounceable).toBe(false);
  });

  it('keeps the testnet flag from a friendly address', () => {
    expect(parseDestination(KQ).testOnly).toBe(true);
    expect(parseDestination(EQ).testOnly).toBe(false);
  });

  it('defaults a raw address to bounceable, like every other TON wallet', () => {
    const dest = parseDestination(RAW);
    expect(dest.bounceable).toBe(true);
    expect(dest.testOnly).toBe(false);
  });

  it('resolves every form to the same account', () => {
    const raw = parseDestination(RAW).address;
    for (const form of [EQ, UQ, KQ]) {
      expect(parseDestination(form).address.equals(raw)).toBe(true);
    }
  });

  it('tolerates surrounding whitespace from a paste', () => {
    expect(parseDestination(`  ${EQ}\n`).address.equals(parseDestination(EQ).address)).toBe(true);
  });

  it('rejects empty and malformed input', () => {
    expect(() => parseDestination('')).toThrow(/Enter a destination/);
    expect(() => parseDestination('   ')).toThrow(/Enter a destination/);
    expect(() => parseDestination('definitely not an address')).toThrow(/not a valid TON address/);
    // Right shape, wrong checksum — must not slip through.
    expect(() => parseDestination(EQ.slice(0, -1) + 'A')).toThrow(/not a valid TON address/);
  });
});

describe('assertNetworkMatches', () => {
  it('refuses a testnet address on mainnet', () => {
    expect(() => assertNetworkMatches(parseDestination(KQ), 'mainnet')).toThrow(/testnet address/);
  });

  it('allows an unflagged address on testnet', () => {
    expect(() => assertNetworkMatches(parseDestination(EQ), 'testnet')).not.toThrow();
    expect(() => assertNetworkMatches(parseDestination(RAW), 'testnet')).not.toThrow();
  });

  it('allows matching combinations', () => {
    expect(() => assertNetworkMatches(parseDestination(KQ), 'testnet')).not.toThrow();
    expect(() => assertNetworkMatches(parseDestination(EQ), 'mainnet')).not.toThrow();
  });
});

describe('parseAmountTon', () => {
  it('converts whole and fractional amounts to nanotons', () => {
    expect(parseAmountTon('1')).toBe(1_000_000_000n);
    expect(parseAmountTon('0.05')).toBe(50_000_000n);
    expect(parseAmountTon('0.000000001')).toBe(1n);
  });

  it('rejects anything that is not a positive decimal', () => {
    for (const bad of ['', '  ', 'abc', '-1', '1e9', '0x10', '1,5', '.5', '1.']) {
      expect(() => parseAmountTon(bad)).toThrow();
    }
  });

  it('rejects zero, however written', () => {
    expect(() => parseAmountTon('0')).toThrow(/greater than zero/);
    expect(() => parseAmountTon('0.000000000')).toThrow(/greater than zero/);
  });

  it('rejects more precision than nanotons can hold', () => {
    expect(() => parseAmountTon('0.0000000001')).toThrow(/9 decimals/);
  });
});

describe('assertAffordable', () => {
  it('rejects an empty wallet', () => {
    expect(() => assertAffordable(toNano('1'), 0n)).toThrow(/no balance/);
  });

  it('rejects sending the entire balance, since fees come out of the rest', () => {
    const balance = toNano('1');
    expect(() => assertAffordable(balance, balance)).toThrow(/network fees/);
  });

  it('rejects an amount that leaves too little for fees', () => {
    expect(() => assertAffordable(toNano('0.99'), toNano('1'))).toThrow(/network fees/);
  });

  it('allows an amount with the fee reserve left over', () => {
    expect(() => assertAffordable(toNano('0.9'), toNano('1'))).not.toThrow();
  });

  it('honours a smaller reserve, and names it in the message', () => {
    const balance = toNano('1');
    expect(() => assertAffordable(balance - SEND_ALL_RESERVE_NANO, balance, SEND_ALL_RESERVE_NANO)).not.toThrow();
    expect(() => assertAffordable(balance - SEND_ALL_RESERVE_NANO + 1n, balance, SEND_ALL_RESERVE_NANO)).toThrow(
      /at least 0\.01 GRAM/,
    );
  });
});

describe('formatOwnAddress', () => {
  it('renders a receiving address non-bounceable', () => {
    expect(formatOwnAddress(parseDestination(RAW).address, 'mainnet')).toBe(UQ);
  });

  it('flags testnet, so it cannot be mistaken for a mainnet address', () => {
    const testnet = formatOwnAddress(parseDestination(RAW).address, 'testnet');
    expect(testnet).not.toBe(UQ);
    expect(parseDestination(testnet).testOnly).toBe(true);
    expect(parseDestination(testnet).bounceable).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders by each component', () => {
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('0.9.1', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('treats missing components as zero', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.1', '1.0.9')).toBeGreaterThan(0);
  });

  it('ignores a leading v and trailing suffixes', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.4-dirty', '1.2.3')).toBeGreaterThan(0);
  });

  it('reports equal for anything unparseable, so garbage never looks newer', () => {
    expect(compareVersions('unknown', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', 'unknown')).toBe(0);
  });
});
