/*
 * SPDX-License-Identifier: MIT
 *
 * Copyright (c) 2026 Stuart Alldritt
 *
 * demo_wave, RGBX v2 guest.
 *
 * The same rolling sine wave as src/main.c, evaluated in integer fixed point.
 * An RGBX v2 guest gets no linear memory, no libm and no floating-point
 * opcodes, so sinf() becomes a range-reduced odd polynomial in Q24, the
 * framebuffer becomes 60 ordered set_span8 calls, and the audio energy and
 * beat that drove the animation through struct rgbx_inputs are read through
 * the capability-gated input_u32 import instead.
 *
 * This file is the canonical RGBX v2 demo_wave. The intent is that the
 * firmware repository consumes this repository at a pinned revision rather
 * than carrying a second copy of the animation; nothing here asserts that it
 * does so today. What the pin would rest on is already true: the module bytes
 * are the byte-for-byte output of the pinned SDK toolchain over these bytes,
 * so changing the arithmetic changes the animation on every device that ships
 * it. Any edit therefore has to come with a re-derived expectation in
 * tests/rgbx-v2-parity.mjs rather than a refreshed golden.
 *
 * Full MIT permission notice: LICENSE at the repository root.
 */
#include <rgbx/rgbx_v2.h>
#include <stdint.h>

#define WIDTH RGBX_V2_WIDTH
#define HEIGHT RGBX_V2_HEIGHT

/* Parameter slots, in the order rgbx-v2.json declares them. They are the same
 * two slots, in the same order, as the RGBX_PARAM table in src/main.c, so a
 * device that already stores a user's Speed and Color for the .llext build
 * keeps them for the package. */
#define P_SPEED 0u
#define P_COLOR 1u

/* Phase-accumulator wrap period, in ms.
 *
 * phase_ms has two consumers with different periods, and the wrap has to be
 * seamless for both: the sine rolls at TAU*0.25 rad/s (period 4000 ms) and
 * crest_x steps every 40 ms across WIDTH columns (period 1600 ms). 8000 ms is
 * their lcm, so both resume exactly where they left off, with no rounding
 * error. This is the period src/main.c chose and the reasoning it chose it
 * for; the port keeps both.
 *
 * The bound is load-bearing here for a second reason. src/main.c needed it to
 * keep picolibc's sinf() on its cheap Cody-Waite argument reduction; this
 * guest has no libm, but it does carry the wave angle in a signed 32-bit Q24
 * value. The largest angle it ever forms is
 *
 *   TAU_Q24 * (100*(WIDTH-1) + PHASE_PERIOD_MS-1) / 4000
 *     = 105414357 * 11899 / 4000 = 313581358,
 *
 * about 15% of INT32_MAX. A free-running accumulator at 1x Speed would pass
 * INT32_MAX about 78 s after activation and wrap the angle into nonsense.
 */
#define PHASE_PERIOD_MS 8000u

/* Fixed-point scales.
 *
 * Angles and the wave offset are carried in Q24 (one unit = 2^-24), the
 * amplitude in Q24 as well, and the sine polynomial's Horner accumulator in
 * Q36. Q24 rather than the Q15 the plasma extension uses for its wave, because
 * the two animations quantize their result at very different resolutions:
 * plasma turns its wave into an 8-bit luma, where one output level is 1/42.5
 * of a wave unit, while this animation truncates the wave offset to a whole
 * panel row. A row boundary has no tolerance at all, so the offset is carried
 * with as much precision as int32 intermediates allow.
 *
 * TAU is src/main.c's literal 6.2831853f, not 2*pi, so that this file states
 * the same constant the animation it ports states. The two differ by 7.2e-9
 * rad, which is under an eighth of the 6.0e-8 rad a Q24 angle can resolve.
 *
 *   TAU_Q24      = round(6.2831853 * 2^24) = 105414357
 *   PI_Q24       = round(6.2831853 / 2 * 2^24) = 52707178
 *   HALF_PI_Q24  = round(6.2831853 / 4 * 2^24) = 26353589
 *
 * The half and quarter turns are rounded from the literal rather than halved
 * from TAU_Q24, so each is the closest Q24 value to the angle it names.
 */
#define TAU_Q24 105414357
#define PI_Q24 52707178
#define HALF_PI_Q24 26353589

/* Round-to-nearest arithmetic right shift, ties away from zero. Every product
 * below is formed in int64 and brought back through this, so the rounding rule
 * is stated once. It returns int64 because the sine's Horner accumulator is a
 * Q36 value that does not fit int32; callers whose result is known to fit cast
 * it back, and the bound that lets them is written down at each one. */
static inline __attribute__((always_inline)) int64_t round_shift(int64_t value, uint32_t shift) {
    const int64_t half = (int64_t)1 << (shift - 1u);
    return value >= 0 ? (value + half) >> shift : -((-value + half) >> shift);
}

/*
 * sin(x) for x in Q24, returned in Q24.
 *
 * Range-reduce into [-pi/2, pi/2] by symmetry, then evaluate the odd Maclaurin
 * series of sin through x^13 as x * factor(x^2), with factor in Q36:
 *
 *   factor(u) = 1 - u/6 + u^2/120 - u^3/5040 + u^4/362880 - u^5/39916800
 *               + u^6/6227020800
 *
 * The coefficients are round(2^36 / (2k+1)!), alternating in sign:
 *
 *   1/1     -> 68719476736      1/5040       -> 13634817
 *   1/6     -> 11453246123      1/362880     -> 189372
 *   1/120   -> 572662306        1/39916800   -> 1722
 *                               1/6227020800 -> 11
 *
 * Two choices here are worth stating, because a cheaper version of each was
 * tried first and is visible in the output.
 *
 * Q36 rather than the Q30 the plasma guest uses: at Q30 the last two
 * coefficients round to 27 and 0, so the series cannot be carried past x^11 at
 * all, and rounding the rest to Q30 already costs up to 1.1e-7 in the sine.
 * At Q36 the same rounding costs at most 4.3e-9, and 1/6227020800 is still
 * representable.
 *
 * Through x^13 rather than x^11: truncating after x^11 leaves |x|^13/13! =
 * 5.8e-8 on [-pi/2, pi/2], and the series alternates, so the shortfall is
 * one-sided and largest exactly at the peak. That is enough to make
 * sin(pi/2) come back as 16777215 instead of 16777216, which truncates the
 * crest of the wave one row down at the column nearest the peak: a visible
 * pixel, not a rounding curiosity. Through x^13 the truncation is |x|^15/15! =
 * 6.8e-10, about a ninetieth of the 6.0e-8 that one Q24 unit of the result is
 * worth, and the peak comes back exact.
 *
 * Measured over every one of the 320000 angles this animation can form (40
 * columns at each of the 8000 phases in the period), the worst error against
 * the true sine is 1.65 Q24 units, or 9.9e-8. What is left is the Q24
 * rounding of the angle and of the result, not the series.
 *
 * Intermediates, at the widest argument |x| = HALF_PI_Q24 = 26353589:
 *   x*x                 = 6.9e14, int64
 *   x^2 in Q24          = 41396120, int32
 *   x^2 * Horner term   = 4.8e17, int64
 *   x * factor          = 1.8e18, int64
 * so every product is formed in int64, x^2 and the result fit int32, and the
 * Horner accumulator stays int64.
 */
static __attribute__((noinline)) int32_t bounded_sin_q24(int32_t angle_q24) {
    int32_t x = angle_q24 % TAU_Q24;
    if (x > PI_Q24) {
        x -= TAU_Q24;
    } else if (x < -PI_Q24) {
        x += TAU_Q24;
    }
    if (x > HALF_PI_Q24) {
        x = PI_Q24 - x;
    } else if (x < -HALF_PI_Q24) {
        x = -PI_Q24 - x;
    }

    const int32_t x2_q24 = (int32_t)round_shift((int64_t)x * x, 24);
    int64_t polynomial_q36 = 11;
    polynomial_q36 = -1722 + round_shift((int64_t)x2_q24 * polynomial_q36, 24);
    polynomial_q36 = 189372 + round_shift((int64_t)x2_q24 * polynomial_q36, 24);
    polynomial_q36 = -13634817 + round_shift((int64_t)x2_q24 * polynomial_q36, 24);
    polynomial_q36 = 572662306 + round_shift((int64_t)x2_q24 * polynomial_q36, 24);
    polynomial_q36 = -11453246123 + round_shift((int64_t)x2_q24 * polynomial_q36, 24);
    const int64_t factor_q36 = 68719476736 + round_shift((int64_t)x2_q24 * polynomial_q36, 24);
    /* x * factor is 2^36 * sin(x), and |sin| <= 1, so the Q24 result is at
     * most 2^24 and fits int32. */
    return (int32_t)round_shift((int64_t)x * factor_q36, 36);
}

/*
 * The row the crest sits on in column x, as a signed row index.
 *
 * src/main.c computes, with fx = x/WIDTH and t = phase_ms/1000,
 *
 *   off = sinf(fx*TAU + t*TAU*0.25) * amp
 *   y   = (uint32_t)((int32_t)(HEIGHT/2) + (int32_t)off)
 *
 * The angle is exactly TAU * (x/WIDTH + phase_ms/4000), and with WIDTH = 40
 * that is TAU * (100*x + phase_ms) / 4000, an exact rational in the two
 * integers the guest already holds. Forming it that way, in one rounded 64-bit
 * division, keeps the angle within half a Q24 unit (3e-8 rad) of the real
 * value instead of accumulating a per-column step error.
 *
 * (int32_t)off truncates toward zero, so the shift back to whole rows has to
 * truncate toward zero as well rather than floor.
 */
static inline __attribute__((always_inline)) int32_t crest_row(uint32_t x, uint32_t phase_ms,
                                                               int32_t amp_q24) {
    const int32_t angle_q24 =
        (int32_t)(((uint64_t)TAU_Q24 * (uint64_t)(100u * x + phase_ms) + 2000u) / 4000u);
    /* |sin| <= 2^24 and amp_q24 <= 7*2^24, so the offset fits int32. */
    const int32_t offset_q24 =
        (int32_t)round_shift((int64_t)bounded_sin_q24(angle_q24) * amp_q24, 24);
    const int32_t rows = offset_q24 >= 0 ? (offset_q24 >> 24) : -((-offset_q24) >> 24);
    return (int32_t)(HEIGHT / 2u) + rows;
}

/*
 * The colour of one pixel, as the 0x00RRGGBB set_span8 wants.
 *
 * src/main.c paints the crest pixel at full scale, one dimmer pixel above and
 * below it for body, and then, on a beat, overwrites the whole crest column
 * white. Its set_px() drops any write outside the panel, and its row index is
 * an unsigned value, so a crest row of -1 arrives as 0xFFFFFFFF and is
 * dropped, exactly as a row of 13 is. Comparing a signed crest row against a
 * row that is always 0..HEIGHT-1 reproduces that: no in-panel row can equal a
 * negative crest row or one at HEIGHT or beyond.
 *
 * The flash is folded into flash_x, which the caller sets to the crest column
 * on a beat and to WIDTH otherwise. WIDTH is not a column, so the comparison
 * is simply false when there is no beat.
 *
 * noinline is a size requirement, not a style choice. The released memoryless
 * profile caps a module at 2048 bytes; letting this inline into the eight
 * arguments of every set_span8 call produces 2161 bytes and the SDK gate
 * refuses it. As one function it is 1217.
 *
 * Two budgets a later edit here has to respect. This function calls
 * bounded_sin_q24() once per PIXEL, 480 times a frame rather than 40: a guest
 * has no linear memory and at most 8 globals, so there is nowhere to hold the
 * 40 crest rows across the rows that reuse them, and the span order is fixed
 * row-major. And the module already defines 4 functions against 4 imports,
 * which is exactly the 8 the profile admits, so a new helper that does not
 * inline fails admission rather than merely growing the file.
 */
static __attribute__((noinline)) uint32_t wave_pixel(uint32_t x, int32_t row,
                                                                 uint32_t phase_ms,
                                                                 int32_t amp_q24, uint32_t flash_x,
                                                                 uint32_t crest_colour,
                                                                 uint32_t body_colour) {
    if (x == flash_x) {
        return 0x00ffffffu;
    }
    const int32_t crest = crest_row(x, phase_ms, amp_q24);
    if (row == crest) {
        return crest_colour;
    }
    if (row == crest - 1 || row == crest + 1) {
        return body_colour;
    }
    return 0u;
}

static __attribute__((address_space(1))) uint32_t phase_ms;

RGBX_V2_EXPORT("rgbx_init") void rgbx_init(void) {
    phase_ms = 0;
}

RGBX_V2_EXPORT("rgbx_tick") void rgbx_tick(uint32_t dt_ms) {
    /* src/main.c advances the accumulator as
     *   phase_ms = (phase_ms + dt_ms * params[P_SPEED] / 50) % PHASE_PERIOD_MS
     * in 32-bit arithmetic. Speed is a uint32 the host writes without a range
     * check, so that product overflows: at Speed = UINT32_MAX and a matching
     * dt it wraps to 1, the increment divides down to 0, and the animation
     * freezes at the fastest setting the app can ask for. Widening the product
     * to 64 bits and reducing the increment before adding it is the same
     * arithmetic modulo PHASE_PERIOD_MS for every input that did not overflow,
     * and the intended one for those that did. */
    const uint32_t speed = rgbx_v2_param_u32(P_SPEED);
    const uint32_t step = (uint32_t)(((uint64_t)dt_ms * (uint64_t)speed / 50u) % PHASE_PERIOD_MS);
    const uint32_t phase = (phase_ms + step) % PHASE_PERIOD_MS;
    phase_ms = phase;

    /* src/main.c splits the colour into three bytes and writes them into the
     * framebuffer; set_span8 takes the same three bytes packed as 0x00RRGGBB,
     * so the crest colour is the parameter with any high byte masked off. The
     * body colour keeps main.c's per-channel integer divide by 3, which is not
     * the same as dividing the packed value. */
    const uint32_t colour = rgbx_v2_param_u32(P_COLOR) & 0x00ffffffu;
    const uint32_t body_colour = ((((colour >> 16) & 0xffu) / 3u) << 16) |
                                 ((((colour >> 8) & 0xffu) / 3u) << 8) | ((colour & 0xffu) / 3u);

    /* Audio energy in the lowest display bucket swells the wave amplitude.
     * src/main.c reads rgbx_inputs.audio_display_bucket[0], a float normalized
     * to roughly 0..1, clamps it to [0, 1], and forms
     *
     *   amp = 2.0 + energy * ((HEIGHT/2) - 1.0) = 2.0 + energy * 5.0
     *
     * RGBX v2 delivers the same quantity as an unsigned Q16 fixed-point value,
     * so the low clamp is structural and only the high one is left. The Q24
     * amplitude is then exact for every admissible input:
     *
     *   amp_q24 = 2*2^24 + 5 * (energy_q16 / 2^16) * 2^24
     *           = 33554432 + 1280 * energy_q16
     *
     * because 5 * 2^24 / 2^16 = 1280 is a whole number. At the clamp it is
     * 33554432 + 1280*65536 = 117440512 = 7 * 2^24, the widest the panel can
     * use. No rounding enters the amplitude at all. */
    uint32_t energy_q16 = rgbx_v2_input_u32(RGBX_V2_INPUT_AUDIO_DISPLAY_Q16, 0u);
    if (energy_q16 > 65536u) {
        energy_q16 = 65536u;
    }
    const int32_t amp_q24 = 33554432 + (int32_t)(1280u * energy_q16);

    /* src/main.c ORs the per-band beat flags together; RGBX v2 delivers the
     * same four flags as one mask, so any nonzero mask is that same OR. */
    const uint32_t crest_x = (phase / 40u) % WIDTH;
    const uint32_t flash_x = rgbx_v2_input_u32(RGBX_V2_INPUT_AUDIO_BEAT_MASK, 0u) != 0u
                                 ? crest_x
                                 : (uint32_t)WIDTH;

    /* One complete frame is exactly HEIGHT*WIDTH/8 spans at ascending
     * first_pixel offsets, which is what the ABI requires of a frame.
     * wave_pixel() has no side effects, so the eight arguments below may be
     * evaluated in any order the compiler likes; C does not define one. */
    uint32_t first_pixel = 0;
    for (uint32_t y = 0; y < HEIGHT; ++y) {
        const int32_t row = (int32_t)y;
        for (uint32_t x = 0; x < WIDTH; x += RGBX_V2_PIXELS_PER_SPAN) {
            rgbx_v2_set_span8(
                first_pixel,
                wave_pixel(x + 0u, row, phase, amp_q24, flash_x, colour, body_colour),
                wave_pixel(x + 1u, row, phase, amp_q24, flash_x, colour, body_colour),
                wave_pixel(x + 2u, row, phase, amp_q24, flash_x, colour, body_colour),
                wave_pixel(x + 3u, row, phase, amp_q24, flash_x, colour, body_colour),
                wave_pixel(x + 4u, row, phase, amp_q24, flash_x, colour, body_colour),
                wave_pixel(x + 5u, row, phase, amp_q24, flash_x, colour, body_colour),
                wave_pixel(x + 6u, row, phase, amp_q24, flash_x, colour, body_colour),
                wave_pixel(x + 7u, row, phase, amp_q24, flash_x, colour, body_colour));
            first_pixel += RGBX_V2_PIXELS_PER_SPAN;
        }
    }

    /* Shuffle's good-switch-point: the wave phase wrapping, as in src/main.c.
     * Exactly one call per committed frame, which the ABI requires of any
     * guest that imports it. */
    rgbx_v2_set_good_moment(crest_x == 0u ? 1u : 0u);
}
