idf_component_register(
    SRCS "main.c" "gatt_svc.c" "wallet_key.c" "confirm_button.c" "ota_service.c" "pin_auth.c" "display.c" "ton_mnemonic.c" "ton_tx.c" "ton_proof.c" "ton_jetton.c" "wallet_seal.c"
    INCLUDE_DIRS "."
    REQUIRES bt nvs_flash esp_partition ed25519 driver esp_timer app_update mbedtls esp_lcd efuse bootloader_support
)
