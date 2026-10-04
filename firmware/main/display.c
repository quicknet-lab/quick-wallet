#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "driver/gpio.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "display.h"
#include "display_font.h"

static const char *TAG = "display";

/* LilyGO T-Display-S3 (ESP32-S3R8, 16MB flash): ST7789 driving a 170x320
 * IPS panel over the chip's 8-bit Intel 8080 LCD bus. Pin numbers are the
 * board's, not a choice — they are wired on the PCB. */
#define PIN_LCD_D0    39
#define PIN_LCD_D1    40
#define PIN_LCD_D2    41
#define PIN_LCD_D3    42
#define PIN_LCD_D4    45
#define PIN_LCD_D5    46
#define PIN_LCD_D6    47
#define PIN_LCD_D7    48
#define PIN_LCD_WR    8
#define PIN_LCD_DC    7
#define PIN_LCD_CS    6
#define PIN_LCD_RST   5
/* Read strobe. Nothing here ever reads from the panel, but the line must
 * be parked high: held low, the ST7789 would drive the shared data bus
 * against the ESP32 writing on it. The i80 driver doesn't know about RD,
 * so this firmware sets it once and leaves it. */
#define PIN_LCD_RD    9
#define PIN_LCD_BL    38
/* Enables the board's peripheral power rail (the panel among them). Low at
 * reset, so without this the screen simply stays dark. */
#define PIN_POWER_ON  15

/* Native panel size, and the landscape orientation this firmware uses. */
#define PANEL_H_RES 320
#define PANEL_V_RES 170
/* The visible 170 columns sit in the middle of the ST7789's 240-column
 * memory; rotated to landscape that offset lands on the row address. */
#define PANEL_GAP_Y ((240 - PANEL_V_RES) / 2)

/* 10 MHz write clock: one 320x170 frame in ~11ms, with room to spare
 * against the ST7789's 66ns minimum write cycle. */
#define PCLK_HZ (10 * 1000 * 1000)

/* Each 8x13 glyph fills its cell 1:1. The 40x13 grid is then 320x169
 * pixels: the whole panel width, and all but one row of its height, which
 * is painted black once at init and never touched again. */
#define CELL_W   DISPLAY_FONT_W
#define CELL_H   DISPLAY_FONT_H
#define ORIGIN_X ((PANEL_H_RES - DISPLAY_COLS * CELL_W) / 2)
#define ORIGIN_Y ((PANEL_V_RES - DISPLAY_ROWS * CELL_H) / 2)

#define COLOR_FG 0xFFFF /* white */
#define COLOR_BG 0x0000 /* black */

/* One band = one text row, full panel width. Small enough to sit in
 * internal DMA memory (8KB) rather than keeping a whole 106KB RGB565
 * frame around for eight lines of text. */
#define BAND_PIXELS (PANEL_H_RES * CELL_H)
#define BAND_BYTES  (BAND_PIXELS * sizeof(uint16_t))

static esp_lcd_panel_handle_t s_panel;
static esp_lcd_panel_io_handle_t s_io;
static uint16_t *s_band;
static SemaphoreHandle_t s_band_done;
/* The framebuffer is the text itself: the UI only ever draws characters on
 * a fixed grid, so there is nothing to keep per pixel. */
static char s_fb[DISPLAY_ROWS][DISPLAY_COLS];
/* What the panel actually shows, row by row, so display_flush() only sends
 * rows that changed. Updated only after a row's transfer completes: a
 * failed send leaves it stale, and the next flush sends that row again. */
static char s_shown[DISPLAY_ROWS][DISPLAY_COLS];
static SemaphoreHandle_t s_lock;

void display_lock(void)
{
    if (s_lock != NULL) {
        xSemaphoreTakeRecursive(s_lock, portMAX_DELAY);
    }
}

void display_unlock(void)
{
    if (s_lock != NULL) {
        xSemaphoreGiveRecursive(s_lock);
    }
}

static bool IRAM_ATTR on_band_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *edata, void *ctx)
{
    BaseType_t hpw = pdFALSE;
    xSemaphoreGiveFromISR(s_band_done, &hpw);
    return hpw == pdTRUE;
}

/* Sends s_band to the panel and waits for the DMA transfer to finish
 * before the caller refills it. */
static esp_err_t send_band(int y, int height)
{
    ESP_RETURN_ON_ERROR(esp_lcd_panel_draw_bitmap(s_panel, 0, y, PANEL_H_RES, y + height, s_band), TAG,
                        "draw bitmap failed");
    xSemaphoreTake(s_band_done, portMAX_DELAY);
    return ESP_OK;
}

/* Paints the whole panel background, including the margins around the text
 * grid that display_flush() never revisits. */
static esp_err_t fill_screen_bg(void)
{
    for (size_t i = 0; i < BAND_PIXELS; i++) {
        s_band[i] = COLOR_BG;
    }
    for (int y = 0; y < PANEL_V_RES; y += CELL_H) {
        int height = (y + CELL_H <= PANEL_V_RES) ? CELL_H : (PANEL_V_RES - y);
        ESP_RETURN_ON_ERROR(send_band(y, height), TAG, "background fill failed");
    }
    return ESP_OK;
}

esp_err_t display_init(void)
{
    /* First, so the lock exists even if the panel itself fails to come up —
     * callers draw into the framebuffer regardless. */
    s_lock = xSemaphoreCreateRecursiveMutex();
    display_clear();

    gpio_config_t out_pins = {
        .pin_bit_mask = (1ULL << PIN_POWER_ON) | (1ULL << PIN_LCD_RD) | (1ULL << PIN_LCD_BL),
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&out_pins), TAG, "lcd gpio config failed");
    ESP_RETURN_ON_ERROR(gpio_set_level(PIN_POWER_ON, 1), TAG, "power on failed");
    ESP_RETURN_ON_ERROR(gpio_set_level(PIN_LCD_RD, 1), TAG, "rd park failed");
    /* Backlight stays off until the first frame is on the panel, so boot
     * doesn't start with a flash of whatever was left in the panel's RAM. */
    ESP_RETURN_ON_ERROR(gpio_set_level(PIN_LCD_BL, 0), TAG, "backlight off failed");

    esp_lcd_i80_bus_handle_t bus = NULL;
    esp_lcd_i80_bus_config_t bus_config = {
        .clk_src = LCD_CLK_SRC_DEFAULT,
        .dc_gpio_num = PIN_LCD_DC,
        .wr_gpio_num = PIN_LCD_WR,
        .data_gpio_nums = {
            PIN_LCD_D0, PIN_LCD_D1, PIN_LCD_D2, PIN_LCD_D3,
            PIN_LCD_D4, PIN_LCD_D5, PIN_LCD_D6, PIN_LCD_D7,
        },
        .bus_width = 8,
        .max_transfer_bytes = BAND_BYTES,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_i80_bus(&bus_config, &bus), TAG, "i80 bus init failed");

    esp_lcd_panel_io_i80_config_t io_config = {
        .cs_gpio_num = PIN_LCD_CS,
        .pclk_hz = PCLK_HZ,
        .trans_queue_depth = 2,
        .on_color_trans_done = on_band_done,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .dc_levels = {
            .dc_idle_level = 0,
            .dc_cmd_level = 0,
            .dc_dummy_level = 0,
            .dc_data_level = 1,
        },
        /* Pixels are built as native little-endian uint16_t; the panel
         * wants the high byte of each RGB565 value first. */
        .flags.swap_color_bytes = 1,
    };
    /* Before the IO exists, since on_band_done() is wired into it. */
    s_band_done = xSemaphoreCreateBinary();
    ESP_RETURN_ON_FALSE(s_band_done != NULL, ESP_ERR_NO_MEM, TAG, "band semaphore alloc failed");

    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_i80(bus, &io_config, &s_io), TAG, "panel io init failed");

    s_band = esp_lcd_i80_alloc_draw_buffer(s_io, BAND_BYTES, MALLOC_CAP_DMA);
    ESP_RETURN_ON_FALSE(s_band != NULL, ESP_ERR_NO_MEM, TAG, "band buffer alloc failed");

    esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = PIN_LCD_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_st7789(s_io, &panel_config, &s_panel), TAG, "panel create failed");

    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(s_panel), TAG, "panel reset failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(s_panel), TAG, "panel init failed");
    /* This is an IPS panel: it is wired so that the ST7789's "inverted"
     * mode is the normal one. Without this, text would come out black on
     * white. */
    ESP_RETURN_ON_ERROR(esp_lcd_panel_invert_color(s_panel, true), TAG, "panel invert failed");
    /* Landscape, USB-C port on the left. Swapping both mirror flags
     * (false, true) turns the picture the other way up, for a board held
     * with the port on the right. */
    ESP_RETURN_ON_ERROR(esp_lcd_panel_swap_xy(s_panel, true), TAG, "panel swap failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_mirror(s_panel, true, false), TAG, "panel mirror failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_set_gap(s_panel, 0, PANEL_GAP_Y), TAG, "panel gap failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(s_panel, true), TAG, "panel on failed");

    ESP_RETURN_ON_ERROR(fill_screen_bg(), TAG, "screen clear failed");
    memset(s_shown, ' ', sizeof(s_shown));
    ESP_RETURN_ON_ERROR(gpio_set_level(PIN_LCD_BL, 1), TAG, "backlight on failed");

    ESP_LOGI(TAG, "display ready (%dx%d, %dx%d text grid)", PANEL_H_RES, PANEL_V_RES, DISPLAY_COLS, DISPLAY_ROWS);
    return ESP_OK;
}

void display_clear(void)
{
    memset(s_fb, ' ', sizeof(s_fb));
}

void display_draw_text(uint8_t row, uint8_t col, const char *text)
{
    if (row >= DISPLAY_ROWS) {
        return;
    }
    for (const char *p = text; *p != '\0' && col < DISPLAY_COLS; p++, col++) {
        s_fb[row][col] = *p;
    }
}

/* Renders one text row into s_band: background everywhere, then each
 * glyph's set bits. A character the font doesn't have is drawn as '?'. */
static void render_row(uint8_t row)
{
    for (size_t i = 0; i < BAND_PIXELS; i++) {
        s_band[i] = COLOR_BG;
    }
    for (uint8_t col = 0; col < DISPLAY_COLS; col++) {
        char ch = s_fb[row][col];
        if (ch == ' ') {
            continue;
        }
        uint8_t code = (uint8_t)ch;
        if (code < DISPLAY_FONT_FIRST || code > DISPLAY_FONT_LAST) {
            code = '?';
        }
        const uint8_t *glyph = &display_font8x13[(code - DISPLAY_FONT_FIRST) * DISPLAY_FONT_H];
        int x0 = ORIGIN_X + col * CELL_W;
        for (int gy = 0; gy < DISPLAY_FONT_H; gy++) {
            uint16_t *px = &s_band[gy * PANEL_H_RES + x0];
            for (int gx = 0; gx < DISPLAY_FONT_W; gx++) {
                if (glyph[gy] & (0x80 >> gx)) {
                    px[gx] = COLOR_FG;
                }
            }
        }
    }
}

static volatile uint32_t s_frame_seq;

uint32_t display_frame_seq(void)
{
    return s_frame_seq;
}

esp_err_t display_flush(void)
{
    s_frame_seq++;
    if (s_panel == NULL) {
        return ESP_OK; /* no screen on this board (or init failed) — quietly do nothing */
    }
    for (uint8_t row = 0; row < DISPLAY_ROWS; row++) {
        if (memcmp(s_shown[row], s_fb[row], DISPLAY_COLS) == 0) {
            continue;
        }
        render_row(row);
        ESP_RETURN_ON_ERROR(send_band(ORIGIN_Y + row * CELL_H, CELL_H), TAG, "row %u send failed", row);
        memcpy(s_shown[row], s_fb[row], DISPLAY_COLS);
    }
    return ESP_OK;
}

/* Horizontally centers text on the given row — used everywhere short status
 * text is drawn so it doesn't sit pinned to the left edge with a wall of
 * empty space next to it. Falls back to col 0 for a line too long to
 * center (display_draw_text still clips it at the right edge). */
void display_draw_text_centered(uint8_t row, const char *text)
{
    size_t len = strlen(text);
    uint8_t col = (len < DISPLAY_COLS) ? (uint8_t)((DISPLAY_COLS - len) / 2) : 0;
    display_draw_text(row, col, text);
}

/* The logo, as in web/public/favicon.svg: a rounded square on a 100x100
 * grid, cut by a diagonal into a white left part and a cyan right one.
 * Left part:  x 16..66-(y-18)/2, y 18..82, corners of radius 10 on the left.
 * Right part: x 76-(y-18)/2..84, y 18..82, corners of radius 10 on the right. */
#define LOGO_SCALE   1.3f                   /* panel pixels per logo unit */
#define LOGO_X0      (160.0f - 50 * LOGO_SCALE) /* centered horizontally */
#define LOGO_Y0      (60.0f - 50 * LOGO_SCALE)  /* above the text on row 10 */
#define LOGO_ROW_TEXT 10
#define COLOR_ACCENT_R 0x6b                  /* #6bd6c9, the web app's cyan */
#define COLOR_ACCENT_G 0xd6
#define COLOR_ACCENT_B 0xc9

static bool in_corner(float x, float y, float cx, float cy)
{
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= 100.0f;
}

/* 0 = outside, 1 = left (white) part, 2 = right (cyan) part. */
static int logo_part(float x, float y)
{
    if (y < 18 || y > 82) {
        return 0;
    }
    float cut = (y - 18) / 2;
    if (x >= 16 && x <= 66 - cut) {
        if (x < 26 && y < 28) {
            return in_corner(x, y, 26, 28) ? 1 : 0;
        }
        if (x < 26 && y > 72) {
            return in_corner(x, y, 26, 72) ? 1 : 0;
        }
        return 1;
    }
    if (x <= 84 && x >= 76 - cut) {
        if (x > 74 && y < 28) {
            return in_corner(x, y, 74, 28) ? 2 : 0;
        }
        if (x > 74 && y > 72) {
            return in_corner(x, y, 74, 72) ? 2 : 0;
        }
        return 2;
    }
    return 0;
}

static uint16_t rgb565(unsigned r, unsigned g, unsigned b)
{
    return (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
}

/* Draws the logo into s_band, which holds panel lines y0..y0+CELL_H-1.
 * Each pixel is sampled 4x4 times so the diagonal and the corners are
 * smoothed against the black background. */
static void draw_logo_band(int y0)
{
    for (int by = 0; by < CELL_H; by++) {
        for (int x = 0; x < PANEL_H_RES; x++) {
            unsigned white = 0, cyan = 0;
            for (int sy = 0; sy < 4; sy++) {
                for (int sx = 0; sx < 4; sx++) {
                    float lx = (x + (sx + 0.5f) / 4 - LOGO_X0) / LOGO_SCALE;
                    float ly = (y0 + by + (sy + 0.5f) / 4 - LOGO_Y0) / LOGO_SCALE;
                    int part = logo_part(lx, ly);
                    white += (part == 1);
                    cyan += (part == 2);
                }
            }
            if (white + cyan == 0) {
                continue;
            }
            unsigned r = (white * 0xff + cyan * COLOR_ACCENT_R) / 16;
            unsigned g = (white * 0xff + cyan * COLOR_ACCENT_G) / 16;
            unsigned b = (white * 0xff + cyan * COLOR_ACCENT_B) / 16;
            s_band[by * PANEL_H_RES + x] = rgb565(r, g, b);
        }
    }
}

void display_show_splash(void)
{
    display_lock();
    if (s_panel == NULL) {
        display_unlock();
        return;
    }

    display_clear();
    display_draw_text_centered(LOGO_ROW_TEXT, "QUICK WALLET");
    char version[DISPLAY_COLS + 1] = "v";
    strlcat(version, esp_app_get_description()->version, sizeof(version));
    display_draw_text(DISPLAY_ROWS - 1, 0, version);

    for (uint8_t row = 0; row < DISPLAY_ROWS; row++) {
        render_row(row);
        if (row < LOGO_ROW_TEXT) {
            draw_logo_band(ORIGIN_Y + row * CELL_H);
        }
        if (send_band(ORIGIN_Y + row * CELL_H, CELL_H) != ESP_OK) {
            break;
        }
    }
    /* The logo isn't in the text framebuffer: mark every row as unknown so
     * the next flush repaints the whole screen over it. */
    memset(s_shown, 0, sizeof(s_shown));
    display_unlock();
}

void display_show_status(const char *title, const char *line1, const char *line2)
{
    display_lock();
    display_clear();

    /* Vertically centers the whole title/line1/line2 block in the text
     * rows instead of pinning it to the top — a blank row separates the
     * title from the body, same as before, just placed so the used rows
     * sit in the middle of the screen instead of leaving the bottom half
     * empty. */
    uint8_t used_rows = 0;
    if (title != NULL) {
        used_rows += 1;
        if (line1 != NULL || line2 != NULL) {
            used_rows += 1; /* gap row after the title */
        }
    }
    if (line1 != NULL) {
        used_rows += 1;
    }
    if (line2 != NULL) {
        used_rows += 1;
    }

    uint8_t row = (used_rows < DISPLAY_ROWS) ? (uint8_t)((DISPLAY_ROWS - used_rows) / 2) : 0;
    if (title != NULL) {
        display_draw_text_centered(row, title);
        row += 1;
        if (line1 != NULL || line2 != NULL) {
            row += 1;
        }
    }
    if (line1 != NULL) {
        display_draw_text_centered(row, line1);
        row += 1;
    }
    if (line2 != NULL) {
        display_draw_text_centered(row, line2);
    }

    /* Firmware version, bottom-left, on every status screen — the full-page
     * screens in gatt_svc.c (transaction, seed, sign-in) keep that row for
     * their own hints and don't come through here. */
    char version[DISPLAY_COLS + 1] = "v";
    strlcat(version, esp_app_get_description()->version, sizeof(version));
    display_draw_text(DISPLAY_ROWS - 1, 0, version);

    display_flush();
    display_unlock();
}
