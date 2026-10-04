#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "ton_tx.h"

/* Jettons the device recognises by itself, mainnet only.
 *
 * A jetton transfer is addressed to the sender's own jetton wallet, whose
 * address follows from the token's master and the owner. For a token listed
 * here the device works that address out from its own wallet address, so
 * when a transfer leaves from it the device knows which token it is and
 * where the decimal point goes — without taking the host's word for either.
 *
 * Plain C with no ESP-IDF dependency beyond mbedtls, like ton_tx.c, so it
 * builds on the development machine for the tests in firmware/test/. */

typedef struct {
    const char *symbol; /* printable ASCII, as the screen shows it */
    uint8_t decimals;
} ton_jetton_t;

/* The listed token whose jetton wallet, for the wallet owner_hash (workchain
 * 0), is jetton_wallet; NULL if it is none of them. */
const ton_jetton_t *ton_jetton_identify(const uint8_t owner_hash[32], const ton_tx_addr_t *jetton_wallet);
