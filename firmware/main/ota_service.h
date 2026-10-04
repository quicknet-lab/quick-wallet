#pragma once

#include <stdbool.h>
#include "host/ble_hs.h"

/* Same base UUID family as gatt_svc.h, 0x10-0x13 range to keep OTA
 * characteristics visually/namespace-separate from the wallet ones. 0x11
 * was the first image characteristic, plain chunks with response each; it
 * is gone and its UUID is not reused. */
#define GATT_CHR_OTA_CONTROL_UUID \
    BLE_UUID128_DECLARE(0x10, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

#define GATT_CHR_OTA_STATUS_UUID \
    BLE_UUID128_DECLARE(0x12, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

/* The image: [offset: u32 BE][next bytes of the image], written mostly
 * without response. The offset must be exactly the
 * number of image bytes received so far in this update; any other one —
 * a write lost or reordered on the way — aborts the update at once
 * (OTA_STATUS_ERROR) instead of leaving a gap that would only show at END.
 * The client still writes every few chunks with response, which can only
 * be answered once everything before it has been processed, so it never
 * gets far ahead of the flash writes. END checks the image's hash and
 * signature. */
#define GATT_CHR_OTA_DATA_AT_UUID \
    BLE_UUID128_DECLARE(0x13, 0x7c, 0x2b, 0x6a, 0x4f, 0x9a, 0x1a, 0x9a, \
                         0x9e, 0x4c, 0xa1, 0x0b, 0x00, 0xee, 0xff, 0xc0)

/* Commands written to the ota_control characteristic. */
enum ota_control_cmd {
    OTA_CMD_START = 1, /* arm: waits for physical confirm button */
    OTA_CMD_END = 2,   /* finalize: validate image, check its version, wait for a
                        * second press, then set boot partition and reboot */
    OTA_CMD_ABORT = 3, /* cancel an in-progress update */
};

enum ota_status {
    OTA_STATUS_IDLE = 0,
    OTA_STATUS_AWAITING_CONFIRM = 1, /* START written, waiting for button */
    OTA_STATUS_IN_PROGRESS = 2,      /* button pressed, streaming chunks */
    OTA_STATUS_SUCCESS = 3,          /* END validated, rebooting shortly */
    OTA_STATUS_ERROR = 4,
    /* Button pressed, the target slot is being erased (~6.5s) before
     * IN_PROGRESS; data written now is refused. Sent so the screen and the
     * app say the update has started the moment the press lands. */
    OTA_STATUS_PREPARING = 5,
    /* END validated the image and its version is not older than the running
     * one: both versions are on screen, and a second press within the
     * confirm window switches to it (SUCCESS). Left alone, the window runs
     * out and the update is dropped (IDLE); the old firmware keeps running. */
    OTA_STATUS_AWAITING_SWITCH = 6,
    /* END refused the image: its version is older than the running one, or
     * not a version at all. Any old signed release would otherwise install
     * as readily as a new one, with every hole it had. */
    OTA_STATUS_DOWNGRADE = 7,
};

void ota_service_init(void);

/* GATT access callbacks — wired into gatt_svc.c's characteristic table. */
int ota_control_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                           struct ble_gatt_access_ctxt *ctxt, void *arg);
int ota_data_at_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                          struct ble_gatt_access_ctxt *ctxt, void *arg);
int ota_status_access_cb(uint16_t conn_handle, uint16_t attr_handle,
                          struct ble_gatt_access_ctxt *ctxt, void *arg);

/* Called from the confirm button's task (arg unused). No-op unless an OTA
 * START is currently awaiting confirmation. */
void ota_service_on_confirm_button(void *arg);

/* Called on BLE disconnect. No-op unless an OTA was armed/in-progress on
 * this connection — resets it to IDLE so a stale state doesn't block the
 * next connection's OTA attempts. */
void ota_service_on_disconnect(void);

bool ota_service_in_progress(void);
