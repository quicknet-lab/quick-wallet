#!/usr/bin/env bash
#
# Host tests for the on-device transaction parser (main/ton_tx.c), the
# TON Connect proof (main/ton_proof.c), the jetton registry (main/ton_jetton.c)
# and the PIN seal (main/wallet_seal.c). Builds them
# with the development machine's compiler against ESP-IDF's own copy of
# mbedtls — the same SHA-256 the device uses — after regenerating the test
# vectors from @ton/ton (needs `npm install` in web/ once).
#
#   ./firmware/test/run_tests.sh

set -euo pipefail
cd "$(dirname "$0")"

IDF="${IDF_PATH:-$HOME/esp/esp-idf}"
MBEDTLS="$IDF/components/mbedtls/mbedtls"
[ -f "$MBEDTLS/library/sha256.c" ] || {
  echo "mbedtls not found under $IDF — set IDF_PATH." >&2
  exit 1
}

node gen_vectors.mjs

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
for t in ton_tx ton_proof ton_jetton; do
  cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize=address,undefined \
    -I../main -I"$MBEDTLS/include" -I"$MBEDTLS/library" \
    "../main/$t.c" "${t}_test.c" \
    "$MBEDTLS/library/sha256.c" "$MBEDTLS/library/platform_util.c" \
    -o "$OUT/${t}_test"
  "$OUT/${t}_test"
done

# wallet_seal needs GCM, AES and PBKDF2 on top: built against a config with
# exactly those modules (wallet_seal_mbedtls_config.h).
cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize=address,undefined \
  '-DMBEDTLS_CONFIG_FILE="wallet_seal_mbedtls_config.h"' \
  -I. -I../main -I"$MBEDTLS/include" -I"$MBEDTLS/library" \
  ../main/wallet_seal.c wallet_seal_test.c \
  "$MBEDTLS"/library/{gcm,aes,cipher,cipher_wrap,pkcs5,md,sha256,platform_util,constant_time}.c \
  -o "$OUT/wallet_seal_test"
"$OUT/wallet_seal_test"
