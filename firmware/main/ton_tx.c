#include <string.h>
#include <stdio.h>
#include "mbedtls/sha256.h"
#include "ton_tx.h"

/* ------------------------------------------------------------ bag of cells */

typedef struct {
    uint16_t data_off; /* into s_boc */
    uint16_t bits;
    uint8_t d2;
    uint8_t n_refs;
    bool exotic;
    uint16_t refs[4];
    uint16_t depth;
    uint8_t hash[32];
} cell_t;

static cell_t s_cells[TON_TX_MAX_CELLS];
static size_t s_n_cells;
static const uint8_t *s_boc;

static uint64_t read_be(const uint8_t *p, unsigned n)
{
    uint64_t v = 0;
    for (unsigned i = 0; i < n; i++) {
        v = (v << 8) | p[i];
    }
    return v;
}

/* Representation hash of every cell, children first. Refs always point to a
 * later index (checked while reading), so walking backwards has each child's
 * hash and depth ready before its parent needs them — no recursion, and no
 * way for a crafted bag to form a cycle. Only level-0 cells get here, where
 * the representation is simply d1 d2 data depth(refs) hash(refs). */
static void hash_cells(void)
{
    uint8_t repr[2 + 128 + 4 * 2 + 4 * 32];
    for (size_t i = s_n_cells; i-- > 0;) {
        cell_t *c = &s_cells[i];
        size_t data_len = (c->d2 + 1) / 2;
        size_t n = 0;
        repr[n++] = (uint8_t)(c->n_refs + (c->exotic ? 8 : 0));
        repr[n++] = c->d2;
        memcpy(repr + n, s_boc + c->data_off, data_len);
        n += data_len;
        uint16_t depth = 0;
        for (unsigned r = 0; r < c->n_refs; r++) {
            const cell_t *child = &s_cells[c->refs[r]];
            repr[n++] = (uint8_t)(child->depth >> 8);
            repr[n++] = (uint8_t)child->depth;
            if (child->depth + 1 > depth) {
                depth = child->depth + 1;
            }
        }
        for (unsigned r = 0; r < c->n_refs; r++) {
            memcpy(repr + n, s_cells[c->refs[r]].hash, 32);
            n += 32;
        }
        c->depth = depth;
        mbedtls_sha256(repr, n, c->hash, 0);
    }
}

/* The standard serialization (magic b5ee9c72) as @ton/core writes it with
 * idx and crc32 turned off: exactly one root, at index 0, and nothing after
 * the cell data. */
static bool load_boc(const uint8_t *boc, size_t len)
{
    s_boc = boc;
    if (len < 6 || read_be(boc, 4) != 0xb5ee9c72) {
        return false;
    }
    uint8_t flags = boc[4];
    unsigned size = flags & 7;
    unsigned off_bytes = boc[5];
    if ((flags & 0xf8) != 0 || size < 1 || size > 2 || off_bytes < 1 || off_bytes > 4) {
        return false; /* has_idx / has_crc32c / cache bits, or absurd widths */
    }
    size_t pos = 6;
    if (len < pos + 4 * size + off_bytes) {
        return false;
    }
    uint64_t n_cells = read_be(boc + pos, size); pos += size;
    uint64_t n_roots = read_be(boc + pos, size); pos += size;
    uint64_t n_absent = read_be(boc + pos, size); pos += size;
    uint64_t tot_size = read_be(boc + pos, off_bytes); pos += off_bytes;
    uint64_t root = read_be(boc + pos, size); pos += size;
    if (n_cells < 1 || n_cells > TON_TX_MAX_CELLS || n_roots != 1 || n_absent != 0 || root != 0
        || tot_size != len - pos) {
        return false;
    }
    s_n_cells = (size_t)n_cells;

    for (size_t i = 0; i < s_n_cells; i++) {
        cell_t *c = &s_cells[i];
        if (len - pos < 2) {
            return false;
        }
        uint8_t d1 = boc[pos];
        c->d2 = boc[pos + 1];
        pos += 2;
        c->n_refs = d1 & 7;
        c->exotic = (d1 & 8) != 0;
        /* with-hashes (16) and any level (32..224) are never produced for a
         * plain message tree; a pruned branch or Merkle cell here would mean
         * hashing something other than the full content. */
        if (c->n_refs > 4 || (d1 & 0xf0) != 0) {
            return false;
        }
        size_t data_len = (c->d2 + 1) / 2;
        if (len - pos < data_len) {
            return false;
        }
        c->data_off = (uint16_t)pos;
        if (c->d2 & 1) {
            /* Partial last byte: a 1 marks where the data ends. */
            uint8_t last = boc[pos + data_len - 1];
            if (last == 0) {
                return false;
            }
            unsigned trailing = 0;
            while (!(last & (1u << trailing))) {
                trailing++;
            }
            c->bits = (uint16_t)(data_len * 8 - 1 - trailing);
        } else {
            c->bits = (uint16_t)(data_len * 8);
        }
        pos += data_len;
        if (len - pos < (size_t)c->n_refs * size) {
            return false;
        }
        for (unsigned r = 0; r < c->n_refs; r++) {
            uint64_t ref = read_be(boc + pos, size);
            pos += size;
            if (ref <= i || ref >= s_n_cells) {
                return false;
            }
            c->refs[r] = (uint16_t)ref;
        }
        /* The only exotic cell accepted is a library reference (type 2 plus
         * a 256-bit hash): it can appear inside a StateInit's code, and it
         * hashes like an ordinary cell. */
        if (c->exotic && (c->bits != 8 + 256 || boc[c->data_off] != 2 || c->n_refs != 0)) {
            return false;
        }
    }
    if (pos != len) {
        return false;
    }
    hash_cells();
    return true;
}

/* ------------------------------------------------------------------ slices */

typedef struct {
    uint16_t cell;
    uint16_t bit;
    uint8_t ref;
} slice_t;

static slice_t slice_of(uint16_t cell)
{
    slice_t s = { .cell = cell };
    return s;
}

static bool is_exotic(const slice_t *s)
{
    return s_cells[s->cell].exotic;
}

static unsigned bits_left(const slice_t *s)
{
    return s_cells[s->cell].bits - s->bit;
}

static unsigned refs_left(const slice_t *s)
{
    return s_cells[s->cell].n_refs - s->ref;
}

static bool at_end(const slice_t *s)
{
    return bits_left(s) == 0 && refs_left(s) == 0;
}

static bool ld_uint(slice_t *s, unsigned n, uint64_t *out)
{
    if (n > 64 || bits_left(s) < n) {
        return false;
    }
    const uint8_t *d = s_boc + s_cells[s->cell].data_off;
    uint64_t v = 0;
    for (unsigned i = 0; i < n; i++) {
        unsigned b = s->bit + i;
        v = (v << 1) | ((d[b >> 3] >> (7 - (b & 7))) & 1);
    }
    s->bit += n;
    *out = v;
    return true;
}

static bool ld_bit(slice_t *s, bool *out)
{
    uint64_t v;
    if (!ld_uint(s, 1, &v)) {
        return false;
    }
    *out = v != 0;
    return true;
}

/* A ref into ordinary content: exotic (library) cells only ever make sense
 * as a StateInit's code, which is never read as a slice. */
static bool ld_ref(slice_t *s, slice_t *child)
{
    if (refs_left(s) == 0) {
        return false;
    }
    *child = slice_of(s_cells[s->cell].refs[s->ref++]);
    return true;
}

static bool skip_ref(slice_t *s)
{
    if (refs_left(s) == 0) {
        return false;
    }
    s->ref++;
    return true;
}

/* VarUInteger 16: a 4-bit byte count, then that many bytes. */
static bool ld_coins(slice_t *s, uint8_t out[TON_TX_AMOUNT_BYTES])
{
    uint64_t n;
    if (!ld_uint(s, 4, &n)) {
        return false;
    }
    memset(out, 0, TON_TX_AMOUNT_BYTES);
    for (unsigned i = 0; i < n; i++) {
        uint64_t byte;
        if (!ld_uint(s, 8, &byte)) {
            return false;
        }
        out[TON_TX_AMOUNT_BYTES - n + i] = (uint8_t)byte;
    }
    return true;
}

/* addr_std$10 without anycast, in the base or masterchain. addr_var and
 * anycast addresses are refused rather than shown in some partial form. */
static bool ld_addr_std(slice_t *s, ton_tx_addr_t *out)
{
    uint64_t tag, anycast, wc;
    if (!ld_uint(s, 2, &tag) || tag != 2 || !ld_uint(s, 1, &anycast) || anycast != 0 || !ld_uint(s, 8, &wc)) {
        return false;
    }
    out->workchain = (int8_t)(uint8_t)wc;
    if (out->workchain != 0 && out->workchain != -1) {
        return false;
    }
    for (unsigned i = 0; i < 32; i++) {
        uint64_t byte;
        if (!ld_uint(s, 8, &byte)) {
            return false;
        }
        out->hash[i] = (uint8_t)byte;
    }
    return true;
}

/* addr_none$00 or addr_std — for response_destination, which only ever
 * receives leftover gas out of a value that is itself shown. */
static bool skip_addr_optional(slice_t *s)
{
    slice_t peek = *s;
    uint64_t tag;
    if (!ld_uint(&peek, 2, &tag)) {
        return false;
    }
    if (tag == 0) {
        *s = peek;
        return true;
    }
    ton_tx_addr_t ignored;
    return ld_addr_std(s, &ignored);
}

/* Maybe ^Cell */
static bool skip_maybe_ref(slice_t *s)
{
    bool present;
    return ld_bit(s, &present) && (!present || skip_ref(s));
}

/* ---------------------------------------------------------------- comments */

/* Text after a 32-bit zero op: the rest of this cell, then each following
 * cell of the snake through its only ref. Refused (so the body is shown as
 * a plain contract call instead) if it isn't whole bytes along one chain. */
static bool ld_comment(slice_t s, char out[TON_TX_COMMENT_MAX + 1])
{
    size_t n = 0;
    bool truncated = false;
    for (unsigned cells = 0; cells < TON_TX_MAX_CELLS; cells++) {
        if (bits_left(&s) % 8 != 0 || refs_left(&s) > 1 || is_exotic(&s)) {
            return false;
        }
        while (bits_left(&s) > 0) {
            uint64_t c;
            if (!ld_uint(&s, 8, &c)) {
                return false;
            }
            if (n < TON_TX_COMMENT_MAX) {
                out[n++] = (c >= 0x20 && c <= 0x7e) ? (char)c : '?';
            } else {
                truncated = true;
            }
        }
        if (refs_left(&s) == 0) {
            if (truncated) {
                memcpy(out + TON_TX_COMMENT_MAX - 3, "...", 3);
            }
            out[n] = '\0';
            return true;
        }
        ld_ref(&s, &s);
    }
    return false;
}

/* (Either Cell ^Cell) forward payload: records a text comment if that's what
 * it is. Anything else in it is the recipient contract's business. */
static bool ld_forward_payload(slice_t *s, ton_tx_msg_t *msg)
{
    bool by_ref;
    if (!ld_bit(s, &by_ref)) {
        return false;
    }
    slice_t payload = *s;
    if (by_ref && !ld_ref(s, &payload)) {
        return false;
    }
    uint64_t op;
    if (!is_exotic(&payload) && bits_left(&payload) >= 32 && ld_uint(&payload, 32, &op) && op == 0) {
        msg->has_comment = ld_comment(payload, msg->comment);
    }
    return true;
}

/* ------------------------------------------------------------------ bodies */

#define OP_COMMENT 0x00000000u
#define OP_JETTON_TRANSFER 0x0f8a7ea5u
#define OP_NFT_TRANSFER 0x5fcc3d14u

static bool ld_jetton_transfer(slice_t s, ton_tx_msg_t *msg)
{
    uint64_t query_id;
    return ld_uint(&s, 64, &query_id)
        && ld_coins(&s, msg->token_amount)
        && ld_addr_std(&s, &msg->to)
        && skip_addr_optional(&s)
        && skip_maybe_ref(&s)
        && ld_coins(&s, (uint8_t[TON_TX_AMOUNT_BYTES]){ 0 }) /* forward_ton_amount, within the shown value */
        && ld_forward_payload(&s, msg);
}

static bool ld_nft_transfer(slice_t s, ton_tx_msg_t *msg)
{
    uint64_t query_id;
    return ld_uint(&s, 64, &query_id)
        && ld_addr_std(&s, &msg->to)
        && skip_addr_optional(&s)
        && skip_maybe_ref(&s)
        && ld_coins(&s, (uint8_t[TON_TX_AMOUNT_BYTES]){ 0 }) /* forward_amount */
        && ld_forward_payload(&s, msg);
}

/* Decides what kind of message this is from its body. Only the reading of
 * the body can fall back; the TON value and destination were already taken
 * from the message itself and don't depend on it. A body with a token
 * transfer's op that doesn't parse as one is refused, not shown as a call:
 * token contracts read such bodies leniently and may well carry them out,
 * and a call screen shows neither the token amount nor its recipient. */
static bool classify_body(slice_t body, ton_tx_msg_t *msg)
{
    msg->kind = TON_TX_MSG_CALL;
    msg->has_op = false;
    if (is_exotic(&body)) {
        return true;
    }
    if (at_end(&body)) {
        msg->kind = TON_TX_MSG_TRANSFER;
        return true;
    }
    uint64_t op;
    if (!ld_uint(&body, 32, &op)) {
        return true;
    }
    msg->has_op = true;
    msg->op = (uint32_t)op;

    ton_tx_msg_t parsed = *msg;
    bool ok = false;
    if (op == OP_COMMENT) {
        ok = parsed.has_comment = ld_comment(body, parsed.comment);
        parsed.kind = TON_TX_MSG_TRANSFER;
    } else if (op == OP_JETTON_TRANSFER) {
        ok = ld_jetton_transfer(body, &parsed);
        parsed.kind = TON_TX_MSG_JETTON;
    } else if (op == OP_NFT_TRANSFER) {
        ok = ld_nft_transfer(body, &parsed);
        parsed.kind = TON_TX_MSG_NFT;
    }
    if (ok) {
        parsed.has_op = false;
        *msg = parsed;
    }
    return ok || (op != OP_JETTON_TRANSFER && op != OP_NFT_TRANSFER);
}

/* ---------------------------------------------------------------- messages */

/* StateInit: split_depth Maybe(5) special Maybe(2) code Maybe ^Cell
 * data Maybe ^Cell library Maybe ^Cell (HashmapE). Only consumed — what it
 * deploys can't be judged here, and is flagged on screen instead. */
static bool skip_state_init(slice_t *s)
{
    bool present;
    uint64_t ignored;
    if (!ld_bit(s, &present) || (present && !ld_uint(s, 5, &ignored))) {
        return false;
    }
    if (!ld_bit(s, &present) || (present && !ld_uint(s, 2, &ignored))) {
        return false;
    }
    return skip_maybe_ref(s) && skip_maybe_ref(s) && skip_maybe_ref(s);
}

/* MessageRelaxed with int_msg_info$0 — what a wallet sends. */
static ton_tx_err_t ld_message(slice_t s, ton_tx_msg_t *msg)
{
    memset(msg, 0, sizeof(*msg));
    bool is_external, ihr_disabled, bounced, has_extra;
    uint64_t src_tag, ignored;
    uint8_t fee[TON_TX_AMOUNT_BYTES];
    if (is_exotic(&s)
        || !ld_bit(&s, &is_external) || is_external
        || !ld_bit(&s, &ihr_disabled)
        || !ld_bit(&s, &msg->bounce)
        || !ld_bit(&s, &bounced)
        || !ld_uint(&s, 2, &src_tag) || src_tag != 0 /* src: filled in by the chain */
        || !ld_addr_std(&s, &msg->dest)
        || !ld_coins(&s, msg->ton)
        || !ld_bit(&s, &has_extra) || has_extra /* extra currencies: nothing here could show them */
        || !ld_coins(&s, fee)                   /* ihr_fee */
        || !ld_coins(&s, fee)                   /* fwd_fee */
        || !ld_uint(&s, 64, &ignored)           /* created_lt */
        || !ld_uint(&s, 32, &ignored)) {        /* created_at */
        return TON_TX_ERR_MESSAGE;
    }

    bool has_init;
    if (!ld_bit(&s, &has_init)) {
        return TON_TX_ERR_MESSAGE;
    }
    if (has_init) {
        msg->deploys = true;
        bool init_by_ref;
        if (!ld_bit(&s, &init_by_ref)) {
            return TON_TX_ERR_MESSAGE;
        }
        if (init_by_ref) {
            slice_t init;
            if (!ld_ref(&s, &init) || is_exotic(&init) || !skip_state_init(&init) || !at_end(&init)) {
                return TON_TX_ERR_MESSAGE;
            }
        } else if (!skip_state_init(&s)) {
            return TON_TX_ERR_MESSAGE;
        }
    }

    bool body_by_ref;
    if (!ld_bit(&s, &body_by_ref)) {
        return TON_TX_ERR_MESSAGE;
    }
    slice_t body = s;
    if (body_by_ref) {
        if (!ld_ref(&s, &body) || !at_end(&s)) {
            return TON_TX_ERR_MESSAGE;
        }
    }
    return classify_body(body, msg) ? TON_TX_OK : TON_TX_ERR_MESSAGE;
}

/* ------------------------------------------------------------------ request */

#define OP_AUTH_SIGNED_EXTERNAL 0x7369676eu
#define OP_ACTION_SEND_MSG 0x0ec3c86du
#define SEND_MODE_APP 3 /* PAY_GAS_SEPARATELY | IGNORE_ERRORS */

/* wallet_id = network_global_id XOR context, where the context for the
 * wallet the app derives (client context, workchain 0, v5r1, subwallet 0)
 * is 0x80000000 — see createWalletContract() in web/src/wallet.ts. */
#define WALLET_ID_MAINNET 0x7fffff11u /* -239 ^ 0x80000000 */
#define WALLET_ID_TESTNET 0x7ffffffdu /* -3 ^ 0x80000000 */

ton_tx_err_t ton_tx_parse(const uint8_t *boc, size_t len, ton_tx_t *out)
{
    memset(out, 0, sizeof(*out));
    if (len > TON_TX_MAX_BOC_LEN || !load_boc(boc, len)) {
        return TON_TX_ERR_BOC;
    }

    /* signed_request: op wallet_id valid_until seqno
     *                 out_actions:(Maybe ^OutList) has_other_actions:(## 1) */
    slice_t root = slice_of(0);
    uint64_t op, wallet_id, valid_until, seqno;
    if (is_exotic(&root)
        || !ld_uint(&root, 32, &op) || op != OP_AUTH_SIGNED_EXTERNAL
        || !ld_uint(&root, 32, &wallet_id)
        || !ld_uint(&root, 32, &valid_until)
        || !ld_uint(&root, 32, &seqno)) {
        return TON_TX_ERR_WALLET;
    }
    out->valid_until = (uint32_t)valid_until;
    if (wallet_id == WALLET_ID_TESTNET) {
        out->testnet = true;
    } else if (wallet_id != WALLET_ID_MAINNET) {
        return TON_TX_ERR_WALLET;
    }

    bool has_actions, has_other_actions;
    slice_t list;
    if (!ld_bit(&root, &has_actions) || !has_actions || !ld_ref(&root, &list)) {
        return TON_TX_ERR_ACTION;
    }
    if (!ld_bit(&root, &has_other_actions) || has_other_actions) {
        return TON_TX_ERR_ACTION; /* add/remove extension, toggle signature auth */
    }
    if (!at_end(&root)) {
        return TON_TX_ERR_WALLET;
    }

    /* out_list$_ prev:^OutList action:OutAction — last action outermost,
     * the empty cell ends it. */
    uint16_t msg_cells[TON_TX_MAX_MESSAGES];
    size_t n = 0;
    while (!at_end(&list)) {
        uint64_t tag, mode;
        slice_t prev, msg;
        if (is_exotic(&list) || s_cells[list.cell].bits != 32 + 8 || s_cells[list.cell].n_refs != 2
            || !ld_ref(&list, &prev)
            || !ld_uint(&list, 32, &tag) || tag != OP_ACTION_SEND_MSG
            || !ld_uint(&list, 8, &mode) || mode != SEND_MODE_APP
            || !ld_ref(&list, &msg)) {
            return TON_TX_ERR_ACTION;
        }
        if (n == TON_TX_MAX_MESSAGES) {
            return TON_TX_ERR_TOO_MANY;
        }
        msg_cells[n++] = msg.cell;
        list = prev;
    }
    if (n == 0) {
        return TON_TX_ERR_ACTION;
    }

    for (size_t i = 0; i < n; i++) {
        ton_tx_err_t err = ld_message(slice_of(msg_cells[n - 1 - i]), &out->msgs[i]);
        if (err != TON_TX_OK) {
            return err;
        }
    }
    out->n_msgs = n;
    memcpy(out->hash, s_cells[0].hash, 32);
    return TON_TX_OK;
}

/* -------------------------------------------------------------- formatting */

static uint16_t crc16_xmodem(const uint8_t *data, size_t len)
{
    uint16_t crc = 0;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i] << 8;
        for (int b = 0; b < 8; b++) {
            crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
        }
    }
    return crc;
}

void ton_tx_format_address(const ton_tx_addr_t *addr, bool bounceable, bool test_only, char *out)
{
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    uint8_t raw[36];
    raw[0] = (uint8_t)((bounceable ? 0x11 : 0x51) | (test_only ? 0x80 : 0));
    raw[1] = (uint8_t)addr->workchain;
    memcpy(raw + 2, addr->hash, 32);
    uint16_t crc = crc16_xmodem(raw, 34);
    raw[34] = (uint8_t)(crc >> 8);
    raw[35] = (uint8_t)crc;
    for (size_t i = 0, o = 0; i < sizeof(raw); i += 3) {
        uint32_t v = ((uint32_t)raw[i] << 16) | ((uint32_t)raw[i + 1] << 8) | raw[i + 2];
        out[o++] = alphabet[(v >> 18) & 63];
        out[o++] = alphabet[(v >> 12) & 63];
        out[o++] = alphabet[(v >> 6) & 63];
        out[o++] = alphabet[v & 63];
    }
    out[TON_TX_ADDR_STR_LEN] = '\0';
}

void ton_tx_format_amount(const uint8_t amount[TON_TX_AMOUNT_BYTES], unsigned decimals, size_t max_chars,
                          char *out, size_t out_size)
{
    /* Up to 2^128 is 39 digits; plus decimals of padding, a point, a '~'. */
    char digits[80];
    uint8_t n[TON_TX_AMOUNT_BYTES];
    memcpy(n, amount, sizeof(n));
    size_t len = 0;
    bool nonzero;
    do {
        unsigned rem = 0;
        nonzero = false;
        for (size_t i = 0; i < sizeof(n); i++) {
            unsigned cur = (rem << 8) | n[i];
            n[i] = (uint8_t)(cur / 10);
            rem = cur % 10;
            nonzero |= n[i] != 0;
        }
        digits[len++] = (char)('0' + rem);
    } while (nonzero);
    if (decimals > 38) {
        decimals = 38;
    }
    while (len <= decimals) {
        digits[len++] = '0';
    }

    /* digits is least significant first. */
    size_t int_len = len - decimals;
    char text[80];
    size_t t = 0;
    for (size_t i = len; i-- > decimals;) {
        text[t++] = digits[i];
    }
    size_t frac_len = decimals;
    while (frac_len > 0 && digits[decimals - frac_len] == '0') {
        frac_len--; /* trailing zeros of the fraction */
    }
    bool cut = false;
    if (frac_len > 0 && int_len + 1 + frac_len > max_chars) {
        cut = true;
        /* room for "~", the integer part and the point */
        frac_len = max_chars > int_len + 2 ? max_chars - int_len - 2 : 0;
    }
    if (frac_len > 0) {
        text[t++] = '.';
        for (size_t i = 0; i < frac_len; i++) {
            text[t++] = digits[decimals - 1 - i];
        }
    }
    text[t] = '\0';

    if (int_len + (cut ? 1 : 0) > max_chars || max_chars >= out_size) {
        snprintf(out, out_size, "(too long)");
    } else {
        snprintf(out, out_size, "%s%s", cut ? "~" : "", text);
    }
}
