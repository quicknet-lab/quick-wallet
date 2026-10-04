#include <string.h>
#include <stdio.h>
#include <inttypes.h>
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_nimble_hci.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "esp_ota_ops.h"
#include "esp_flash_encrypt.h"
#include "esp_secure_boot.h"
#include "gatt_svc.h"
#include "wallet_key.h"
#include "confirm_button.h"
#include "ota_service.h"
#include "pin_auth.h"
#include "display.h"

/* Registers the NimBLE bond-store callbacks; backed by NVS when
 * CONFIG_BT_NIMBLE_NVS_PERSIST=y (see config/esp32s3.conf), so bonds survive
 * a reboot. Declared here because ESP-IDF's NimBLE component provides the
 * definition but no public header for it. */
extern void ble_store_config_init(void);

/* LilyGO T-Display-S3: two momentary buttons to GND next to the USB-C
 * port. The lower one (GPIO14) is the confirm button — it does nothing
 * else on this board. The other one is BOOT (GPIO0), a strapping pin the
 * bootloader samples at reset to enter USB download mode; leaving it to
 * that job keeps flashing the board and confirming a transfer from ever
 * being the same press. Almost every other free-looking pin on this board
 * is spoken for by the LCD's 8-bit bus (GPIO39-42, 45-48) or its control
 * lines. */
#define CONFIRM_BUTTON_GPIO GPIO_NUM_14

static const char *TAG = "quick_wallet";
static const char *DEVICE_NAME = "QuickWallet";

/* Repeat-pairing confirm window: BLE_GAP_EVENT_REPEAT_PAIRING must answer
 * synchronously (no "wait for the button, then decide" — NimBLE doesn't
 * support deferring this particular decision), so the attempt that
 * triggered it is always rejected. A button press within this window
 * instead removes the stale bond for next time — the central then simply
 * retries pairing (phones/laptops normally do this automatically or the
 * user re-taps connect), and since the old bond is gone by then, that
 * retry is a normal first-time pairing, not another repeat-pairing event. */
#define REPEAT_PAIRING_CONFIRM_TIMEOUT_US (30 * 1000 * 1000)

/* How long after boot the logo splash stays up at least (display.c). */
#define SPLASH_MIN_US (1500 * 1000)
static bool s_repeat_pairing_pending;
static int64_t s_repeat_pairing_pending_since_us;
static ble_addr_t s_repeat_pairing_peer_addr;

/* Returns whether advertising is running. */
static bool ble_advertise(void)
{
    struct ble_gap_adv_params adv_params;
    struct ble_hs_adv_fields fields;
    int rc;

    memset(&fields, 0, sizeof(fields));
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = (uint8_t *)DEVICE_NAME;
    fields.name_len = strlen(DEVICE_NAME);
    fields.name_is_complete = 1;

    rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "failed to set adv fields, rc=%d", rc);
        return false;
    }

    memset(&adv_params, 0, sizeof(adv_params));
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;

    extern int gap_event_cb(struct ble_gap_event *event, void *arg);
    rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, NULL, BLE_HS_FOREVER,
                            &adv_params, gap_event_cb, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "failed to start advertising, rc=%d", rc);
        return false;
    }
    return true;
}

/* Asks the central for a short connection interval. Nobody asked before,
 * so the link ran at whatever the phone or computer picked (often 30-50ms),
 * and every with-response write — ~2800 of them in an OTA image — waits at
 * least one interval. 15-30ms rather than 7.5ms: Apple's accessory
 * guidelines require a minimum of at least 15ms and a maximum at least 15ms
 * above it, and macOS/iOS refuse a request outside that. A refusal only
 * leaves the central's own choice in place. */
static void request_fast_interval(uint16_t conn_handle)
{
    const struct ble_gap_upd_params params = {
        .itvl_min = 12,             /* x1.25ms = 15ms */
        .itvl_max = 24,             /* x1.25ms = 30ms */
        .latency = 0,
        .supervision_timeout = 400, /* x10ms = 4s */
        .min_ce_len = 0,
        .max_ce_len = 0,
    };
    int rc = ble_gap_update_params(conn_handle, &params);
    if (rc != 0) {
        ESP_LOGW(TAG, "connection parameter update request failed, rc=%d", rc);
    }
}

int gap_event_cb(struct ble_gap_event *event, void *arg)
{
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        ESP_LOGI(TAG, "connection %s; status=%d",
                 event->connect.status == 0 ? "established" : "failed",
                 event->connect.status);
        if (event->connect.status == 0) {
            g_conn_handle = event->connect.conn_handle;
            request_fast_interval(event->connect.conn_handle);
        } else {
            ble_advertise();
        }
        return 0;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "disconnected, reason=%d", event->disconnect.reason);
        g_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        pin_auth_session_reset();
        gatt_svc_on_disconnect();
        ota_service_on_disconnect();
        ble_advertise();
        return 0;

    case BLE_GAP_EVENT_ADV_COMPLETE:
        ble_advertise();
        return 0;

    case BLE_GAP_EVENT_CONN_UPDATE: {
        /* Logged so the interval actually agreed on can be read off
         * `idf.py monitor` when measuring OTA speed. */
        struct ble_gap_conn_desc desc;
        if (ble_gap_conn_find(event->conn_update.conn_handle, &desc) == 0) {
            ESP_LOGI(TAG, "connection updated; status=%d interval=%u.%02ums latency=%u timeout=%ums",
                     event->conn_update.status, desc.conn_itvl * 125 / 100, desc.conn_itvl * 125 % 100,
                     desc.conn_latency, desc.supervision_timeout * 10);
        }
        return 0;
    }

    case BLE_GAP_EVENT_ENC_CHANGE:
        /* Link either got encrypted (status==0, after pairing/bonding) or
         * failed to. Characteristics flagged _ENC/_AUTHEN refuse access
         * until this fires successfully. */
        ESP_LOGI(TAG, "encryption change; status=%d", event->enc_change.status);
        return 0;

    case BLE_GAP_EVENT_PASSKEY_ACTION:
        if (event->passkey.params.action == BLE_SM_IOACT_DISP) {
            /* NimBLE passkeys are always exactly 6 digits, 000000-999999.
             * Rejection sampling rather than a bare % 1000000: 4,294,000,000
             * is the largest multiple of 10^6 below 2^32, so drawing below
             * it makes every code exactly equally likely. */
            uint32_t passkey;
            do {
                passkey = esp_random();
            } while (passkey >= 4294000000u);
            passkey %= 1000000;

            char line[32];
            snprintf(line, sizeof(line), "%06" PRIu32, passkey);
            display_show_status("Pairing Code", line, "Enter on phone");
            ESP_LOGI(TAG, "displaying pairing passkey");

            struct ble_sm_io io = {
                .action = BLE_SM_IOACT_DISP,
                .passkey = passkey,
            };
            int rc = ble_sm_inject_io(event->passkey.conn_handle, &io);
            if (rc != 0) {
                ESP_LOGE(TAG, "ble_sm_inject_io failed, rc=%d", rc);
            }
        }
        return 0;

    case BLE_GAP_EVENT_REPEAT_PAIRING: {
        /* Central already holds a bond for this identity (e.g. this
         * device's flash was erased/reflashed, or the central lost its
         * copy) but is attempting to pair again. This device can hold
         * bonds for several of the owner's own devices at once
         * (CONFIG_BT_NIMBLE_MAX_BONDS=3 — phone + laptop + one more), so
         * this isn't about a single fixed owner device; it's about not
         * letting an address that merely CLAIMS to already be bonded
         * silently evict a real bond without proof someone is physically
         * at the device. See on_confirm_button() for how the button
         * gates the actual bond removal. */
        struct ble_gap_conn_desc desc;
        int rc = ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc);
        assert(rc == 0);

        s_repeat_pairing_pending = true;
        s_repeat_pairing_pending_since_us = esp_timer_get_time();
        s_repeat_pairing_peer_addr = desc.peer_id_addr;
        ESP_LOGW(TAG, "repeat pairing attempt — press the confirm button within 30s to allow it");
        display_show_status("Re-pair Attempt", "Press button", "to allow (30s)");
        return BLE_GAP_REPEAT_PAIRING_IGNORE;
    }

    default:
        return 0;
    }
}

static void on_sync(void)
{
    int rc = ble_hs_util_ensure_addr(0);
    assert(rc == 0);

    /* A bonded central keeps the GATT table it discovered once and goes on
     * using those handles; after an update that changes the table it then
     * talks to the wrong characteristics ("GATT operation failed", seen after
     * the update to 1.3.0). Service Changed tells it to discover again.
     * NimBLE keeps the pending indication per bonded peer in the bond store,
     * but the handle range only in RAM, so it is raised on every start
     * rather than only after an update: one rediscovery on the first
     * connection after a power-up is the whole cost. */
    ble_svc_gatt_changed(0x0001, 0xffff);

    if (!ble_advertise()) {
        return;
    }

    /* Rollback safety net (CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE): an OTA
     * image counts as good only once the board is actually reachable over
     * BLE — once flash encryption is in release mode, OTA over BLE is the
     * only way to update it, so an image that boots but never advertises
     * must be left unconfirmed for the bootloader to revert on the next
     * reset. A no-op on every boot but the first after an update. */
    esp_ota_mark_app_valid_cancel_rollback();

#if CONFIG_SECURE_FLASH_ENC_ENABLED
    /* The secure build's bootloader leaves flash encryption in Development
     * mode, with the USB download path able to write and read the flash.
     * Close it for good here, at the same point the image is accepted: on a
     * factory-fresh board right after the first start burned Secure Boot and
     * Flash Encryption, on an older board right after the OTA update to this
     * version. Release mode also switches the ROM to Secure Download mode.
     * From then on OTA over BLE is the only way in. A no-op once done. */
    if (esp_secure_boot_enabled() && esp_get_flash_encryption_mode() == ESP_FLASH_ENC_MODE_DEVELOPMENT) {
        ESP_LOGW(TAG, "switching flash encryption to Release mode — USB flashing closes for good");
        esp_flash_encryption_set_release_mode();
        ESP_LOGW(TAG, "flash encryption is in Release mode; eFuse checklist %s",
                 esp_flash_encryption_cfg_verify_release_mode() ? "complete" : "has warnings (see above)");
    }
#endif
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "nimble host reset, reason=%d", reason);
}

/* A single physical button serves three independent confirm flows (tx
 * signing, OTA start, repeat-pairing bond removal) — each callee no-ops
 * unless it has something of its own awaiting confirmation, so a stray
 * press only ever does one thing.
 *
 * A press means whatever the screen is asking about right now. Anything
 * armed by an authenticated, PIN-unlocked central (a signature, an OTA)
 * repaints the screen and therefore owns the press — and supersedes a
 * pending repeat-pairing request, which is dropped. Otherwise someone in
 * radio range could trigger repeat-pairing, walk away, and have the
 * owner's next press (meant for a transfer) swallowed — or, with a spoofed
 * identity address, turned into deleting the owner's real bond. A request
 * whose 30s window has passed doesn't take the press either.
 *
 * Deliberately *not* cleared on disconnect: after IGNORE many centrals drop
 * the link at once, and the owner re-pairing their own phone still needs
 * the press to count after that. */
static void on_confirm_button(bool long_press, void *arg)
{
    bool repeat_pending = s_repeat_pairing_pending;
    s_repeat_pairing_pending = false;
    if (repeat_pending && !gatt_svc_confirm_pending() && !ota_service_in_progress()) {
        if (esp_timer_get_time() - s_repeat_pairing_pending_since_us <= REPEAT_PAIRING_CONFIRM_TIMEOUT_US) {
            ble_store_util_delete_peer(&s_repeat_pairing_peer_addr);
            ESP_LOGI(TAG, "repeat-pairing confirmed — stale bond removed, central may re-pair now");
            display_show_status("Re-pair", "Allowed,", "pair again");
            return;
        }
        ESP_LOGW(TAG, "repeat-pairing window expired — press handled as an ordinary one");
    } else if (repeat_pending) {
        ESP_LOGW(TAG, "repeat-pairing request superseded by an armed operation — dropped");
    }

    gatt_svc_on_confirm_button(long_press);
    ota_service_on_confirm_button(arg);
}

static void nimble_host_task(void *param)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void app_main(void)
{
    /* Best-effort: a dead/missing display shouldn't stop the wallet from
     * booting, so log and carry on rather than ESP_ERROR_CHECK() here. */
    if (display_init() == ESP_OK) {
        display_show_splash();
    } else {
        ESP_LOGW(TAG, "display init failed — continuing without it");
    }

    ESP_ERROR_CHECK(wallet_key_init());
    pin_auth_init();

    ESP_ERROR_CHECK(nimble_port_init());

    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;

    /* Bonding + LE Secure Connections encryption: without this the link is
     * fully open and anyone in radio range can passively read everything
     * (signing hashes, and soon PIN/seed traffic) off the air.
     *
     * IO cap: pairing shows a random 6-digit passkey on the display
     * (BLE_GAP_EVENT_PASSKEY_ACTION above) that the user enters on the
     * phone/laptop's own pairing prompt — this is "Passkey Entry", which
     * also defeats an active MITM during the very first pairing, not just
     * passive eavesdropping. It depends on the screen being there, which is
     * one reason this firmware targets one board rather than a family. */
    ble_hs_cfg.sm_io_cap = BLE_HS_IO_DISPLAY_ONLY;
    ble_hs_cfg.sm_mitm = 1;
    ble_hs_cfg.sm_bonding = 1;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_store_config_init();

    /* gatt_svc_init() paints the device state over the splash; keep the
     * splash up long enough to be seen, counting the time the setup above
     * already took. */
    int64_t splash_left_us = SPLASH_MIN_US - esp_timer_get_time();
    if (splash_left_us > 0) {
        vTaskDelay(pdMS_TO_TICKS(splash_left_us / 1000));
    }

    gatt_svc_init();
    ble_svc_gap_device_name_set(DEVICE_NAME);

    confirm_button_init(CONFIRM_BUTTON_GPIO, on_confirm_button, NULL);

    nimble_port_freertos_init(nimble_host_task);

    ESP_LOGI(TAG, "Quick Wallet up, advertising as \"%s\"", DEVICE_NAME);
}
