cmake_minimum_required(VERSION 3.16)

# BLE-only by design: no Wi-Fi, Ethernet, Thread or network protocol stacks.
# EXCLUDE_COMPONENTS only drops components from the default "build
# everything" list; it cannot remove one another component REQUIRES. So
# esp_wifi stays in the build (bt, esp_phy and wpa_supplicant require it,
# which is also why its prebuilt libraries under esp_wifi/lib must be
# present), and so does esp-tls (required by tcp_transport). None of their
# code reaches the image: nothing calls into them, so the linker drops it,
# and a release is refused if its .elf contains esp_wifi_init.
set(EXCLUDE_COMPONENTS
    esp_wifi wifi_provisioning esp_eth openthread ieee802154
    esp_https_ota esp_https_server esp_http_server esp_http_client
    esp-tls mqtt protocomm esp_local_ctrl
)

# Reported over BLE on the version characteristic and compared against the
# release manifest by the web app to decide whether an OTA update is
# available (see GATT_CHR_VERSION_UUID). Set explicitly rather than left to
# IDF's `git describe` fallback, which yields a commit-ish string that
# nothing can meaningfully order. Bump on every released firmware build.
set(PROJECT_VER "1.0.0")

# There is no "default" configuration in this project, deliberately. Every
# setting in config/*.conf is a property of one chip and one board — flash
# size, partition-table offset, which eFuse burns exist, which GPIO the
# button is on — and letting a future second chip inherit those silently
# would be a bug, not a convenience. So the config file is named for its
# target and chosen by target here.
#
# Not the stock `sdkconfig.defaults` + `sdkconfig.defaults.<target>` pair:
# IDF only reads the target-suffixed file as a suffix of an existing
# `sdkconfig.defaults` (tools/cmake/kconfig.cmake), so dropping the
# chip-agnostic file would silently drop the whole configuration with it.
# Setting SDKCONFIG_DEFAULTS explicitly has no such failure mode — and a
# target with no config file of its own stops the build right here instead
# of quietly coming up on stock IDF defaults.
#
# Adding a chip = adding config/<target>.conf, with every setting decided
# for it on purpose. Note that a stray sdkconfig.defaults would be ignored:
# this assignment overrides it.
if(NOT IDF_TARGET)
    set(IDF_TARGET "$ENV{IDF_TARGET}")
endif()
if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/config/${IDF_TARGET}.conf")
    message(FATAL_ERROR
        "No configuration for target '${IDF_TARGET}'. This firmware is built "
        "per chip: add firmware/config/${IDF_TARGET}.conf, or build for a "
        "target that has one (currently: esp32s3).")
endif()
set(SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/config/${IDF_TARGET}.conf")

# The secure build (Secure Boot, flash encryption, anti-rollback — all
# burned into eFuses on first boot) is opt-in and layered on top:
#   idf.py -B build.esp32s3-secure -D QUICK_WALLET_SECURE=1 build
# It keeps its sdkconfig inside its own build directory. The shared
# project-level sdkconfig overrides the .conf files, so letting the secure
# build write there would quietly turn the next ordinary build into one
# that burns eFuses too.
option(QUICK_WALLET_SECURE "Build with Secure Boot, flash encryption and anti-rollback" OFF)
if(QUICK_WALLET_SECURE)
    if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/config/${IDF_TARGET}-secure.conf")
        message(FATAL_ERROR "No secure configuration for target '${IDF_TARGET}'.")
    endif()
    list(APPEND SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/config/${IDF_TARGET}-secure.conf")
    set(SDKCONFIG "${CMAKE_BINARY_DIR}/sdkconfig")
else()
    # Belt and braces for the same reason: an ordinary build refuses a
    # project-level sdkconfig that has any eFuse-burning option switched on.
    set(_sdkconfig "${CMAKE_CURRENT_LIST_DIR}/sdkconfig")
    if(SDKCONFIG)
        set(_sdkconfig "${SDKCONFIG}")
    endif()
    if(EXISTS "${_sdkconfig}")
        file(STRINGS "${_sdkconfig}" _burning REGEX
             "^CONFIG_(SECURE_BOOT|SECURE_FLASH_ENC_ENABLED|BOOTLOADER_APP_ANTI_ROLLBACK)=y$")
        if(_burning)
            message(FATAL_ERROR
                "${_sdkconfig} enables eFuse-burning options (${_burning}) in an "
                "ordinary build. Delete it and build again; the secure build is "
                "-D QUICK_WALLET_SECURE=1 in a build directory of its own.")
        endif()
    endif()
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(quick_wallet)
