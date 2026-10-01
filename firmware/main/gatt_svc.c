#include <string.h>
#include <stdio.h>
#include <time.h>
#include <stdbool.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_app_desc.h"
#include "esp_random.h"
#include "esp_system.h"
#include "host/ble_hs.h"
#include "host/ble_uuid.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "gatt_svc.h"
#include "wallet_key.h"
#include "ota_service.h"
#include "pin_auth.h"
#include "display.h"
#include "ton_mnemonic.h"
#include "ton_tx.h"
#include "ton_proof.h"
#include "ton_jetton.h"

static const char *TAG = "gatt_svc";

uint16_t g_conn_handle = BLE_HS_CONN_HANDLE_NONE;

static uint16_t status_chr_val_handle;
static uint16_t ota_status_chr_val_handle;
static uint8_t status_val = WALLET_STATUS_IDLE;

/* Guards all confirm state below: s_pending and what it carries (last_tx,
 * s_new_pin, the parsed request on screen), the finished signature, and the
 * seed display. Three tasks touch it — the NimBLE host (GATT reads/writes),
 * the confirm button task and the esp_timer task (timeouts) — and on the
 * dual-core S3 they genuinely run at the same time. Held only for the state
 * transition itself: never across gatt_svc_set_status() or signing, which
 * are slow and take locks of their own. */
static SemaphoreHandle_t s_lock;
#define LOCK()   xSemaphoreTake(s_lock, portMAX_DELAY)
#define UNLOCK() xSemaphoreGive(s_lock)

/* Bumped on every disconnect. The button task signs outside the lock, so a
 * signature finished after its central has left is recognised by a changed
 * generation and thrown away instead of waiting for the next connection. */
static uint32_t s_conn_gen;

/* Confirmation window: an unsigned tx must be approved via the physical
 * button within this long, or it's dropped and the central must resend. */
#define CONFIRM_TIMEOUT_US (30 * 1000 * 1000)
/* How long the wallet's own address stays up: long enough to compare all
 * 48 characters at a reading pace, not forever. */
#define ADDRESS_TIMEOUT_US (2 * 60 * 1000 * 1000LL)

/* How long a terminal display status (signed/rejected/created/etc.) stays up
 * before auto-reverting to the idle screen — see show_status_on_display(). */
#define DISPLAY_REVERT_DELAY_US (5 * 1000 * 1000)
static bool s_display_revert_pending;
static int64_t s_display_revert_at_us;
/* The frame the status that scheduled the revert went up in. */
static uint32_t s_display_revert_frame;

/* A signing request arrives as the wallet's whole signing message, in chunks
 * (see GATT_CHR_TX_REQUEST_UUID), and ton_tx.c reads and hashes it here.
 * The reassembly state is touched only by the NimBLE host task — every GATT
 * access and the disconnect callback run there — so it needs no lock. */
struct tx_hint {
    uint8_t flags; /* GATT_TX_HINT_* */
    bool has_token;
    uint8_t decimals;
    char symbol[GATT_TX_SYMBOL_MAX + 1];
};
static uint8_t s_req[TON_TX_MAX_BOC_LEN];
static size_t s_req_len;
static size_t s_req_expected; /* 0 while no request is open */
static struct tx_hint s_req_hint;
static ton_tx_t s_req_tx;
static const ton_jetton_t *s_req_jettons[TON_TX_MAX_MESSAGES];

static void reset_request(void)
{
    s_req_len = 0;
    s_req_expected = 0;
}

/* A ton_proof request (GATT_CHR_PROOF_REQUEST_UUID), reassembled the same
 * way and on the same task. */
#define PROOF_REQ_MAX (1 + 8 + 1 + TON_PROOF_DOMAIN_MAX + TON_PROOF_PAYLOAD_MAX)
static uint8_t s_proof_req[PROOF_REQ_MAX];
static size_t s_proof_req_len;
static size_t s_proof_req_expected; /* 0 while no request is open */

static void reset_proof_request(void)
{
    s_proof_req_len = 0;
    s_proof_req_expected = 0;
}

/* What PENDING_SIGN signs and what the screen shows for it, both set from
 * the same parsed request. TON signs the wallet's 32-byte cell hash (ed25519
 * does its own SHA-512 over it, which is what a W5 contract expects), and
 * last_tx is the hash ton_tx computed — never one the host supplied. For
 * PENDING_PROOF it is the hash ton_proof computed, and s_proof is what the
 * screen shows for it. */
#define TON_SIGNING_HASH_LEN 32
static uint8_t last_tx[TON_SIGNING_HASH_LEN];
static ton_tx_t s_tx;
static struct tx_hint s_tx_hint;
/* Per message: the token whose jetton wallet of this wallet's it leaves
 * from, when the device recognises it itself (ton_jetton.h); NULL if not. */
static const ton_jetton_t *s_tx_jettons[TON_TX_MAX_MESSAGES];
static struct {
    char domain[TON_PROOF_DOMAIN_MAX + 1];
    uint64_t timestamp;
    bool testnet;
} s_proof;

/* One page for the request as a whole, then one per message, plus — for a
 * jetton or NFT transfer — one naming the contract it is addressed to, plus
 * one for a comment that doesn't fit the spare row of its message's page. A press on any page but the last moves on;
 * only a press on the last one signs, so nothing can be signed unseen. */
#define TX_MAX_PAGES (3 * TON_TX_MAX_MESSAGES + 1)
#define TX_INLINE_COMMENT_MAX (DISPLAY_COLS - 5) /* after "Msg: " */
enum tx_page_kind {
    TX_PAGE_MAIN = 0,
    /* What is true of the whole request rather than of one message: when it
     * stops being valid, and how many messages follow. First, so that what
     * comes after it is read knowing how much there is of it. */
    TX_PAGE_REQUEST,
    /* What the message is addressed to, written out in full: for a jetton
     * transfer the jetton wallet of this wallet's that pays, for an NFT
     * transfer the item being handed over. It comes before the main page so
     * the amount and the recipient are still what's on screen at the moment
     * the last press signs. In both cases it is the only thing identifying
     * *what* is leaving that the device reads out of the signed data itself:
     * unless the device recognises the token (ton_jetton.h), the token name
     * on the main page is the host's word (see the '?') and so is where the
     * decimal point goes, and nothing on screen names the NFT. */
    TX_PAGE_SOURCE,
    TX_PAGE_COMMENT,
};
static struct {
    uint8_t msg;
    uint8_t kind;
} s_tx_pages[TX_MAX_PAGES];
static uint8_t s_tx_page_count;
static uint8_t s_tx_page;

static uint8_t last_signature[WALLET_SIGNATURE_LEN];
static bool signature_ready;

/* Caller holds s_lock. */
static void layout_tx_pages(void)
{
    s_tx_page_count = 0;
    s_tx_page = 0;
    s_tx_pages[s_tx_page_count].msg = 0;
    s_tx_pages[s_tx_page_count++].kind = TX_PAGE_REQUEST;
    for (size_t i = 0; i < s_tx.n_msgs; i++) {
        const ton_tx_msg_t *m = &s_tx.msgs[i];
        if (m->kind == TON_TX_MSG_JETTON || m->kind == TON_TX_MSG_NFT) {
            s_tx_pages[s_tx_page_count].msg = (uint8_t)i;
            s_tx_pages[s_tx_page_count++].kind = TX_PAGE_SOURCE;
        }
        s_tx_pages[s_tx_page_count].msg = (uint8_t)i;
        s_tx_pages[s_tx_page_count++].kind = TX_PAGE_MAIN;
        if (m->has_comment && (m->kind != TON_TX_MSG_TRANSFER || strlen(m->comment) > TX_INLINE_COMMENT_MAX)) {
            s_tx_pages[s_tx_page_count].msg = (uint8_t)i;
            s_tx_pages[s_tx_page_count++].kind = TX_PAGE_COMMENT;
        }
    }

    /* The hint names one token. If this request moves jettons out of more
     * than one jetton wallet it can't be right for all of them, so every
     * amount is shown in plain units instead. */
    const ton_tx_addr_t *jetton_wallet = NULL;
    for (size_t i = 0; i < s_tx.n_msgs; i++) {
        const ton_tx_msg_t *m = &s_tx.msgs[i];
        if (m->kind != TON_TX_MSG_JETTON) {
            continue;
        }
        if (jetton_wallet == NULL) {
            jetton_wallet = &m->dest;
        } else if (jetton_wallet->workchain != m->dest.workchain
                   || memcmp(jetton_wallet->hash, m->dest.hash, sizeof(m->dest.hash)) != 0) {
            s_tx_hint.has_token = false;
        }
    }
}

/* Once the first confirm press reveals page 1, display is self-paced: each
 * further press reveals the next page, and a press on the last page
 * dismisses it. No fixed on-screen timer — the whole point is that how long
 * someone needs to copy 24 words down by hand varies. SEED_IDLE_TIMEOUT_US
 * is only a safety net against leaving the phrase lit up on an abandoned
 * device indefinitely, not the normal way to dismiss it. */
/* Two columns of "24. abcdefgh" (the longest word has 8 letters) make a
 * 26-character line, centered on the row. The 12 rows under the header take
 * the whole phrase, so it is one page. */
#define SEED_WORDS_PER_PAGE 24
#define SEED_ROWS_PER_PAGE (SEED_WORDS_PER_PAGE / 2)
#define SEED_TOTAL_PAGES (TON_MNEMONIC_WORD_COUNT / SEED_WORDS_PER_PAGE)
#define SEED_IDLE_TIMEOUT_US (5 * 60 * 1000 * 1000LL)
static bool seed_showing;
static int seed_page;
static uint16_t seed_words[TON_MNEMONIC_WORD_COUNT];
static int64_t seed_last_activity_us;

/* GATT_SHOW_SEED_OP_START_CHECK: seed_check says the pages end in a check,
 * seed_checking that the check is on screen. Everything else describes
 * the current question; like seed_words, it all lives under s_lock and is
 * zeroed when the phrase leaves the screen (seed_end_locked). */
#define SEED_CHECK_QUESTIONS 3
#define SEED_CHECK_OPTIONS 5
static bool seed_check;
static bool seed_checking;
static int seed_check_question;
static uint8_t seed_check_positions[SEED_CHECK_QUESTIONS];
static uint16_t seed_check_options[SEED_CHECK_OPTIONS];
static int seed_check_selected;

/* Exactly one operation at a time may wait for the confirm button. There is
 * one button and one line of screen text naming what it would confirm, so
 * two operations armed at once would make a press ambiguous — and the
 * screen could only ever name one of them. A second request is therefore
 * refused outright (WALLET_STATUS_BUSY) rather than queued behind the
 * first. */
enum pending_op {
    PENDING_NONE = 0,
    PENDING_SIGN,
    PENDING_CREATE_WALLET,
    PENDING_SHOW_SEED,
    PENDING_SHOW_SEED_CHECK,
    PENDING_PIN_SET,
    PENDING_PIN_CHANGE,
    PENDING_WIPE,
    PENDING_PROOF,
    PENDING_SHOW_ADDRESS,
};
static enum pending_op s_pending;
static int64_t s_pending_since_us;
/* Set from the confirming press until the new key is in NVS (see
 * create_wallet_task). Nothing else may be armed meanwhile — above all not
 * a second create_wallet, whose key would race this one into NVS. */
static bool s_creating;

/* The status a dropped operation reports: the confirm window ran out, or
 * the button was pressed after it had. */
static void set_rejected_status(enum pending_op op)
{
    switch (op) {
    case PENDING_SIGN:           gatt_svc_set_status(WALLET_STATUS_REJECTED); break;
    case PENDING_CREATE_WALLET:  gatt_svc_set_status(WALLET_STATUS_CREATE_REJECTED); break;
    case PENDING_SHOW_SEED:
    case PENDING_SHOW_SEED_CHECK: gatt_svc_set_status(WALLET_STATUS_SEED_REJECTED); break;
    case PENDING_PIN_SET:        gatt_svc_set_status(WALLET_STATUS_PIN_SET_REJECTED); break;
    case PENDING_PIN_CHANGE:     gatt_svc_set_status(WALLET_STATUS_PIN_CHANGE_REJECTED); break;
    case PENDING_WIPE:           gatt_svc_set_status(WALLET_STATUS_WIPE_REJECTED); break;
    case PENDING_PROOF:          gatt_svc_set_status(WALLET_STATUS_PROOF_REJECTED); break;
    case PENDING_SHOW_ADDRESS:   gatt_svc_set_status(WALLET_STATUS_ADDRESS_DONE); break;
    case PENDING_NONE:           break;
    }
}

/* What PENDING_SHOW_ADDRESS shows: this wallet's own address. */
static struct {
    ton_tx_addr_t addr;
    bool testnet;
} s_own_address;

/* Buffered PIN for PENDING_PIN_SET / PENDING_PIN_CHANGE — held only between
 * the write and the confirming button press, and zeroed the moment it's
 * applied or dropped. */
static uint8_t s_new_pin[PIN_AUTH_MAX_LEN];
static size_t s_new_pin_len;

/* Caller holds s_lock. */
static void clear_pending(void)
{
    s_pending = PENDING_NONE;
    memset(s_new_pin, 0, sizeof(s_new_pin));
    s_new_pin_len = 0;
    memset(last_tx, 0, sizeof(last_tx));
    memset(&s_tx, 0, sizeof(s_tx));
    memset(s_tx_jettons, 0, sizeof(s_tx_jettons));
    memset(&s_proof, 0, sizeof(s_proof));
    memset(&s_own_address, 0, sizeof(s_own_address));
    s_tx_page = 0;
    s_tx_page_count = 0;
}

/* Caller holds s_lock. Returns false if something else already holds the
 * button. Also refuses while the seed phrase is on screen, where presses
 * already mean "next page", and during OTA, which has its own confirm
 * state in ota_service.c. */
static bool arm_pending_locked(enum pending_op op)
{
    if (s_pending != PENDING_NONE || s_creating || seed_showing || ota_service_in_progress()) {
        ESP_LOGW(TAG, "refusing to arm op %d — another confirmation is already pending", (int)op);
        return false;
    }
    s_pending = op;
    s_pending_since_us = esp_timer_get_time();
    return true;
}

/* For operations that carry no payload. Reports BUSY on refusal — outside
 * the lock, like every status update. */
static bool arm_pending(enum pending_op op)
{
    LOCK();
    bool armed = arm_pending_locked(op);
    UNLOCK();
    if (!armed) {
        gatt_svc_set_status(WALLET_STATUS_BUSY);
    }
    return armed;
}

/* Caller holds s_lock. True once the confirm window has elapsed for
 * whatever is currently armed. */
static bool pending_expired(void)
{
    int64_t window = s_pending == PENDING_SHOW_ADDRESS ? ADDRESS_TIMEOUT_US : CONFIRM_TIMEOUT_US;
    return esp_timer_get_time() - s_pending_since_us > window;
}

static int pubkey_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                             struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (!wallet_key_exists()) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    /* The key is public in the cryptographic sense, not in the privacy one:
     * it is the wallet address, and with it the balance and the entire
     * history of this wallet, for anyone within radio range who once paired.
     * The app reads it only after unlocking anyway (enterWalletSection()). */
    if (!pin_auth_session_unlocked()) {
        ESP_LOGW(TAG, "refusing pubkey read — PIN not verified on this connection");
        return BLE_ATT_ERR_INSUFFICIENT_AUTHOR;
    }
    int rc = os_mbuf_append(ctxt->om, wallet_key_get_pubkey(), WALLET_PUBKEY_LEN);
    return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int create_wallet_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                                    struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    uint8_t opcode;
    uint16_t copied_len;
    if (len != 1 || ble_hs_mbuf_to_flat(ctxt->om, &opcode, sizeof(opcode), &copied_len) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    if (opcode == GATT_CREATE_WALLET_OP_START) {
        if (wallet_key_exists()) {
            ESP_LOGW(TAG, "refusing create_wallet — a wallet already exists");
            return BLE_ATT_ERR_UNLIKELY;
        }
        /* The key is sealed under the PIN the moment it exists, so there has
         * to be one, unlocked on this connection. */
        if (!pin_auth_is_set() || !pin_auth_session_unlocked()) {
            ESP_LOGW(TAG, "refusing create_wallet — no PIN set, or not unlocked on this connection");
            return BLE_ATT_ERR_INSUFFICIENT_AUTHOR;
        }
        if (!arm_pending(PENDING_CREATE_WALLET)) {
            return 0;
        }
        ESP_LOGI(TAG, "create_wallet armed — awaiting physical confirm");
        gatt_svc_set_status(WALLET_STATUS_CREATE_AWAITING_CONFIRM);
        return 0;
    }

    if (opcode == GATT_CREATE_WALLET_OP_WIPE) {
        if (!wallet_key_exists() && !pin_auth_is_set()) {
            ESP_LOGW(TAG, "refusing wipe — nothing to erase");
            return BLE_ATT_ERR_UNLIKELY;
        }
        /* Same gate as signing: knowing the PIN on this connection, plus
         * someone physically at the device. Without the PIN check any
         * bonded central could brick the wallet for its owner. */
        if (!pin_auth_session_unlocked()) {
            ESP_LOGW(TAG, "refusing wipe — PIN not verified on this connection");
            return BLE_ATT_ERR_INSUFFICIENT_AUTHOR;
        }
        if (!arm_pending(PENDING_WIPE)) {
            return 0;
        }
        ESP_LOGW(TAG, "factory reset armed — awaiting physical confirm");
        gatt_svc_set_status(WALLET_STATUS_WIPE_AWAITING_CONFIRM);
        return 0;
    }

    return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
}

static int show_seed_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                                struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (!wallet_key_exists()) {
        ESP_LOGW(TAG, "refusing show_seed write — no wallet created yet");
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (!pin_auth_session_unlocked()) {
        ESP_LOGW(TAG, "refusing show_seed write — PIN not verified on this connection");
        return BLE_ATT_ERR_INSUFFICIENT_AUTHOR;
    }
    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    uint8_t opcode;
    uint16_t copied_len;
    if (len != 1 || ble_hs_mbuf_to_flat(ctxt->om, &opcode, sizeof(opcode), &copied_len) != 0
        || (opcode != GATT_SHOW_SEED_OP_START && opcode != GATT_SHOW_SEED_OP_START_CHECK)) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    if (!wallet_key_has_mnemonic()) {
        ESP_LOGW(TAG, "refusing show_seed — this wallet predates mnemonic storage");
        gatt_svc_set_status(WALLET_STATUS_SEED_UNAVAILABLE);
        return 0;
    }

    if (!arm_pending(opcode == GATT_SHOW_SEED_OP_START_CHECK ? PENDING_SHOW_SEED_CHECK : PENDING_SHOW_SEED)) {
        return 0;
    }
    ESP_LOGI(TAG, "show_seed armed — awaiting physical confirm");
    gatt_svc_set_status(WALLET_STATUS_SEED_AWAITING_CONFIRM);
    return 0;
}

/* See GATT_CHR_TX_REQUEST_UUID for the framing. */
static int tx_request_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                                 struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (!wallet_key_exists()) {
        ESP_LOGW(TAG, "refusing tx_request write — no wallet created yet");
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (ota_service_in_progress()) {
        ESP_LOGW(TAG, "refusing tx_request write while an OTA update is in progress");
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (!pin_auth_session_unlocked()) {
        ESP_LOGW(TAG, "refusing tx_request write — PIN not verified on this connection");
        return BLE_ATT_ERR_INSUFFICIENT_AUTHOR;
    }
    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    uint8_t op;
    if (len < 1 || os_mbuf_copydata(ctxt->om, 0, 1, &op) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    if (op == GATT_TX_REQUEST_OP_BEGIN) {
        uint8_t header[6 + GATT_TX_SYMBOL_MAX];
        reset_request();
        if (len < 6 || len > sizeof(header) || os_mbuf_copydata(ctxt->om, 0, len, header) != 0) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        size_t total = ((size_t)header[1] << 8) | header[2];
        size_t symbol_len = header[5];
        if (total == 0 || total > TON_TX_MAX_BOC_LEN || len != 6 + symbol_len) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        memset(&s_req_hint, 0, sizeof(s_req_hint));
        s_req_hint.flags = header[3];
        s_req_hint.decimals = header[4];
        s_req_hint.has_token = header[4] <= GATT_TX_MAX_DECIMALS;
        for (size_t i = 0; i < symbol_len; i++) {
            uint8_t c = header[6 + i];
            s_req_hint.symbol[i] = (c >= 0x20 && c <= 0x7e) ? (char)c : '?';
        }
        s_req_expected = total;
        return 0;
    }

    if (op == GATT_TX_REQUEST_OP_DATA) {
        size_t chunk = len - 1u;
        if (s_req_expected == 0 || chunk > s_req_expected - s_req_len
            || os_mbuf_copydata(ctxt->om, 1, chunk, s_req + s_req_len) != 0) {
            reset_request();
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        s_req_len += chunk;
        return 0;
    }

    if (op != GATT_TX_REQUEST_OP_COMMIT || len != 1 || s_req_expected == 0 || s_req_len != s_req_expected) {
        reset_request();
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    ton_tx_err_t err = ton_tx_parse(s_req, s_req_len, &s_req_tx);
    reset_request();
    if (err != TON_TX_OK) {
        ESP_LOGW(TAG, "refusing to sign: request not understood (ton_tx error %d)", (int)err);
        gatt_svc_set_status(WALLET_STATUS_TX_INVALID);
        return 0;
    }

    /* Tokens the device knows by itself are named and scaled by it; a host
     * label that says otherwise for one of them is not a display slip but a
     * wrong amount on screen, so the request is refused. */
    memset(s_req_jettons, 0, sizeof(s_req_jettons));
    if (!s_req_tx.testnet) {
        uint8_t owner[32];
        ton_proof_wallet_address(wallet_key_get_pubkey(), false, owner);
        for (size_t i = 0; i < s_req_tx.n_msgs; i++) {
            const ton_tx_msg_t *m = &s_req_tx.msgs[i];
            const ton_jetton_t *known = m->kind == TON_TX_MSG_JETTON ? ton_jetton_identify(owner, &m->dest) : NULL;
            if (known != NULL && s_req_hint.has_token
                && (s_req_hint.decimals != known->decimals || strcmp(s_req_hint.symbol, known->symbol) != 0)) {
                ESP_LOGW(TAG, "refusing to sign: the host labels %s as %s with %u decimals", known->symbol,
                         s_req_hint.symbol, (unsigned)s_req_hint.decimals);
                gatt_svc_set_status(WALLET_STATUS_TX_INVALID);
                return 0;
            }
            s_req_jettons[i] = known;
        }
    }

    /* Arming and storing what to sign are one step under the lock, and a
     * competing confirmation is checked first, so a second request can't
     * replace the one the user is being shown. */
    LOCK();
    bool armed = arm_pending_locked(PENDING_SIGN);
    if (armed) {
        s_tx = s_req_tx;
        s_tx_hint = s_req_hint;
        memcpy(s_tx_jettons, s_req_jettons, sizeof(s_tx_jettons));
        memcpy(last_tx, s_tx.hash, sizeof(last_tx));
        layout_tx_pages();
        signature_ready = false;
        memset(last_signature, 0, sizeof(last_signature));
    }
    UNLOCK();
    if (!armed) {
        gatt_svc_set_status(WALLET_STATUS_BUSY);
        return 0;
    }

    ESP_LOGI(TAG, "signing request read, %u message(s) — awaiting physical confirm", (unsigned)s_req_tx.n_msgs);
    gatt_svc_set_status(WALLET_STATUS_AWAITING_CONFIRM);
    return 0;
}

/* See GATT_CHR_PROOF_REQUEST_UUID for the framing and the record. */
static int proof_request_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                                    struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (!wallet_key_exists()) {
        ESP_LOGW(TAG, "refusing proof_request write — no wallet created yet");
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (ota_service_in_progress()) {
        ESP_LOGW(TAG, "refusing proof_request write while an OTA update is in progress");
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (!pin_auth_session_unlocked()) {
        ESP_LOGW(TAG, "refusing proof_request write — PIN not verified on this connection");
        return BLE_ATT_ERR_INSUFFICIENT_AUTHOR;
    }
    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    uint8_t op;
    if (len < 1 || os_mbuf_copydata(ctxt->om, 0, 1, &op) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    if (op == GATT_TX_REQUEST_OP_BEGIN) {
        uint8_t header[3];
        reset_proof_request();
        if (len != sizeof(header) || os_mbuf_copydata(ctxt->om, 0, len, header) != 0) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        size_t total = ((size_t)header[1] << 8) | header[2];
        if (total < 1 + 8 + 1 || total > PROOF_REQ_MAX) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        s_proof_req_expected = total;
        return 0;
    }

    if (op == GATT_TX_REQUEST_OP_DATA) {
        size_t chunk = len - 1u;
        if (s_proof_req_expected == 0 || chunk > s_proof_req_expected - s_proof_req_len
            || os_mbuf_copydata(ctxt->om, 1, chunk, s_proof_req + s_proof_req_len) != 0) {
            reset_proof_request();
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        s_proof_req_len += chunk;
        return 0;
    }

    if (op != GATT_TX_REQUEST_OP_COMMIT || len != 1 || s_proof_req_expected == 0
        || s_proof_req_len != s_proof_req_expected) {
        reset_proof_request();
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    const uint8_t *r = s_proof_req;
    size_t total = s_proof_req_len;
    reset_proof_request();
    bool testnet = (r[0] & GATT_PROOF_FLAG_TESTNET) != 0;
    uint64_t timestamp = 0;
    for (unsigned i = 0; i < 8; i++) {
        timestamp = (timestamp << 8) | r[1 + i];
    }
    size_t domain_len = r[9];
    const char *domain = (const char *)r + 10;
    if ((r[0] & ~GATT_PROOF_FLAG_TESTNET) != 0 || domain_len > total - 10
        || !ton_proof_domain_valid(domain, domain_len) || total - 10 - domain_len > TON_PROOF_PAYLOAD_MAX) {
        ESP_LOGW(TAG, "refusing proof request: malformed, or a domain the screen can't show");
        gatt_svc_set_status(WALLET_STATUS_PROOF_INVALID);
        return 0;
    }
    uint8_t hash[32];
    ton_proof_hash(wallet_key_get_pubkey(), testnet, domain, domain_len, timestamp,
                   (const uint8_t *)domain + domain_len, total - 10 - domain_len, hash);

    LOCK();
    bool armed = arm_pending_locked(PENDING_PROOF);
    if (armed) {
        memcpy(last_tx, hash, sizeof(last_tx));
        memcpy(s_proof.domain, domain, domain_len);
        s_proof.domain[domain_len] = '\0';
        s_proof.timestamp = timestamp;
        s_proof.testnet = testnet;
        signature_ready = false;
        memset(last_signature, 0, sizeof(last_signature));
    }
    UNLOCK();
    if (!armed) {
        gatt_svc_set_status(WALLET_STATUS_BUSY);
        return 0;
    }

    ESP_LOGI(TAG, "proof request for %.*s — awaiting physical confirm", (int)domain_len, domain);
    gatt_svc_set_status(WALLET_STATUS_PROOF_AWAITING_CONFIRM);
    return 0;
}

static int show_address_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                                   struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (!wallet_key_exists()) {
        ESP_LOGW(TAG, "refusing show_address write — no wallet created yet");
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (!pin_auth_session_unlocked()) {
        ESP_LOGW(TAG, "refusing show_address write — PIN not verified on this connection");
        return BLE_ATT_ERR_INSUFFICIENT_AUTHOR;
    }
    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    uint8_t flags;
    uint16_t copied_len;
    if (len != 1 || ble_hs_mbuf_to_flat(ctxt->om, &flags, sizeof(flags), &copied_len) != 0
        || (flags & ~GATT_ADDRESS_FLAG_TESTNET) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    bool testnet = (flags & GATT_ADDRESS_FLAG_TESTNET) != 0;
    ton_tx_addr_t addr = { .workchain = 0 };
    ton_proof_wallet_address(wallet_key_get_pubkey(), testnet, addr.hash);

    LOCK();
    bool armed = arm_pending_locked(PENDING_SHOW_ADDRESS);
    if (armed) {
        s_own_address.addr = addr;
        s_own_address.testnet = testnet;
    }
    UNLOCK();
    if (!armed) {
        gatt_svc_set_status(WALLET_STATUS_BUSY);
        return 0;
    }
    ESP_LOGI(TAG, "showing own %s address", testnet ? "testnet" : "mainnet");
    gatt_svc_set_status(WALLET_STATUS_ADDRESS_SHOWING);
    return 0;
}

static int signed_tx_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                                struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    /* Same gate as asking for the signature in the first place. */
    if (!pin_auth_session_unlocked()) {
        return BLE_ATT_ERR_INSUFFICIENT_AUTHOR;
    }

    /* One approval, one signature: taken out and consumed in a single step
     * so a stale signature can't be picked up again by a later connection
     * that never confirmed anything. The client reads it exactly once,
     * right after SIGNED. */
    uint8_t signature[WALLET_SIGNATURE_LEN];
    LOCK();
    bool ready = signature_ready;
    if (ready) {
        memcpy(signature, last_signature, sizeof(signature));
        signature_ready = false;
        memset(last_signature, 0, sizeof(last_signature));
    }
    UNLOCK();
    if (!ready) {
        /* Not signed (yet): empty read. Central should watch the status
         * characteristic for SIGNED before reading this. */
        return 0;
    }
    int rc = os_mbuf_append(ctxt->om, signature, sizeof(signature));
    memset(signature, 0, sizeof(signature));
    return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int version_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                              struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    const esp_app_desc_t *desc = esp_app_get_description();
    size_t len = strnlen(desc->version, sizeof(desc->version));
    int rc = os_mbuf_append(ctxt->om, desc->version, len);
    return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int status_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                             struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    int rc = os_mbuf_append(ctxt->om, &status_val, sizeof(status_val));
    return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int pin_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                          struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    if (len < 1) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    uint8_t buf[1 + PIN_AUTH_MAX_LEN];
    uint16_t copied_len;
    if (len > sizeof(buf) || ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &copied_len) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }

    uint8_t opcode = buf[0];
    const uint8_t *pin = buf + 1;
    size_t pin_len = copied_len - 1;

    /* Both of these store a PIN, so both wait for someone physically at the
     * device. For CHANGE the unlocked session is the proof of the *current*
     * PIN and the press is the proof of presence; for SET there is no PIN to
     * prove anything with, and the press is the only thing standing between
     * a bonded central and a board it could lock its owner out of. */
    if (opcode == GATT_PIN_OP_SET || opcode == GATT_PIN_OP_CHANGE) {
        const bool changing = opcode == GATT_PIN_OP_CHANGE;
        if (changing && (!pin_auth_is_set() || !pin_auth_session_unlocked())) {
            memset(buf, 0, sizeof(buf));
            ESP_LOGW(TAG, "refusing PIN change — session not unlocked");
            return BLE_ATT_ERR_INSUFFICIENT_AUTHOR;
        }
        if (!changing && pin_auth_is_set()) {
            memset(buf, 0, sizeof(buf));
            gatt_svc_set_status(WALLET_STATUS_PIN_ALREADY_SET);
            return 0;
        }
        if (pin_len < PIN_AUTH_MIN_LEN || pin_len > PIN_AUTH_MAX_LEN) {
            memset(buf, 0, sizeof(buf));
            gatt_svc_set_status(WALLET_STATUS_PIN_INVALID_LEN);
            return 0;
        }
        LOCK();
        bool armed = arm_pending_locked(changing ? PENDING_PIN_CHANGE : PENDING_PIN_SET);
        if (armed) {
            memcpy(s_new_pin, pin, pin_len);
            s_new_pin_len = pin_len;
        }
        UNLOCK();
        memset(buf, 0, sizeof(buf));
        if (!armed) {
            gatt_svc_set_status(WALLET_STATUS_BUSY);
            return 0;
        }
        ESP_LOGI(TAG, "PIN %s armed — awaiting physical confirm", changing ? "change" : "setup");
        gatt_svc_set_status(changing ? WALLET_STATUS_PIN_CHANGE_AWAITING_CONFIRM
                                     : WALLET_STATUS_PIN_SET_AWAITING_CONFIRM);
        return 0;
    }

    pin_auth_result_t result;
    if (opcode == GATT_PIN_OP_VERIFY) {
        result = pin_auth_verify(pin, pin_len);
    } else {
        memset(buf, 0, sizeof(buf));
        return BLE_ATT_ERR_UNLIKELY;
    }
    memset(buf, 0, sizeof(buf));

    switch (result) {
    case PIN_AUTH_OK:
        gatt_svc_set_status(WALLET_STATUS_PIN_OK);
        break;
    case PIN_AUTH_ALREADY_SET:
        gatt_svc_set_status(WALLET_STATUS_PIN_ALREADY_SET);
        break;
    case PIN_AUTH_BAD_LEN:
        gatt_svc_set_status(WALLET_STATUS_PIN_INVALID_LEN);
        break;
    case PIN_AUTH_WRONG:
        gatt_svc_set_status(WALLET_STATUS_PIN_WRONG);
        break;
    case PIN_AUTH_LOCKED:
        gatt_svc_set_status(WALLET_STATUS_PIN_LOCKED);
        break;
    case PIN_AUTH_FAILED:
        /* Storage or hardware HMAC error, not the PIN — logged in
         * wallet_key.c. Reported as a failed attempt: the session stays
         * locked either way. */
        gatt_svc_set_status(WALLET_STATUS_PIN_WRONG);
        break;
    }
    return 0;
}

/* Every characteristic requires an *authenticated* link (_AUTHEN), not just
 * an encrypted one (_ENC): encryption alone is also satisfied by a Just
 * Works key, which gives no protection against a MITM during the first
 * pairing. With _AUTHEN the ATT layer itself refuses access until the bond
 * was made with the passkey shown on the display (main.c), so that guarantee
 * no longer rests on the pairing settings alone. A bond made before
 * passkey pairing existed (Just Works) is refused too and must be redone. */
static const struct ble_gatt_svc_def gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = GATT_SVC_UUID,
        .characteristics = (struct ble_gatt_chr_def[]){
            {
                .uuid = GATT_CHR_PUBKEY_UUID,
                .access_cb = pubkey_access_cb,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC | BLE_GATT_CHR_F_READ_AUTHEN,
            },
            {
                .uuid = GATT_CHR_TX_REQUEST_UUID,
                .access_cb = tx_request_access_cb,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC | BLE_GATT_CHR_F_WRITE_AUTHEN,
            },
            {
                .uuid = GATT_CHR_PROOF_REQUEST_UUID,
                .access_cb = proof_request_access_cb,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC | BLE_GATT_CHR_F_WRITE_AUTHEN,
            },
            {
                .uuid = GATT_CHR_SHOW_ADDRESS_UUID,
                .access_cb = show_address_access_cb,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC | BLE_GATT_CHR_F_WRITE_AUTHEN,
            },
            {
                .uuid = GATT_CHR_SIGNED_TX_UUID,
                .access_cb = signed_tx_access_cb,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC | BLE_GATT_CHR_F_READ_AUTHEN,
            },
            {
                .uuid = GATT_CHR_STATUS_UUID,
                .access_cb = status_access_cb,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC | BLE_GATT_CHR_F_READ_AUTHEN | BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &status_chr_val_handle,
            },
            {
                .uuid = GATT_CHR_PIN_UUID,
                .access_cb = pin_access_cb,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC | BLE_GATT_CHR_F_WRITE_AUTHEN,
            },
            {
                .uuid = GATT_CHR_CREATE_WALLET_UUID,
                .access_cb = create_wallet_access_cb,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC | BLE_GATT_CHR_F_WRITE_AUTHEN,
            },
            {
                .uuid = GATT_CHR_SHOW_SEED_UUID,
                .access_cb = show_seed_access_cb,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC | BLE_GATT_CHR_F_WRITE_AUTHEN,
            },
            {
                .uuid = GATT_CHR_VERSION_UUID,
                .access_cb = version_access_cb,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC | BLE_GATT_CHR_F_READ_AUTHEN,
            },
            {
                .uuid = GATT_CHR_OTA_CONTROL_UUID,
                .access_cb = ota_control_access_cb,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC | BLE_GATT_CHR_F_WRITE_AUTHEN,
            },
            {
                .uuid = GATT_CHR_OTA_STATUS_UUID,
                .access_cb = ota_status_access_cb,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC | BLE_GATT_CHR_F_READ_AUTHEN | BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &ota_status_chr_val_handle,
            },
            {
                .uuid = GATT_CHR_OTA_DATA_AT_UUID,
                .access_cb = ota_data_at_access_cb,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP | BLE_GATT_CHR_F_WRITE_ENC
                         | BLE_GATT_CHR_F_WRITE_AUTHEN,
            },
            { 0 }, /* terminator */
        },
    },
    { 0 }, /* terminator */
};

/* Paints one page of the 24-word mnemonic (see seed_words above) — called
 * once per physical confirm press, never in a loop, so how long a page
 * stays up is entirely up to the person reading it. No BLE traffic happens
 * here; the phrase is never sent over the air.
 *
 * Caller holds s_lock (seed_words must not be wiped mid-draw by the idle
 * timeout); the frame itself is composed under the display lock so a status
 * update from another task can't land halfway through it. */
static void draw_seed_page(int page)
{
    char header[48];
    /* Room for what gcc thinks the numbers could print. */
    char line[48];

    display_lock();
    display_clear();
    if (SEED_TOTAL_PAGES == 1) {
        snprintf(header, sizeof(header), "Seed: %d words", TON_MNEMONIC_WORD_COUNT);
    } else {
        snprintf(header, sizeof(header), "Seed %d-%d/%d (%d/%d)", page * SEED_WORDS_PER_PAGE + 1,
                 (page + 1) * SEED_WORDS_PER_PAGE, TON_MNEMONIC_WORD_COUNT, page + 1, SEED_TOTAL_PAGES);
    }
    display_draw_text_centered(0, header);
    /* Numbered down the left column, then down the right one — the order
     * the words are written out on paper. */
    for (int row = 0; row < SEED_ROWS_PER_PAGE; row++) {
        int left = page * SEED_WORDS_PER_PAGE + row;
        int right = left + SEED_ROWS_PER_PAGE;
        snprintf(line, sizeof(line), "%2d. %-8s  %2d. %-8s", left + 1, ton_mnemonic_word(seed_words[left]),
                 right + 1, ton_mnemonic_word(seed_words[right]));
        display_draw_text_centered(1 + row, line);
    }
    display_flush();
    display_unlock();
}

/* Caller holds s_lock, like draw_seed_page(). */
static void draw_seed_check(void)
{
    /* Room for what gcc thinks the numbers could print; display_draw_text
     * clips at DISPLAY_COLS on its own. */
    char line[48];

    display_lock();
    display_clear();
    snprintf(line, sizeof(line), "Check %d/%d: word #%d", seed_check_question + 1, SEED_CHECK_QUESTIONS,
             seed_check_positions[seed_check_question] + 1);
    display_draw_text_centered(0, line);
    for (int i = 0; i < SEED_CHECK_OPTIONS; i++) {
        snprintf(line, sizeof(line), "%s %-8s", i == seed_check_selected ? ">" : " ",
                 ton_mnemonic_word(seed_check_options[i]));
        display_draw_text_centered(2 + i, line);
    }
    display_draw_text_centered(DISPLAY_ROWS - 2, "Press: next word");
    display_draw_text_centered(DISPLAY_ROWS - 1, "Hold 1s: choose");
    display_flush();
    display_unlock();
}

/* Caller holds s_lock. The right word plus SEED_CHECK_OPTIONS - 1 others,
 * all different, in random order. Other words of the phrase may turn up
 * among them — picking one of those is exactly the mistake (words written
 * down out of order) this is here to catch. */
static void seed_check_ask_locked(void)
{
    uint16_t right = seed_words[seed_check_positions[seed_check_question]];
    int right_at = esp_random() % SEED_CHECK_OPTIONS;
    for (int i = 0; i < SEED_CHECK_OPTIONS; i++) {
        if (i == right_at) {
            seed_check_options[i] = right;
            continue;
        }
        bool taken;
        do {
            seed_check_options[i] = esp_random() % 2048;
            taken = seed_check_options[i] == right;
            for (int j = 0; j < i; j++) {
                taken = taken || seed_check_options[j] == seed_check_options[i];
            }
        } while (taken);
    }
    seed_check_selected = 0;
    draw_seed_check();
}

/* Caller holds s_lock. SEED_CHECK_QUESTIONS different positions. */
static void seed_check_start_locked(void)
{
    for (int q = 0; q < SEED_CHECK_QUESTIONS; q++) {
        bool taken;
        do {
            seed_check_positions[q] = esp_random() % TON_MNEMONIC_WORD_COUNT;
            taken = false;
            for (int j = 0; j < q; j++) {
                taken = taken || seed_check_positions[j] == seed_check_positions[q];
            }
        } while (taken);
    }
    seed_check_question = 0;
    seed_checking = true;
    seed_check_ask_locked();
}

/* Caller holds s_lock. Takes the phrase, and anything derived from it, off
 * the device's memory; the caller repaints the screen by reporting a
 * status. */
static void seed_end_locked(void)
{
    seed_showing = false;
    seed_check = false;
    seed_checking = false;
    memset(seed_words, 0, sizeof(seed_words));
    memset(seed_check_positions, 0, sizeof(seed_check_positions));
    memset(seed_check_options, 0, sizeof(seed_check_options));
    seed_check_question = 0;
    seed_check_selected = 0;
}

/* Caller holds s_lock. One press while the phrase is up: pages through it,
 * then through the check if there is one. Returns the status to report. */
static enum wallet_status seed_press_locked(bool long_press)
{
    if (!seed_checking) {
        seed_page++;
        if (seed_page < SEED_TOTAL_PAGES) {
            ESP_LOGI(TAG, "show_seed: advancing to page %d/%d", seed_page + 1, SEED_TOTAL_PAGES);
            draw_seed_page(seed_page);
            return WALLET_STATUS_SEED_SHOWING;
        }
        if (!seed_check) {
            seed_end_locked();
            ESP_LOGI(TAG, "show_seed: dismissed after last page");
            return WALLET_STATUS_SEED_DONE;
        }
        ESP_LOGI(TAG, "show_seed: last page passed — checking");
        seed_check_start_locked();
        return WALLET_STATUS_SEED_CHECKING;
    }

    if (!long_press) {
        seed_check_selected = (seed_check_selected + 1) % SEED_CHECK_OPTIONS;
        draw_seed_check();
        return WALLET_STATUS_SEED_CHECKING;
    }
    if (seed_check_options[seed_check_selected] != seed_words[seed_check_positions[seed_check_question]]) {
        seed_end_locked();
        ESP_LOGW(TAG, "seed check: wrong word picked");
        return WALLET_STATUS_SEED_CHECK_FAILED;
    }
    seed_check_question++;
    if (seed_check_question == SEED_CHECK_QUESTIONS) {
        seed_end_locked();
        ESP_LOGI(TAG, "seed check: passed");
        return WALLET_STATUS_SEED_CHECKED;
    }
    seed_check_ask_locked();
    return WALLET_STATUS_SEED_CHECKING;
}

/* Caller holds s_lock. Written out in full, 24 characters to a row:
 * checking only the two ends of an address is exactly what vanity addresses
 * are generated to get past. */
static void draw_address(uint8_t first_row, const ton_tx_addr_t *addr, bool bounceable, bool test_only)
{
    char text[TON_TX_ADDR_STR_LEN + 1];
    ton_tx_format_address(addr, bounceable, test_only, text);
    for (int i = 0; i < 2; i++) {
        char line[25];
        memcpy(line, text + 24 * i, 24);
        line[24] = '\0';
        display_draw_text_centered(first_row + i, line);
    }
}

/* Paints the current page of the signing request (see s_tx_pages). Every
 * figure and address on it is read from the message being signed; the host
 * only chooses the token label (shown with a '?') and which friendly form
 * addresses are written in. Caller holds s_lock. */
static void draw_tx_page(void)
{
    static const char *const titles[] = {
        [TON_TX_MSG_TRANSFER] = "Send GRAM",
        [TON_TX_MSG_JETTON] = "Send token",
        [TON_TX_MSG_NFT] = "Send NFT",
        [TON_TX_MSG_CALL] = "!Call",
    };
    const uint8_t msg_index = s_tx_pages[s_tx_page].msg;
    const ton_tx_msg_t *m = &s_tx.msgs[msg_index];
    const bool last = s_tx_page + 1 >= s_tx_page_count;
    /* Sized for the longest thing written into them (a whole comment), not
     * for the screen: display_draw_text clips at DISPLAY_COLS on its own. */
    char counter[24] = "";
    char line[TON_TX_COMMENT_MAX + 48];
    char amount[48];

    if (s_tx.n_msgs > 1) {
        snprintf(counter, sizeof(counter), " %u/%u", (unsigned)msg_index + 1, (unsigned)s_tx.n_msgs);
    }

    display_lock();
    display_clear();
    if (s_tx_pages[s_tx_page].kind == TX_PAGE_REQUEST) {
        /* The deadline is the host's choice and the device has no clock to
         * hold it against — this is here to be compared with the clock in
         * the owner's pocket, where minutes from now is ordinary and next
         * year means a signature meant to be used at someone else's
         * convenience. */
        time_t deadline = (time_t)s_tx.valid_until;
        struct tm utc;
        display_draw_text_centered(0, "Signing request");
        display_draw_text_centered(3, "Expires (UTC):");
        if (gmtime_r(&deadline, &utc) != NULL) {
            snprintf(line, sizeof(line), "%04d-%02d-%02d %02d:%02d", utc.tm_year + 1900, utc.tm_mon + 1,
                     utc.tm_mday, utc.tm_hour, utc.tm_min);
        } else {
            snprintf(line, sizeof(line), "%" PRIu32, s_tx.valid_until);
        }
        display_draw_text_centered(4, line);
        snprintf(line, sizeof(line), "%u message%s", (unsigned)s_tx.n_msgs, s_tx.n_msgs == 1 ? "" : "s");
        display_draw_text_centered(6, line);
    } else if (s_tx_pages[s_tx_page].kind == TX_PAGE_SOURCE) {
        const bool nft = m->kind == TON_TX_MSG_NFT;
        const ton_jetton_t *known = s_tx_jettons[msg_index];
        if (known != NULL) {
            snprintf(line, sizeof(line), "Your %s wallet%s", known->symbol, counter);
        } else {
            snprintf(line, sizeof(line), "%s%s", nft ? "NFT item" : "Token wallet", counter);
        }
        display_draw_text_centered(0, line);
        display_draw_text_centered(3, nft ? "being sent:" : "sending from:");
        /* Always a contract, so written the way explorers and wallets write
         * contracts (EQ…) for the ends to compare — not in the form the
         * recipient was typed in, which is what the hint's flag is about. */
        draw_address(4, &m->dest, true, (s_tx_hint.flags & GATT_TX_HINT_TEST_ONLY) != 0);
    } else if (s_tx_pages[s_tx_page].kind == TX_PAGE_COMMENT) {
        snprintf(line, sizeof(line), "Comment%s", counter);
        display_draw_text_centered(0, line);
        size_t comment_len = strlen(m->comment);
        for (uint8_t row = 1; row <= DISPLAY_ROWS - 2; row++) {
            size_t off = (size_t)(row - 1) * DISPLAY_COLS;
            if (off >= comment_len) {
                break;
            }
            snprintf(line, sizeof(line), "%.*s", (int)DISPLAY_COLS, m->comment + off);
            display_draw_text(row, 0, line);
        }
    } else {
        snprintf(line, sizeof(line), "%s%s%s", titles[m->kind], m->deploys ? "+deploy" : "", counter);
        display_draw_text_centered(0, line);

        switch (m->kind) {
        case TON_TX_MSG_JETTON:
            if (s_tx_jettons[msg_index] != NULL) {
                /* Named and scaled by the device itself: no '?'. */
                ton_tx_format_amount(m->token_amount, s_tx_jettons[msg_index]->decimals, DISPLAY_COLS, amount,
                                     sizeof(amount));
                snprintf(line, sizeof(line), "%s to:", s_tx_jettons[msg_index]->symbol);
            } else if (s_tx_hint.has_token) {
                ton_tx_format_amount(m->token_amount, s_tx_hint.decimals, DISPLAY_COLS, amount, sizeof(amount));
                snprintf(line, sizeof(line), "%s? to:", s_tx_hint.symbol[0] != '\0' ? s_tx_hint.symbol : "token");
            } else {
                ton_tx_format_amount(m->token_amount, 0, DISPLAY_COLS, amount, sizeof(amount));
                snprintf(line, sizeof(line), "token units to:");
            }
            break;
        case TON_TX_MSG_NFT:
            /* The item itself was written out in full on the page before
             * this one; abbreviating it here again would only invite
             * comparing the two ends of an address, which is exactly what a
             * generated look-alike gets past. */
            snprintf(amount, sizeof(amount), "item: prev page");
            snprintf(line, sizeof(line), "new owner:");
            break;
        default:
            ton_tx_format_amount(m->ton, 9, DISPLAY_COLS, amount, sizeof(amount));
            snprintf(line, sizeof(line), "GRAM to:");
            break;
        }
        display_draw_text_centered(2, amount);
        display_draw_text_centered(3, line);
        draw_address(4, (m->kind == TON_TX_MSG_JETTON || m->kind == TON_TX_MSG_NFT) ? &m->to : &m->dest,
                     (s_tx_hint.flags & GATT_TX_HINT_BOUNCEABLE) != 0,
                     (s_tx_hint.flags & GATT_TX_HINT_TEST_ONLY) != 0);

        line[0] = '\0';
        switch (m->kind) {
        case TON_TX_MSG_TRANSFER:
            if (m->has_comment && strlen(m->comment) > TX_INLINE_COMMENT_MAX) {
                snprintf(line, sizeof(line), "Msg: next page");
            } else if (m->has_comment) {
                snprintf(line, sizeof(line), "Msg: %s", m->comment);
            }
            break;
        case TON_TX_MSG_JETTON:
        case TON_TX_MSG_NFT:
            /* The TON riding along for gas — leftovers come back, but this
             * is what leaves the wallet. */
            ton_tx_format_amount(m->ton, 9, DISPLAY_COLS - 9, amount, sizeof(amount));
            snprintf(line, sizeof(line), "+%s GRAM gas", amount);
            break;
        case TON_TX_MSG_CALL:
            if (m->has_op) {
                snprintf(line, sizeof(line), "op 0x%08" PRIx32, m->op);
            } else {
                snprintf(line, sizeof(line), "no op code");
            }
            break;
        }
        display_draw_text_centered(7, line);
    }
    snprintf(line, sizeof(line), "%s%s", s_tx.testnet ? "TESTNET " : "", last ? "Hold 1s = sign" : "Press = next");
    display_draw_text_centered(DISPLAY_ROWS - 1, line);
    display_flush();
    display_unlock();
}

/* The site a ton_proof is for, written out in full, and the time it claims
 * to be made at. Caller holds s_lock. */
static void draw_proof_page(void)
{
    /* Room for what gcc thinks a date could print; display_draw_text clips
     * at DISPLAY_COLS on its own. */
    char line[48];
    display_lock();
    display_clear();
    display_draw_text_centered(0, "Sign in to site:");
    size_t len = strlen(s_proof.domain);
    for (uint8_t row = 0; row < 5 && (size_t)row * DISPLAY_COLS < len; row++) {
        snprintf(line, sizeof(line), "%.*s", (int)DISPLAY_COLS, s_proof.domain + (size_t)row * DISPLAY_COLS);
        display_draw_text_centered(2 + row, line);
    }
    /* Like a request's expiry: host-chosen, and here to be compared with a
     * clock the owner has — a proof dated far ahead is one meant to be
     * used later. */
    time_t when = (time_t)s_proof.timestamp;
    struct tm utc;
    if (s_proof.timestamp <= INT32_MAX && gmtime_r(&when, &utc) != NULL) {
        snprintf(line, sizeof(line), "%04d-%02d-%02d %02d:%02d UTC", utc.tm_year + 1900, utc.tm_mon + 1,
                 utc.tm_mday, utc.tm_hour, utc.tm_min);
    } else {
        snprintf(line, sizeof(line), "time: far future");
    }
    display_draw_text_centered(DISPLAY_ROWS - 3, line);
    snprintf(line, sizeof(line), "%sHold 1s = sign", s_proof.testnet ? "TESTNET " : "");
    display_draw_text_centered(DISPLAY_ROWS - 1, line);
    display_flush();
    display_unlock();
}

/* This wallet's own address, in the form the app shows for receiving. Caller
 * holds s_lock. */
static void draw_own_address_page(void)
{
    display_lock();
    display_clear();
    display_draw_text_centered(0, s_own_address.testnet ? "Your address (TESTNET)" : "Your address");
    draw_address(4, &s_own_address.addr, false, s_own_address.testnet);
    display_draw_text_centered(8, "Compare it with the app");
    display_draw_text_centered(DISPLAY_ROWS - 1, "Press = done");
    display_flush();
    display_unlock();
}

/* Deriving the key takes ~10-20s of solid CPU. On the button task
 * (priority 10) that starves the idle task past the 5s task watchdog; at
 * idle priority it shares the core with it round-robin instead. arg is
 * non-NULL when this runs as a task of its own, which then ends itself. */
static void create_wallet_task(void *arg)
{
    wallet_key_result_t result = wallet_key_create();
    LOCK();
    s_creating = false;
    UNLOCK();
    if (result != WALLET_KEY_OK) {
        ESP_LOGE(TAG, "wallet creation failed, result=%d", (int)result);
    }
    gatt_svc_set_status(result == WALLET_KEY_OK ? WALLET_STATUS_CREATED : WALLET_STATUS_CREATE_REJECTED);
    if (arg != NULL) {
        vTaskDelete(NULL);
    }
}

void gatt_svc_on_confirm_button(bool long_press)
{
    LOCK();

    /* Actively paging through the seed phrase takes priority over anything
     * else a press could mean — once page 1 is up, every further press
     * unambiguously means "next page" (or "done" on the last one). */
    if (seed_showing) {
        seed_last_activity_us = esp_timer_get_time();
        enum wallet_status status = seed_press_locked(long_press);
        UNLOCK();
        /* SEED_SHOWING / SEED_CHECKING are BLE notifies only — the display
         * was painted above. */
        gatt_svc_set_status(status);
        return;
    }

    enum pending_op op = s_pending;
    if (op == PENDING_NONE) {
        UNLOCK();
        /* main.c hands the same press to ota_service next; if an update
         * owns the button, the press is its to log. */
        if (!ota_service_in_progress()) {
            ESP_LOGI(TAG, "confirm button pressed, but nothing is pending — ignored");
        }
        return;
    }

    /* A request longer than one page is read a press at a time, and each
     * page gets a confirm window of its own. Only a press on the last page
     * falls through to signing. */
    if (op == PENDING_SIGN && !pending_expired() && s_tx_page + 1 < s_tx_page_count) {
        s_tx_page++;
        s_pending_since_us = esp_timer_get_time();
        UNLOCK();
        gatt_svc_set_status(WALLET_STATUS_AWAITING_CONFIRM);
        return;
    }

    /* A signature takes a deliberate hold, not a press: paging and signing
     * used to be the same short press, so a few quick presses in a row could
     * run through every page and sign without anything being read. A short
     * press on the signing page does nothing; the window keeps running. */
    if ((op == PENDING_SIGN || op == PENDING_PROOF) && !long_press && !pending_expired()) {
        UNLOCK();
        ESP_LOGI(TAG, "short press on the signing page — hold the button to sign");
        return;
    }

    /* Everything this press acts on is copied out before clear_pending().
     * The moment the lock is released the NimBLE host is free to arm a new
     * operation and overwrite last_tx / s_new_pin, so reading either of
     * them afterwards could sign a hash nobody confirmed. */
    uint8_t tx_hash[TON_SIGNING_HASH_LEN];
    memcpy(tx_hash, last_tx, sizeof(tx_hash));
    uint8_t new_pin[PIN_AUTH_MAX_LEN];
    size_t new_pin_len = s_new_pin_len;
    memcpy(new_pin, s_new_pin, sizeof(new_pin));
    uint32_t conn_gen = s_conn_gen;

    bool expired = pending_expired();
    /* The phrase goes up in the same step that frees the button. Put up
     * after UNLOCK(), it would leave a gap where an OTA or another operation
     * could be armed, and the next press would then mean two things. */
    bool seed_up = (op == PENDING_SHOW_SEED || op == PENDING_SHOW_SEED_CHECK) && !expired
                   && wallet_key_get_mnemonic(seed_words);
    s_creating = op == PENDING_CREATE_WALLET && !expired;
    if (seed_up) {
        seed_page = 0;
        seed_showing = true;
        seed_check = op == PENDING_SHOW_SEED_CHECK;
        seed_last_activity_us = esp_timer_get_time();
        draw_seed_page(seed_page);
    }
    clear_pending();
    UNLOCK();

    if (expired || (op != PENDING_PIN_CHANGE && op != PENDING_PIN_SET)) {
        memset(new_pin, 0, sizeof(new_pin));
        new_pin_len = 0;
    }
    if (expired || (op != PENDING_SIGN && op != PENDING_PROOF)) {
        memset(tx_hash, 0, sizeof(tx_hash));
    }
    if (expired) {
        ESP_LOGW(TAG, "confirm button pressed after timeout — op %d dropped", (int)op);
        set_rejected_status(op);
        return;
    }

    switch (op) {
    case PENDING_CREATE_WALLET:
        ESP_LOGI(TAG, "wallet creation confirmed — deriving key (~10-20s, see WALLET_STATUS_CREATE_GENERATING)");
        gatt_svc_set_status(WALLET_STATUS_CREATE_GENERATING);
        if (xTaskCreate(create_wallet_task, "create_wallet", 6144, (void *)1, tskIDLE_PRIORITY, NULL) != pdPASS) {
            ESP_LOGW(TAG, "no memory for create_wallet task — deriving on the button task");
            create_wallet_task(NULL);
        }
        return;

    case PENDING_SHOW_SEED:
    case PENDING_SHOW_SEED_CHECK:
        if (!seed_up) {
            ESP_LOGW(TAG, "show_seed confirmed but mnemonic is gone — ignored");
            gatt_svc_set_status(WALLET_STATUS_SEED_UNAVAILABLE);
            return;
        }
        ESP_LOGI(TAG, "show_seed confirmed — showing page 1/%d", SEED_TOTAL_PAGES);
        gatt_svc_set_status(WALLET_STATUS_SEED_SHOWING);
        return;

    case PENDING_PIN_SET: {
        pin_auth_result_t result = pin_auth_set(new_pin, new_pin_len);
        memset(new_pin, 0, sizeof(new_pin));
        switch (result) {
        case PIN_AUTH_OK:
            ESP_LOGI(TAG, "PIN set");
            /* Storing it also unlocks this session (pin_auth_set), which is
             * exactly what PIN_OK tells the client. */
            gatt_svc_set_status(WALLET_STATUS_PIN_OK);
            break;
        case PIN_AUTH_ALREADY_SET:
            /* Someone else won the race between the write and this press. */
            gatt_svc_set_status(WALLET_STATUS_PIN_ALREADY_SET);
            break;
        default:
            ESP_LOGW(TAG, "PIN setup failed, result=%d", (int)result);
            gatt_svc_set_status(WALLET_STATUS_PIN_SET_REJECTED);
            break;
        }
        return;
    }

    case PENDING_PIN_CHANGE: {
        pin_auth_result_t result = pin_auth_change(new_pin, new_pin_len);
        memset(new_pin, 0, sizeof(new_pin));
        if (result == PIN_AUTH_OK) {
            ESP_LOGI(TAG, "PIN changed");
            gatt_svc_set_status(WALLET_STATUS_PIN_CHANGED);
        } else {
            ESP_LOGW(TAG, "PIN change failed, result=%d", (int)result);
            gatt_svc_set_status(WALLET_STATUS_PIN_CHANGE_REJECTED);
        }
        return;
    }

    case PENDING_WIPE:
        ESP_LOGW(TAG, "factory reset confirmed — erasing wallet and PIN");
        gatt_svc_set_status(WALLET_STATUS_WIPED);
        wallet_key_wipe();
        pin_auth_wipe();
        /* Bonds live in NimBLE's own NVS namespace, which neither wipe above
         * touches — erasing a namespace only erases that namespace. Left
         * behind, they would let whoever was paired with the previous owner's
         * wallet connect to the "fresh" device without pairing again, and
         * they are what _AUTHEN accepts as proof of an authenticated link.
         * Erased here rather than on the next boot so a reset that is
         * interrupted before rebooting doesn't leave them lying around. */
        int rc = ble_store_clear();
        if (rc != 0) {
            ESP_LOGE(TAG, "failed to clear BLE bonds on wipe, rc=%d", rc);
        }
        /* Reboot rather than trying to rewind every module's in-memory state
         * back to "fresh device" by hand — the next boot reads the now-empty
         * NVS and comes up in exactly the state a brand-new board is in. */
        display_show_status("Factory Reset", "Erased,", "rebooting");
        vTaskDelay(pdMS_TO_TICKS(1500));
        esp_restart();
        return;

    case PENDING_SHOW_ADDRESS:
        gatt_svc_set_status(WALLET_STATUS_ADDRESS_DONE);
        return;

    case PENDING_SIGN:
    case PENDING_PROOF: {
        uint8_t signature[WALLET_SIGNATURE_LEN];
        wallet_key_sign(tx_hash, sizeof(tx_hash), signature);
        memset(tx_hash, 0, sizeof(tx_hash));
        LOCK();
        bool delivered = conn_gen == s_conn_gen;
        if (delivered) {
            memcpy(last_signature, signature, sizeof(last_signature));
            signature_ready = true;
        }
        UNLOCK();
        memset(signature, 0, sizeof(signature));
        if (!delivered) {
            ESP_LOGW(TAG, "central disconnected while signing — signature discarded");
            return;
        }
        ESP_LOGI(TAG, "%s confirmed and signed", op == PENDING_PROOF ? "proof" : "tx");
        gatt_svc_set_status(op == PENDING_PROOF ? WALLET_STATUS_PROOF_SIGNED : WALLET_STATUS_SIGNED);
        return;
    }

    default:
        return;
    }
}

static void timeout_check_cb(void *arg)
{
    /* Check-and-clear happens under the lock, so a press racing the end of
     * the window resolves one way only: either the button task takes the
     * operation, or this timer drops it — never both. */
    LOCK();
    enum pending_op expired_op = PENDING_NONE;
    if (s_pending != PENDING_NONE && pending_expired()) {
        expired_op = s_pending;
        clear_pending();
    }
    bool seed_idle = seed_showing && esp_timer_get_time() - seed_last_activity_us > SEED_IDLE_TIMEOUT_US;
    /* A check left unfinished is not a passed one. */
    bool seed_idle_check = seed_idle && seed_check;
    if (seed_idle) {
        seed_end_locked();
    }
    /* The idle time of an unlocked session counts only while nothing is
     * underway: a prompt waiting for the button or an OTA in flight is use.
     * Decided under the lock, so nothing can be armed in between. */
    bool session_locked = false;
    if (s_pending != PENDING_NONE || seed_showing || ota_service_in_progress()) {
        pin_auth_session_touch();
    } else {
        session_locked = pin_auth_session_expire_idle();
    }
    UNLOCK();

    if (session_locked) {
        gatt_svc_set_status(WALLET_STATUS_SESSION_LOCKED);
    }

    if (expired_op != PENDING_NONE) {
        ESP_LOGW(TAG, "confirm window expired — op %d dropped", (int)expired_op);
        set_rejected_status(expired_op);
    }
    if (seed_idle) {
        ESP_LOGW(TAG, "show_seed idle for too long — cleared from screen");
        gatt_svc_set_status(seed_idle_check ? WALLET_STATUS_SEED_CHECK_FAILED : WALLET_STATUS_SEED_DONE);
    }
    if (s_display_revert_pending && esp_timer_get_time() >= s_display_revert_at_us) {
        s_display_revert_pending = false;
        /* Only if that status is still what the screen shows. Transaction
         * and sign-in pages, the seed phrase and its check, the pairing code
         * and the OTA prompt are all drawn without coming through here; one
         * put up within a few seconds of, say, "PIN Unlocked" used to be
         * wiped by this revert (seen on the board 2026-09-29). */
        if (display_frame_seq() == s_display_revert_frame) {
            display_show_status("Quick Wallet", "Ready", NULL);
        }
    }
}

bool gatt_svc_confirm_pending(void)
{
    LOCK();
    bool pending = s_pending != PENDING_NONE || seed_showing;
    UNLOCK();
    return pending;
}

bool gatt_svc_arm_if_idle(bool (*arm)(void *ctx), void *ctx)
{
    LOCK();
    bool armed = s_pending == PENDING_NONE && !seed_showing && arm(ctx);
    UNLOCK();
    return armed;
}

void gatt_svc_on_disconnect(void)
{
    LOCK();
    s_conn_gen++;

    /* A half-sent signing request must not be completed by whatever the next
     * connection writes, nor a signature nobody collected be picked up. */
    reset_request();
    reset_proof_request();
    signature_ready = false;
    memset(last_signature, 0, sizeof(last_signature));

    /* Nothing armed by a central may outlive that central's connection.
     * It matters most for PENDING_WIPE: left armed, a stray button press
     * minutes later would erase the wallet with nobody having asked for it
     * in this session. The seed display is deliberately left alone — it's
     * paged by the person standing at the device, not by the client, and
     * cutting it short would strand someone mid-way through copying words. */
    if (s_pending != PENDING_NONE) {
        ESP_LOGI(TAG, "central disconnected — dropping pending op %d", (int)s_pending);
        clear_pending();
        /* The confirm prompt is still on screen; without this it stays
         * there, looking armed, until the next status is drawn. */
        display_show_status("Quick Wallet", "Ready", NULL);
    }
    UNLOCK();
}

uint16_t gatt_svc_ota_status_handle(void)
{
    return ota_status_chr_val_handle;
}

/* Mirrors a status onto the display (no-op on boards without one — see
 * display_flush()). For WALLET_STATUS_AWAITING_CONFIRM that is the current page
 * of the parsed signing request — see draw_tx_page(). */
static void show_status_on_display(enum wallet_status status)
{
    switch (status) {
    case WALLET_STATUS_NO_WALLET:
        display_show_status("No Wallet", "Create via app", NULL);
        break;
    case WALLET_STATUS_CREATE_AWAITING_CONFIRM:
        display_show_status("Create Wallet", "Press button", "to confirm");
        break;
    case WALLET_STATUS_CREATED:
        display_show_status("Wallet", "Created", NULL);
        break;
    case WALLET_STATUS_CREATE_REJECTED:
        display_show_status("Create Wallet", "Rejected", "or timed out");
        break;
    case WALLET_STATUS_CREATE_GENERATING:
        display_show_status("Create Wallet", "Generating key...", "please wait");
        break;
    case WALLET_STATUS_PIN_NOT_SET:
        display_show_status("Quick Wallet", "Set a PIN", "via app");
        break;
    case WALLET_STATUS_AWAITING_CONFIRM:
        LOCK();
        if (s_pending == PENDING_SIGN && s_tx_page_count > 0) {
            draw_tx_page();
        } else {
            /* Only if the window closed between arming and this repaint. */
            display_show_status("Sign Transaction", "Press button", "to confirm");
        }
        UNLOCK();
        break;
    case WALLET_STATUS_TX_INVALID:
        display_show_status("Transaction", "Not understood,", "refused");
        break;
    case WALLET_STATUS_SIGNED:
        display_show_status("Transaction", "Signed", NULL);
        break;
    case WALLET_STATUS_REJECTED:
        display_show_status("Transaction", "Rejected", "or timed out");
        break;
    case WALLET_STATUS_PIN_OK:
        display_show_status("PIN", "Unlocked", NULL);
        break;
    case WALLET_STATUS_SESSION_LOCKED:
        display_show_status("Locked", "Unused 5 min", "Enter PIN in app");
        break;
    case WALLET_STATUS_PIN_WRONG:
        display_show_status("PIN", "Wrong PIN", NULL);
        break;
    case WALLET_STATUS_PIN_LOCKED:
        display_show_status("PIN", "Locked out,", "try later");
        break;
    case WALLET_STATUS_PIN_ALREADY_SET:
        display_show_status("PIN", "Already set", NULL);
        break;
    case WALLET_STATUS_PIN_INVALID_LEN:
        display_show_status("PIN", "Invalid length", NULL);
        break;
    case WALLET_STATUS_SEED_AWAITING_CONFIRM:
        display_show_status("Show Seed Phrase", "Press button", "to confirm");
        break;
    case WALLET_STATUS_SEED_SHOWING:
        /* show_seed_on_display() paints the actual word pages right after this
         * status is set — nothing generic to draw here. */
        break;
    case WALLET_STATUS_SEED_DONE:
        display_show_status("Seed Phrase", "Done", NULL);
        break;
    case WALLET_STATUS_SEED_REJECTED:
        display_show_status("Show Seed Phrase", "Rejected", "or timed out");
        break;
    case WALLET_STATUS_SEED_CHECKING:
        /* Painted by draw_seed_check(), like SEED_SHOWING. */
        break;
    case WALLET_STATUS_SEED_CHECKED:
        display_show_status("Seed Phrase", "Written down", "correctly");
        break;
    case WALLET_STATUS_SEED_CHECK_FAILED:
        display_show_status("Seed Phrase", "Check failed,", "view it again");
        break;
    case WALLET_STATUS_SEED_UNAVAILABLE:
        display_show_status("Seed Phrase", "Not available", "for this wallet");
        break;
    case WALLET_STATUS_PIN_SET_AWAITING_CONFIRM:
        display_show_status("Set PIN", "Press button", "to confirm");
        break;
    case WALLET_STATUS_PIN_SET_REJECTED:
        display_show_status("Set PIN", "Rejected", "or timed out");
        break;
    case WALLET_STATUS_PIN_CHANGE_AWAITING_CONFIRM:
        display_show_status("Change PIN", "Press button", "to confirm");
        break;
    case WALLET_STATUS_PIN_CHANGED:
        display_show_status("PIN", "Changed", NULL);
        break;
    case WALLET_STATUS_PIN_CHANGE_REJECTED:
        display_show_status("Change PIN", "Rejected", "or timed out");
        break;
    case WALLET_STATUS_WIPE_AWAITING_CONFIRM:
        /* Named as bluntly as it fits on the screen: this is the one
         * confirmation that destroys the key, so it must not read like the
         * routine ones above. */
        display_show_status("ERASE WALLET?", "Press button", "to confirm");
        break;
    case WALLET_STATUS_WIPED:
        display_show_status("Factory Reset", "Erased", NULL);
        break;
    case WALLET_STATUS_WIPE_REJECTED:
        display_show_status("Erase Wallet", "Rejected", "or timed out");
        break;
    case WALLET_STATUS_PROOF_AWAITING_CONFIRM:
        LOCK();
        if (s_pending == PENDING_PROOF) {
            draw_proof_page();
        }
        UNLOCK();
        break;
    case WALLET_STATUS_PROOF_SIGNED:
        display_show_status("Sign In", "Signed", NULL);
        break;
    case WALLET_STATUS_PROOF_REJECTED:
        display_show_status("Sign In", "Rejected", "or timed out");
        break;
    case WALLET_STATUS_PROOF_INVALID:
        display_show_status("Sign In", "Not understood,", "refused");
        break;
    case WALLET_STATUS_BUSY:
        display_show_status("Busy", "Finish the other", "request first");
        break;
    case WALLET_STATUS_ADDRESS_SHOWING:
        LOCK();
        if (s_pending == PENDING_SHOW_ADDRESS) {
            draw_own_address_page();
        }
        UNLOCK();
        break;
    case WALLET_STATUS_IDLE:
    default:
        display_show_status("Quick Wallet", "Ready", NULL);
        break;
    }

    /* Every status auto-clears back to the idle screen after a few seconds
     * — except the ones that describe an actual ongoing wait or a
     * standing state, where reverting early would be misleading (the
     * device is still waiting, or there's genuinely nothing else to show). */
    switch (status) {
    case WALLET_STATUS_IDLE:
    case WALLET_STATUS_NO_WALLET:
    case WALLET_STATUS_AWAITING_CONFIRM:
    case WALLET_STATUS_CREATE_AWAITING_CONFIRM:
    case WALLET_STATUS_SEED_AWAITING_CONFIRM:
    case WALLET_STATUS_SEED_SHOWING:
    case WALLET_STATUS_CREATE_GENERATING:
    case WALLET_STATUS_PIN_NOT_SET:
    case WALLET_STATUS_PIN_SET_AWAITING_CONFIRM:
    case WALLET_STATUS_PIN_CHANGE_AWAITING_CONFIRM:
    case WALLET_STATUS_WIPE_AWAITING_CONFIRM:
    case WALLET_STATUS_PROOF_AWAITING_CONFIRM:
    case WALLET_STATUS_ADDRESS_SHOWING:
    case WALLET_STATUS_SESSION_LOCKED:
        s_display_revert_pending = false;
        break;
    default:
        s_display_revert_pending = true;
        s_display_revert_at_us = esp_timer_get_time() + DISPLAY_REVERT_DELAY_US;
        s_display_revert_frame = display_frame_seq();
        break;
    }
}

void gatt_svc_set_status(enum wallet_status status)
{
    status_val = (uint8_t)status;
    show_status_on_display(status);
    if (g_conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        struct os_mbuf *om = ble_hs_mbuf_from_flat(&status_val, sizeof(status_val));
        if (om != NULL) {
            ble_gattc_notify_custom(g_conn_handle, status_chr_val_handle, om);
        }
    }
}

void gatt_svc_init(void)
{
    /* Before anything that can call back into this module: GATT access,
     * the confirm button and the timeout timer all start after this. */
    s_lock = xSemaphoreCreateMutex();
    assert(s_lock != NULL);

    ble_svc_gap_init();
    ble_svc_gatt_init();

    int rc = ble_gatts_count_cfg(gatt_svcs);
    assert(rc == 0);

    rc = ble_gatts_add_svcs(gatt_svcs);
    assert(rc == 0);

    ota_service_init();

    if (!pin_auth_is_set()) {
        status_val = WALLET_STATUS_PIN_NOT_SET;
    } else if (!wallet_key_exists()) {
        status_val = WALLET_STATUS_NO_WALLET;
    }
    /* Always paint the real state over main.c's generic "Starting..."
     * splash — otherwise a device that already has a wallet (the common
     * case after any reboot) shows a screen that never updates until the
     * first tx/PIN/OTA event happens. */
    show_status_on_display(status_val);

    const esp_timer_create_args_t timer_args = {
        .callback = timeout_check_cb,
        .name = "confirm_timeout",
    };
    esp_timer_handle_t timer;
    ESP_ERROR_CHECK(esp_timer_create(&timer_args, &timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(timer, 1 * 1000 * 1000));
}
