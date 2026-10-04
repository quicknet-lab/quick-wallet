/* Host-side tests for main/ton_tx.c against vectors built by @ton/ton (see
 * gen_vectors.mjs). Run ./run_tests.sh. */
#include <stdio.h>
#include <string.h>
#include "ton_tx.h"
#include "ton_tx_vectors.h"

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

static const char *err_name(ton_tx_err_t err)
{
    switch (err) {
    case TON_TX_OK: return NULL;
    case TON_TX_ERR_BOC: return "BOC";
    case TON_TX_ERR_WALLET: return "WALLET";
    case TON_TX_ERR_ACTION: return "ACTION";
    case TON_TX_ERR_MESSAGE: return "MESSAGE";
    case TON_TX_ERR_TOO_MANY: return "TOO_MANY";
    }
    return "?";
}

static const char *kind_name(ton_tx_msg_kind_t kind)
{
    switch (kind) {
    case TON_TX_MSG_TRANSFER: return "TRANSFER";
    case TON_TX_MSG_JETTON: return "JETTON";
    case TON_TX_MSG_NFT: return "NFT";
    case TON_TX_MSG_CALL: return "CALL";
    }
    return "?";
}

static bool same_addr(const ton_tx_addr_t *a, const ton_tx_addr_t *b)
{
    return a->workchain == b->workchain && memcmp(a->hash, b->hash, 32) == 0;
}

static void check_vector(const vector_t *v)
{
    static ton_tx_t tx;
    ton_tx_err_t err = ton_tx_parse(v->boc, v->boc_len, &tx);
    const char *got = err_name(err);
    if (v->err != NULL || got != NULL) {
        CHECK(got != NULL && v->err != NULL && strcmp(got, v->err) == 0, "%s: expected error %s, got %s", v->name,
              v->err ? v->err : "none", got ? got : "none");
        return;
    }
    CHECK(memcmp(tx.hash, v->hash, 32) == 0, "%s: hash differs from @ton/core", v->name);
    CHECK(tx.testnet == v->testnet, "%s: testnet", v->name);
    /* Every vector is built with the same fixed timeout — see gen_vectors.mjs. */
    CHECK(tx.valid_until == 1900000000u, "%s: valid_until %u", v->name, (unsigned)tx.valid_until);
    CHECK(tx.n_msgs == v->n_msgs, "%s: %zu messages, expected %zu", v->name, tx.n_msgs, v->n_msgs);
    for (size_t i = 0; i < tx.n_msgs && i < v->n_msgs; i++) {
        const ton_tx_msg_t *m = &tx.msgs[i];
        const expect_msg_t *e = &v->msgs[i];
        CHECK(strcmp(kind_name(m->kind), e->kind) == 0, "%s[%zu]: kind %s, expected %s", v->name, i,
              kind_name(m->kind), e->kind);
        CHECK(memcmp(m->ton, e->ton, 16) == 0, "%s[%zu]: TON value", v->name, i);
        CHECK(same_addr(&m->dest, &e->dest), "%s[%zu]: destination", v->name, i);
        CHECK(m->bounce == e->bounce, "%s[%zu]: bounce", v->name, i);
        CHECK(m->deploys == e->deploys, "%s[%zu]: deploys", v->name, i);
        if (m->kind == TON_TX_MSG_JETTON) {
            CHECK(memcmp(m->token_amount, e->token_amount, 16) == 0, "%s[%zu]: token amount", v->name, i);
        }
        if (m->kind == TON_TX_MSG_JETTON || m->kind == TON_TX_MSG_NFT) {
            CHECK(same_addr(&m->to, &e->to), "%s[%zu]: token recipient", v->name, i);
        }
        if (e->comment != NULL) {
            CHECK(m->has_comment && strcmp(m->comment, e->comment) == 0, "%s[%zu]: comment \"%s\", expected \"%s\"",
                  v->name, i, m->has_comment ? m->comment : "(none)", e->comment);
        } else {
            CHECK(!m->has_comment, "%s[%zu]: unexpected comment \"%s\"", v->name, i, m->comment);
        }
        CHECK(m->has_op == e->has_op && (!m->has_op || m->op == e->op), "%s[%zu]: op", v->name, i);
    }
}

static void check_corruption(void)
{
    /* Every single-byte change to a valid request is either refused or
     * changes the hash — never parsed into the same hash with other fields. */
    static uint8_t boc[TON_TX_MAX_BOC_LEN];
    static ton_tx_t tx;
    const vector_t *v = &vectors[0];
    memcpy(boc, v->boc, v->boc_len);
    for (size_t i = 0; i < v->boc_len; i++) {
        for (unsigned bit = 0; bit < 8; bit++) {
            boc[i] ^= (uint8_t)(1u << bit);
            if (ton_tx_parse(boc, v->boc_len, &tx) == TON_TX_OK) {
                CHECK(memcmp(tx.hash, v->hash, 32) != 0, "bit flip at byte %zu kept the same hash", i);
            }
            boc[i] ^= (uint8_t)(1u << bit);
        }
    }
    for (size_t len = 0; len < v->boc_len; len++) {
        CHECK(ton_tx_parse(boc, len, &tx) != TON_TX_OK, "truncated to %zu bytes was accepted", len);
    }
}

static void check_amounts(void)
{
    struct {
        uint64_t value;
        unsigned decimals;
        size_t max;
        const char *expected;
    } cases[] = {
        { 12500000000ull, 9, 21, "12.5" },
        { 1, 9, 21, "0.000000001" },
        { 0, 9, 21, "0" },
        { 100500000, 6, 21, "100.5" },
        { 42, 0, 21, "42" },
        { 123456789123456789ull, 9, 12, "~123456789.1" },
        { 123456789123456789ull, 9, 10, "~123456789" },
        { 123456789123456789ull, 9, 9, "(too long)" },
        { 123456789000000000ull, 9, 9, "123456789" },
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        uint8_t amount[16] = { 0 };
        for (int b = 0; b < 8; b++) {
            amount[15 - b] = (uint8_t)(cases[i].value >> (8 * b));
        }
        char out[32];
        ton_tx_format_amount(amount, cases[i].decimals, cases[i].max, out, sizeof(out));
        CHECK(strcmp(out, cases[i].expected) == 0, "amount %llu/%u in %zu: \"%s\", expected \"%s\"",
              (unsigned long long)cases[i].value, cases[i].decimals, cases[i].max, out, cases[i].expected);
    }
}

int main(void)
{
    for (size_t i = 0; i < sizeof(vectors) / sizeof(vectors[0]); i++) {
        check_vector(&vectors[i]);
    }
    for (size_t i = 0; i < sizeof(address_vectors) / sizeof(address_vectors[0]); i++) {
        const address_vector_t *a = &address_vectors[i];
        char out[TON_TX_ADDR_STR_LEN + 1];
        ton_tx_format_address(&a->addr, a->bounceable, a->test_only, out);
        CHECK(strcmp(out, a->expected) == 0, "address %s, expected %s", out, a->expected);
    }
    check_corruption();
    check_amounts();
    printf("%s (%zu transaction vectors)\n", failures ? "FAILED" : "ok", sizeof(vectors) / sizeof(vectors[0]));
    return failures ? 1 : 0;
}
