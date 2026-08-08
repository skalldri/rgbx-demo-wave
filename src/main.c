/*
 * demo_wave — the worked example for standalone rgbx extension repos.
 *
 * A sine wave rolls across the panel, its crest color set by a COLOR
 * parameter and its speed by a UINT32 parameter; the wave amplitude reacts
 * to audio energy (band 0), and a beat on any band fires a full-column
 * flash at the crest. Uses real sinf(): firmware v3.1.0+ exports
 * single-precision libm to extensions (the SDK's build gate verifies the
 * exact callable surface — double-precision math is still rejected, so
 * keep float literals f-suffixed).
 *
 * Built from the rgbx-extension-template; registered in the rgb-sunglasses
 * repo's extensions/registry.json as the registry's seed entry.
 */

#include <rgbx/rgbx_api.h>
#include <zephyr/llext/symbol.h>
#include <math.h>

#define WIDTH 40u
#define HEIGHT 12u

#define P_SPEED 0u
#define P_COLOR 1u

#define TAU 6.2831853f

struct rgbx_inputs rgbx_inputs;
uint8_t rgbx_framebuffer[WIDTH * HEIGHT * 3u];
uint8_t rgbx_good_moment;

static const struct rgbx_param_desc params[] = {
	RGBX_PARAM("Speed", RGBX_PARAM_UINT32, 50),
	RGBX_PARAM("Color", RGBX_PARAM_COLOR, 0x0020FF60),
};

const struct rgbx_manifest rgbx_manifest = {
    .abi_version = RGBX_ABI_VERSION,
    .name = "Demo Wave",
    .width = WIDTH,
    .height = HEIGHT,
    .param_count = sizeof(params) / sizeof(params[0]),
    .params = params,
};

static uint32_t phase_ms;

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
	phase_ms = 0;
}

void rgbx_tick(void)
{
	phase_ms += rgbx_inputs.dt_ms * rgbx_inputs.params[P_SPEED] / 50u;

	for (uint32_t i = 0; i < sizeof(rgbx_framebuffer); i++) {
		rgbx_framebuffer[i] = 0;
	}

	const uint32_t color = rgbx_inputs.params[P_COLOR];
	const uint8_t cr = (color >> 16) & 0xFF;
	const uint8_t cg = (color >> 8) & 0xFF;
	const uint8_t cb = color & 0xFF;

	/* Audio energy in the lowest band swells the wave amplitude. */
	float energy = rgbx_inputs.audio_display_bucket[0];
	if (energy < 0.0f) {
		energy = 0.0f;
	}
	if (energy > 1.0f) {
		energy = 1.0f;
	}
	const float amp = 2.0f + energy * ((float)(HEIGHT / 2u) - 1.0f);

	uint32_t beat = 0;
	for (uint32_t band = 0; band < RGBX_AUDIO_NUM_BANDS; band++) {
		beat |= rgbx_inputs.audio_beat[band];
	}

	const float t = (float)phase_ms * 0.001f;
	const uint32_t crest_x = (phase_ms / 40u) % WIDTH;
	for (uint32_t x = 0; x < WIDTH; x++) {
		const float fx = (float)x / (float)WIDTH;
		/* One real sine across the panel, rolling with time. */
		const float off = sinf(fx * TAU + t * TAU * 0.25f) * amp;
		const uint32_t mid = HEIGHT / 2u;
		const uint32_t y = (uint32_t)((int32_t)mid + (int32_t)off);

		/* Crest pixel at full scale; one dimmer pixel above and below
		 * for body. Full-scale rendering matters: the firmware scales
		 * everything by a global brightness factor (default 0.02).
		 */
		set_px(x, y, cr, cg, cb);
		set_px(x, y - 1u, cr / 3, cg / 3, cb / 3);
		set_px(x, y + 1u, cr / 3, cg / 3, cb / 3);

		if (beat && x == crest_x) {
			for (uint32_t fy = 0; fy < HEIGHT; fy++) {
				set_px(x, fy, 255, 255, 255);
			}
		}
	}

	/* Shuffle's good-switch-point: the wave phase wrapping. */
	rgbx_good_moment = (crest_x == 0u) ? 1u : 0u;
}

EXPORT_SYMBOL(rgbx_manifest);
EXPORT_SYMBOL(rgbx_inputs);
EXPORT_SYMBOL(rgbx_framebuffer);
EXPORT_SYMBOL(rgbx_init);
EXPORT_SYMBOL(rgbx_tick);
EXPORT_SYMBOL(rgbx_good_moment);
