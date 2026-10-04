#pragma once

#include <stdint.h>
#include "esp_err.h"

/* The text grid the whole UI is written against: 40 columns by 13 rows.
 * That is what the 8x13 font fits on this 320x170 panel with nothing left
 * over — every screen in gatt_svc.c is laid out against these two numbers
 * and the widths derived from them (how much of an amount is shown before
 * it is truncated, how long a comment may be before it moves to a page of
 * its own). */
#define DISPLAY_COLS 40
#define DISPLAY_ROWS 13

/* ST7789 170x320 IPS over an 8-bit Intel 8080 bus, used in landscape
 * (320x170). LilyGO T-Display-S3: data D0-D7 on GPIO39-42/45-48, WR=8,
 * RD=9, DC=7, CS=6, RST=5, backlight=38, peripheral power=15. */
esp_err_t display_init(void);

/* Clears the in-memory framebuffer only; call display_flush() to push it. */
void display_clear(void);

/* Draws text at the given text row/column; clips at the right edge, does
 * not wrap. Only touches the framebuffer — call display_flush() to show
 * it. */
void display_draw_text(uint8_t row, uint8_t col, const char *text);

/* Same as display_draw_text(), but horizontally centers the text on the
 * row instead of starting at a fixed column. */
void display_draw_text_centered(uint8_t row, const char *text);

/* Renders the framebuffer to the panel. No-op (returns ESP_OK) if
 * display_init() was never called or failed — callers don't need to guard
 * every call site for a board with a dead screen. */
esp_err_t display_flush(void);

/* Counts display_flush() calls: whoever put something up can tell later
 * whether anything else has been drawn over it since. */
uint32_t display_frame_seq(void);

/* Boot splash: the Quick Wallet logo (the web app's favicon, drawn in
 * pixels rather than text), "QUICK WALLET" under it and the firmware
 * version in the bottom-left corner. The next display_flush() or
 * display_show_status() repaints the whole screen over it. Takes the
 * display lock itself. */
void display_show_splash(void);

/* Convenience: clears, draws up to 3 lines (any may be NULL to skip), and
 * flushes in one call. title goes on row 0, line1/line2 on rows 2-3
 * (row 1 left blank as a visual gap). The firmware version goes in the
 * bottom-left corner. Takes the display lock itself. */
void display_show_status(const char *title, const char *line1, const char *line2);

/* There is one framebuffer and several tasks draw on it (NimBLE host,
 * confirm button, timers). Anyone composing a frame out of
 * display_clear() / display_draw_text*() / display_flush() calls holds
 * this lock across all of them, so another task's status can't be mixed
 * into a half-drawn confirm or seed screen. Recursive:
 * display_show_status() may be called under it. */
void display_lock(void);
void display_unlock(void);
