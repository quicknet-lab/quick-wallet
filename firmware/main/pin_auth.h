#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* 6 characters at the least: with the PIN sealing the key (wallet_seal.h),
 * its length is what an attacker who can rewind the failure counter has to
 * get through, one on-chip attempt at a time. */
#define PIN_AUTH_MIN_LEN 6
#define PIN_AUTH_MAX_LEN 10

typedef enum {
    PIN_AUTH_OK = 0,
    PIN_AUTH_ALREADY_SET,  /* set: a PIN already exists, this device only takes one */
    PIN_AUTH_BAD_LEN,      /* PIN shorter than PIN_AUTH_MIN_LEN or longer than PIN_AUTH_MAX_LEN */
    PIN_AUTH_WRONG,        /* verify: the PIN doesn't open the sealed wallet */
    PIN_AUTH_LOCKED,       /* verify: too many recent failures, still in backoff window */
    PIN_AUTH_FAILED,       /* storage or hardware error */
} pin_auth_result_t;

/* The PIN itself lives nowhere: it is checked by unsealing the wallet
 * (wallet_key.c). This module keeps what goes around that — lengths, the
 * persisted failure counter with its lockout, and the per-connection
 * session. Call after wallet_key_init(). */
void pin_auth_init(void);

bool pin_auth_is_set(void);

/* One-shot: only succeeds while no PIN exists yet — the first step on a
 * blank device, before a wallet can be created. Use pin_auth_change() to
 * replace an existing one. On success, unlocks the current session too. */
pin_auth_result_t pin_auth_set(const uint8_t *pin, size_t len);

/* Replaces an existing PIN, resealing the wallet under it. Deliberately takes
 * only the new PIN: the caller is responsible for having proven the current
 * one (an unlocked session) and for confirming with the physical button —
 * see GATT_PIN_OP_CHANGE. Clears the failure counter. */
pin_auth_result_t pin_auth_change(const uint8_t *pin, size_t len);

/* Factory reset: erases the failure counter and drops back to the "no PIN
 * configured" state. The sealed wallet goes with wallet_key_wipe(). Callers
 * must gate this behind the same PIN + physical button proof used for
 * signing (see GATT_CREATE_WALLET_OP_WIPE) — nothing here checks. */
void pin_auth_wipe(void);

/* On PIN_AUTH_OK, unlocks the current session and the wallet with it.
 * Failures increment a persisted counter that backs an escalating lockout
 * window, so guessing stays slow even across reboots/power loss. */
pin_auth_result_t pin_auth_verify(const uint8_t *pin, size_t len);

/* An unlocked session left unused this long locks itself (see
 * pin_auth_session_expire_idle()), so a browser tab left open doesn't keep
 * the device unlocked indefinitely. */
#define PIN_AUTH_SESSION_IDLE_US (5LL * 60 * 1000 * 1000)

/* True once pin_auth_verify() or pin_auth_set() has succeeded on the current
 * BLE connection. Reset by pin_auth_session_reset() on every disconnect,
 * which also locks the wallet, so a PIN must be re-entered for each new
 * connection. Every gated operation asks this first, so a true answer also
 * counts as use of the session and restarts its idle time. */
bool pin_auth_session_unlocked(void);
void pin_auth_session_reset(void);

/* Restarts the idle time without a request — for while an operation is
 * underway (waiting for the button, an OTA in flight), which is use too. */
void pin_auth_session_touch(void);

/* Locks the session if it has gone unused for PIN_AUTH_SESSION_IDLE_US;
 * true if it just did. Polled by gatt_svc.c's timer, which first makes sure
 * nothing is underway. */
bool pin_auth_session_expire_idle(void);
