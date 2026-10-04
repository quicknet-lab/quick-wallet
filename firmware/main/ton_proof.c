#include <string.h>
#include "mbedtls/sha256.h"
#include "ton_proof.h"

/* The W5R1 wallet code, by its cell hash and depth: the code is the same for
 * every such wallet, so the whole code cell never needs to be here. */
static const uint8_t W5R1_CODE_HASH[32] = {
    0x20, 0x83, 0x4b, 0x7b, 0x72, 0xb1, 0x12, 0x14, 0x7e, 0x1b, 0x2f, 0xb4, 0x57, 0xb8, 0x4e, 0x74,
    0xd1, 0xa3, 0x0f, 0x04, 0xf7, 0x37, 0xd4, 0xf6, 0x2a, 0x66, 0x8e, 0x95, 0x52, 0xd2, 0xb7, 0x2f,
};
#define W5R1_CODE_DEPTH 6

/* Same wallet_id values ton_tx.c accepts. */
#define WALLET_ID_MAINNET 0x7fffff11u
#define WALLET_ID_TESTNET 0x7ffffffdu

static void put_bits(uint8_t *buf, unsigned *bit, uint64_t value, unsigned n)
{
    for (unsigned i = n; i-- > 0; (*bit)++) {
        if ((value >> i) & 1) {
            buf[*bit >> 3] |= (uint8_t)(0x80 >> (*bit & 7));
        }
    }
}

/* The address is the hash of the wallet's StateInit: code, and data made of
 * is_signature_allowed = 1, seqno = 0, wallet_id, the public key and an
 * empty extensions dictionary — 322 bits, no refs. */
void ton_proof_wallet_address(const uint8_t pubkey[32], bool testnet, uint8_t out[32])
{
    /* d1 d2, then 322 bits padded with a 1 and zeros to 41 bytes. */
    uint8_t data_repr[2 + 41] = { 0, 81 };
    uint8_t *d = data_repr + 2;
    unsigned bit = 0;
    put_bits(d, &bit, 1, 1);
    put_bits(d, &bit, 0, 32);
    put_bits(d, &bit, testnet ? WALLET_ID_TESTNET : WALLET_ID_MAINNET, 32);
    for (unsigned i = 0; i < 32; i++) {
        put_bits(d, &bit, pubkey[i], 8);
    }
    put_bits(d, &bit, 0, 1);
    put_bits(d, &bit, 1, 1); /* completion tag */
    uint8_t data_hash[32];
    mbedtls_sha256(data_repr, sizeof(data_repr), data_hash, 0);

    /* StateInit: no split_depth, no special, code and data present, no
     * library — bits 00110 and two refs. */
    uint8_t init_repr[2 + 1 + 2 * 2 + 2 * 32] = { 2, 1, 0x34, 0, W5R1_CODE_DEPTH, 0, 0 };
    memcpy(init_repr + 7, W5R1_CODE_HASH, 32);
    memcpy(init_repr + 39, data_hash, 32);
    mbedtls_sha256(init_repr, sizeof(init_repr), out, 0);
}

bool ton_proof_domain_valid(const char *domain, size_t len)
{
    if (len == 0 || len > TON_PROOF_DOMAIN_MAX) {
        return false;
    }
    for (size_t i = 0; i < len; i++) {
        char c = domain[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_' || c == ':')) {
            return false;
        }
    }
    return true;
}

void ton_proof_hash(const uint8_t pubkey[32], bool testnet, const char *domain, size_t domain_len,
                    uint64_t timestamp, const uint8_t *payload, size_t payload_len, uint8_t out[32])
{
    static const char PREFIX[] = "ton-proof-item-v2/";
    uint8_t head[4 + 32 + 4];
    head[0] = head[1] = head[2] = head[3] = 0; /* workchain 0 */
    ton_proof_wallet_address(pubkey, testnet, head + 4);
    for (unsigned i = 0; i < 4; i++) {
        head[36 + i] = (uint8_t)(domain_len >> (8 * i));
    }
    uint8_t ts[8];
    for (unsigned i = 0; i < 8; i++) {
        ts[i] = (uint8_t)(timestamp >> (8 * i));
    }

    uint8_t outer[2 + 11 + 32] = { 0xff, 0xff };
    memcpy(outer + 2, "ton-connect", 11);

    mbedtls_sha256_context ctx;
    mbedtls_sha256_init(&ctx);
    mbedtls_sha256_starts(&ctx, 0);
    mbedtls_sha256_update(&ctx, (const uint8_t *)PREFIX, sizeof(PREFIX) - 1);
    mbedtls_sha256_update(&ctx, head, sizeof(head));
    mbedtls_sha256_update(&ctx, (const uint8_t *)domain, domain_len);
    mbedtls_sha256_update(&ctx, ts, sizeof(ts));
    mbedtls_sha256_update(&ctx, payload, payload_len);
    mbedtls_sha256_finish(&ctx, outer + 13);
    mbedtls_sha256_free(&ctx);

    mbedtls_sha256(outer, sizeof(outer), out, 0);
}
