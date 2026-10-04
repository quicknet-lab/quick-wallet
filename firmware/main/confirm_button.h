#pragma once

#include <stdbool.h>
#include "driver/gpio.h"

/* long_press: held for CONFIRM_BUTTON_LONG_MS. A short press is reported
 * when the button is released, a long one as soon as it has been held that
 * long — so holding it gives feedback without waiting for the release. */
typedef void (*confirm_button_cb_t)(bool long_press, void *arg);

#define CONFIRM_BUTTON_LONG_MS 1000

/* Button must short pin to GND; internal pull-up is enabled, no external
 * resistor needed. Debounced in software. */
void confirm_button_init(gpio_num_t pin, confirm_button_cb_t cb, void *arg);
