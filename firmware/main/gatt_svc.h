#pragma once

#include <stdbool.h>
#include "host/ble_hs.h"

/* Custom 128-bit UUIDs for the Quick Wallet GATT service. */
#define GATT_SVC_UUID \
    BLE_UUID128_DECLARE(0x00, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

/* Read-only: this wallet's ed25519 public key. Requires an unlocked PIN
 * session — the key is public in the cryptographic sense, but it is also the
 * wallet address, and with it the balance and the whole history of this
 * wallet, for anyone in radio range who once paired. */
#define GATT_CHR_PUBKEY_UUID \
    BLE_UUID128_DECLARE(0x01, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

/* UUIDs 0x02 and 0x09 are deliberately unassigned: a client that writes a
 * bare hash to sign finds no characteristic there rather than a different
 * one. The device signs only what it has read — see
 * GATT_CHR_TX_REQUEST_UUID. */

#define GATT_CHR_SIGNED_TX_UUID \
    BLE_UUID128_DECLARE(0x03, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

#define GATT_CHR_STATUS_UUID \
    BLE_UUID128_DECLARE(0x04, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

/* Write [opcode][pin bytes]: opcode 0x01 = SET (only while no PIN exists
 * yet — the first step on a blank device, before a wallet can be created),
 * 0x02 = VERIFY (unlocks the current connection on success),
 * 0x03 = CHANGE (replaces the PIN with the supplied one). Result is
 * reported on the status characteristic (see WALLET_STATUS_PIN_*).
 *
 * CHANGE takes only the *new* PIN: proof of the current one is the
 * already-unlocked session (which required a correct VERIFY on this same
 * connection), and on top of that it waits for the physical confirm button,
 * so a hijacked-but-unlocked connection still can't lock the owner out
 * without someone standing at the device.
 *
 * SET waits for the same button, and for the same reason: there is no PIN
 * yet, so nothing else proves who is asking. Whoever gets a PIN onto a
 * device without one owns it — signing and factory reset are both gated on
 * knowing that PIN — so a bonded central left alone with a fresh board (or
 * one just reset, or one whose owner hasn't finished setup) could otherwise
 * lock its owner out of their own wallet for good. */
#define GATT_CHR_PIN_UUID \
    BLE_UUID128_DECLARE(0x05, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

/* The PIN isn't stored or compared: it seals the wallet (wallet_seal.h),
 * and VERIFY is an attempt to unseal it — see wallet_key.h. 6-10 bytes
 * (PIN_AUTH_MIN_LEN/MAX_LEN). */
#define GATT_PIN_OP_SET 0x01
#define GATT_PIN_OP_VERIFY 0x02
#define GATT_PIN_OP_CHANGE 0x03

/* Write exactly 1 byte:
 *   0x01 START — arm wallet creation (only while no wallet exists, and only
 *                with a PIN set and unlocked on this connection: the new key
 *                is sealed under it straight away),
 *   0x02 WIPE  — arm a factory reset: erases the wallet key, the stored
 *                mnemonic and the PIN, then reboots into the fresh-device
 *                state. Requires an unlocked PIN session; allowed once a PIN
 *                is set, with or without a wallet.
 * Both wait for the same physical confirm button used for tx signing/OTA,
 * same 30s window. A fresh device has no wallet at all until creation
 * completes — see wallet_key.h.
 *
 * Note the deliberate consequence of gating WIPE behind the PIN: a
 * forgotten PIN cannot be recovered from, by design.
 * The seed phrase still restores the funds into any other wallet. */
#define GATT_CHR_CREATE_WALLET_UUID \
    BLE_UUID128_DECLARE(0x06, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

#define GATT_CREATE_WALLET_OP_START 0x01
#define GATT_CREATE_WALLET_OP_WIPE 0x02

/* Write exactly 1 byte (0x01) to ask the device to show its 24-word backup
 * phrase on the display — requires an existing wallet with a stored mnemonic
 * (see wallet_key_get_mnemonic()) and an unlocked PIN session, then waits
 * for the same physical confirm button as tx signing/wallet creation. Once
 * shown, display is self-paced, not timed: each further physical press
 * reveals the next page (12 of the 24 words at a time), and a press on the
 * last page dismisses it — see gatt_svc_on_confirm_button()'s seed_showing
 * handling. The phrase itself never goes over BLE in either direction —
 * only the status characteristic reports progress (see WALLET_STATUS_SEED_*). */
#define GATT_CHR_SHOW_SEED_UUID \
    BLE_UUID128_DECLARE(0x07, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

#define GATT_SHOW_SEED_OP_START 0x01
/* Same, but the last page is followed by a check that the phrase was
 * written down right: three times the device asks for the word at a
 * random position and offers five words, one of them right. A short press highlights the next one, a long press picks it.
 * Answered entirely on the device — only the outcome goes over BLE
 * (WALLET_STATUS_SEED_CHECKED / _CHECK_FAILED), never a word or a
 * position. The app asks for this once, right after creating the wallet. */
#define GATT_SHOW_SEED_OP_START_CHECK 0x02

/* Read-only: the running firmware's version string from esp_app_desc_t
 * (i.e. the project version, not a protocol version), unterminated, at
 * most 32 bytes. Exists so the web app can tell the user what is on the
 * device before offering an OTA update — see ota_service.h. */
#define GATT_CHR_VERSION_UUID \
    BLE_UUID128_DECLARE(0x08, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

/* Asks for a signature. The payload is the W5R1 wallet's whole signing
 * message as a bag of cells (@ton/core Cell.toBoc({ idx: false, crc32:
 * false })), at most TON_TX_MAX_BOC_LEN bytes, sent in writes of [op][...]:
 *
 *   BEGIN  [0x01][length: u16 BE][hint flags][decimals][symbol length][symbol]
 *   DATA   [0x02][next bytes of the payload]          (repeated)
 *   COMMIT [0x03]
 *
 * On COMMIT the device parses the message and computes its hash itself
 * (ton_tx.h). Something it won't sign is reported as WALLET_STATUS_TX_INVALID;
 * otherwise it arms the confirm button, and the screen shows what the parsed
 * message does: first a page for the request as a whole (when it expires, how
 * many messages), then a page per message, plus one naming the contract a
 * token or NFT transfer is addressed to (the jetton wallet the tokens leave,
 * or the NFT item itself), plus one for a comment too long to sit on its
 * message's page. A press moves to the next page (each page gets a fresh
 * confirm window and re-notifies AWAITING_CONFIRM, so the host can extend its
 * own timeout); holding the button for a second on the last page signs the
 * hash it computed (a short press there does nothing). The
 * signature is then read from GATT_CHR_SIGNED_TX_UUID.
 *
 * The hint changes only how things are written on screen, never what is
 * signed: GATT_TX_HINT_* picks the friendly-address form (the same address
 * either way), and decimals + symbol label jetton amounts, shown with a '?'
 * because the device can't tell which token a jetton wallet holds. The '?'
 * covers the decimals as much as the name: they scale the figure on screen by
 * whatever the host says, which is why the jetton wallet the tokens leave from
 * gets a page of its own — that address is read out of what is signed, so it
 * is the one thing about a token transfer the device can state itself. An NFT
 * item address is shown the same way, in full: nothing else on screen says
 * which item is leaving.
 * The exception is a token the device recognises by itself (ton_jetton.h —
 * USDT on mainnet): leaving from this wallet's own jetton wallet for it, the
 * amount is named and scaled by the device, without a '?', and a hint that
 * labels it with another symbol or other decimals gets the whole request
 * refused (WALLET_STATUS_TX_INVALID).
 * Decimals GATT_TX_NO_TOKEN, or above GATT_TX_MAX_DECIMALS, means no label:
 * amounts are shown in plain token units. Symbol bytes outside printable
 * ASCII show as '?'. BEGIN discards any request still being assembled. */
#define GATT_CHR_TX_REQUEST_UUID \
    BLE_UUID128_DECLARE(0x0a, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

#define GATT_TX_REQUEST_OP_BEGIN 0x01
#define GATT_TX_REQUEST_OP_DATA 0x02
#define GATT_TX_REQUEST_OP_COMMIT 0x03

/* Asks for a TON Connect ton_proof (see ton_proof.h): the signature that
 * tells a site this wallet is the one connecting to it. Same framing as
 * GATT_CHR_TX_REQUEST_UUID — BEGIN [0x01][length: u16 BE], DATA [0x02][...],
 * COMMIT [0x03] — around a record of
 *
 *   [flags][timestamp: u64 BE][domain length][domain][payload]
 *
 * flags GATT_PROOF_FLAG_TESTNET picks the wallet the proof is for (its
 * address is computed on the device from its own key); the payload is the
 * rest of the record, at most TON_PROOF_PAYLOAD_MAX bytes. A domain the
 * screen couldn't show faithfully is refused (WALLET_STATUS_PROOF_INVALID).
 * Otherwise the screen names the site and the time, and holding the button
 * for a second signs; the
 * signature is read from GATT_CHR_SIGNED_TX_UUID like a transaction's. */
#define GATT_CHR_PROOF_REQUEST_UUID \
    BLE_UUID128_DECLARE(0x0b, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

#define GATT_PROOF_FLAG_TESTNET 0x01

/* Write exactly 1 byte [flags] to have the device show this wallet's own
 * address on its screen, in full, so the owner can check the one a site
 * shows for receiving against it. The address is computed on the device
 * from its own key (ton_proof_wallet_address()) and written the way the app
 * writes it for receiving: non-bounceable, test-only on testnet.
 * GATT_ADDRESS_FLAG_TESTNET picks the testnet wallet; no other bit may be
 * set. Requires an unlocked PIN session, and like any confirm-button
 * operation is refused with WALLET_STATUS_BUSY while another one waits.
 * Reports ADDRESS_SHOWING, then ADDRESS_DONE on a press or after
 * ADDRESS_TIMEOUT in gatt_svc.c. Signs nothing. */
#define GATT_CHR_SHOW_ADDRESS_UUID \
    BLE_UUID128_DECLARE(0x0c, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

#define GATT_ADDRESS_FLAG_TESTNET 0x01

#define GATT_TX_HINT_BOUNCEABLE 0x01
#define GATT_TX_HINT_TEST_ONLY 0x02
#define GATT_TX_NO_TOKEN 0xff
#define GATT_TX_MAX_DECIMALS 24
#define GATT_TX_SYMBOL_MAX 10

/* Status values pushed on the status characteristic / used for notifications. */
enum wallet_status {
    WALLET_STATUS_IDLE = 0,
    WALLET_STATUS_AWAITING_CONFIRM = 1,
    WALLET_STATUS_SIGNED = 2,
    WALLET_STATUS_REJECTED = 3,
    WALLET_STATUS_PIN_OK = 4,
    WALLET_STATUS_PIN_WRONG = 5,
    WALLET_STATUS_PIN_LOCKED = 6,
    WALLET_STATUS_PIN_ALREADY_SET = 7,
    WALLET_STATUS_PIN_INVALID_LEN = 8,
    WALLET_STATUS_NO_WALLET = 9,
    WALLET_STATUS_CREATE_AWAITING_CONFIRM = 10,
    WALLET_STATUS_CREATED = 11,
    WALLET_STATUS_CREATE_REJECTED = 12,
    WALLET_STATUS_SEED_AWAITING_CONFIRM = 13,
    WALLET_STATUS_SEED_SHOWING = 14,
    WALLET_STATUS_SEED_DONE = 15,
    WALLET_STATUS_SEED_REJECTED = 16,
    WALLET_STATUS_SEED_UNAVAILABLE = 17,
    /* Confirm button was pressed, key derivation is running (TON's mnemonic
     * scheme mandates 100,000 PBKDF2-HMAC-SHA512 iterations for the actual
     * seed plus, on average, another ~100,000 for the "grind" — see
     * ton_mnemonic.c — so this genuinely takes on the order of 10-20s on
     * this MCU). Pushed before the blocking work starts so the client isn't
     * left guessing whether anything happened. */
    WALLET_STATUS_CREATE_GENERATING = 18,
    /* No PIN has been set: a blank device, whose first step is setting one
     * (a wallet can only be created after). Read at connect time so the
     * client shows the "set a PIN" flow rather than "enter your PIN".
     * NO_WALLET, read at connect time, means a PIN is set but no wallet
     * created yet: unlock, then create. */
    WALLET_STATUS_PIN_NOT_SET = 19,
    /* PIN change (GATT_PIN_OP_CHANGE): armed and waiting for the physical
     * button, then applied or dropped. */
    WALLET_STATUS_PIN_CHANGE_AWAITING_CONFIRM = 20,
    WALLET_STATUS_PIN_CHANGED = 21,
    WALLET_STATUS_PIN_CHANGE_REJECTED = 22,
    /* Factory reset (GATT_CREATE_WALLET_OP_WIPE). WIPED is pushed just
     * before the device reboots itself into the fresh-device state, so the
     * client should expect the connection to drop right after seeing it. */
    WALLET_STATUS_WIPE_AWAITING_CONFIRM = 23,
    WALLET_STATUS_WIPED = 24,
    WALLET_STATUS_WIPE_REJECTED = 25,
    /* Another operation is already waiting for the confirm button, so this
     * request was refused rather than queued — otherwise one press could
     * mean two different things and the screen could only name one of them. */
    WALLET_STATUS_BUSY = 26,
    /* A signing request the device refused to arm: malformed, not an
     * external W5R1 request for this wallet, or doing something it won't
     * sign (see ton_tx.h). */
    WALLET_STATUS_TX_INVALID = 27,
    /* First PIN (GATT_PIN_OP_SET): armed and waiting for the physical
     * button, then stored or dropped. Success is reported as
     * WALLET_STATUS_PIN_OK, which is also what it means for the client —
     * storing a PIN unlocks the session that asked for it. */
    WALLET_STATUS_PIN_SET_AWAITING_CONFIRM = 28,
    WALLET_STATUS_PIN_SET_REJECTED = 29,
    /* ton_proof (GATT_CHR_PROOF_REQUEST_UUID): armed and waiting for the
     * button, then signed or dropped; INVALID when refused before arming. */
    WALLET_STATUS_PROOF_AWAITING_CONFIRM = 30,
    WALLET_STATUS_PROOF_SIGNED = 31,
    WALLET_STATUS_PROOF_REJECTED = 32,
    WALLET_STATUS_PROOF_INVALID = 33,
    /* GATT_SHOW_SEED_OP_START_CHECK: the last page has been passed and the
     * check is on screen; then passed, or failed on a wrong pick (or on
     * being left idle for SEED_IDLE_TIMEOUT_US). Take the place of
     * SEED_DONE for that opcode. */
    WALLET_STATUS_SEED_CHECKING = 34,
    WALLET_STATUS_SEED_CHECKED = 35,
    WALLET_STATUS_SEED_CHECK_FAILED = 36,
    /* GATT_CHR_SHOW_ADDRESS_UUID: the address is on screen; then taken
     * off it by a press, the timeout or a disconnect. */
    WALLET_STATUS_ADDRESS_SHOWING = 37,
    WALLET_STATUS_ADDRESS_DONE = 38,
    /* Pushed unprompted: the unlocked session went unused for
     * PIN_AUTH_SESSION_IDLE_US and locked itself. The connection stays up;
     * the client asks for the PIN again (GATT_PIN_OP_VERIFY). */
    WALLET_STATUS_SESSION_LOCKED = 39,
};

void gatt_svc_init(void);
void gatt_svc_set_status(enum wallet_status status);

/* Called from the confirm button's task when it's pressed. Signs the
 * pending tx (if any, and still within the confirm window) and pushes a
 * SIGNED/REJECTED status update. No-op if nothing is pending. long_press
 * signs (the last page of a transaction, a ton_proof) — a short press there
 * is ignored — and picks the highlighted word in the seed check
 * (GATT_SHOW_SEED_OP_START_CHECK); everywhere else either press confirms. */
void gatt_svc_on_confirm_button(bool long_press);

/* True while any wallet operation is waiting for the confirm button, or
 * while the seed phrase is being paged through on screen. Used by
 * ota_service.c to refuse starting an update at a moment when a button
 * press would be ambiguous, and internally to refuse arming a second
 * operation on top of a first. */
bool gatt_svc_confirm_pending(void);

/* Calls arm() under this module's lock, and only if gatt_svc_confirm_pending()
 * would be false; returns arm()'s result, or false without calling it.
 * Checking and arming as one step is what keeps an OTA from being armed on
 * top of a seed phrase the button task put up in between. arm() may take
 * ota_service.c's lock — that is the lock order — but must not call back
 * into this module. */
bool gatt_svc_arm_if_idle(bool (*arm)(void *ctx), void *ctx);

/* Called on BLE disconnect: drops anything the departing central had armed
 * so a later button press can't complete an operation nobody is waiting on
 * (an armed factory reset most of all). Leaves an on-screen seed display
 * running — that one is driven by the person at the device. */
void gatt_svc_on_disconnect(void);

/* Live value handle for the ota_status characteristic (NimBLE only
 * finalizes val_handle when it starts the GATT server, which happens
 * after gatt_svc_init() returns — so ota_service.c must read this at
 * notify-time rather than caching a copy taken right after registration). */
uint16_t gatt_svc_ota_status_handle(void);

/* Connection handle of the current (single) central, or BLE_HS_CONN_HANDLE_NONE. */
extern uint16_t g_conn_handle;
