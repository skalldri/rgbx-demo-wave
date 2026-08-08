/*
 * hello — the kitchen-sink test extension, written in plain C against the
 * raw flat ABI (no C++ wrapper) to prove the wire contract independently.
 * It exercises every part of the rgbx surface:
 *
 *  - every parameter type: Speed (UINT32), Color (COLOR), Crash + Hang
 *    (BOOL — the deliberate sandbox-recovery triggers), Message (STRING);
 *  - every input source: IMU (accel tilts the scan head), audio (bottom row
 *    is the 20-bucket spectrum, top row flashes on band beats), buttons
 *    (corner markers light after a press);
 *  - logging from inside the sandbox (printk in rgbx_init).
 *
 * Visuals are drawn at full 255 brightness so the animation stays visible
 * after the pattern controller's global brightness scaling.
 *
 * Sandbox-recovery test hooks (issue #85 demo): setting Crash makes the next
 * tick write to kernel SRAM (a clean MPU fault — not address 0, which is
 * MCUboot's fprotect/SPU-guarded flash and raises a harsher fault class);
 * setting Hang spins past the tick deadline. Either way the firmware must
 * keep running, notify Is Active = false, render the proxy's fault banner,
 * and recover via `ext select`.
 */

#include <rgbx/rgbx_api.h>
#include <zephyr/kernel.h>
#include <zephyr/llext/symbol.h>

#define WIDTH 40u
#define HEIGHT 12u

/* Parameter indices, matching the manifest below. */
#define P_SPEED 0u
#define P_COLOR 1u
#define P_CRASH 2u
#define P_HANG 3u
#define P_MESSAGE 4u

struct rgbx_inputs rgbx_inputs;
uint8_t rgbx_framebuffer[WIDTH * HEIGHT * 3u];
/* OPTIONAL export (see rgbx_api.h "Optional exports"): demos the flat-C path for the
 * shuffle good-switch-point signal — set each tick at the scan-head wrap below. */
uint8_t rgbx_good_moment;

static const struct rgbx_param_desc params[] = {
	RGBX_PARAM("Speed", RGBX_PARAM_UINT32, 50),
	RGBX_PARAM("Color", RGBX_PARAM_COLOR, 0x0000FF80),
	RGBX_PARAM("Crash", RGBX_PARAM_BOOL, 0),
	RGBX_PARAM("Hang", RGBX_PARAM_BOOL, 0),
	RGBX_PARAM_STR("Message", "HELLO"),
};

const struct rgbx_manifest rgbx_manifest = {
    .abi_version = RGBX_ABI_VERSION,
    .name = "Hello Extension",
    .width = WIDTH,
    .height = HEIGHT,
    .param_count = sizeof(params) / sizeof(params[0]),
    .params = params,
};

static uint32_t pos_ms;
static uint32_t button_glow_ms[5]; /* per-button corner marker countdown */

static void set_px(uint32_t x, uint32_t y, uint8_t r, uint8_t g, uint8_t b)
{
	if (x < WIDTH && y < HEIGHT) {
		uint8_t *px = &rgbx_framebuffer[RGBX_PIXEL_INDEX(WIDTH, x, y)];
		px[0] = r;
		px[1] = g;
		px[2] = b;
	}
}

void rgbx_init(void)
{
	pos_ms = 0;
	for (uint32_t i = 0; i < 5u; i++) {
		button_glow_ms[i] = 0;
	}
	printk("hello: rgbx_init running inside the sandbox\n");
}

void rgbx_tick(void)
{
	/* --- BOOL params: the deliberate sandbox-recovery triggers --------- */
	if (rgbx_inputs.params[P_CRASH]) {
		*(volatile uint32_t *)0x20000000 = 1; /* kernel SRAM -> MPU fault */
	}
	if (rgbx_inputs.params[P_HANG]) {
		while (1) { /* deliberate tick-deadline overrun */
		}
	}

	const uint32_t dt = rgbx_inputs.dt_ms;
	pos_ms += dt * rgbx_inputs.params[P_SPEED] / 50u; /* 50 == 1x */

	for (uint32_t i = 0; i < sizeof(rgbx_framebuffer); i++) {
		rgbx_framebuffer[i] = 0;
	}

	/* --- STRING param: one scanning column per Message character ------- */
	const char *msg = rgbx_inputs.param_strings[0]; /* Message is string slot 0 */
	uint32_t nCols = 0;
	uint32_t charSum = 0;
	while (msg[nCols] != '\0' && nCols < WIDTH) {
		charSum += (uint32_t)msg[nCols];
		nCols++;
	}
	if (nCols == 0) {
		nCols = 1;
	}

	/* --- COLOR param, hash-tinted by the message ------------------------ */
	const uint32_t color = rgbx_inputs.params[P_COLOR];
	const uint8_t cr = ((color >> 16) & 0xFF) ^ (uint8_t)(charSum * 37u);
	const uint8_t cg = ((color >> 8) & 0xFF) ^ (uint8_t)(charSum * 101u);
	const uint8_t cb = (color & 0xFF) ^ (uint8_t)(charSum * 197u);

	/* --- IMU: accel X tilts the bright scan head up/down ---------------- */
	int32_t tilt = (int32_t)(rgbx_inputs.accel[0]); /* ~±10 m/s^2 -> ±10 */
	if (tilt > 5) {
		tilt = 5;
	}
	if (tilt < -5) {
		tilt = -5;
	}

	const uint32_t base = (pos_ms / 50u) % WIDTH;
	for (uint32_t c = 0; c < nCols; c++) {
		const uint32_t x = (base + c * (WIDTH / nCols)) % WIDTH;
		for (uint32_t y = 1; y + 1 < HEIGHT; y++) {
			set_px(x, y, cr / 2, cg / 2, cb / 2);
		}
		const uint32_t headY = (uint32_t)((int32_t)(HEIGHT / 2) + tilt);
		set_px(x, headY, cr, cg, cb);
	}

	/* Shuffle's good-moment signal (issue #121): the scan-head wrapping back to
	 * column 0 is this animation's natural cycle boundary. */
	rgbx_good_moment = (base == 0u) ? 1u : 0u;

	/* --- audio: bottom row = 20-bucket spectrum, top row = beat flash --- */
	for (uint32_t bkt = 0; bkt < RGBX_AUDIO_NUM_DISPLAY_BUCKETS; bkt++) {
		float e = rgbx_inputs.audio_display_bucket[bkt];
		if (e < 0.0f) {
			e = 0.0f;
		}
		if (e > 1.0f) {
			e = 1.0f;
		}
		const uint8_t v = (uint8_t)(e * 255.0f);
		set_px(bkt * 2u, HEIGHT - 1u, v, v, 0);
		set_px(bkt * 2u + 1u, HEIGHT - 1u, v, v, 0);
	}
	for (uint32_t band = 0; band < RGBX_AUDIO_NUM_BANDS; band++) {
		if (rgbx_inputs.audio_beat[band]) {
			for (uint32_t x = band * (WIDTH / 4u); x < (band + 1u) * (WIDTH / 4u); x++) {
				set_px(x, 0, 255, 255, 255);
			}
		}
	}

	/* --- buttons: corner (and center for wake) markers glow ~500 ms ----- */
	static const uint32_t corner[5][2] = {
	    {0, 0}, {0, HEIGHT - 1u}, {WIDTH - 1u, 0}, {WIDTH - 1u, HEIGHT - 1u}, {WIDTH / 2u, 0}};
	for (uint32_t b = 0; b < 5u; b++) {
		if (rgbx_inputs.buttons_pressed & (1u << b)) {
			button_glow_ms[b] = 500u;
		}
		if (button_glow_ms[b] > 0) {
			button_glow_ms[b] = (button_glow_ms[b] > dt) ? button_glow_ms[b] - dt : 0u;
			set_px(corner[b][0], corner[b][1], 255, 255, 255);
		}
	}
}

EXPORT_SYMBOL(rgbx_manifest);
EXPORT_SYMBOL(rgbx_inputs);
EXPORT_SYMBOL(rgbx_framebuffer);
EXPORT_SYMBOL(rgbx_init);
EXPORT_SYMBOL(rgbx_tick);
EXPORT_SYMBOL(rgbx_good_moment);
