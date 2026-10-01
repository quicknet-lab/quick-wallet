import { describe, expect, it } from 'vitest';
import { securityBurned } from './flash';

const DATA1 = 0x60007034;
const DATA2 = 0x60007038;

function loaderWith(regs: Record<number, number>) {
  return { readReg: async (addr: number) => regs[addr] ?? 0 };
}

describe('securityBurned', () => {
  it('passes a fresh chip, whatever the neighbouring bits say', () =>
    expect(securityBurned(loaderWith({ [DATA1]: ~(0x7 << 18), [DATA2]: ~(1 << 20) }))).resolves.toBe(false));

  it('refuses a chip with flash encryption on', () =>
    expect(securityBurned(loaderWith({ [DATA1]: 1 << 18 }))).resolves.toBe(true));

  it('refuses a chip whose flash encryption was switched on and off again', () =>
    expect(securityBurned(loaderWith({ [DATA1]: 0x3 << 18 }))).resolves.toBe(true));

  it('refuses a chip with secure boot on', () =>
    expect(securityBurned(loaderWith({ [DATA2]: 1 << 20 }))).resolves.toBe(true));
});
