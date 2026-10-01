#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "ton_mnemonic.h"

#define WALLET_PUBKEY_LEN 32
#define WALLET_SIGNATURE_LEN 64

/* The wallet's secrets (private key, public key, mnemonic) are stored only
 * sealed under the PIN — see wallet_seal.h. The PIN comes first: it is set
 * on a device with no wallet, and a wallet can only be created afterwards,
 * into an unlocked session, so the key is sealed the moment it exists and
 * never sits in flash in the clear.
 *
 * Unlocking derives the seal key from the PIN (through the chip's hardware
 * HMAC) and keeps it, and the unsealed secrets, in RAM until
 * wallet_key_lock() — called on every disconnect. */

typedef enum {
    WALLET_KEY_OK = 0,
    WALLET_KEY_WRONG_PIN, /* unlock: the PIN doesn't open the sealed blob */
    WALLET_KEY_REFUSED,   /* not allowed in the current state (see each call) */
    WALLET_KEY_FAILED,    /* crypto, hardware or storage error */
} wallet_key_result_t;

/* Sets up encrypted NVS and the hardware HMAC key (burned into a free eFuse
 * key block on the very first start, read-protected). Once the board runs
 * with Secure Boot and Flash Encryption on, also closes the eFuse RD_DIS
 * field for good — the one step the secure build's bootloader leaves to the
 * app, so that the HMAC key can be read-protected first. Loads nothing
 * secret: the device starts locked. */
esp_err_t wallet_key_init(void);

/* A PIN has been set, i.e. there is a sealed blob to unlock. */
bool wallet_key_pin_set(void);

/* A wallet has been created. Known without unlocking — it only decides
 * which status the device starts in. */
bool wallet_key_exists(void);

/* First PIN, on a device with none: seals an empty secret under it and
 * leaves the device unlocked. REFUSED if a PIN is already set. */
wallet_key_result_t wallet_key_set_pin(const uint8_t *pin, size_t len);

/* WRONG_PIN if the PIN doesn't open the blob. On OK the device is unlocked. */
wallet_key_result_t wallet_key_unlock(const uint8_t *pin, size_t len);

/* Reseals the current secret under a new PIN. REFUSED unless unlocked —
 * being unlocked is the proof of the current PIN. Stays unlocked. */
wallet_key_result_t wallet_key_change_pin(const uint8_t *pin, size_t len);

/* Drops the seal key and the unsealed secrets from RAM. */
void wallet_key_lock(void);

/* Generates a TON mnemonic (see ton_mnemonic.h) via the hardware RNG,
 * derives the keypair from it (~10-20s) and stores it sealed. REFUSED unless
 * unlocked with no wallet yet. The seal key is taken at the start, so a
 * disconnect during the derivation doesn't lose the new wallet: it is stored
 * all the same, just not left unlocked. */
wallet_key_result_t wallet_key_create(void);

/* Only meaningful while unlocked with a wallet — every caller already gates
 * on the PIN session. */
const uint8_t *wallet_key_get_pubkey(void);

void wallet_key_sign(const uint8_t *msg, size_t msg_len,
                      uint8_t signature_out[WALLET_SIGNATURE_LEN]);

/* Copies the mnemonic out for on-device display (see gatt_svc.c's show_seed
 * characteristic). False, leaving indices_out untouched, unless unlocked
 * with a wallet. */
bool wallet_key_get_mnemonic(uint16_t indices_out[TON_MNEMONIC_WORD_COUNT]);

/* Whether wallet_key_get_mnemonic() would succeed, without copying the
 * words out. */
bool wallet_key_has_mnemonic(void);

/* Factory reset: erases the sealed wallet and the PIN with it, back to a
 * blank device. The eFuse HMAC key stays (it can't be erased) and is reused.
 * Irreversible on this device — only the 24-word phrase shown at creation
 * time can bring the wallet back, and only into some other wallet, since
 * this one has no seed-import path. Callers must gate this behind PIN +
 * physical button (see GATT_CREATE_WALLET_OP_WIPE); nothing here checks. */
void wallet_key_wipe(void);
