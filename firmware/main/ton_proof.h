#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* TON Connect ton_proof: a signature that tells a site this wallet belongs to
 * whoever is connecting to it. What gets signed is
 *
 *   sha256(0xffff ‖ "ton-connect" ‖ sha256(message)), with message =
 *   "ton-proof-item-v2/" ‖ workchain (i32 BE) ‖ address hash ‖
 *   domain length (u32 LE) ‖ domain ‖ timestamp (u64 LE) ‖ payload
 *
 * Everything but the site's domain, the time and its payload is filled in
 * here: the address is this wallet's own, computed from the public key the
 * same way ton_tx.c recognises it (W5R1, subwallet 0, workchain 0), so the
 * host can't have a proof issued for some other account. The 0xffff prefix
 * keeps the result from ever being a message a wallet contract would accept:
 * it is a hash of bytes built here, never a cell hash.
 *
 * Plain C with no ESP-IDF dependency beyond mbedtls, like ton_tx.c, so it
 * builds on the development machine for the tests in firmware/test/. */

/* A host name as the site's manifest URL gives it, port included. Longer
 * ones are refused: the whole domain has to fit on one screen. */
#define TON_PROOF_DOMAIN_MAX 128
/* The site's challenge, opaque to the wallet. */
#define TON_PROOF_PAYLOAD_MAX 256

/* This wallet's address hash (workchain 0) for its public key. */
void ton_proof_wallet_address(const uint8_t pubkey[32], bool testnet, uint8_t out[32]);

/* True if domain is something the screen can show faithfully: 1 to
 * TON_PROOF_DOMAIN_MAX characters of lowercase letters, digits, '.', '-',
 * '_' and ':' (a host name as a URL parser writes it, internationalised
 * names in their xn-- form). Anything else — spaces, capitals, look-alike
 * bytes — is refused rather than drawn. */
bool ton_proof_domain_valid(const char *domain, size_t len);

/* The 32 bytes to sign. The caller has checked the domain and the payload
 * length. */
void ton_proof_hash(const uint8_t pubkey[32], bool testnet, const char *domain, size_t domain_len,
                    uint64_t timestamp, const uint8_t *payload, size_t payload_len, uint8_t out[32]);
