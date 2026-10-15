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

#define COLOR_BG COLOR_BLACK

/* One band = BAND_H panel lines, full width: 10 bands make the 170-line
 * frame. Small enough to sit in internal DMA memory (11KB) rather than
 * keeping a whole 106KB RGB565 frame around. */
#define BAND_H      17
#define BAND_PIXELS (PANEL_H_RES * BAND_H)
#define BAND_BYTES  (BAND_PIXELS * sizeof(uint16_t))

static esp_lcd_panel_handle_t s_panel;
static esp_lcd_panel_io_handle_t s_io;
static uint16_t *s_band;
static SemaphoreHandle_t s_band_done;

/* The frame is a list of what to draw, not pixels: each band is rendered
 * from it just before being sent. Sized for the busiest screen (the seed
 * page: a header and 48 text runs) with room to spare; anything past that
 * is a layout bug, logged and dropped. */
#define MAX_OPS   96
#define TEXT_POOL 2048
enum op_kind { OP_FILL, OP_TEXT, OP_LOGO };
struct op {
    uint8_t kind;
    int16_t x, y, w, h;
    uint16_t color;
    const display_font_t *font;
    uint16_t text_off, text_len;
};
static struct op s_ops[MAX_OPS];
static size_t s_n_ops;
static char s_text[TEXT_POOL];
static size_t s_text_used;
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

static esp_err_t paint_frame(void);

esp_err_t display_init(void)
{
    /* First, so the lock exists even if the panel itself fails to come up —
     * callers compose frames regardless. */
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

    /* The frame is still empty (display_clear() above): this blanks the
     * panel before the backlight comes on. */
    ESP_RETURN_ON_ERROR(paint_frame(), TAG, "screen clear failed");
    ESP_RETURN_ON_ERROR(gpio_set_level(PIN_LCD_BL, 1), TAG, "backlight on failed");

    ESP_LOGI(TAG, "display ready (%dx%d)", PANEL_H_RES, PANEL_V_RES);
    return ESP_OK;
}


const display_font_t display_font_s = {8, 16, display_font_s_bits};
const display_font_t display_font_s_bold = {8, 16, display_font_s_bold_bits};
const display_font_t display_font_m = {12, 24, display_font_m_bits};
const display_font_t display_font_l = {16, 32, display_font_l_bits};

#define FONT_FIRST 0x20
#define FONT_LAST  0x7E

void display_clear(void)
{
    s_n_ops = 0;
    s_text_used = 0;
}

static struct op *add_op(enum op_kind kind)
{
    if (s_n_ops >= MAX_OPS) {
        ESP_LOGE(TAG, "frame full, element dropped");
        return NULL;
    }
    struct op *op = &s_ops[s_n_ops++];
    memset(op, 0, sizeof(*op));
    op->kind = kind;
    return op;
}

void display_fill(int x, int y, int w, int h, uint16_t color)
{
    struct op *op = add_op(OP_FILL);
    if (op != NULL) {
        op->x = (int16_t)x;
        op->y = (int16_t)y;
        op->w = (int16_t)w;
        op->h = (int16_t)h;
        op->color = color;
    }
}

int display_text_width(const display_font_t *font, const char *text)
{
    return (int)strlen(text) * font->w;
}

int display_text(int x, int y, const display_font_t *font, uint16_t color, const char *text)
{
    size_t len = strlen(text);
    int end = x + (int)len * font->w;
    if (len == 0) {
        return end;
    }
    if (len > TEXT_POOL - s_text_used) {
        ESP_LOGE(TAG, "frame text full, element dropped");
        return end;
    }
    struct op *op = add_op(OP_TEXT);
    if (op != NULL) {
        op->x = (int16_t)x;
        op->y = (int16_t)y;
        op->color = color;
        op->font = font;
        op->text_off = (uint16_t)s_text_used;
        op->text_len = (uint16_t)len;
        memcpy(&s_text[s_text_used], text, len);
        s_text_used += len;
    }
    return end;
}

void display_text_centered(int y, const display_font_t *font, uint16_t color, const char *text)
{
    int w = display_text_width(font, text);
    display_text(w < DISPLAY_W ? (DISPLAY_W - w) / 2 : 0, y, font, color, text);
}

void display_header(const char *title, uint16_t color)
{
    display_fill(0, 0, DISPLAY_W, DISPLAY_HEADER_H, color);
    display_text_centered((DISPLAY_HEADER_H - FONT_S_BOLD->h) / 2, FONT_S_BOLD, COLOR_BLACK, title);
}

void display_footer(const char *hint, bool commits, bool testnet)
{
    if (testnet) {
        display_fill(0, DISPLAY_FOOTER_Y, 9 * FONT_S_BOLD->w, DISPLAY_H - DISPLAY_FOOTER_Y, COLOR_ORANGE);
        display_text(FONT_S_BOLD->w / 2, DISPLAY_FOOTER_Y, FONT_S_BOLD, COLOR_BLACK, "TESTNET");
    }
    if (commits) {
        display_text_centered(DISPLAY_FOOTER_Y, FONT_S_BOLD, COLOR_ACCENT, hint);
    } else {
        display_text_centered(DISPLAY_FOOTER_Y, FONT_S, COLOR_GRAY, hint);
    }
}

/* Rasterizes the part of a text run that falls on the band holding panel
 * lines band_y..band_y+BAND_H-1. A character the font doesn't have is drawn
 * as '?'. */
static void render_text(const struct op *op, int band_y)
{
    const display_font_t *f = op->font;
    const int stride = (f->w + 7) / 8;
    const int gy0 = (band_y > op->y) ? band_y - op->y : 0;
    const int gy1 = (band_y + BAND_H - op->y < f->h) ? band_y + BAND_H - op->y : f->h;
    if (gy0 >= gy1) {
        return;
    }
    int x = op->x;
    for (size_t i = 0; i < op->text_len && x < PANEL_H_RES; i++, x += f->w) {
        uint8_t code = (uint8_t)s_text[op->text_off + i];
        if (code == ' ' || x + f->w <= 0) {
            continue;
        }
        if (code < FONT_FIRST || code > FONT_LAST) {
            code = '?';
        }
        const uint8_t *glyph = &f->bits[(code - FONT_FIRST) * f->h * stride];
        for (int gy = gy0; gy < gy1; gy++) {
            const uint8_t *bits = &glyph[gy * stride];
            uint16_t *line = &s_band[(op->y + gy - band_y) * PANEL_H_RES];
            for (int gx = 0; gx < f->w; gx++) {
                int px = x + gx;
                if ((bits[gx >> 3] & (0x80 >> (gx & 7))) && px >= 0 && px < PANEL_H_RES) {
                    line[px] = op->color;
                }
            }
        }
    }
}

static void render_fill(const struct op *op, int band_y)
{
    int x0 = op->x < 0 ? 0 : op->x;
    int x1 = (op->x + op->w > PANEL_H_RES) ? PANEL_H_RES : op->x + op->w;
    int y0 = op->y > band_y ? op->y : band_y;
    int y1 = (op->y + op->h < band_y + BAND_H) ? op->y + op->h : band_y + BAND_H;
    for (int y = y0; y < y1; y++) {
        for (int x = x0; x < x1; x++) {
            s_band[(y - band_y) * PANEL_H_RES + x] = op->color;
        }
    }
}

static void render_logo(int band_y);

/* Renders the frame band by band and sends each one. */
static esp_err_t paint_frame(void)
{
    for (int y = 0; y < PANEL_V_RES; y += BAND_H) {
        for (size_t i = 0; i < BAND_PIXELS; i++) {
            s_band[i] = COLOR_BG;
        }
        for (size_t i = 0; i < s_n_ops; i++) {
            switch (s_ops[i].kind) {
            case OP_FILL:
                render_fill(&s_ops[i], y);
                break;
            case OP_TEXT:
                render_text(&s_ops[i], y);
                break;
            case OP_LOGO:
                render_logo(y);
                break;
            }
        }
        ESP_RETURN_ON_ERROR(send_band(y, BAND_H), TAG, "band at line %d send failed", y);
    }
    return ESP_OK;
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
    return paint_frame();
}

/* The logo, as in web/public/favicon.svg: a rounded square on a 100x100
 * grid, cut by a diagonal into a white left part and a cyan right one.
 * Left part:  x 16..66-(y-18)/2, y 18..82, corners of radius 10 on the left.
 * Right part: x 76-(y-18)/2..84, y 18..82, corners of radius 10 on the right. */
#define LOGO_SCALE   1.3f                       /* panel pixels per logo unit */
#define LOGO_X0      (160.0f - 50 * LOGO_SCALE) /* centered horizontally */
#define LOGO_Y0      (55.0f - 50 * LOGO_SCALE)  /* above the name */
#define LOGO_TEXT_Y  116
/* Panel pixels the logo can touch: units 16..84 by 18..82. */
#define LOGO_PX_X0   ((int)(LOGO_X0 + 16 * LOGO_SCALE))
#define LOGO_PX_X1   ((int)(LOGO_X0 + 84 * LOGO_SCALE) + 2)
#define LOGO_PX_Y0   ((int)(LOGO_Y0 + 18 * LOGO_SCALE))
#define LOGO_PX_Y1   ((int)(LOGO_Y0 + 82 * LOGO_SCALE) + 2)
#define COLOR_ACCENT_R 0x6b                      /* #6bd6c9, the web app's cyan */
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

/* Draws the logo's part of the band. Each pixel is sampled 4x4 times so
 * the diagonal and the corners are smoothed against the black
 * background. */
static void render_logo(int band_y)
{
    for (int by = 0; by < BAND_H; by++) {
        int y = band_y + by;
        if (y < LOGO_PX_Y0 || y >= LOGO_PX_Y1) {
            continue;
        }
        for (int x = LOGO_PX_X0; x < LOGO_PX_X1; x++) {
            unsigned white = 0, cyan = 0;
            for (int sy = 0; sy < 4; sy++) {
                for (int sx = 0; sx < 4; sx++) {
                    float lx = (x + (sx + 0.5f) / 4 - LOGO_X0) / LOGO_SCALE;
                    float ly = (y + (sy + 0.5f) / 4 - LOGO_Y0) / LOGO_SCALE;
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
            s_band[by * PANEL_H_RES + x] = DISPLAY_RGB(r, g, b);
        }
    }
}

/* Firmware version, small and gray in the bottom-left corner. */
static void draw_version(void)
{
    char version[40] = "v";
    strlcat(version, esp_app_get_description()->version, sizeof(version));
    display_text(4, DISPLAY_FOOTER_Y, FONT_S, COLOR_GRAY, version);
}

void display_show_splash(void)
{
    display_lock();
    display_clear();
    add_op(OP_LOGO);
    display_text_centered(LOGO_TEXT_Y, FONT_M, COLOR_WHITE, "QUICK WALLET");
    draw_version();
    display_flush();
    display_unlock();
}

void display_show_status(uint16_t color, const char *title, const char *line1, const char *line2)
{
    display_lock();
    display_clear();
    display_header(title, color);

    const uint16_t message_color = (color == COLOR_ACCENT) ? COLOR_WHITE : color;
    if (line1 != NULL) {
        /* One short word on its own ("Signed", "Ready") reads at a glance
         * in the large font; anything with a second line stays in FONT_M so
         * the two sit together. */
        const display_font_t *font =
            (line2 == NULL && display_text_width(FONT_L, line1) <= DISPLAY_W) ? FONT_L : FONT_M;
        const int y = (line2 != NULL) ? 52 : 64;
        display_text_centered(y, font, message_color, line1);
        if (line2 != NULL) {
            display_text_centered(y + font->h + 10, FONT_S, COLOR_GRAY, line2);
        }
    }

    /* Firmware version on every status screen — the full-page screens in
     * gatt_svc.c (transaction, seed, sign-in) keep that row for their own
     * hints and don't come through here. */
    draw_version();

    display_flush();
    display_unlock();
}
