#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* On-device reading of what is about to be signed.
 *
 * The host sends the W5R1 wallet's whole signing message as a bag of cells,
 * not just its hash. This module checks it is an external request for this
 * wallet family that does nothing but send messages, computes the cell hash
 * itself — that hash, and only that hash, is what gets signed — and pulls out
 * everything that decides where funds go: how long the request stays valid,
 * and per message how much TON leaves, the destination, whether it deploys a contract, and for the body formats
 * it knows (text comment, TEP-74 jetton transfer, TEP-62 NFT transfer) the
 * token amount and recipient. Other bodies are reported as a contract call
 * with their op code; the TON value and destination of those are still read
 * from the signed data. A body with a jetton or NFT transfer op that doesn't
 * parse as that transfer is refused rather than shown as a call.
 *
 * Refused outright: anything but auth_signed_external, a wallet_id other
 * than subwallet 0 of v5r1 on mainnet or testnet, extension actions (they
 * would hand control of the wallet to another contract), actions other than
 * send_msg, send modes other than 3 (PAY_GAS_SEPARATELY | IGNORE_ERRORS —
 * the only one the app uses; 128 would send the whole balance whatever the
 * shown value), extra currencies, and any exotic cell but a library cell.
 *
 * Not reentrant: parsing works in static buffers. Only the NimBLE host task
 * calls it. Plain C with no ESP-IDF dependency beyond mbedtls, so it also
 * builds on the development machine for the tests in firmware/test/. */

#define TON_TX_MAX_BOC_LEN 8192
#define TON_TX_MAX_CELLS 256
/* What a wallet sends at once for anything the app does (a swap is up to 4). */
#define TON_TX_MAX_MESSAGES 4
/* VarUInteger 16 is at most 15 bytes; kept as a 16-byte big-endian number. */
#define TON_TX_AMOUNT_BYTES 16
/* User-friendly base64url form. */
#define TON_TX_ADDR_STR_LEN 48
/* Longer comments are shown cut off, ending in "...". */
#define TON_TX_COMMENT_MAX 120

typedef struct {
    int8_t workchain;
    uint8_t hash[32];
} ton_tx_addr_t;

typedef enum {
    TON_TX_MSG_TRANSFER, /* empty body or a text comment */
    TON_TX_MSG_JETTON,   /* TEP-74 transfer out of the jetton wallet in dest */
    TON_TX_MSG_NFT,      /* TEP-62 transfer, sent to the item */
    TON_TX_MSG_CALL,     /* any other body */
} ton_tx_msg_kind_t;

typedef struct {
    ton_tx_msg_kind_t kind;
    uint8_t ton[TON_TX_AMOUNT_BYTES]; /* nanoTON leaving the wallet */
    ton_tx_addr_t dest;
    bool bounce;
    bool deploys; /* carries a StateInit */

    /* JETTON: units and the new owner. NFT: the new owner. */
    uint8_t token_amount[TON_TX_AMOUNT_BYTES];
    ton_tx_addr_t to;

    /* TRANSFER: the comment. JETTON/NFT: a text comment in the forward
     * payload. Printable ASCII; any other byte shows as '?'. */
    bool has_comment;
    char comment[TON_TX_COMMENT_MAX + 1];

    /* CALL: the body's first 32 bits, when it has that many. */
    bool has_op;
    uint32_t op;
} ton_tx_msg_t;

typedef struct {
    uint8_t hash[32]; /* what gets signed */
    bool testnet;
    /* Unix time after which the wallet contract refuses this message. Shown,
     * not checked: the device has no clock. The host picks it, so a long one
     * means a signature that can be held back and broadcast later — until
     * the wallet sends anything else and the seqno moves past it. */
    uint32_t valid_until;
    size_t n_msgs;
    ton_tx_msg_t msgs[TON_TX_MAX_MESSAGES]; /* in the order they are sent */
} ton_tx_t;

typedef enum {
    TON_TX_OK = 0,
    TON_TX_ERR_BOC,      /* not a well-formed single-root bag of cells */
    TON_TX_ERR_WALLET,   /* not an external W5R1 request for this wallet */
    TON_TX_ERR_ACTION,   /* no messages, or something other than a plain send */
    TON_TX_ERR_MESSAGE,  /* a message this device can't show faithfully */
    TON_TX_ERR_TOO_MANY, /* more than TON_TX_MAX_MESSAGES */
} ton_tx_err_t;

ton_tx_err_t ton_tx_parse(const uint8_t *boc, size_t len, ton_tx_t *out);

/* Friendly form of addr into out (TON_TX_ADDR_STR_LEN + 1 bytes). The flags
 * only change how the same address is written, never which one it is. */
void ton_tx_format_address(const ton_tx_addr_t *addr, bool bounceable, bool test_only, char *out);

/* amount as a decimal with `decimals` places, trailing zeros dropped, in at
 * most max_chars characters. If that doesn't fit, fractional digits are cut
 * and the result starts with '~'; never integer digits — if those alone
 * don't fit, out is "(too long)". out_size must exceed max_chars. */
void ton_tx_format_amount(const uint8_t amount[TON_TX_AMOUNT_BYTES], unsigned decimals, size_t max_chars,
                          char *out, size_t out_size);
