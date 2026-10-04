#include "freertos/FreeRTOS.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs.h"
#include "wallet_key.h"
#include "pin_auth.h"

static const char *TAG = "pin_auth";

#define NVS_NAMESPACE "auth"
#define NVS_KEY_FAILS "pin_fails"

/* First few wrong attempts are free (typos happen); after that each
 * additional failure roughly doubles the wait, capped at an hour. Counted
 * from device boot time, not wall-clock — the ESP32 here has no
 * battery-backed RTC, so "wait N minutes" can only be enforced relative to
 * uptime. A reboot doesn't let an attacker skip the wait: the delay is
 * still measured out in real seconds before another attempt is accepted. */
#define LOCKOUT_FREE_ATTEMPTS 3
#define LOCKOUT_BASE_SEC 2
#define LOCKOUT_MAX_SEC (60 * 60)

static nvs_handle_t s_nvs;
static uint32_t s_fail_count;
static int64_t s_earliest_allowed_us;
static bool s_session_unlocked;
/* Last use of the unlocked session, for pin_auth_session_expire_idle().
 * Written from the BLE host task, read from the timer task: 64 bits are two
 * stores on this CPU, so both go through the spinlock. */
static int64_t s_session_used_us;
static portMUX_TYPE s_used_mux = portMUX_INITIALIZER_UNLOCKED;

static int64_t lockout_delay_us(uint32_t fail_count)
{
    if (fail_count <= LOCKOUT_FREE_ATTEMPTS) {
        return 0;
    }
    uint32_t shift = fail_count - LOCKOUT_FREE_ATTEMPTS;
    if (shift > 20) {
        shift = 20; /* avoid UB from an oversized shift; MAX_SEC caps it anyway */
    }
    int64_t delay_sec = (int64_t)LOCKOUT_BASE_SEC << shift;
    if (delay_sec > LOCKOUT_MAX_SEC) {
        delay_sec = LOCKOUT_MAX_SEC;
    }
    return delay_sec * 1000000LL;
}

void pin_auth_session_touch(void)
{
    int64_t now = esp_timer_get_time();
    portENTER_CRITICAL(&s_used_mux);
    s_session_used_us = now;
    portEXIT_CRITICAL(&s_used_mux);
}

static void unlock_session(void)
{
    pin_auth_session_touch();
    s_session_unlocked = true;
}

static void persist_fail_count(uint32_t fail_count)
{
    s_fail_count = fail_count;
    ESP_ERROR_CHECK(nvs_set_u32(s_nvs, NVS_KEY_FAILS, fail_count));
    ESP_ERROR_CHECK(nvs_commit(s_nvs));
}

void pin_auth_init(void)
{
    ESP_ERROR_CHECK(nvs_open(NVS_NAMESPACE, NVS_READWRITE, &s_nvs));

    uint32_t fails = 0;
    nvs_get_u32(s_nvs, NVS_KEY_FAILS, &fails); /* defaults to 0 if not found */
    s_fail_count = fails;
    s_earliest_allowed_us = lockout_delay_us(fails);

    /* Nothing to gate if no PIN has been configured yet. */
    s_session_unlocked = !pin_auth_is_set();

    ESP_LOGI(TAG, "pin_set=%d fail_count=%u", pin_auth_is_set(), (unsigned)s_fail_count);
}

bool pin_auth_is_set(void)
{
    return wallet_key_pin_set();
}

static bool len_ok(size_t len)
{
    return len >= PIN_AUTH_MIN_LEN && len <= PIN_AUTH_MAX_LEN;
}

pin_auth_result_t pin_auth_set(const uint8_t *pin, size_t len)
{
    if (pin_auth_is_set()) {
        return PIN_AUTH_ALREADY_SET;
    }
    if (!len_ok(len)) {
        return PIN_AUTH_BAD_LEN;
    }
    switch (wallet_key_set_pin(pin, len)) {
    case WALLET_KEY_OK:
        unlock_session(); /* they just proved they know it */
        ESP_LOGI(TAG, "PIN set");
        return PIN_AUTH_OK;
    case WALLET_KEY_REFUSED:
        return PIN_AUTH_ALREADY_SET;
    default:
        return PIN_AUTH_FAILED;
    }
}

pin_auth_result_t pin_auth_change(const uint8_t *pin, size_t len)
{
    if (!pin_auth_is_set()) {
        /* Nothing to change — the caller should have used SET. */
        return PIN_AUTH_WRONG;
    }
    if (!len_ok(len)) {
        return PIN_AUTH_BAD_LEN;
    }
    wallet_key_result_t r = wallet_key_change_pin(pin, len);
    if (r != WALLET_KEY_OK) {
        return r == WALLET_KEY_REFUSED ? PIN_AUTH_WRONG : PIN_AUTH_FAILED;
    }
    /* Failures were counted against a PIN that no longer exists, and the
     * owner just proved themselves twice over (session + button), so
     * carrying the lockout forward would only punish them. */
    persist_fail_count(0);
    s_earliest_allowed_us = 0;
    ESP_LOGI(TAG, "PIN changed");
    return PIN_AUTH_OK;
}

void pin_auth_wipe(void)
{
    ESP_ERROR_CHECK(nvs_erase_all(s_nvs));
    ESP_ERROR_CHECK(nvs_commit(s_nvs));
    s_fail_count = 0;
    s_earliest_allowed_us = 0;
    unlock_session(); /* nothing left to gate */
    ESP_LOGW(TAG, "PIN failure counter erased (factory reset)");
}

pin_auth_result_t pin_auth_verify(const uint8_t *pin, size_t len)
{
    if (!pin_auth_is_set()) {
        /* Nothing sealed yet to open — the UI shouldn't offer "verify"
         * before a PIN is set (see WALLET_STATUS_PIN_NOT_SET). */
        ESP_LOGW(TAG, "verify attempted with no PIN set — refusing");
        return PIN_AUTH_WRONG;
    }
    if (esp_timer_get_time() < s_earliest_allowed_us) {
        return PIN_AUTH_LOCKED;
    }
    if (!len_ok(len)) {
        return PIN_AUTH_BAD_LEN;
    }

    /* Counted before the attempt and taken back on success, not counted
     * after a failure: cutting the power while the PIN is being checked
     * would otherwise leave a wrong guess uncounted, and the lockout could
     * be sidestepped one power cycle at a time. */
    uint32_t fails_before = s_fail_count;
    persist_fail_count(fails_before + 1);

    wallet_key_result_t r = wallet_key_unlock(pin, len);
    if (r == WALLET_KEY_OK) {
        persist_fail_count(0);
        s_earliest_allowed_us = 0;
        unlock_session();
        ESP_LOGI(TAG, "PIN verified");
        return PIN_AUTH_OK;
    }
    if (r != WALLET_KEY_WRONG_PIN) {
        persist_fail_count(fails_before); /* not the PIN's fault */
        ESP_LOGE(TAG, "unlock failed for a reason other than the PIN, result=%d", (int)r);
        return PIN_AUTH_FAILED;
    }

    s_earliest_allowed_us = esp_timer_get_time() + lockout_delay_us(s_fail_count);
    ESP_LOGW(TAG, "wrong PIN, fail_count=%u", (unsigned)s_fail_count);
    return PIN_AUTH_WRONG;
}

bool pin_auth_session_unlocked(void)
{
    if (s_session_unlocked) {
        pin_auth_session_touch();
    }
    return s_session_unlocked;
}

bool pin_auth_session_expire_idle(void)
{
    if (!s_session_unlocked || !pin_auth_is_set()) {
        return false;
    }
    portENTER_CRITICAL(&s_used_mux);
    int64_t used = s_session_used_us;
    portEXIT_CRITICAL(&s_used_mux);
    if (esp_timer_get_time() - used <= PIN_AUTH_SESSION_IDLE_US) {
        return false;
    }
    ESP_LOGI(TAG, "session unused for %d s — locked", (int)(PIN_AUTH_SESSION_IDLE_US / 1000000));
    pin_auth_session_reset();
    return true;
}

void pin_auth_session_reset(void)
{
    s_session_unlocked = !pin_auth_is_set();
    wallet_key_lock();
}
