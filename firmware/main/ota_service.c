#include <string.h>
#include <stdio.h>
#include <stdbool.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_ota_ops.h"
#include "esp_app_desc.h"
#include "host/ble_hs.h"
#include "ota_service.h"
#include "gatt_svc.h"
#include "pin_auth.h"
#include "display.h"

static const char *TAG = "ota_service";

#define OTA_CONFIRM_TIMEOUT_US (30 * 1000 * 1000)
#define OTA_REBOOT_DELAY_US (800 * 1000)
/* esp_ota_end() verifies the Secure Boot RSA signature: several KB deep. */
#define OTA_FINISH_STACK 8192

static enum ota_status s_status = OTA_STATUS_IDLE;

/* Where an update is between the START write and the reboot. Anything but
 * IDLE means the confirm button belongs to this update, which is what
 * gatt_svc.c asks about through ota_service_in_progress() before arming a
 * wallet operation of its own.
 *
 * STARTING and FINISHING have states of their own because the flash work in
 * them takes seconds — esp_ota_begin() erases the whole 1.5MB slot,
 * esp_ota_end() reads and hashes the image — and during that time the update
 * is neither waiting for a press nor streaming. Without them the device would
 * look idle exactly then, and a signing request landing in that window would
 * arm itself and repaint the screen while the update carried on: the next
 * press would sign a transaction under a screen that says "Installing". */
enum ota_state {
    OTA_STATE_IDLE = 0,
    OTA_STATE_ARMED,     /* START written, waiting for the physical button */
    OTA_STATE_STARTING,  /* button pressed, esp_ota_begin() erasing the slot */
    OTA_STATE_STREAMING, /* handle open, image chunks accepted */
    OTA_STATE_FINISHING, /* END written, esp_ota_end() validating the image,
                          * or the second press switching to it */
    OTA_STATE_AWAITING_SWITCH, /* image validated, waiting for the second press */
};

/* Guards s_state, the arming timestamp, the target partition and the esp_ota
 * handle they describe. Three tasks touch them — the NimBLE host (GATT writes
 * and the disconnect callback), the confirm button task and the esp_timer
 * task (the confirm-window timeout) — and on the dual-core S3 they genuinely
 * run at the same time. Held only for the state transition itself: never
 * across esp_ota_begin/write/end or notify_status(), which are slow and take
 * locks of their own.
 *
 * Lock order: gatt_svc.c's lock first, then this one — arm_pending_locked()
 * calls ota_service_in_progress() under its own lock, and arming an update
 * runs under it too (gatt_svc_arm_if_idle), so the two sides can't both
 * claim the button. Anything here that needs gatt_svc_confirm_pending() must
 * ask before LOCK(), never under it. */
static SemaphoreHandle_t s_lock;
#define LOCK()   xSemaphoreTake(s_lock, portMAX_DELAY)
#define UNLOCK() xSemaphoreGive(s_lock)

static enum ota_state s_state = OTA_STATE_IDLE;
static int64_t s_armed_since_us;
static esp_ota_handle_t s_ota_handle;
/* Image bytes received so far through ota_data_at (see its UUID). */
static uint32_t s_received;
static const esp_partition_t *s_update_partition;
/* The version of the validated image, for the screen while it waits. */
static char s_incoming_version[sizeof(((esp_app_desc_t *)0)->version) + 1];

/* "1.2.3", optionally after a 'v' and before anything else (a "-dirty"
 * suffix). False for anything not starting like that. */
static bool parse_version(const char *s, unsigned v[3])
{
    if (*s == 'v') {
        s++;
    }
    for (int i = 0; i < 3; i++) {
        if (i > 0 && *s++ != '.') {
            return false;
        }
        if (*s < '0' || *s > '9') {
            return false;
        }
        unsigned n = 0;
        while (*s >= '0' && *s <= '9') {
            if (n > 99999) {
                return false;
            }
            n = n * 10 + (unsigned)(*s++ - '0');
        }
        v[i] = n;
    }
    return true;
}

/* An image may replace the running firmware only if it is not older. One
 * whose version can't be read is refused; a running version that can't be
 * read (a development build) lets anything signed through. */
static bool version_allowed(const char *running, const char *incoming)
{
    unsigned now[3], next[3];
    if (!parse_version(incoming, next)) {
        return false;
    }
    if (!parse_version(running, now)) {
        return true;
    }
    for (int i = 0; i < 3; i++) {
        if (next[i] != now[i]) {
            return next[i] > now[i];
        }
    }
    return true;
}

/* Both versions and what a press does. Takes the display lock itself. */
static void draw_switch_prompt(void)
{
    char line[48];
    display_lock();
    display_clear();
    display_draw_text_centered(0, "Install firmware?");
    snprintf(line, sizeof(line), "New: %s", s_incoming_version);
    display_draw_text_centered(3, line);
    snprintf(line, sizeof(line), "Now: %s", esp_app_get_description()->version);
    display_draw_text_centered(4, line);
    display_draw_text_centered(DISPLAY_ROWS - 1, "Press = install");
    display_flush();
    display_unlock();
}

static void show_status_on_display(enum ota_status status)
{
    switch (status) {
    case OTA_STATUS_AWAITING_CONFIRM:
        display_show_status("OTA Update", "Press button", "to confirm");
        break;
    case OTA_STATUS_PREPARING:
    case OTA_STATUS_IN_PROGRESS:
        display_show_status("OTA Update", "Installing...", NULL);
        break;
    case OTA_STATUS_SUCCESS:
        display_show_status("OTA Update", "Success,", "rebooting");
        break;
    case OTA_STATUS_ERROR:
        display_show_status("OTA Update", "Error", NULL);
        break;
    case OTA_STATUS_AWAITING_SWITCH:
        draw_switch_prompt();
        break;
    case OTA_STATUS_DOWNGRADE:
        display_show_status("OTA Update", "Older version,", "refused");
        break;
    case OTA_STATUS_IDLE:
    default:
        break; /* don't clobber whatever the wallet status screen was showing */
    }
}

static void notify_status(enum ota_status status)
{
    s_status = status;
    show_status_on_display(status);
    uint16_t val_handle = gatt_svc_ota_status_handle();
    if (g_conn_handle == BLE_HS_CONN_HANDLE_NONE || val_handle == 0) {
        return;
    }
    uint8_t val = (uint8_t)status;
    struct os_mbuf *om = ble_hs_mbuf_from_flat(&val, sizeof(val));
    if (om != NULL) {
        ble_gattc_notify_custom(g_conn_handle, val_handle, om);
    }
}

/* Drops whatever is in flight and goes back to IDLE; returns true if there
 * was anything to drop, so the caller knows whether to report it.
 *
 * The handle is taken out under the lock and closed outside it, so two
 * callers can never close the same one. A still-running esp_ota_begin() is
 * left alone on purpose: the button task owns that handle and closes what it
 * opened as soon as it sees the state has moved on (see
 * ota_service_on_confirm_button). FINISHING is left alone too — handle_end()
 * owns the handle by then and the device is on its way to rebooting. */
static bool abort_update(void)
{
    LOCK();
    enum ota_state was = s_state;
    esp_ota_handle_t handle = s_ota_handle;
    if (was == OTA_STATE_IDLE || was == OTA_STATE_FINISHING) {
        UNLOCK();
        return false;
    }
    s_state = OTA_STATE_IDLE;
    UNLOCK();

    if (was == OTA_STATE_STREAMING) {
        esp_ota_abort(handle);
    }
    return true;
}

void ota_service_on_disconnect(void)
{
    /* Without this, a central that drops mid-update (crash, out of range,
     * killed script) leaves the device stuck in AWAITING_CONFIRM/IN_PROGRESS
     * until a fresh connection sends ABORT or the confirm-window timer
     * happens to fire — meanwhile every OTA START from a new connection is
     * refused with BLE_ATT_ERR_UNLIKELY because the old state is still armed. */
    if (abort_update()) {
        ESP_LOGI(TAG, "central disconnected mid-OTA — resetting");
        notify_status(OTA_STATUS_IDLE);
    }
}

static void reboot_timer_cb(void *arg)
{
    ESP_LOGI(TAG, "rebooting into newly updated firmware");
    esp_restart();
}

/* Runs under gatt_svc.c's lock (see gatt_svc_arm_if_idle), so nothing on
 * the wallet side can claim the button between its check and this. */
static bool arm_locked(void *ctx)
{
    LOCK();
    bool armed = s_state == OTA_STATE_IDLE;
    if (armed) {
        s_state = OTA_STATE_ARMED;
        s_armed_since_us = esp_timer_get_time();
        s_update_partition = ctx;
    }
    UNLOCK();
    return armed;
}

static int handle_start(void)
{
    if (!pin_auth_session_unlocked()) {
        ESP_LOGW(TAG, "refusing OTA START — PIN not verified on this connection");
        return BLE_ATT_ERR_INSUFFICIENT_AUTHOR;
    }

    const esp_partition_t *partition = esp_ota_get_next_update_partition(NULL);
    if (partition == NULL) {
        ESP_LOGE(TAG, "no OTA update partition available");
        notify_status(OTA_STATUS_ERROR);
        return BLE_ATT_ERR_UNLIKELY;
    }

    if (!gatt_svc_arm_if_idle(arm_locked, (void *)partition)) {
        ESP_LOGW(TAG, "refusing OTA START — another confirmation is pending or OTA already armed");
        return BLE_ATT_ERR_UNLIKELY;
    }

    ESP_LOGI(TAG, "OTA armed, target partition \"%s\" — awaiting physical confirm", partition->label);
    notify_status(OTA_STATUS_AWAITING_CONFIRM);
    return 0;
}

/* Validates the received image: its signature (esp_ota_end), then its
 * version. On a task of its own because the Secure Boot RSA check needs far
 * more stack than the NimBLE host task has — run there, it overflowed it and
 * rebooted the board at the end of every update (firmware 1.3.0 and 1.4.0).
 * The state stays FINISHING throughout, so the handle is this task's alone. */
static void finish_task(void *arg)
{
    LOCK();
    esp_ota_handle_t handle = s_ota_handle;
    const esp_partition_t *partition = s_update_partition;
    UNLOCK();

    esp_err_t err = esp_ota_end(handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_end failed: %s", esp_err_to_name(err));
        LOCK();
        s_state = OTA_STATE_IDLE;
        UNLOCK();
        notify_status(OTA_STATUS_ERROR);
        vTaskDelete(NULL);
        return;
    }

    /* esp_ota_end() has checked the signature, so this is a release — but
     * not necessarily a newer one. */
    esp_app_desc_t incoming;
    err = esp_ota_get_partition_description(partition, &incoming);
    char version[sizeof(s_incoming_version)];
    if (err == ESP_OK) {
        memcpy(version, incoming.version, sizeof(incoming.version));
        version[sizeof(incoming.version)] = '\0';
    }
    if (err != ESP_OK || !version_allowed(esp_app_get_description()->version, version)) {
        ESP_LOGE(TAG, "refusing image version \"%s\" over \"%s\"", err == ESP_OK ? version : "?",
                 esp_app_get_description()->version);
        LOCK();
        s_state = OTA_STATE_IDLE;
        UNLOCK();
        notify_status(OTA_STATUS_DOWNGRADE);
        vTaskDelete(NULL);
        return;
    }

    LOCK();
    memcpy(s_incoming_version, version, sizeof(s_incoming_version));
    s_state = OTA_STATE_AWAITING_SWITCH;
    s_armed_since_us = esp_timer_get_time();
    UNLOCK();
    ESP_LOGI(TAG, "OTA image %s validated — awaiting second press to switch", version);
    notify_status(OTA_STATUS_AWAITING_SWITCH);
    vTaskDelete(NULL);
}

static int handle_end(void)
{
    /* Taken out of the shared state in one step: from here on the handle
     * belongs to finish_task, and the state still says an update is in
     * flight so the button can't be claimed by anything else while the image
     * is being validated. */
    LOCK();
    bool streaming = s_state == OTA_STATE_STREAMING;
    if (streaming) {
        s_state = OTA_STATE_FINISHING;
    }
    esp_ota_handle_t handle = s_ota_handle;
    UNLOCK();
    if (!streaming) {
        ESP_LOGW(TAG, "END with no OTA in progress");
        return BLE_ATT_ERR_UNLIKELY;
    }

    /* Low priority: hashing the image takes a while, and the idle task must
     * keep running for the task watchdog. */
    if (xTaskCreate(finish_task, "ota_finish", OTA_FINISH_STACK, NULL, tskIDLE_PRIORITY + 1, NULL) != pdPASS) {
        ESP_LOGE(TAG, "no memory for the OTA finish task");
        esp_ota_abort(handle);
        LOCK();
        s_state = OTA_STATE_IDLE;
        UNLOCK();
        notify_status(OTA_STATUS_ERROR);
        return BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    return 0;
}

/* Runs on the button task once the second press has been accepted, with the
 * state at FINISHING so nothing else can claim the button meanwhile. */
static void switch_and_reboot(const esp_partition_t *partition)
{
    esp_err_t err = esp_ota_set_boot_partition(partition);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_set_boot_partition failed: %s", esp_err_to_name(err));
        LOCK();
        s_state = OTA_STATE_IDLE;
        UNLOCK();
        notify_status(OTA_STATUS_ERROR);
        return;
    }

    ESP_LOGI(TAG, "boot partition set — rebooting shortly");
    notify_status(OTA_STATUS_SUCCESS);

    const esp_timer_create_args_t timer_args = {
        .callback = reboot_timer_cb,
        .name = "ota_reboot",
    };
    esp_timer_handle_t timer;
    if (esp_timer_create(&timer_args, &timer) == ESP_OK) {
        esp_timer_start_once(timer, OTA_REBOOT_DELAY_US);
    } else {
        esp_restart();
    }
}

int ota_control_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                           struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    if (OS_MBUF_PKTLEN(ctxt->om) != 1) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    uint8_t cmd;
    uint16_t copied;
    if (ble_hs_mbuf_to_flat(ctxt->om, &cmd, sizeof(cmd), &copied) != 0) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    /* Every command, not just START: otherwise any bonded central that
     * never proved the PIN could abort an update in flight, or finalize
     * one and set the boot partition. */
    if (!pin_auth_session_unlocked()) {
        ESP_LOGW(TAG, "refusing OTA command 0x%02x — PIN not verified on this connection", cmd);
        return BLE_ATT_ERR_INSUFFICIENT_AUTHOR;
    }

    switch (cmd) {
    case OTA_CMD_START:
        return handle_start();
    case OTA_CMD_END:
        return handle_end();
    case OTA_CMD_ABORT:
        if (abort_update()) {
            ESP_LOGI(TAG, "OTA aborted by central");
            notify_status(OTA_STATUS_IDLE);
        }
        return 0;
    default:
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
}

/* See GATT_CHR_OTA_DATA_AT_UUID. */
int ota_data_at_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                          struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    /* Same gate as every OTA command: an update left open by a central that
     * disconnected mid-flight must not be writable by the next one just
     * because the state is still STREAMING. */
    if (!pin_auth_session_unlocked()) {
        ESP_LOGW(TAG, "refusing OTA data — PIN not verified on this connection");
        return BLE_ATT_ERR_INSUFFICIENT_AUTHOR;
    }

    LOCK();
    bool streaming = s_state == OTA_STATE_STREAMING;
    esp_ota_handle_t handle = s_ota_handle;
    uint32_t expected = s_received;
    UNLOCK();
    if (!streaming) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    static uint8_t buf[4 + 512];
    uint16_t copied;
    if (len <= 4 || len > sizeof(buf) || ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &copied) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    uint32_t offset = ((uint32_t)buf[0] << 24) | ((uint32_t)buf[1] << 16) | ((uint32_t)buf[2] << 8) | buf[3];
    if (offset != expected) {
        ESP_LOGE(TAG, "OTA data at %" PRIu32 ", expected %" PRIu32 " — a write went missing", offset, expected);
        abort_update();
        notify_status(OTA_STATUS_ERROR);
        return BLE_ATT_ERR_INVALID_OFFSET;
    }

    /* Written outside the lock, which is safe because every writer of the
     * handle and of s_received is this same NimBLE host task: a concurrent
     * ABORT or disconnect can only run before this call or after it, never
     * during. */
    esp_err_t err = esp_ota_write(handle, buf + 4, copied - 4);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_write failed: %s", esp_err_to_name(err));
        abort_update();
        notify_status(OTA_STATUS_ERROR);
        return BLE_ATT_ERR_UNLIKELY;
    }
    s_received = expected + (copied - 4u);
    return 0;
}

int ota_status_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                          struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_READ_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    uint8_t val = (uint8_t)s_status;
    int rc = os_mbuf_append(ctxt->om, &val, sizeof(val));
    return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

void ota_service_on_confirm_button(void *arg)
{
    (void)arg;

    /* Asked before LOCK(), never under it — see the lock-order note above.
     * By the time a press reaches this task, gatt_svc.c has already handled
     * it (main.c calls it first), so anything pending on the wallet side
     * means that press was already spent there: most often the seed phrase
     * being paged through, where a press means "next page". */
    bool wallet_owns_press = gatt_svc_confirm_pending();

    LOCK();
    enum ota_state state = s_state;
    bool expired = esp_timer_get_time() - s_armed_since_us > OTA_CONFIRM_TIMEOUT_US;
    const esp_partition_t *partition = s_update_partition;
    bool start = false;
    bool go = false;
    if (state == OTA_STATE_AWAITING_SWITCH) {
        go = !expired && !wallet_owns_press && g_conn_handle != BLE_HS_CONN_HANDLE_NONE;
        s_state = go ? OTA_STATE_FINISHING : OTA_STATE_IDLE;
    }
    if (state == OTA_STATE_ARMED) {
        /* Either way this update stops being armed here: it is going ahead
         * under this press, or it is dropped. Nothing is left for a later
         * press to complete. */
        start = !expired && !wallet_owns_press && g_conn_handle != BLE_HS_CONN_HANDLE_NONE;
        s_state = start ? OTA_STATE_STARTING : OTA_STATE_IDLE;
    }
    UNLOCK();

    if (state == OTA_STATE_AWAITING_SWITCH) {
        if (go) {
            switch_and_reboot(partition);
        } else {
            ESP_LOGW(TAG, "second press too late, or after disconnect — update dropped");
            notify_status(OTA_STATUS_IDLE);
        }
        return;
    }
    if (state != OTA_STATE_ARMED) {
        return;
    }
    if (!start) {
        if (expired) {
            ESP_LOGW(TAG, "confirm button pressed after OTA timeout — dropped");
            notify_status(OTA_STATUS_IDLE);
        } else if (wallet_owns_press) {
            ESP_LOGW(TAG, "confirm button belonged to a wallet operation — OTA dropped");
            notify_status(OTA_STATUS_IDLE);
        } else {
            /* Central disconnected between arming OTA and this (delayed,
             * queue-based) button event — ota_service_on_disconnect() has
             * normally reset the state already, so starting the update now
             * would arm it with nobody to stream data. */
            ESP_LOGW(TAG, "confirm button pressed after disconnect — dropped");
        }
        return;
    }

    /* Erases the whole slot, so it runs for seconds — outside the lock, with
     * the state left at STARTING so nothing else can claim the button
     * meanwhile. PREPARING first, so the press is answered right away rather
     * than after the erase. */
    notify_status(OTA_STATUS_PREPARING);
    esp_ota_handle_t handle;
    esp_err_t err = esp_ota_begin(partition, OTA_SIZE_UNKNOWN, &handle);

    /* Whatever happened while the slot was being erased decides this: an
     * ABORT or a disconnect will have moved the state off STARTING, and then
     * the handle just opened is closed right here rather than left behind for
     * the next central to write into. */
    LOCK();
    bool keep = err == ESP_OK && s_state == OTA_STATE_STARTING
                && g_conn_handle != BLE_HS_CONN_HANDLE_NONE;
    if (keep) {
        s_ota_handle = handle;
        s_received = 0;
        s_state = OTA_STATE_STREAMING;
    } else if (s_state == OTA_STATE_STARTING) {
        s_state = OTA_STATE_IDLE;
    }
    UNLOCK();

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_begin failed: %s", esp_err_to_name(err));
        notify_status(OTA_STATUS_ERROR);
        return;
    }
    if (!keep) {
        ESP_LOGW(TAG, "OTA cancelled while the slot was being erased — dropped");
        esp_ota_abort(handle);
        notify_status(OTA_STATUS_IDLE);
        return;
    }

    ESP_LOGI(TAG, "OTA confirmed — streaming to \"%s\"", partition->label);
    notify_status(OTA_STATUS_IN_PROGRESS);
}

static void timeout_check_cb(void *arg)
{
    /* Only a wait for a press times out — the first one or the second: once
     * the button has been pressed the update is running, and how long the
     * flash work or the transfer takes is not the owner's decision to make
     * again. */
    LOCK();
    bool dropped = (s_state == OTA_STATE_ARMED || s_state == OTA_STATE_AWAITING_SWITCH)
                   && esp_timer_get_time() - s_armed_since_us > OTA_CONFIRM_TIMEOUT_US;
    if (dropped) {
        s_state = OTA_STATE_IDLE;
    }
    UNLOCK();

    if (dropped) {
        ESP_LOGW(TAG, "OTA confirm window expired");
        notify_status(OTA_STATUS_IDLE);
    }
}

bool ota_service_in_progress(void)
{
    LOCK();
    bool busy = s_state != OTA_STATE_IDLE;
    UNLOCK();
    return busy;
}

void ota_service_init(void)
{
    /* Before the timer below and before any GATT access can reach this
     * module: both take the lock. */
    s_lock = xSemaphoreCreateMutex();
    assert(s_lock != NULL);

    const esp_timer_create_args_t timer_args = {
        .callback = timeout_check_cb,
        .name = "ota_confirm_timeout",
    };
    esp_timer_handle_t timer;
    ESP_ERROR_CHECK(esp_timer_create(&timer_args, &timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(timer, 1 * 1000 * 1000));
}
