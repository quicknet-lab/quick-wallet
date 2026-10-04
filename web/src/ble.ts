import { Buffer } from 'buffer';

// Matches firmware/main/gatt_svc.h exactly — see that file for the wire protocol.
const SERVICE_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c00';
const PUBKEY_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c01';
const SIGNED_TX_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c03';
const STATUS_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c04';
const PIN_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c05';
const CREATE_WALLET_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c06';
const SHOW_SEED_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c07';
const VERSION_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c08';
const TX_REQUEST_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c0a';
const PROOF_REQUEST_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c0b';
const SHOW_ADDRESS_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c0c';

// OTA lives in the same service under the 0x10-0x13 range — see ota_service.h.
const OTA_CONTROL_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c10';
const OTA_STATUS_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c12';
/** Offset-checked image writes, mostly without response. */
const OTA_DATA_AT_UUID = 'c0ffee00-0ba1-4c9e-9a1a-9a4f6a2b7c13';

export const WalletStatus = {
  Idle: 0,
  AwaitingConfirm: 1,
  Signed: 2,
  Rejected: 3,
  PinOk: 4,
  PinWrong: 5,
  PinLocked: 6,
  PinAlreadySet: 7,
  PinInvalidLen: 8,
  NoWallet: 9,
  CreateAwaitingConfirm: 10,
  Created: 11,
  CreateRejected: 12,
  SeedAwaitingConfirm: 13,
  SeedShowing: 14,
  SeedDone: 15,
  SeedRejected: 16,
  SeedUnavailable: 17,
  CreateGenerating: 18,
  PinNotSet: 19,
  PinChangeAwaitingConfirm: 20,
  PinChanged: 21,
  PinChangeRejected: 22,
  WipeAwaitingConfirm: 23,
  Wiped: 24,
  WipeRejected: 25,
  Busy: 26,
  TxInvalid: 27,
  PinSetAwaitingConfirm: 28,
  PinSetRejected: 29,
  ProofAwaitingConfirm: 30,
  ProofSigned: 31,
  ProofRejected: 32,
  ProofInvalid: 33,
  SeedChecking: 34,
  SeedChecked: 35,
  SeedCheckFailed: 36,
  AddressShowing: 37,
  AddressDone: 38,
  /** Pushed unprompted: the unlocked session went unused and locked itself. */
  SessionLocked: 39,
} as const;
export type WalletStatus = (typeof WalletStatus)[keyof typeof WalletStatus];

/** Mirrors enum ota_status in firmware/main/ota_service.h. */
export const OtaStatus = {
  Idle: 0,
  AwaitingConfirm: 1,
  InProgress: 2,
  Success: 3,
  Error: 4,
  Preparing: 5,
  AwaitingSwitch: 6,
  Downgrade: 7,
} as const;
export type OtaStatus = (typeof OtaStatus)[keyof typeof OtaStatus];

const PIN_OP_SET = 0x01;
const PIN_OP_VERIFY = 0x02;
const PIN_OP_CHANGE = 0x03;
const CREATE_WALLET_OP_START = 0x01;
const CREATE_WALLET_OP_WIPE = 0x02;
const SHOW_SEED_OP_START = 0x01;
const SHOW_SEED_OP_START_CHECK = 0x02;
const ADDRESS_FLAG_TESTNET = 0x01;

const OTA_CMD_START = 0x01;
const OTA_CMD_END = 0x02;
const OTA_CMD_ABORT = 0x03;

/**
 * Bytes per ATT write. The firmware accepts up to 512, but the real limit
 * is the negotiated ATT MTU, which Web Bluetooth doesn't expose — 244 is
 * the largest payload that fits the commonly negotiated 247-byte MTU, and
 * stays safe on stacks that negotiate less generously.
 */
const WRITE_BYTES = 244;

/** Image bytes per write on ota_data_at: the same write size, less the
 * 4-byte offset in front. */
const OTA_AT_CHUNK_BYTES = WRITE_BYTES - 4;
/** Every this many writes on ota_data_at, one goes with response. Its answer
 * comes only once the board has processed everything before it, so the
 * writes without response never run further ahead than this — well within
 * the board's 24 incoming buffers while it writes to flash. */
const OTA_AT_SYNC_EVERY = 16;

/** DataView over a characteristic read isn't necessarily a whole buffer. */
function toBuffer(value: DataView): Buffer {
  return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

/**
 * The device's screen renders a single-byte 5x7 bitmap font (plain ASCII
 * only, see display_font5x7 in firmware/main/display_font.h) -- it has no
 * notion of UTF-8. A token symbol off an indexer can carry anything (USDT's
 * on-chain symbol is actually "USD₮", with a special Tether currency sign),
 * so known look-alikes are swapped for the plain letter they stand in for
 * first (USDT still reads as "USDT", not "USD") and anything else outside
 * printable ASCII is dropped.
 */
const DEVICE_ASCII_SUBSTITUTIONS: Record<string, string> = {
  '₮': 'T', // TENGE SIGN, used as USDT's on-chain symbol ("USD₮")
};

function toDeviceAscii(text: string): string {
  let mapped = text;
  for (const [from, to] of Object.entries(DEVICE_ASCII_SUBSTITUTIONS)) {
    mapped = mapped.split(from).join(to);
  }
  return mapped.replace(/[^\x20-\x7E]/g, '');
}

// GATT_CHR_TX_REQUEST_UUID framing — see firmware/main/gatt_svc.h.
const TX_REQUEST_OP_BEGIN = 0x01;
const TX_REQUEST_OP_DATA = 0x02;
const TX_REQUEST_OP_COMMIT = 0x03;
const TX_HINT_BOUNCEABLE = 0x01;
const TX_HINT_TEST_ONLY = 0x02;
const TX_NO_TOKEN = 0xff;
const TX_MAX_DECIMALS = 24;
const TX_SYMBOL_MAX = 10;
/** TON_TX_MAX_BOC_LEN in firmware/main/ton_tx.h. */
export const TX_REQUEST_MAX_BYTES = 8192;

/**
 * How the device writes things on its confirm screen. None of it changes
 * what gets signed or what the device reads out of the message.
 */
export type DeviceHint = {
  /** Friendly-address form (EQ… or UQ…, kQ…/0Q… with testOnly) — the same address either way. */
  bounceable: boolean;
  testOnly: boolean;
  /** Labels jetton amounts. The device can't tell which token a jetton
   * wallet holds, so it shows this with a '?'; without it, plain units. */
  token?: { symbol: string; decimals: number };
};

/** BEGIN, then `body` in DATA chunks sized to one ATT write, then COMMIT. */
function framedWrites(begin: Buffer, body: Buffer): Buffer[] {
  const writes = [begin];
  const chunk = WRITE_BYTES - 1;
  for (let offset = 0; offset < body.length; offset += chunk) {
    writes.push(Buffer.concat([Buffer.from([TX_REQUEST_OP_DATA]), body.subarray(offset, offset + chunk)]));
  }
  writes.push(Buffer.from([TX_REQUEST_OP_COMMIT]));
  return writes;
}

/** The writes that hand one signing message to the device, in order. */
export function encodeTxRequest(boc: Buffer, hint: DeviceHint): Buffer[] {
  if (boc.length === 0 || boc.length > TX_REQUEST_MAX_BYTES) {
    throw new Error(
      `This transaction can't be checked on the device (${boc.length} bytes, at most ${TX_REQUEST_MAX_BYTES}).`,
    );
  }
  const token = hint.token;
  const labelled =
    token !== undefined && Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= TX_MAX_DECIMALS;
  const symbol = Buffer.from(labelled ? toDeviceAscii(token.symbol).slice(0, TX_SYMBOL_MAX) : '', 'latin1');
  const flags = (hint.bounceable ? TX_HINT_BOUNCEABLE : 0) | (hint.testOnly ? TX_HINT_TEST_ONLY : 0);

  const begin = Buffer.concat([
    Buffer.from([
      TX_REQUEST_OP_BEGIN,
      boc.length >> 8,
      boc.length & 0xff,
      flags,
      labelled ? token.decimals : TX_NO_TOKEN,
      symbol.length,
    ]),
    symbol,
  ]);
  return framedWrites(begin, boc);
}

// GATT_CHR_PROOF_REQUEST_UUID — see firmware/main/gatt_svc.h and ton_proof.h.
const PROOF_FLAG_TESTNET = 0x01;
const PROOF_DOMAIN_MAX = 128;
const PROOF_PAYLOAD_MAX = 256;

/**
 * The writes that ask the device for a TON Connect ton_proof: the same
 * BEGIN/DATA/COMMIT framing as a signing request, around
 * [flags][timestamp u64 BE][domain length][domain][payload]. The device
 * fills in the wallet address itself and shows the domain before signing.
 */
export function encodeProofRequest(params: {
  domain: string;
  timestamp: number;
  payload: string;
  testnet: boolean;
}): Buffer[] {
  const domain = Buffer.from(params.domain, 'utf8');
  const payload = Buffer.from(params.payload, 'utf8');
  if (domain.length === 0 || domain.length > PROOF_DOMAIN_MAX || !/^[a-z0-9._:-]+$/.test(params.domain)) {
    throw new Error(`The device can't show the site name "${params.domain}", so it can't sign in to it.`);
  }
  if (payload.length > PROOF_PAYLOAD_MAX) {
    throw new Error(`The site's sign-in challenge is too long for the device (${payload.length} bytes).`);
  }
  const timestamp = Buffer.alloc(8);
  timestamp.writeUInt32BE(Math.floor(params.timestamp / 2 ** 32), 0);
  timestamp.writeUInt32BE(params.timestamp % 2 ** 32, 4);
  const record = Buffer.concat([
    Buffer.from([params.testnet ? PROOF_FLAG_TESTNET : 0]),
    timestamp,
    Buffer.from([domain.length]),
    domain,
    payload,
  ]);
  return framedWrites(Buffer.from([TX_REQUEST_OP_BEGIN, record.length >> 8, record.length & 0xff]), record);
}

const CONFIRM_TIMEOUT_MS = 35_000; // a little over the firmware's 30s window
const PIN_TIMEOUT_MS = 5_000; // PBKDF2 on-device takes well under a second; this covers BLE latency
// Confirm window (30s) to reveal page 1, plus the display itself, which is
// self-paced (each further physical press reveals the next of 4 pages, or
// dismisses on the last one) rather than timed — the device's own
// per-page idle safety net is 5 minutes (see SEED_IDLE_TIMEOUT_US in
// gatt_svc.c), so this just needs to outlast the worst case of that across
// all 4 pages, with margin.
const SHOW_SEED_TIMEOUT_MS = 25 * 60_000;
// Confirm window (30s) plus the mnemonic grind + derivation itself — TON
// mandates 100,000 PBKDF2-HMAC-SHA512 iterations for the seed, plus the
// "grind" (see firmware/main/ton_mnemonic.c): random phrases are tried until
// one passes a 1-in-256 check, so it is ~10-20s on average but has a long
// tail — 79s was seen on the board (2026-09-29), past the 60s this used to
// be. Five minutes leaves the tail far behind.
const CREATE_WALLET_TIMEOUT_MS = 5 * 60_000;
// A little over the firmware's 2-minute window (ADDRESS_TIMEOUT_US).
const SHOW_ADDRESS_TIMEOUT_MS = 2 * 60_000 + 5_000;

export class QuickWalletBle {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private pubkeyChar: BluetoothRemoteGATTCharacteristic | null = null;
  private txRequestChar: BluetoothRemoteGATTCharacteristic | null = null;
  private proofRequestChar: BluetoothRemoteGATTCharacteristic | null = null;
  private showAddressChar: BluetoothRemoteGATTCharacteristic | null = null;
  private signedTxChar: BluetoothRemoteGATTCharacteristic | null = null;
  private statusChar: BluetoothRemoteGATTCharacteristic | null = null;
  private pinChar: BluetoothRemoteGATTCharacteristic | null = null;
  private createWalletChar: BluetoothRemoteGATTCharacteristic | null = null;
  private showSeedChar: BluetoothRemoteGATTCharacteristic | null = null;
  private versionChar: BluetoothRemoteGATTCharacteristic | null = null;
  private otaControlChar: BluetoothRemoteGATTCharacteristic | null = null;
  private otaStatusChar: BluetoothRemoteGATTCharacteristic | null = null;
  private otaDataAtChar: BluetoothRemoteGATTCharacteristic | null = null;
  /** Status notifications are enabled once per connection, on first use —
   * not in connect(), where the first access to a protected characteristic
   * would start pairing earlier than the UI expects. */
  private statusNotifying: Promise<unknown> | null = null;

  /**
   * Called when the link drops for any reason — the device powering off,
   * going out of range, rebooting after a factory reset or an OTA update,
   * or an explicit disconnect(). The device forgets its unlocked PIN
   * session on every disconnect, so the UI has to go back to the PIN gate
   * rather than keep showing controls that would now fail.
   */
  onDisconnected: (() => void) | null = null;

  /**
   * Called when the device locks an unlocked session that went unused for
   * five minutes (WALLET_STATUS_SESSION_LOCKED). The link stays up; the
   * device wants the PIN again before anything else.
   */
  onSessionLocked: (() => void) | null = null;

  get connected(): boolean {
    return this.server?.connected ?? false;
  }

  async connect(): Promise<void> {
    if (!navigator.bluetooth) {
      throw new Error(
        'Web Bluetooth is not available in this browser. Use desktop Chrome/Edge or Android Chrome — it does not work on iOS Safari at all.',
      );
    }

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'QuickWallet' }],
      optionalServices: [SERVICE_UUID],
    });

    this.device.addEventListener('gattserverdisconnected', () => {
      this.forgetCharacteristics();
      this.onDisconnected?.();
    });

    this.server = await this.device.gatt!.connect();
    const service = await this.server.getPrimaryService(SERVICE_UUID);
    const found = new Map((await service.getCharacteristics()).map((c) => [c.uuid, c]));
    const need = (uuid: string) => {
      const characteristic = found.get(uuid);
      if (!characteristic) throw new Error(`The device is missing characteristic ${uuid}. Is its firmware too old?`);
      return characteristic;
    };
    this.pubkeyChar = need(PUBKEY_UUID);
    this.txRequestChar = need(TX_REQUEST_UUID);
    this.proofRequestChar = need(PROOF_REQUEST_UUID);
    this.showAddressChar = need(SHOW_ADDRESS_UUID);
    this.signedTxChar = need(SIGNED_TX_UUID);
    this.statusChar = need(STATUS_UUID);
    // Notifications are on from the PIN check onward, before any session
    // there is to lock.
    this.statusChar.addEventListener('characteristicvaluechanged', (event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (value?.getUint8(0) === WalletStatus.SessionLocked) this.onSessionLocked?.();
    });
    this.pinChar = need(PIN_UUID);
    this.createWalletChar = need(CREATE_WALLET_UUID);
    this.showSeedChar = need(SHOW_SEED_UUID);
    this.versionChar = need(VERSION_UUID);
    this.otaControlChar = need(OTA_CONTROL_UUID);
    this.otaStatusChar = need(OTA_STATUS_UUID);
    this.otaDataAtChar = need(OTA_DATA_AT_UUID);
  }

  private forgetCharacteristics(): void {
    this.server = null;
    this.statusNotifying = null;
    this.pubkeyChar = null;
    this.txRequestChar = null;
    this.proofRequestChar = null;
    this.showAddressChar = null;
    this.signedTxChar = null;
    this.statusChar = null;
    this.pinChar = null;
    this.createWalletChar = null;
    this.showSeedChar = null;
    this.versionChar = null;
    this.otaControlChar = null;
    this.otaStatusChar = null;
    this.otaDataAtChar = null;
  }

  disconnect(): void {
    this.device?.gatt?.disconnect();
  }

  /**
   * Reads the current wallet status. Every characteristic here requires an
   * authenticated (passkey-paired) link in firmware, so on a fresh device
   * this read is also what triggers OS-level BLE pairing: the device shows
   * a 6-digit code on its screen and the OS asks for it. That code is what
   * stops a man-in-the-middle during the first pairing — if the OS pairs
   * without asking for one, something is wrong. Unlike pubkey, this always
   * succeeds even before a wallet exists, so it's the right first call
   * after connect().
   */
  async getStatus(): Promise<WalletStatus> {
    if (!this.statusChar) throw new Error('not connected');
    const value = await this.statusChar.readValue();
    return value.getUint8(0) as WalletStatus;
  }

  /**
   * This wallet's public key — the address, really, so the device hands it
   * out only on a PIN-unlocked connection. Call it after setPin/verifyPin
   * returned PinOk, as enterWalletSection() does.
   */
  async getPubkey(): Promise<Buffer> {
    if (!this.pubkeyChar) throw new Error('not connected');
    return toBuffer(await this.pubkeyChar.readValue());
  }

  /** Firmware version string from esp_app_desc_t, e.g. "0.9.0". */
  async getFirmwareVersion(): Promise<string> {
    if (!this.versionChar) throw new Error('not connected');
    return new TextDecoder().decode(await this.versionChar.readValue()).trim();
  }


  /**
   * Subscribes to status notifications and resolves on the first one in
   * `terminal`. Every confirm-button operation follows this shape: write a
   * request, then watch the status characteristic until the device reports
   * an outcome. Rejects on timeout, and always detaches its listener.
   */
  private waitForStatus(
    terminal: readonly WalletStatus[],
    timeoutMs: number,
    onStatus?: (s: WalletStatus) => void,
    /** A status that means progress rather than an outcome, and restarts the timeout. */
    extendOn?: WalletStatus,
  ): Promise<WalletStatus> {
    const statusChar = this.statusChar;
    if (!statusChar) return Promise.reject(new Error('not connected'));

    return new Promise<WalletStatus>((resolve, reject) => {
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        statusChar.removeEventListener('characteristicvaluechanged', onChange);
        fn();
      };
      const expire = () => finish(() => reject(new Error('timed out waiting for the device')));
      let timer = setTimeout(expire, timeoutMs);
      const onChange = (event: Event) => {
        const target = event.target as BluetoothRemoteGATTCharacteristic;
        const status = target.value!.getUint8(0) as WalletStatus;
        onStatus?.(status);
        if (status === extendOn) {
          clearTimeout(timer);
          timer = setTimeout(expire, timeoutMs);
        }
        // The device refuses to arm a second operation while one is already
        // waiting for the button — surface that instead of timing out.
        if (status === WalletStatus.Busy) {
          finish(() =>
            reject(new Error('The device is already waiting for a button press for something else.')),
          );
          return;
        }
        if (terminal.includes(status)) {
          finish(() => resolve(status));
        }
      };
      statusChar.addEventListener('characteristicvaluechanged', onChange);
      const notifying = (this.statusNotifying ??= statusChar.startNotifications());
      notifying.catch((err) => {
        if (this.statusNotifying === notifying) this.statusNotifying = null;
        finish(() => reject(err));
      });
    });
  }

  /**
   * Arms wallet creation, waits for the physical confirm button. Only
   * succeeds while the device has no wallet yet (see WALLET_STATUS_NO_WALLET).
   */
  async createWallet(onStatus?: (s: WalletStatus) => void): Promise<WalletStatus> {
    if (!this.createWalletChar) throw new Error('not connected');
    const result = this.waitForStatus(
      [WalletStatus.Created, WalletStatus.CreateRejected],
      CREATE_WALLET_TIMEOUT_MS,
      onStatus,
    );
    await this.createWalletChar.writeValueWithResponse(Buffer.from([CREATE_WALLET_OP_START]));
    onStatus?.(WalletStatus.CreateAwaitingConfirm);
    return result;
  }

  /**
   * Arms a factory reset: erases the wallet key, the stored mnemonic and the
   * PIN, then the device reboots itself into the fresh-device state. Needs
   * an unlocked PIN session, and waits for the physical confirm button.
   *
   * Expect the connection to drop right after Wiped — the reboot is part of
   * the operation, not a failure.
   */
  async wipeDevice(onStatus?: (s: WalletStatus) => void): Promise<WalletStatus> {
    if (!this.createWalletChar) throw new Error('not connected');
    const result = this.waitForStatus(
      [WalletStatus.Wiped, WalletStatus.WipeRejected],
      CONFIRM_TIMEOUT_MS,
      onStatus,
    );
    await this.createWalletChar.writeValueWithResponse(Buffer.from([CREATE_WALLET_OP_WIPE]));
    onStatus?.(WalletStatus.WipeAwaitingConfirm);
    return result;
  }

  /**
   * Asks the device to show its 24-word backup phrase on its own OLED
   * screen, waits for the physical confirm button, then for the on-device
   * paging display to finish. The phrase itself never crosses BLE — this
   * only reports progress via status codes so the UI can tell the user
   * where to look. Fails with SeedUnavailable if this wallet predates
   * mnemonic storage (created before this feature existed).
   *
   * With `check`, the last page is followed by an on-device check that the
   * phrase was written down right, answered with the device's button; the
   * outcome is SeedChecked or SeedCheckFailed instead of SeedDone.
   */
  async showSeed(onStatus?: (s: WalletStatus) => void, check = false): Promise<WalletStatus> {
    if (!this.showSeedChar) throw new Error('not connected');
    const result = this.waitForStatus(
      check
        ? [WalletStatus.SeedChecked, WalletStatus.SeedCheckFailed, WalletStatus.SeedRejected, WalletStatus.SeedUnavailable]
        : [WalletStatus.SeedDone, WalletStatus.SeedRejected, WalletStatus.SeedUnavailable],
      SHOW_SEED_TIMEOUT_MS,
      onStatus,
    );
    await this.showSeedChar.writeValueWithResponse(
      Buffer.from([check ? SHOW_SEED_OP_START_CHECK : SHOW_SEED_OP_START]),
    );
    onStatus?.(WalletStatus.SeedAwaitingConfirm);
    return result;
  }

  /**
   * Has the device show this wallet's own address on its screen, computed
   * from its own key, so the one the app shows for receiving can be checked
   * against it. Resolves once it is off the screen again: a press on the
   * device, or its 2-minute window running out.
   */
  async showAddress(testnet: boolean, onStatus?: (s: WalletStatus) => void): Promise<void> {
    if (!this.showAddressChar) throw new Error('not connected');
    const result = this.waitForStatus([WalletStatus.AddressDone], SHOW_ADDRESS_TIMEOUT_MS, onStatus);
    await this.showAddressChar.writeValueWithResponse(Buffer.from([testnet ? ADDRESS_FLAG_TESTNET : 0]));
    await result;
  }

  /**
   * Asks the device to sign a W5 signing message, sent whole as a bag of
   * cells (Cell.toBoc({ idx: false, crc32: false })). The device parses and
   * hashes it itself, shows what it does — a page per message, each press
   * moving on, a press on the last page signing — and returns the 64-byte
   * ed25519 signature of the hash it computed. Throws if the device refuses
   * the request (TxInvalid), the user doesn't confirm, or it times out.
   *
   * The timeout restarts with every page: the device re-notifies
   * AwaitingConfirm each time the user moves on.
   */
  async signTransaction(
    boc: Buffer,
    hint: DeviceHint,
    onStatus?: (s: WalletStatus) => void,
  ): Promise<Buffer> {
    if (!this.txRequestChar || !this.signedTxChar) throw new Error('not connected');
    const writes = encodeTxRequest(boc, hint);

    const result = this.waitForStatus(
      [WalletStatus.Signed, WalletStatus.Rejected, WalletStatus.TxInvalid],
      CONFIRM_TIMEOUT_MS,
      onStatus,
      WalletStatus.AwaitingConfirm,
    );
    for (const write of writes) {
      await this.txRequestChar.writeValueWithResponse(write);
    }

    const status = await result;
    if (status === WalletStatus.TxInvalid) {
      throw new Error('The device could not read this transaction and refused to sign it.');
    }
    if (status !== WalletStatus.Signed) {
      throw new Error('transaction was rejected or timed out on the device');
    }

    // The firmware consumes the signature on read, so this must happen
    // exactly once per approval.
    const signature = toBuffer(await this.signedTxChar.readValue());
    if (signature.length !== 64) {
      throw new Error(`expected a 64-byte signature, got ${signature.length}`);
    }
    return signature;
  }

  /**
   * Asks the device for a TON Connect ton_proof for `domain`: it shows the
   * site and the time, and a press signs. Returns the 64-byte signature.
   */
  async signProof(
    params: { domain: string; timestamp: number; payload: string; testnet: boolean },
    onStatus?: (s: WalletStatus) => void,
  ): Promise<Buffer> {
    if (!this.signedTxChar || !this.proofRequestChar) throw new Error('not connected');
    const writes = encodeProofRequest(params);
    const result = this.waitForStatus(
      [WalletStatus.ProofSigned, WalletStatus.ProofRejected, WalletStatus.ProofInvalid],
      CONFIRM_TIMEOUT_MS,
      onStatus,
    );
    for (const write of writes) {
      await this.proofRequestChar.writeValueWithResponse(write);
    }
    const status = await result;
    if (status === WalletStatus.ProofInvalid) {
      throw new Error('The device refused this sign-in request.');
    }
    if (status !== WalletStatus.ProofSigned) {
      throw new Error('Sign-in was rejected or timed out on the device.');
    }
    const signature = toBuffer(await this.signedTxChar.readValue());
    if (signature.length !== 64) {
      throw new Error(`expected a 64-byte signature, got ${signature.length}`);
    }
    return signature;
  }

  /**
   * One write to the PIN characteristic, then the wait for its outcome.
   * `awaiting` is reported right after the write for the operations that
   * then wait for the confirm button.
   */
  private async sendPinOp(
    opcode: number,
    pin: string,
    terminal: readonly WalletStatus[],
    timeoutMs: number,
    onStatus?: (s: WalletStatus) => void,
    awaiting?: WalletStatus,
  ): Promise<WalletStatus> {
    if (!this.pinChar) throw new Error('not connected');
    if (pin.length < 6 || pin.length > 10) {
      throw new Error('PIN must be 6-10 characters');
    }

    const result = this.waitForStatus(terminal, timeoutMs, onStatus);
    // Never persisted anywhere on this side: built fresh, sent, then the
    // caller's own copy (the input field) is the only thing left holding it.
    const payload = Buffer.concat([Buffer.from([opcode]), Buffer.from(pin, 'utf8')]);
    await this.pinChar.writeValueWithResponse(payload);
    if (awaiting !== undefined) onStatus?.(awaiting);
    return result;
  }

  /**
   * Sets the first PIN. Only succeeds once — the device refuses a second SET
   * (see PIN_AUTH_ALREADY_SET) — and, like a change, it waits for the
   * physical confirm button: until a PIN exists there is nothing else to
   * prove that whoever is asking is the owner rather than a bonded central
   * that would lock them out of their own wallet.
   */
  async setPin(pin: string, onStatus?: (s: WalletStatus) => void): Promise<WalletStatus> {
    return this.sendPinOp(
      PIN_OP_SET,
      pin,
      [
        WalletStatus.PinOk,
        WalletStatus.PinSetRejected,
        WalletStatus.PinAlreadySet,
        WalletStatus.PinInvalidLen,
        WalletStatus.Busy,
      ],
      CONFIRM_TIMEOUT_MS,
      onStatus,
      WalletStatus.PinSetAwaitingConfirm,
    );
  }

  /** Unlocks this connection for signing/OTA on PinOk; wrong/locked otherwise. */
  async verifyPin(pin: string): Promise<WalletStatus> {
    return this.sendPinOp(
      PIN_OP_VERIFY,
      pin,
      [
        WalletStatus.PinOk,
        WalletStatus.PinWrong,
        WalletStatus.PinLocked,
        WalletStatus.PinAlreadySet,
        WalletStatus.PinInvalidLen,
      ],
      PIN_TIMEOUT_MS,
    );
  }

  /**
   * Replaces the PIN. Only the new PIN goes over the wire: the device takes
   * this connection's unlocked session as proof of the current one, and
   * additionally requires the physical confirm button.
   */
  async changePin(newPin: string, onStatus?: (s: WalletStatus) => void): Promise<WalletStatus> {
    return this.sendPinOp(
      PIN_OP_CHANGE,
      newPin,
      [WalletStatus.PinChanged, WalletStatus.PinChangeRejected, WalletStatus.PinInvalidLen],
      CONFIRM_TIMEOUT_MS,
      onStatus,
      WalletStatus.PinChangeAwaitingConfirm,
    );
  }

  /**
   * Streams a firmware image to the device and reboots it into the update.
   *
   * Shape of the exchange (see firmware/main/ota_service.c): START arms the
   * update and waits for the physical button, the device reports InProgress
   * once pressed, then the image goes out in chunks, and END validates it.
   * The device then refuses an older version (Downgrade), or shows both
   * versions and waits for a second press (AwaitingSwitch) before switching
   * (Success). Requires an
   * unlocked PIN session, which by this point in the UI the user already
   * has — no second PIN prompt.
   *
   * The connection drops on success: rebooting is how the update finishes.
   */
  async updateFirmware(
    image: ArrayBuffer,
    onProgress?: (sentBytes: number, totalBytes: number) => void,
    onStatus?: (s: OtaStatus) => void,
  ): Promise<void> {
    const { otaControlChar, otaDataAtChar, otaStatusChar } = this;
    if (!otaControlChar || !otaDataAtChar || !otaStatusChar) throw new Error('not connected');

    const confirmed = new Promise<void>((resolve, reject) => {
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        otaStatusChar.removeEventListener('characteristicvaluechanged', onChange);
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error('timed out waiting for the confirm button'))),
        CONFIRM_TIMEOUT_MS,
      );
      const onChange = (event: Event) => {
        const target = event.target as BluetoothRemoteGATTCharacteristic;
        const status = target.value!.getUint8(0) as OtaStatus;
        onStatus?.(status);
        if (status === OtaStatus.InProgress) finish(resolve);
        if (status === OtaStatus.Error) finish(() => reject(new Error('the device rejected the update')));
        if (status === OtaStatus.Idle) {
          finish(() => reject(new Error('the update was cancelled or timed out on the device')));
        }
      };
      otaStatusChar.addEventListener('characteristicvaluechanged', onChange);
      otaStatusChar.startNotifications().catch((err) => finish(() => reject(err)));
    });

    await otaControlChar.writeValueWithResponse(Buffer.from([OTA_CMD_START]));
    onStatus?.(OtaStatus.AwaitingConfirm);
    await confirmed;

    const bytes = new Uint8Array(image);
    try {
      // Each write carries its offset, so the board refuses a gap the
      // moment it appears rather than at the end.
      for (let i = 0, offset = 0; offset < bytes.length; i++, offset += OTA_AT_CHUNK_BYTES) {
        const piece = bytes.subarray(offset, offset + OTA_AT_CHUNK_BYTES);
        const write = new Uint8Array(4 + piece.length);
        new DataView(write.buffer).setUint32(0, offset);
        write.set(piece, 4);
        const last = offset + piece.length >= bytes.length;
        if (last || i % OTA_AT_SYNC_EVERY === OTA_AT_SYNC_EVERY - 1) {
          await otaDataAtChar.writeValueWithResponse(write);
        } else {
          await otaDataAtChar.writeValueWithoutResponse(write);
        }
        onProgress?.(offset + piece.length, bytes.length);
      }
    } catch (err) {
      // Leave the device idle rather than stuck mid-update; if the link is
      // already gone this write fails too and there's nothing to clean up.
      await otaControlChar.writeValueWithResponse(Buffer.from([OTA_CMD_ABORT])).catch(() => {});
      throw err;
    }

    const device = this.device;
    const switched = new Promise<void>((resolve, reject) => {
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        otaStatusChar.removeEventListener('characteristicvaluechanged', onChange);
        device?.removeEventListener('gattserverdisconnected', onGone);
        fn();
      };
      const expire = () => finish(() => reject(new Error('timed out waiting for the device to switch to the update')));
      // Validating the image takes a few seconds, then the confirm window.
      let timer = setTimeout(expire, CONFIRM_TIMEOUT_MS + 30_000);
      const onChange = (event: Event) => {
        const status = (event.target as BluetoothRemoteGATTCharacteristic).value!.getUint8(0) as OtaStatus;
        onStatus?.(status);
        if (status === OtaStatus.AwaitingSwitch) {
          clearTimeout(timer);
          timer = setTimeout(expire, CONFIRM_TIMEOUT_MS);
        }
        if (status === OtaStatus.Success) finish(resolve);
        if (status === OtaStatus.Downgrade) {
          finish(() => reject(new Error('the device refused to install an older firmware version')));
        }
        if (status === OtaStatus.Error) finish(() => reject(new Error('the device rejected the update')));
        if (status === OtaStatus.Idle) {
          finish(() => reject(new Error('the update was not confirmed on the device')));
        }
      };
      // The device drops an update whose second press never came when the
      // link goes.
      const onGone = () => finish(() => reject(new Error('the connection dropped before the update was confirmed')));
      otaStatusChar.addEventListener('characteristicvaluechanged', onChange);
      device?.addEventListener('gattserverdisconnected', onGone);
    });

    await otaControlChar.writeValueWithResponse(Buffer.from([OTA_CMD_END]));
    await switched;
  }
}
