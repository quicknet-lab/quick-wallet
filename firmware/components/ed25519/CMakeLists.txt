# orlp/ed25519 (zlib license, see LICENSE), vendored from
# https://github.com/orlp/ed25519 — every file here matches master b1f19fa
# (2022-10-03) byte for byte, unmodified. seed.c relies on /dev/urandom
# (POSIX-only); we seed keys via esp_fill_random instead. key_exchange.c
# (X25519 ECDH), verify.c and add_scalar.c are unused — keypair and signing
# only — so they are not built (verify.c and add_scalar.c stay in src/ as
# part of the unmodified upstream copy).
idf_component_register(
    SRCS
        "src/fe.c"
        "src/ge.c"
        "src/keypair.c"
        "src/sc.c"
        "src/sha512.c"
        "src/sign.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "src"
)

target_compile_definitions(${COMPONENT_LIB} PRIVATE ED25519_NO_SEED)
