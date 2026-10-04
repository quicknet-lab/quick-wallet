/* Host-side tests for main/ton_proof.c against vectors from gen_vectors.mjs.
 * Run ./run_tests.sh. */
#include <stdio.h>
#include <string.h>
#include "ton_proof.h"
#include "ton_proof_vectors.h"

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

int main(void)
{
    uint8_t out[32];
    ton_proof_wallet_address(proof_pubkey, false, out);
    CHECK(memcmp(out, proof_address_mainnet, 32) == 0, "mainnet address differs from @ton/ton");
    ton_proof_wallet_address(proof_pubkey, true, out);
    CHECK(memcmp(out, proof_address_testnet, 32) == 0, "testnet address differs from @ton/ton");

    for (size_t i = 0; i < sizeof(proof_vectors) / sizeof(proof_vectors[0]); i++) {
        const proof_vector_t *v = &proof_vectors[i];
        CHECK(ton_proof_domain_valid(v->domain, strlen(v->domain)), "%s: domain refused", v->domain);
        ton_proof_hash(proof_pubkey, v->testnet, v->domain, strlen(v->domain), v->timestamp,
                       (const uint8_t *)v->payload, strlen(v->payload), out);
        CHECK(memcmp(out, v->hash, 32) == 0, "%s: hash differs from the spec", v->domain);
    }

    static const char *const refused[] = { "", "App.example", "a b.com", "evil.com/path", "caf\xc3\xa9.fr" };
    for (size_t i = 0; i < sizeof(refused) / sizeof(refused[0]); i++) {
        CHECK(!ton_proof_domain_valid(refused[i], strlen(refused[i])), "domain \"%s\" accepted", refused[i]);
    }
    char long_domain[TON_PROOF_DOMAIN_MAX + 2];
    memset(long_domain, 'a', sizeof(long_domain));
    CHECK(ton_proof_domain_valid(long_domain, TON_PROOF_DOMAIN_MAX), "longest domain refused");
    CHECK(!ton_proof_domain_valid(long_domain, TON_PROOF_DOMAIN_MAX + 1), "overlong domain accepted");

    printf("%s (%zu proof vectors)\n", failures ? "FAILED" : "ok", sizeof(proof_vectors) / sizeof(proof_vectors[0]));
    return failures ? 1 : 0;
}
