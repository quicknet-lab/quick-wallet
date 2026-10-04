/* Host-side tests for main/wallet_seal.c against vectors from gen_vectors.mjs
 * (node:crypto). The hardware HMAC is stood in for by software HMAC-SHA256
 * under the same fixed test key. Run ./run_tests.sh. */
#include <stdio.h>
#include <string.h>
#include "mbedtls/md.h"
#include "wallet_seal.h"
#include "wallet_seal_vectors.h"

static int failures;

#define CHECK(cond, ...)                                  \
    do {                                                  \
        if (!(cond)) {                                    \
            failures++;                                   \
            printf("  FAIL %s:%d: ", __FILE__, __LINE__); \
            printf(__VA_ARGS__);                          \
            printf("\n");                                 \
        }                                                 \
    } while (0)

#define SECRET_LEN 145
#define BLOB_LEN WALLET_SEAL_BLOB_LEN(SECRET_LEN)

static int soft_hmac(const uint8_t msg[32], uint8_t out[32])
{
    return mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
                           seal_hw_key, sizeof(seal_hw_key), msg, 32, out);
}

static int broken_hmac(const uint8_t msg[32], uint8_t out[32])
{
    (void)msg;
    (void)out;
    return -1;
}

static wallet_seal_result_t kek_for(const char *pin, const uint8_t *salt, uint8_t kek[32])
{
    return wallet_seal_derive_kek((const uint8_t *)pin, strlen(pin), salt, soft_hmac, kek);
}

int main(void)
{
    const size_t n = sizeof(seal_vectors) / sizeof(seal_vectors[0]);
    CHECK(sizeof(seal_vectors[0].blob) == BLOB_LEN, "vector blob size differs from WALLET_SEAL_BLOB_LEN");

    for (size_t i = 0; i < n; i++) {
        const seal_vector_t *v = &seal_vectors[i];
        uint8_t kek[32];
        CHECK(kek_for(v->pin, v->salt, kek) == WALLET_SEAL_OK, "vector %zu: kek derivation failed", i);

        uint8_t blob[BLOB_LEN];
        CHECK(wallet_seal(kek, v->salt, v->nonce, v->secret, SECRET_LEN, blob) == WALLET_SEAL_OK,
              "vector %zu: seal failed", i);
        CHECK(memcmp(blob, v->blob, BLOB_LEN) == 0, "vector %zu: blob differs from node:crypto", i);
        CHECK(memcmp(wallet_seal_blob_salt(blob), v->salt, 16) == 0, "vector %zu: salt not where expected", i);

        uint8_t secret[SECRET_LEN];
        CHECK(wallet_unseal(kek, v->blob, BLOB_LEN, secret, SECRET_LEN) == WALLET_SEAL_OK,
              "vector %zu: unseal failed", i);
        CHECK(memcmp(secret, v->secret, SECRET_LEN) == 0, "vector %zu: unsealed secret differs", i);

        /* The PIN is checked by nothing but the tag: a neighbouring PIN, the
         * right PIN with one more character, and an empty PIN all fail. */
        static const char *const wrong[] = { "123457", "1234567", "" };
        for (size_t w = 0; w < sizeof(wrong) / sizeof(wrong[0]); w++) {
            if (strcmp(wrong[w], v->pin) == 0) {
                continue;
            }
            uint8_t bad_kek[32];
            kek_for(wrong[w], v->salt, bad_kek);
            memset(secret, 0xa5, sizeof(secret));
            CHECK(wallet_unseal(bad_kek, v->blob, BLOB_LEN, secret, SECRET_LEN) == WALLET_SEAL_WRONG_PIN,
                  "vector %zu: PIN \"%s\" accepted", i, wrong[w]);
            uint8_t zero[SECRET_LEN] = { 0 };
            CHECK(memcmp(secret, zero, SECRET_LEN) == 0, "vector %zu: secret not wiped after a wrong PIN", i);
        }

        /* Any flipped byte — header (version, salt, nonce: all authenticated),
         * ciphertext or tag — is refused. */
        for (size_t at = 0; at < BLOB_LEN; at++) {
            uint8_t tampered[BLOB_LEN];
            memcpy(tampered, v->blob, BLOB_LEN);
            tampered[at] ^= 0x01;
            wallet_seal_result_t r = wallet_unseal(kek, tampered, BLOB_LEN, secret, SECRET_LEN);
            CHECK(r != WALLET_SEAL_OK, "vector %zu: byte %zu flipped and still accepted", i, at);
        }

        CHECK(wallet_unseal(kek, v->blob, BLOB_LEN - 1, secret, SECRET_LEN) == WALLET_SEAL_BAD_BLOB,
              "vector %zu: short blob not refused as malformed", i);
        uint8_t future[BLOB_LEN];
        memcpy(future, v->blob, BLOB_LEN);
        future[0] = WALLET_SEAL_VERSION + 1;
        CHECK(wallet_unseal(kek, future, BLOB_LEN, secret, SECRET_LEN) == WALLET_SEAL_BAD_BLOB,
              "vector %zu: unknown version not refused as malformed", i);
    }

    /* A failing hardware HMAC must not leave a usable (e.g. all-zero) kek. */
    uint8_t kek[32];
    memset(kek, 0xa5, sizeof(kek));
    CHECK(wallet_seal_derive_kek((const uint8_t *)"123456", 6, seal_vectors[0].salt, broken_hmac, kek)
              == WALLET_SEAL_FAILED,
          "broken HMAC not reported");
    uint8_t zero[32] = { 0 };
    CHECK(memcmp(kek, zero, sizeof(kek)) == 0, "kek not wiped after an HMAC failure");

    /* Same secret and PIN sealed twice with different nonces: different blobs,
     * both open. */
    uint8_t a[BLOB_LEN], b[BLOB_LEN], nonce2[12];
    kek_for(seal_vectors[0].pin, seal_vectors[0].salt, kek);
    memset(nonce2, 0x33, sizeof(nonce2));
    wallet_seal(kek, seal_vectors[0].salt, seal_vectors[0].nonce, seal_vectors[0].secret, SECRET_LEN, a);
    wallet_seal(kek, seal_vectors[0].salt, nonce2, seal_vectors[0].secret, SECRET_LEN, b);
    CHECK(memcmp(a, b, BLOB_LEN) != 0, "two nonces gave the same blob");
    uint8_t secret[SECRET_LEN];
    CHECK(wallet_unseal(kek, b, BLOB_LEN, secret, SECRET_LEN) == WALLET_SEAL_OK, "resealed blob does not open");

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("ok (%zu seal vectors)\n", n);
    return 0;
}
