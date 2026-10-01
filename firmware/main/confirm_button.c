#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "confirm_button.h"

static const char *TAG = "confirm_button";

/* Counted from the release, which is itself only taken after
 * RELEASE_STABLE_MS of steady high, so this can be short enough for quick
 * taps through a list. */
#define DEBOUNCE_US 50000
#define POLL_MS 10
#define RELEASE_STABLE_MS 30

static QueueHandle_t s_evt_queue;
static confirm_button_cb_t s_cb;
static void *s_cb_arg;
static gpio_num_t s_pin;

static void IRAM_ATTR gpio_isr_handler(void *arg)
{
    uint32_t gpio_num = (uint32_t)(uintptr_t)arg;
    BaseType_t hpw = pdFALSE;
    xQueueSendFromISR(s_evt_queue, &gpio_num, &hpw);
    if (hpw) {
        portYIELD_FROM_ISR();
    }
}

/* Samples the pin rather than trusting edges once a press has begun: a
 * bouncing contact produces a burst of them, and the only question that
 * matters is how long the pin stayed low. */
static void button_task(void *arg)
{
    uint32_t io_num;
    int64_t last_press_us = 0;

    for (;;) {
        if (xQueueReceive(s_evt_queue, &io_num, portMAX_DELAY)) {
            int64_t now = esp_timer_get_time();
            if (now - last_press_us < DEBOUNCE_US) {
                continue;
            }
            if (gpio_get_level((gpio_num_t)io_num) != 0) {
                continue; /* not actually low anymore -> noise */
            }
            last_press_us = now;

            /* Released means high for RELEASE_STABLE_MS in a row, so a
             * bounce mid-press doesn't end it early. */
            bool long_press = false;
            int high_ms = 0;
            while (high_ms < RELEASE_STABLE_MS) {
                vTaskDelay(pdMS_TO_TICKS(POLL_MS));
                high_ms = gpio_get_level((gpio_num_t)io_num) != 0 ? high_ms + POLL_MS : 0;
                if (high_ms == 0 && esp_timer_get_time() - now >= CONFIRM_BUTTON_LONG_MS * 1000LL) {
                    long_press = true;
                    break;
                }
            }
            ESP_LOGI(TAG, "%s press on GPIO%u", long_press ? "long" : "short", (unsigned)io_num);
            if (s_cb != NULL) {
                s_cb(long_press, s_cb_arg);
            }
            if (long_press) {
                /* The rest of this hold is not a second press. */
                while (gpio_get_level((gpio_num_t)io_num) == 0) {
                    vTaskDelay(pdMS_TO_TICKS(POLL_MS));
                }
            }
            /* Edges queued by the bouncing above belong to this press. */
            xQueueReset(s_evt_queue);
            last_press_us = esp_timer_get_time();
        }
    }
}

void confirm_button_init(gpio_num_t pin, confirm_button_cb_t cb, void *arg)
{
    s_cb = cb;
    s_cb_arg = arg;
    s_pin = pin;

    gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << pin,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_NEGEDGE,
    };
    ESP_ERROR_CHECK(gpio_config(&cfg));

    s_evt_queue = xQueueCreate(4, sizeof(uint32_t));
    ESP_ERROR_CHECK(gpio_install_isr_service(0));
    ESP_ERROR_CHECK(gpio_isr_handler_add(s_pin, gpio_isr_handler, (void *)(uintptr_t)s_pin));

    /* This task's callback signs (ed25519_sign()), sends a BLE notify and
     * drives the display over the i80 LCD bus (esp_lcd_panel_draw_bitmap + font rendering)
     * via gatt_svc_set_status(). 2560 bytes covers the first two but
     * overflows once the display is involved, so the stack has real headroom
     * rather than the minimum that happens to pass. */
    xTaskCreate(button_task, "confirm_button_task", 6144, NULL, 10, NULL);
}
