#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

/* The panel as the UI sees it: 320x170 pixels in landscape. Every screen
 * in gatt_svc.c, main.c and ota_service.c is laid out in these pixels with
 * the fonts and colors below. */
#define DISPLAY_W 320
#define DISPLAY_H 170

/* A bitmap font: printable ASCII only, every glyph exactly w x h. */
typedef struct {
    uint8_t w;
    uint8_t h;
    const uint8_t *bits;
} display_font_t;

/* Terminus, in the three sizes the UI uses (see display_font.h):
 * S 8x16 (40 columns) for hints, labels and the footer; S_BOLD for the
 * header; M 12x24 bold (26 columns) for addresses, seed words and body
 * text; L 16x32 bold (20 columns) for amounts and the pairing code. */
extern const display_font_t display_font_s;
extern const display_font_t display_font_s_bold;
extern const display_font_t display_font_m;
extern const display_font_t display_font_l;
#define FONT_S      (&display_font_s)
#define FONT_S_BOLD (&display_font_s_bold)
#define FONT_M      (&display_font_m)
#define FONT_L      (&display_font_l)

/* How many characters of font fit across the whole panel. */
#define DISPLAY_COLS(font) (DISPLAY_W / (font)->w)

/* RGB565. */
#define DISPLAY_RGB(r, g, b) ((uint16_t)((((r) >> 3) << 11) | (((g) >> 2) << 5) | ((b) >> 3)))
#define COLOR_BLACK  DISPLAY_RGB(0x00, 0x00, 0x00)
#define COLOR_WHITE  DISPLAY_RGB(0xFF, 0xFF, 0xFF)
/* Secondary text: labels, word numbers, hints, the version. */
#define COLOR_GRAY   DISPLAY_RGB(0x9A, 0x9A, 0x9A)
/* The web app's cyan: the header of ordinary screens, the action to take. */
#define COLOR_ACCENT DISPLAY_RGB(0x6B, 0xD6, 0xC9)
/* Critical: the ends of every address, dangerous requests, refusals. */
#define COLOR_RED    DISPLAY_RGB(0xFF, 0x40, 0x40)
/* Worth a second look: testnet, deploys, labels only the host vouches for. */
#define COLOR_ORANGE DISPLAY_RGB(0xFF, 0xA0, 0x00)
#define COLOR_GREEN  DISPLAY_RGB(0x40, 0xD8, 0x70)

/* Rows the header and footer take; content goes in between. */
#define DISPLAY_HEADER_H 20
#define DISPLAY_FOOTER_Y (DISPLAY_H - 16)

/* ST7789 170x320 IPS over an 8-bit Intel 8080 bus, used in landscape
 * (320x170). LilyGO T-Display-S3: data D0-D7 on GPIO39-42/45-48, WR=8,
 * RD=9, DC=7, CS=6, RST=5, backlight=38, peripheral power=15. */
esp_err_t display_init(void);

/* Starts a new frame. The frame is a list of what to draw — text and
 * filled rectangles, painted in the order they were added — and nothing
 * reaches the panel until display_flush(). */
void display_clear(void);

/* A filled rectangle, clipped to the panel. */
void display_fill(int x, int y, int w, int h, uint16_t color);

/* Text with its top-left corner at (x, y), one line, clipped at the panel
 * edges (no wrapping). Characters outside printable ASCII are drawn as
 * '?'. Returns the x just past the text, so differently colored runs can
 * follow one another on a line. */
int display_text(int x, int y, const display_font_t *font, uint16_t color, const char *text);

/* Same, horizontally centered on the panel; a line too wide to center
 * starts at x = 0. */
void display_text_centered(int y, const display_font_t *font, uint16_t color, const char *text);

/* Width of text in pixels. */
int display_text_width(const display_font_t *font, const char *text);

/* The title plate across the top (DISPLAY_HEADER_H rows): title centered
 * in bold, black on color. */
void display_header(const char *title, uint16_t color);

/* The bottom row: what the button does, centered — in gray, or in bold
 * cyan when the press is the one that commits (sign, install). A testnet
 * request gets an orange TESTNET tag in the left corner. */
void display_footer(const char *hint, bool commits, bool testnet);

/* Renders the frame to the panel. No-op (returns ESP_OK) if
 * display_init() was never called or failed — callers don't need to guard
 * every call site for a board with a dead screen. */
esp_err_t display_flush(void);

/* Counts display_flush() calls: whoever put something up can tell later
 * whether anything else has been drawn over it since. */
uint32_t display_frame_seq(void);

/* Boot splash: the Quick Wallet logo (the web app's favicon, drawn in
 * pixels rather than text), "QUICK WALLET" under it and the firmware
 * version in the bottom-left corner. Takes the display lock itself. */
void display_show_splash(void);

/* Convenience: a whole status screen in one call. title goes in a header
 * plate of color; line1 is the message, large and centered — in color too,
 * unless color is the ordinary COLOR_ACCENT, then white — and line2 (may be
 * NULL) a smaller gray line under it. A line1 short enough, with no line2,
 * is drawn in FONT_L. The firmware version goes in the bottom-left corner.
 * Takes the display lock itself. */
void display_show_status(uint16_t color, const char *title, const char *line1, const char *line2);

/* There is one frame and several tasks draw on it (NimBLE host, confirm
 * button, timers). Anyone composing a frame out of display_clear() /
 * display_text*() / display_flush() calls holds this lock across all of
 * them, so another task's status can't be mixed into a half-drawn confirm
 * or seed screen. Recursive: display_show_status() may be called under
 * it. */
void display_lock(void);
void display_unlock(void);
