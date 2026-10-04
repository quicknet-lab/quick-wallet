import type { FlashPlan } from './firmware';

/**
 * Installing firmware on a factory-fresh device over USB, from the browser.
 *
 * This speaks the same ROM-bootloader protocol as `idf.py flash`, through
 * esptool-js over Web Serial, so the person who just unboxed a device needs
 * no toolchain, no Python and no driver install — the ESP32-S3's USB port
 * enumerates as a standard serial device on Windows 10+, macOS and Linux,
 * and the browser's port picker is the whole setup step.
 *
 * It is meant as a one-time path. A secure release (FlashPlan.secure) has
 * the device's own bootloader burn Secure Boot v2 and Flash Encryption into
 * eFuses the first time it starts; after that securityBurned() below turns
 * this path away and OTA over BLE is the only way in. A development release
 * leaves the device re-flashable and its flash readable over USB. Whoever
 * calls this must have said which of the two it is, plainly — see the flash
 * modal in main.ts.
 */

export type FlashReport = {
  /** A stage of the process, for the status line. */
  onStep: (message: string) => void;
  /** Fraction written so far, 0-1. */
  onProgress: (fraction: number) => void;
};

// ESP32-S3 eFuse block 0, as read back through the ROM loader
// (IDF soc/esp32s3/include/soc/efuse_reg.h, efuse/esp32s3/esp_efuse_table.csv).
const EFUSE_RD_REPEAT_DATA1_REG = 0x60007034; // SPI_BOOT_CRYPT_CNT: bits 18-20
const EFUSE_RD_REPEAT_DATA2_REG = 0x60007038; // SECURE_BOOT_EN: bit 20

/**
 * Whether the chip has ever had Secure Boot or Flash Encryption burned in.
 * Such a chip checks the bootloader's signature against its own key and
 * expects flash it encrypted itself, so the erase-everything, write-plaintext
 * install below would leave it unable to boot. Any CRYPT_CNT bit counts, not
 * only an odd count: this path is for fresh chips only.
 */
export async function securityBurned(loader: { readReg(addr: number): Promise<number> }): Promise<boolean> {
  const cryptCnt = ((await loader.readReg(EFUSE_RD_REPEAT_DATA1_REG)) >>> 18) & 0x7;
  const secureBootEn = ((await loader.readReg(EFUSE_RD_REPEAT_DATA2_REG)) >>> 20) & 0x1;
  return cryptCnt !== 0 || secureBootEn !== 0;
}

export function usbFlashingSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/**
 * Writes `images` (one per entry of `plan.parts`, already downloaded) to the
 * device the user picks, and reboots it into the result. Returns the name of
 * the chip that was written.
 */
export async function flashDevice(
  plan: FlashPlan,
  images: ArrayBuffer[],
  report: FlashReport,
): Promise<string> {
  if (!usbFlashingSupported()) {
    throw new Error('This browser cannot open USB serial ports — use desktop Chrome or Edge.');
  }

  // First statement for a reason: the port picker only opens while the click
  // that led here still counts as a user gesture, and awaiting anything
  // beforehand (a download, even the dynamic import below) spends it.
  const port = await navigator.serial.requestPort();

  // Loaded on demand rather than imported at the top: esptool-js is a large
  // dependency that all but the first-ever visit never needs.
  const { ESPLoader, Transport } = await import('esptool-js');

  const transport = new Transport(port, false);
  const loader = new ESPLoader({ transport, baudrate: 921600 });

  try {
    report.onStep('Waking the device up…');
    await loader.main();
    const chip = loader.chip.CHIP_NAME;
    if (chip.toLowerCase() !== plan.chip.toLowerCase()) {
      throw new Error(`This release is built for ${plan.chip}, but the device on that port is an ${chip}.`);
    }
    if (await securityBurned(loader)) {
      throw new Error(
        'This device already has Secure Boot or Flash Encryption switched on. Erasing it and writing a fresh install over USB would leave it unable to start — update it over Bluetooth from the wallet instead.',
      );
    }

    // Erasing first rather than writing over what's there: this is the
    // "set up a new device" path, and a half-overwritten NVS carrying a
    // previous owner's wallet would be worse than the extra ten seconds.
    report.onStep('Erasing the device…');

    const total = images.reduce((sum, image) => sum + image.byteLength, 0);
    const writtenPerImage = images.map(() => 0);

    await loader.writeFlash({
      fileArray: plan.parts.map((part, index) => ({
        data: new Uint8Array(images[index]),
        address: part.offset,
      })),
      // The images come out of the IDF build with the right flash mode,
      // frequency and size already in their header; "keep" writes them as
      // built instead of second-guessing from the browser.
      flashMode: 'keep',
      flashFreq: 'keep',
      flashSize: 'keep',
      eraseAll: true,
      compress: true,
      reportProgress: (fileIndex, written) => {
        writtenPerImage[fileIndex] = written;
        report.onProgress(writtenPerImage.reduce((a, b) => a + b, 0) / total);
      },
    });

    report.onStep('Restarting the device…');
    // Not after('hard_reset'): in esptool-js 0.6.1 that only releases RTS
    // without pulling it first, so the chip is never reset and sits in the
    // ROM loader with a dark screen until someone unplugs it (seen on the
    // board 2026-09-29). This is esptool.py's own hard reset: DTR released
    // so GPIO0 isn't held low, EN pulled low by RTS for 100ms, then released.
    await loader.after('custom_reset', undefined, 'D0|R1|W100|R0');
    return chip;
  } finally {
    await transport.disconnect().catch(() => {});
  }
}
