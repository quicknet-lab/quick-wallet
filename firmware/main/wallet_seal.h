#pragma once

/* Seals the wallet's secrets under the PIN, so that the PIN takes part in
 * decrypting the key rather than only gating access to it.
 *
 *   kek  = HMAC_hw( PBKDF2-HMAC-SHA256(PIN, salt, WALLET_SEAL_PBKDF2_ITERATIONS) )
 *   blob = version | salt | nonce | AES-256-GCM_kek(secret, aad = version|salt|nonce) | tag
 *
 * HMAC_hw is a key that exists only inside the chip (an eFuse key block with
 * the HMAC_UP purpose, read-protected — see wallet_key.c). Without it a copy
 * of the blob can't be brute-forced off the device: every PIN guess has to
 * go through this chip, and through pin_auth.c's lockout. A wrong PIN fails
 * the GCM tag, which is how a PIN is checked at all — no hash of the PIN is
 * stored anywhere.
 *
 * The kek is derived once per unlock and then kept by the caller for the
 * session, so the secret can be sealed again (a new wallet created, say)
 * without asking for the PIN twice.
 *
 * Plain C over mbedtls, with the hardware HMAC passed in as a callback, so
 * it builds and is tested on the host (firmware/test/wallet_seal_test.c).
 * Keep it free of ESP-IDF headers. */

#include <stddef.h>
#include <stdint.h>

#define WALLET_SEAL_VERSION 1
#define WALLET_SEAL_KEK_LEN 32
#define WALLET_SEAL_SALT_LEN 16
#define WALLET_SEAL_NONCE_LEN 12
#define WALLET_SEAL_TAG_LEN 16
#define WALLET_SEAL_HEADER_LEN (1 + WALLET_SEAL_SALT_LEN + WALLET_SEAL_NONCE_LEN)
#define WALLET_SEAL_BLOB_LEN(secret_len) (WALLET_SEAL_HEADER_LEN + (secret_len) + WALLET_SEAL_TAG_LEN)
/* Same cost the stored PIN hash used to have: it runs in the NimBLE host
 * task on every unlock. The hardware HMAC, not the iteration count, is what
 * keeps the PIN from being guessed off the device. */
#define WALLET_SEAL_PBKDF2_ITERATIONS 10000

/* HMAC-SHA256 of a 32-byte message under the device's hardware key.
 * Returns 0 on success. */
typedef int (*wallet_seal_hmac_fn)(const uint8_t msg[32], uint8_t out[32]);

typedef enum {
    WALLET_SEAL_OK = 0,
    WALLET_SEAL_WRONG_PIN, /* unseal: tag mismatch — wrong PIN (or a damaged blob) */
    WALLET_SEAL_BAD_BLOB,  /* unseal: wrong length or unknown version */
    WALLET_SEAL_FAILED,    /* crypto or hardware HMAC error */
} wallet_seal_result_t;

wallet_seal_result_t wallet_seal_derive_kek(const uint8_t *pin, size_t pin_len,
                                            const uint8_t salt[WALLET_SEAL_SALT_LEN],
                                            wallet_seal_hmac_fn hmac,
                                            uint8_t kek_out[WALLET_SEAL_KEK_LEN]);

/* The salt the blob's kek was derived with, to derive it again from a PIN. */
const uint8_t *wallet_seal_blob_salt(const uint8_t *blob);

/* salt must be the one kek was derived with; nonce is fresh random bytes from
 * the caller for every seal (the host tests pass fixed ones). blob_out holds
 * WALLET_SEAL_BLOB_LEN(secret_len) bytes. */
wallet_seal_result_t wallet_seal(const uint8_t kek[WALLET_SEAL_KEK_LEN],
                                 const uint8_t salt[WALLET_SEAL_SALT_LEN],
                                 const uint8_t nonce[WALLET_SEAL_NONCE_LEN],
                                 const uint8_t *secret, size_t secret_len,
                                 uint8_t *blob_out);

/* secret_out holds secret_len bytes and is only meaningful on WALLET_SEAL_OK
 * (it is wiped on any failure). */
wallet_seal_result_t wallet_unseal(const uint8_t kek[WALLET_SEAL_KEK_LEN],
                                   const uint8_t *blob, size_t blob_len,
                                   uint8_t *secret_out, size_t secret_len);
