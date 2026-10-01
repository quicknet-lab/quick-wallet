#include <string.h>
#include "mbedtls/sha256.h"
#include "ton_jetton.h"

/* USD₮'s jetton wallet: the code is a library cell (by its hash, depth 0) and
 * the data is status:uint4 balance:Coins owner_address master_address, all
 * zero but the two addresses. Checked against get_wallet_address on the
 * master on mainnet, 2026-10-01 (see firmware/test/gen_vectors.mjs). */
static const uint8_t USDT_MASTER[32] = {
    0xb1, 0x13, 0xa9, 0x94, 0xb5, 0x02, 0x4a, 0x16, 0x71, 0x9f, 0x69, 0x13, 0x93, 0x28, 0xeb, 0x75,
    0x95, 0x96, 0xc3, 0x8a, 0x25, 0xf5, 0x90, 0x28, 0xb1, 0x46, 0xfe, 0xcd, 0xc3, 0x62, 0x1d, 0xfe,
};
static const uint8_t USDT_WALLET_CODE_HASH[32] = {
    0x89, 0x46, 0x8f, 0x02, 0xc7, 0x8e, 0x57, 0x08, 0x02, 0xe3, 0x99, 0x79, 0xc8, 0x51, 0x6f, 0xc3,
    0x8d, 0xf0, 0x7e, 0xa7, 0x6a, 0x48, 0x35, 0x7e, 0x05, 0x36, 0xf2, 0xba, 0x7b, 0x3e, 0xe3, 0x7b,
};

static const ton_jetton_t USDT = { "USDT", 6 };

static void put_bits(uint8_t *buf, unsigned *bit, uint64_t value, unsigned n)
{
    for (unsigned i = n; i-- > 0; (*bit)++) {
        if ((value >> i) & 1) {
            buf[*bit >> 3] |= (uint8_t)(0x80 >> (*bit & 7));
        }
    }
}

/* addr_std$10, no anycast, workchain 0. */
static void put_addr(uint8_t *buf, unsigned *bit, const uint8_t hash[32])
{
    put_bits(buf, bit, 2, 2);
    put_bits(buf, bit, 0, 1);
    put_bits(buf, bit, 0, 8);
    for (unsigned i = 0; i < 32; i++) {
        put_bits(buf, bit, hash[i], 8);
    }
}

/* owner_hash's jetton wallet address hash (workchain 0) for the listed token
 * `jetton`. */
static void ton_jetton_wallet_address(const ton_jetton_t *jetton, const uint8_t owner_hash[32], uint8_t out[32])
{
    (void)jetton; /* USD₮ is the only one listed */

    /* 4 + 4 + 2 * 267 = 542 bits, no refs: d1 d2, then the bits padded with
     * a 1 and zeros to 68 bytes. */
    uint8_t data_repr[2 + 68] = { 0, 135 };
    uint8_t *d = data_repr + 2;
    unsigned bit = 0;
    put_bits(d, &bit, 0, 4); /* status */
    put_bits(d, &bit, 0, 4); /* balance: Coins of zero length */
    put_addr(d, &bit, owner_hash);
    put_addr(d, &bit, USDT_MASTER);
    put_bits(d, &bit, 1, 1); /* completion tag */
    uint8_t data_hash[32];
    mbedtls_sha256(data_repr, sizeof(data_repr), data_hash, 0);

    /* StateInit: no split_depth, no special, code and data present, no
     * library — bits 00110 and two refs, both of depth 0. */
    uint8_t init_repr[2 + 1 + 2 * 2 + 2 * 32] = { 2, 1, 0x34, 0, 0, 0, 0 };
    memcpy(init_repr + 7, USDT_WALLET_CODE_HASH, 32);
    memcpy(init_repr + 39, data_hash, 32);
    mbedtls_sha256(init_repr, sizeof(init_repr), out, 0);
}

const ton_jetton_t *ton_jetton_identify(const uint8_t owner_hash[32], const ton_tx_addr_t *jetton_wallet)
{
    if (jetton_wallet->workchain != 0) {
        return NULL;
    }
    uint8_t expected[32];
    ton_jetton_wallet_address(&USDT, owner_hash, expected);
    return memcmp(expected, jetton_wallet->hash, 32) == 0 ? &USDT : NULL;
}
