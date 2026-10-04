/* Host-side tests for main/ton_jetton.c against USD₮ jetton wallet addresses
 * built by @ton/core (see gen_vectors.mjs). Run ./run_tests.sh. */
#include <stdio.h>
#include <string.h>
#include "ton_jetton.h"
#include "ton_jetton_vectors.h"

int main(void)
{
    int failures = 0;
    for (size_t i = 0; i < sizeof(jetton_vectors) / sizeof(jetton_vectors[0]); i++) {
        const jetton_vector_t *v = &jetton_vectors[i];
        ton_tx_addr_t wallet = { .workchain = 0 };
        memcpy(wallet.hash, v->wallet, 32);
        const ton_jetton_t *found = ton_jetton_identify(v->owner, &wallet);
        if (found == NULL || strcmp(found->symbol, "USDT") != 0 || found->decimals != 6) {
            printf("  FAIL vector %zu: own USDT wallet not recognised\n", i);
            failures++;
        }
        /* Someone else's USD₮ wallet, a near miss and the masterchain are not this one. */
        uint8_t other_owner[32];
        memcpy(other_owner, v->owner, 32);
        other_owner[31] ^= 1;
        wallet.hash[0] ^= 1;
        bool near_miss = ton_jetton_identify(v->owner, &wallet) != NULL;
        wallet.hash[0] ^= 1;
        wallet.workchain = -1;
        bool masterchain = ton_jetton_identify(v->owner, &wallet) != NULL;
        wallet.workchain = 0;
        if (near_miss || masterchain || ton_jetton_identify(other_owner, &wallet) != NULL) {
            printf("  FAIL vector %zu: recognised a wallet that isn't the owner's\n", i);
            failures++;
        }
    }
    printf("%s (%zu jetton vectors)\n", failures ? "FAILED" : "ok", sizeof(jetton_vectors) / sizeof(jetton_vectors[0]));
    return failures ? 1 : 0;
}
