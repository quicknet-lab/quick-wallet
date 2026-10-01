#pragma once

#include <stdint.h>

#define TON_MNEMONIC_WORD_COUNT 24
#define TON_MNEMONIC_SEED_LEN 32

/* Generates a fresh 24-word TON mnemonic via the hardware RNG, re-rolling
 * the whole phrase (TON's "grind") until it passes TON's basic-seed check.
 * TON's optional mnemonic password is deliberately not supported. */
void ton_mnemonic_generate(uint16_t indices_out[TON_MNEMONIC_WORD_COUNT]);

/* Wordlist entry for an index produced by ton_mnemonic_generate() (or read
 * back from storage). index is taken mod 2048, so it's always in range. */
const char *ton_mnemonic_word(uint16_t index);

/* Derives the 32-byte ed25519 private-key seed TON wallets use from a
 * 24-word mnemonic — see ton_mnemonic.c for the exact algorithm. */
void ton_mnemonic_to_seed(const uint16_t indices[TON_MNEMONIC_WORD_COUNT],
                           uint8_t seed_out[TON_MNEMONIC_SEED_LEN]);
