#include <string.h>
#include <stdio.h>
#include <stdbool.h>
#include "esp_random.h"
#include "mbedtls/md.h"
#include "mbedtls/pkcs5.h"
#include "ton_mnemonic.h"
#include "ton_wordlist.h"

/* TON's mnemonic scheme (NOT standard BIP39 — it reuses BIP39's wordlist
 * but not its checksum). Algorithm and constants cross-checked byte-for-byte
 * against @ton/crypto's mnemonic.js (mnemonicNew/mnemonicToEntropy/
 * mnemonicToSeed/isBasicSeed), which itself cites
 * tonlib/tonlib/keys/Mnemonic.cpp:
 *   entropy = HMAC-SHA512(key = words joined by ' ', data = "")
 *   is_basic_seed(entropy) = (PBKDF2-HMAC-SHA512(entropy, "TON seed version",
 *                              max(1, 100000/256), 64)[0] == 0)
 *   seed = PBKDF2-HMAC-SHA512(entropy, "TON default seed", 100000, 64)[0:32]
 * A candidate phrase is valid iff is_basic_seed() passes — about 1/256 of
 * random phrases do, so generation "grinds" by re-rolling all 24 words
 * until one passes, same as tonweb/@ton/crypto do. */

#define PBKDF_ITERATIONS 100000
#define ENTROPY_LEN 64

static void hmac_sha512_phrase(const char *phrase, uint8_t out[ENTROPY_LEN])
{
    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA512);
    mbedtls_md_hmac(info, (const uint8_t *)phrase, strlen(phrase),
                     (const uint8_t *)"", 0, out);
}

const char *ton_mnemonic_word(uint16_t index)
{
    return ton_wordlist[index % TON_WORDLIST_SIZE];
}

/* Longest wordlist entry is 8 chars; 24 words + 23 spaces + NUL comfortably
 * fits in 256 with room to spare. */
static void join_words(const uint16_t indices[TON_MNEMONIC_WORD_COUNT],
                        char out[256])
{
    size_t pos = 0;
    for (int i = 0; i < TON_MNEMONIC_WORD_COUNT; i++) {
        int n = snprintf(out + pos, 256 - pos, "%s%s", i ? " " : "",
                          ton_mnemonic_word(indices[i]));
        pos += (size_t)n;
    }
}

static void mnemonic_to_entropy(const uint16_t indices[TON_MNEMONIC_WORD_COUNT],
                                 uint8_t out[ENTROPY_LEN])
{
    char phrase[256];
    join_words(indices, phrase);
    hmac_sha512_phrase(phrase, out);
    memset(phrase, 0, sizeof(phrase));
}

static bool is_basic_seed(const uint8_t entropy[ENTROPY_LEN])
{
    uint8_t seed[64];
    static const char salt[] = "TON seed version";
    mbedtls_pkcs5_pbkdf2_hmac_ext(MBEDTLS_MD_SHA512, entropy, ENTROPY_LEN,
                                   (const uint8_t *)salt, sizeof(salt) - 1,
                                   PBKDF_ITERATIONS / 256, sizeof(seed), seed);
    bool ok = (seed[0] == 0);
    memset(seed, 0, sizeof(seed));
    return ok;
}

void ton_mnemonic_generate(uint16_t indices_out[TON_MNEMONIC_WORD_COUNT])
{
    uint8_t entropy[ENTROPY_LEN];
    for (;;) {
        for (int i = 0; i < TON_MNEMONIC_WORD_COUNT; i++) {
            uint16_t r;
            esp_fill_random(&r, sizeof(r));
            indices_out[i] = r % TON_WORDLIST_SIZE;
        }
        mnemonic_to_entropy(indices_out, entropy);
        if (is_basic_seed(entropy)) {
            break;
        }
    }
    memset(entropy, 0, sizeof(entropy));
}

void ton_mnemonic_to_seed(const uint16_t indices[TON_MNEMONIC_WORD_COUNT],
                           uint8_t seed_out[TON_MNEMONIC_SEED_LEN])
{
    uint8_t entropy[ENTROPY_LEN];
    uint8_t seed64[64];
    static const char salt[] = "TON default seed";
    mnemonic_to_entropy(indices, entropy);
    mbedtls_pkcs5_pbkdf2_hmac_ext(MBEDTLS_MD_SHA512, entropy, ENTROPY_LEN,
                                   (const uint8_t *)salt, sizeof(salt) - 1,
                                   PBKDF_ITERATIONS, sizeof(seed64), seed64);
    memcpy(seed_out, seed64, TON_MNEMONIC_SEED_LEN);
    memset(entropy, 0, sizeof(entropy));
    memset(seed64, 0, sizeof(seed64));
}
