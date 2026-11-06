# Nayuki's QR Code generator library, C version (MIT license, see LICENSE),
# vendored from https://github.com/nayuki/QR-Code-generator — c/qrcodegen.c
# and c/qrcodegen.h match tag v1.8.0 (720f62b) byte for byte, unmodified.
# Draws the wallet's own receive address as a QR code on the screen.
idf_component_register(
    SRCS "src/qrcodegen.c"
    INCLUDE_DIRS "include"
)
