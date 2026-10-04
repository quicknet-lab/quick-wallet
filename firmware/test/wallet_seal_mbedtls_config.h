/* mbedtls configuration for the wallet_seal host test (run_tests.sh):
 * exactly the modules main/wallet_seal.c uses, so the test links against a
 * handful of mbedtls sources instead of every cipher the default config
 * turns on. */
#define MBEDTLS_AES_C
#define MBEDTLS_GCM_C
#define MBEDTLS_CIPHER_C
#define MBEDTLS_MD_C
#define MBEDTLS_SHA256_C
#define MBEDTLS_PKCS5_C
