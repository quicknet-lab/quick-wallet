#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_partition.h"
#include "esp_random.h"
#include "esp_efuse.h"
#include "esp_efuse_table.h"
#include "esp_hmac.h"
#include "esp_secure_boot.h"
#include "esp_flash_encrypt.h"
#include "bootloader_random.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "ed25519.h"
#include "wallet_seal.h"
#include "wallet_key.h"

static const char *TAG = "wallet_key";

#define NVS_NAMESPACE "wallet"
#define NVS_KEY_SEALED "sealed"
#define NVS_KEY_EXISTS "exists"

/* What is sealed: a flag saying whether it holds a wallet at all (a PIN is
 * set, and sealed, before there is one), then the keys and the mnemonic.
 * orlp/ed25519's "private key" is the SHA-512-expanded 64-byte form, not the
 * raw 32-byte seed — the seed itself is discarded right after keygen. */
typedef struct {
    uint8_t has_wallet;
    uint8_t privkey[64];
    uint8_t pubkey[WALLET_PUBKEY_LEN];
    uint16_t mnemonic[TON_MNEMONIC_WORD_COUNT];
} wallet_secret_t;

#define SECRET_LEN (1 + 64 + WALLET_PUBKEY_LEN + 2 * TON_MNEMONIC_WORD_COUNT)
#define BLOB_LEN WALLET_SEAL_BLOB_LEN(SECRET_LEN)

static nvs_handle_t s_nvs;
static hmac_key_id_t s_hmac_key;
static bool s_hmac_ok;
static bool s_pin_set;
static bool s_exists;

/* Guards everything below: the NimBLE host task (unlock, lock on
 * disconnect), the confirm-button task (set/change PIN, sign) and the
 * wallet-creation task all reach it. */
static SemaphoreHandle_t s_lock;
static bool s_unlocked;
static uint8_t s_kek[WALLET_SEAL_KEK_LEN];
static uint8_t s_salt[WALLET_SEAL_SALT_LEN];
static wallet_secret_t s_secret;

#define LOCK() xSemaphoreTake(s_lock, portMAX_DELAY)
#define UNLOCK() xSemaphoreGive(s_lock)

static void wipe(void *p, size_t n)
{
    volatile uint8_t *b = p;
    while (n--) {
        *b++ = 0;
    }
}

static void secret_to_bytes(const wallet_secret_t *s, uint8_t out[SECRET_LEN])
{
    out[0] = s->has_wallet;
    memcpy(out + 1, s->privkey, 64);
    memcpy(out + 1 + 64, s->pubkey, WALLET_PUBKEY_LEN);
    memcpy(out + 1 + 64 + WALLET_PUBKEY_LEN, s->mnemonic, sizeof(s->mnemonic));
}

static void secret_from_bytes(const uint8_t in[SECRET_LEN], wallet_secret_t *s)
{
    s->has_wallet = in[0];
    memcpy(s->privkey, in + 1, 64);
    memcpy(s->pubkey, in + 1 + 64, WALLET_PUBKEY_LEN);
    memcpy(s->mnemonic, in + 1 + 64 + WALLET_PUBKEY_LEN, sizeof(s->mnemonic));
}

static int hw_hmac(const uint8_t msg[32], uint8_t out[32])
{
    if (!s_hmac_ok) {
        return -1;
    }
    return esp_hmac_calculate(s_hmac_key, msg, 32, out) == ESP_OK ? 0 : -1;
}

/* The HMAC_UP key the PIN seal runs through. Generated on the chip and
 * burned read-protected on the first start, so nothing — this firmware
 * included — can read it back; the HMAC peripheral only uses it. */
static esp_err_t hw_key_init(void)
{
    esp_efuse_block_t block;
    if (!esp_efuse_find_purpose(ESP_EFUSE_KEY_PURPOSE_HMAC_UP, &block)) {
        block = esp_efuse_find_unused_key_block();
        if (block == EFUSE_BLK_KEY_MAX) {
            ESP_LOGE(TAG, "no free eFuse key block for the PIN seal key");
            return ESP_ERR_NOT_FOUND;
        }
        uint8_t key[32];
        /* The radio isn't up yet, so the RNG has no entropy source of its
         * own; this is how IDF's own HMAC-based NVS scheme does it too. */
        bootloader_random_enable();
        esp_fill_random(key, sizeof(key));
        bootloader_random_disable();
        esp_err_t err = esp_efuse_write_key(block, ESP_EFUSE_KEY_PURPOSE_HMAC_UP, key, sizeof(key));
        wipe(key, sizeof(key));
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "burning the PIN seal key failed: %s", esp_err_to_name(err));
            return err;
        }
        ESP_LOGW(TAG, "PIN seal key burned into eFuse key block %d", block - EFUSE_BLK_KEY0);
    }
    s_hmac_key = (hmac_key_id_t)(block - EFUSE_BLK_KEY0);
    s_hmac_ok = true;

    /* The secure build's bootloader leaves RD_DIS writable
     * (CONFIG_SECURE_BOOT_V2_ALLOW_EFUSE_RD_DIS) only so the key above can
     * still be read-protected on a board that has just burned Secure Boot.
     * With the key in place, close it here, as the bootloader otherwise
     * would. Not on a board without both protections: there the bootloader
     * still has to read-protect its own flash-encryption key later. */
    if (esp_secure_boot_enabled() && esp_flash_encryption_enabled()
        && !esp_efuse_read_field_bit(ESP_EFUSE_WR_DIS_RD_DIS)) {
        esp_err_t err = esp_efuse_write_field_bit(ESP_EFUSE_WR_DIS_RD_DIS);
        if (err != ESP_OK) {
            /* Not fatal: the wallet works without it, and it is retried on
             * every start. */
            ESP_LOGE(TAG, "closing eFuse RD_DIS failed: %s", esp_err_to_name(err));
        } else {
            ESP_LOGW(TAG, "eFuse RD_DIS closed for good");
        }
    }
    return ESP_OK;
}

static esp_err_t secure_nvs_init(void)
{
    const esp_partition_t *key_part = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS_KEYS, "nvs_key");
    if (key_part == NULL) {
        ESP_LOGE(TAG, "nvs_key partition not found");
        return ESP_ERR_NOT_FOUND;
    }

    nvs_sec_cfg_t cfg;
    esp_err_t err = nvs_flash_read_security_cfg(key_part, &cfg);
    if (err == ESP_ERR_NVS_KEYS_NOT_INITIALIZED) {
        ESP_LOGI(TAG, "generating NVS encryption keys (first boot)");
        err = nvs_flash_generate_keys(key_part, &cfg);
    }
    if (err != ESP_OK) {
        return err;
    }

    err = nvs_flash_secure_init(&cfg);
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_secure_init(&cfg);
    }
    return err;
}

esp_err_t wallet_key_init(void)
{
    s_lock = xSemaphoreCreateMutex();
    if (s_lock == NULL) {
        return ESP_ERR_NO_MEM;
    }

    /* A failure here is logged and lived with, never returned: the device
     * must still come up and advertise, or a board that can only be updated
     * over the air could never receive the fix. Without the key, setting or
     * entering a PIN fails (hw_hmac) — nothing gets sealed under a
     * half-working key. */
    if (hw_key_init() != ESP_OK) {
        ESP_LOGE(TAG, "PIN seal key unavailable — PIN setup and unlock will fail");
    }

    esp_err_t err = secure_nvs_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "secure NVS init failed: %s", esp_err_to_name(err));
        return err;
    }
    ESP_ERROR_CHECK(nvs_open(NVS_NAMESPACE, NVS_READWRITE, &s_nvs));

    size_t len = 0;
    err = nvs_get_blob(s_nvs, NVS_KEY_SEALED, NULL, &len);
    if (err == ESP_OK) {
        s_pin_set = true;
    } else if (err != ESP_ERR_NVS_NOT_FOUND) {
        ESP_ERROR_CHECK(err);
    }
    uint8_t exists = 0;
    err = nvs_get_u8(s_nvs, NVS_KEY_EXISTS, &exists);
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        ESP_ERROR_CHECK(err);
    }
    s_exists = exists != 0;

    ESP_LOGI(TAG, "pin_set=%d wallet=%d (locked)", s_pin_set, s_exists);
    return ESP_OK;
}

bool wallet_key_pin_set(void)
{
    return s_pin_set;
}

bool wallet_key_exists(void)
{
    return s_exists;
}

/* Seals secret under kek (fresh nonce, salt as given) and commits it, along
 * with the plain "exists" flag. Caller holds nothing — this only touches
 * NVS, whose own lock covers it. */
static wallet_key_result_t store_sealed(const uint8_t kek[WALLET_SEAL_KEK_LEN],
                                        const uint8_t salt[WALLET_SEAL_SALT_LEN],
                                        const wallet_secret_t *secret)
{
    uint8_t nonce[WALLET_SEAL_NONCE_LEN];
    esp_fill_random(nonce, sizeof(nonce));
    uint8_t plain[SECRET_LEN];
    uint8_t blob[BLOB_LEN];
    secret_to_bytes(secret, plain);
    wallet_seal_result_t r = wallet_seal(kek, salt, nonce, plain, SECRET_LEN, blob);
    wipe(plain, sizeof(plain));
    if (r != WALLET_SEAL_OK) {
        ESP_LOGE(TAG, "sealing failed, result=%d", (int)r);
        return WALLET_KEY_FAILED;
    }
    if (nvs_set_blob(s_nvs, NVS_KEY_SEALED, blob, sizeof(blob)) != ESP_OK
        || nvs_set_u8(s_nvs, NVS_KEY_EXISTS, secret->has_wallet) != ESP_OK
        || nvs_commit(s_nvs) != ESP_OK) {
        ESP_LOGE(TAG, "storing the sealed wallet failed");
        return WALLET_KEY_FAILED;
    }
    return WALLET_KEY_OK;
}

/* A fresh salt and the kek for it. */
static wallet_key_result_t new_kek(const uint8_t *pin, size_t len,
                                   uint8_t salt[WALLET_SEAL_SALT_LEN],
                                   uint8_t kek[WALLET_SEAL_KEK_LEN])
{
    esp_fill_random(salt, WALLET_SEAL_SALT_LEN);
    return wallet_seal_derive_kek(pin, len, salt, hw_hmac, kek) == WALLET_SEAL_OK
               ? WALLET_KEY_OK
               : WALLET_KEY_FAILED;
}

wallet_key_result_t wallet_key_set_pin(const uint8_t *pin, size_t len)
{
    if (s_pin_set) {
        return WALLET_KEY_REFUSED;
    }
    uint8_t salt[WALLET_SEAL_SALT_LEN];
    uint8_t kek[WALLET_SEAL_KEK_LEN];
    wallet_key_result_t r = new_kek(pin, len, salt, kek);
    if (r == WALLET_KEY_OK) {
        wallet_secret_t empty = { 0 };
        r = store_sealed(kek, salt, &empty);
    }
    if (r == WALLET_KEY_OK) {
        LOCK();
        memcpy(s_kek, kek, sizeof(s_kek));
        memcpy(s_salt, salt, sizeof(s_salt));
        wipe(&s_secret, sizeof(s_secret));
        s_unlocked = true;
        s_pin_set = true;
        UNLOCK();
    }
    wipe(kek, sizeof(kek));
    return r;
}

wallet_key_result_t wallet_key_unlock(const uint8_t *pin, size_t len)
{
    if (!s_pin_set) {
        return WALLET_KEY_REFUSED;
    }
    uint8_t blob[BLOB_LEN];
    size_t blob_len = sizeof(blob);
    if (nvs_get_blob(s_nvs, NVS_KEY_SEALED, blob, &blob_len) != ESP_OK) {
        ESP_LOGE(TAG, "reading the sealed wallet failed");
        return WALLET_KEY_FAILED;
    }
    uint8_t salt[WALLET_SEAL_SALT_LEN];
    memcpy(salt, wallet_seal_blob_salt(blob), sizeof(salt));

    uint8_t kek[WALLET_SEAL_KEK_LEN];
    if (wallet_seal_derive_kek(pin, len, salt, hw_hmac, kek) != WALLET_SEAL_OK) {
        return WALLET_KEY_FAILED;
    }
    uint8_t plain[SECRET_LEN];
    wallet_seal_result_t sr = wallet_unseal(kek, blob, blob_len, plain, SECRET_LEN);
    wallet_key_result_t r = sr == WALLET_SEAL_OK          ? WALLET_KEY_OK
                            : sr == WALLET_SEAL_WRONG_PIN ? WALLET_KEY_WRONG_PIN
                                                          : WALLET_KEY_FAILED;
    if (r == WALLET_KEY_OK) {
        LOCK();
        memcpy(s_kek, kek, sizeof(s_kek));
        memcpy(s_salt, salt, sizeof(s_salt));
        secret_from_bytes(plain, &s_secret);
        s_unlocked = true;
        UNLOCK();
    }
    wipe(plain, sizeof(plain));
    wipe(kek, sizeof(kek));
    return r;
}

wallet_key_result_t wallet_key_change_pin(const uint8_t *pin, size_t len)
{
    uint8_t salt[WALLET_SEAL_SALT_LEN];
    uint8_t kek[WALLET_SEAL_KEK_LEN];
    wallet_key_result_t r = new_kek(pin, len, salt, kek);
    if (r != WALLET_KEY_OK) {
        return r;
    }
    LOCK();
    if (!s_unlocked) {
        r = WALLET_KEY_REFUSED;
    } else {
        r = store_sealed(kek, salt, &s_secret);
        if (r == WALLET_KEY_OK) {
            memcpy(s_kek, kek, sizeof(s_kek));
            memcpy(s_salt, salt, sizeof(s_salt));
        }
    }
    UNLOCK();
    wipe(kek, sizeof(kek));
    return r;
}

void wallet_key_lock(void)
{
    LOCK();
    wipe(s_kek, sizeof(s_kek));
    wipe(&s_secret, sizeof(s_secret));
    s_unlocked = false;
    UNLOCK();
}

wallet_key_result_t wallet_key_create(void)
{
    uint8_t kek[WALLET_SEAL_KEK_LEN];
    uint8_t salt[WALLET_SEAL_SALT_LEN];
    LOCK();
    bool allowed = s_unlocked && !s_exists;
    if (allowed) {
        memcpy(kek, s_kek, sizeof(kek));
        memcpy(salt, s_salt, sizeof(salt));
    }
    UNLOCK();
    if (!allowed) {
        ESP_LOGW(TAG, "wallet_key_create refused — locked, or a wallet already exists");
        return WALLET_KEY_REFUSED;
    }

    wallet_secret_t fresh = { .has_wallet = 1 };
    ton_mnemonic_generate(fresh.mnemonic);
    uint8_t seed[TON_MNEMONIC_SEED_LEN];
    ton_mnemonic_to_seed(fresh.mnemonic, seed);
    ed25519_create_keypair(fresh.pubkey, fresh.privkey, seed);
    wipe(seed, sizeof(seed));

    wallet_key_result_t r = store_sealed(kek, salt, &fresh);
    if (r == WALLET_KEY_OK) {
        LOCK();
        s_exists = true;
        /* Unlocked with this same kek unless the session ended while the key
         * was being derived — then it stays sealed until the next unlock. */
        if (s_unlocked && memcmp(s_kek, kek, sizeof(kek)) == 0) {
            s_secret = fresh;
        }
        UNLOCK();
        ESP_LOGI(TAG, "generated new wallet keypair from mnemonic (sealed)");
    }
    wipe(&fresh, sizeof(fresh));
    wipe(kek, sizeof(kek));
    return r;
}

void wallet_key_wipe(void)
{
    ESP_ERROR_CHECK(nvs_erase_all(s_nvs));
    ESP_ERROR_CHECK(nvs_commit(s_nvs));
    wallet_key_lock();
    s_pin_set = false;
    s_exists = false;
    ESP_LOGW(TAG, "sealed wallet and PIN erased (factory reset)");
}

bool wallet_key_get_mnemonic(uint16_t indices_out[TON_MNEMONIC_WORD_COUNT])
{
    LOCK();
    bool ok = s_unlocked && s_secret.has_wallet;
    if (ok) {
        memcpy(indices_out, s_secret.mnemonic, sizeof(s_secret.mnemonic));
    }
    UNLOCK();
    return ok;
}

bool wallet_key_has_mnemonic(void)
{
    LOCK();
    bool ok = s_unlocked && s_secret.has_wallet;
    UNLOCK();
    return ok;
}

/* The pointer is to s_secret: the pubkey read and ton_proof use it straight
 * away in the NimBLE task, which is also the only task that locks. */
const uint8_t *wallet_key_get_pubkey(void)
{
    return s_secret.pubkey;
}

void wallet_key_sign(const uint8_t *msg, size_t msg_len,
                      uint8_t signature_out[WALLET_SIGNATURE_LEN])
{
    LOCK();
    if (s_unlocked && s_secret.has_wallet) {
        ed25519_sign(signature_out, msg, msg_len, s_secret.pubkey, s_secret.privkey);
    } else {
        /* Locked by a disconnect between the button press and here: no key
         * to sign with, and an all-zero signature is simply invalid. */
        memset(signature_out, 0, WALLET_SIGNATURE_LEN);
    }
    UNLOCK();
}
