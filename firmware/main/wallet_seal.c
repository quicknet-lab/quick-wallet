#include <string.h>
#include "mbedtls/gcm.h"
#include "mbedtls/pkcs5.h"
#include "wallet_seal.h"

static void wipe(void *p, size_t n)
{
    volatile uint8_t *b = p;
    while (n--) {
        *b++ = 0;
    }
}

wallet_seal_result_t wallet_seal_derive_kek(const uint8_t *pin, size_t pin_len,
                                            const uint8_t salt[WALLET_SEAL_SALT_LEN],
                                            wallet_seal_hmac_fn hmac,
                                            uint8_t kek_out[WALLET_SEAL_KEK_LEN])
{
    uint8_t stretched[32];
    int rc = mbedtls_pkcs5_pbkdf2_hmac_ext(MBEDTLS_MD_SHA256, pin, pin_len,
                                           salt, WALLET_SEAL_SALT_LEN,
                                           WALLET_SEAL_PBKDF2_ITERATIONS,
                                           sizeof(stretched), stretched);
    if (rc == 0) {
        rc = hmac(stretched, kek_out);
    }
    wipe(stretched, sizeof(stretched));
    if (rc != 0) {
        wipe(kek_out, WALLET_SEAL_KEK_LEN);
        return WALLET_SEAL_FAILED;
    }
    return WALLET_SEAL_OK;
}

const uint8_t *wallet_seal_blob_salt(const uint8_t *blob)
{
    return blob + 1;
}

wallet_seal_result_t wallet_seal(const uint8_t kek[WALLET_SEAL_KEK_LEN],
                                 const uint8_t salt[WALLET_SEAL_SALT_LEN],
                                 const uint8_t nonce[WALLET_SEAL_NONCE_LEN],
                                 const uint8_t *secret, size_t secret_len,
                                 uint8_t *blob_out)
{
    uint8_t *header = blob_out;
    header[0] = WALLET_SEAL_VERSION;
    memcpy(header + 1, salt, WALLET_SEAL_SALT_LEN);
    memcpy(header + 1 + WALLET_SEAL_SALT_LEN, nonce, WALLET_SEAL_NONCE_LEN);

    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);
    int rc = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, kek, WALLET_SEAL_KEK_LEN * 8);
    if (rc == 0) {
        rc = mbedtls_gcm_crypt_and_tag(&gcm, MBEDTLS_GCM_ENCRYPT, secret_len,
                                       nonce, WALLET_SEAL_NONCE_LEN,
                                       header, WALLET_SEAL_HEADER_LEN,
                                       secret, blob_out + WALLET_SEAL_HEADER_LEN,
                                       WALLET_SEAL_TAG_LEN,
                                       blob_out + WALLET_SEAL_HEADER_LEN + secret_len);
    }
    mbedtls_gcm_free(&gcm);
    return rc == 0 ? WALLET_SEAL_OK : WALLET_SEAL_FAILED;
}

wallet_seal_result_t wallet_unseal(const uint8_t kek[WALLET_SEAL_KEK_LEN],
                                   const uint8_t *blob, size_t blob_len,
                                   uint8_t *secret_out, size_t secret_len)
{
    if (blob_len != WALLET_SEAL_BLOB_LEN(secret_len) || blob[0] != WALLET_SEAL_VERSION) {
        return WALLET_SEAL_BAD_BLOB;
    }
    const uint8_t *nonce = blob + 1 + WALLET_SEAL_SALT_LEN;

    wallet_seal_result_t result = WALLET_SEAL_OK;
    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);
    int rc = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, kek, WALLET_SEAL_KEK_LEN * 8);
    if (rc == 0) {
        rc = mbedtls_gcm_auth_decrypt(&gcm, secret_len, nonce, WALLET_SEAL_NONCE_LEN,
                                      blob, WALLET_SEAL_HEADER_LEN,
                                      blob + WALLET_SEAL_HEADER_LEN + secret_len,
                                      WALLET_SEAL_TAG_LEN,
                                      blob + WALLET_SEAL_HEADER_LEN, secret_out);
        if (rc == MBEDTLS_ERR_GCM_AUTH_FAILED) {
            result = WALLET_SEAL_WRONG_PIN;
        } else if (rc != 0) {
            result = WALLET_SEAL_FAILED;
        }
    } else {
        result = WALLET_SEAL_FAILED;
    }
    mbedtls_gcm_free(&gcm);
    if (result != WALLET_SEAL_OK) {
        wipe(secret_out, secret_len);
    }
    return result;
}
