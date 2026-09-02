// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Stuart Alldritt
//
// Two host-side models of demo_wave, used by tests/rgbx-v2-parity.mjs to say
// what a frame is SUPPOSED to contain. Neither reads the built module, so
// neither can be fooled by a module that changed.
//
//   floatFrame()   the canonical animation as src/main.c states it, in
//                  double-precision Math.sin. This is the definition of what
//                  demo_wave looks like; the fixed-point guest is an
//                  approximation OF it, so agreement here is the fidelity
//                  claim and it is checked with a stated bound.
//   fixedFrame()   an independent re-derivation of the guest's fixed-point
//                  method (exact rational angle in Q24, then a range-reduced
//                  odd polynomial), written in JavaScript from the arithmetic
//                  rather than compiled from the C. It has to agree with the
//                  module EXACTLY, so it pins every rounding decision the C
//                  makes.
//   advanceAccumulator()  the phase accumulator's own arithmetic, in BigInt,
//                  so the 64-bit steps are exact here by construction rather
//                  than by the same widening the C has to get right.
//
// Both frame models return width*height colours in the guest's emission order:
// pixel index y*WIDTH + x, which is also the order set_span8 walks
// (first_pixel runs 0, 8, 16, ... across the whole frame). A colour is the
// 0x00RRGGBB value the ABI's span import takes, which is also what
// src/main.c's three set_px() bytes amount to.

export const WIDTH = 40;
export const HEIGHT = 12;
export const PIXEL_COUNT = WIDTH * HEIGHT;
export const MID_ROW = HEIGHT / 2;

// Phase-accumulator wrap period in ms: the lcm of the sine's 4000 ms period
// (it rolls at TAU*0.25 rad/s) and the crest column's 1600 ms period (it steps
// one of 40 columns every 40 ms). Both consumers resume exactly where they
// left off, so the wrap is seamless.
export const PERIOD_MS = 8000;

// TAU as src/main.c spells it. Kept literal rather than 2*Math.PI so this
// model states the same constant the canonical animation does; the 7e-8 rad
// difference between them is two orders of magnitude below the error the
// fixed-point arithmetic introduces on its own.
const TAU = 6.2831853;

// Parameter defaults live in rgbx-v2.json, not here. What this file needs is
// only the shape of a colour.
const COLOUR_MASK = 0x00ffffff;

// ---------------------------------------------------------------------------
// The phase accumulator.
// ---------------------------------------------------------------------------

/**
 * One tick of the accumulator: phase = (phase + dt*speed/50 mod period) mod period.
 *
 * BigInt on purpose. The product dt*speed reaches (2^32-1)^2 for a client that
 * writes the full uint32 range into Speed, which is exactly the case the guest
 * has to widen to 64 bits before dividing, so a model that computed it in
 * doubles would lose the low bits it is here to check.
 */
export function advanceAccumulator(phaseMs, dtMs, speed) {
  const step = ((BigInt(dtMs) * BigInt(speed)) / 50n) % BigInt(PERIOD_MS);
  return Number((BigInt(phaseMs) + step) % BigInt(PERIOD_MS));
}

/** The crest column at a given phase: (phase/40) mod WIDTH, both integer. */
export function crestColumn(phaseMs) {
  return Math.floor(phaseMs / 40) % WIDTH;
}

/**
 * The body colour: src/main.c's per-channel integer divide by 3.
 *
 * Dividing the packed 0x00RRGGBB value by 3 is NOT the same operation and
 * would be wrong; the channels are divided separately and repacked.
 */
export function bodyColour(colour) {
  const masked = colour & COLOUR_MASK;
  return ((Math.floor(((masked >>> 16) & 0xff) / 3) << 16) |
          (Math.floor(((masked >>> 8) & 0xff) / 3) << 8) |
          Math.floor((masked & 0xff) / 3)) >>> 0;
}

/**
 * Turn a column's crest row into a full frame.
 *
 * Shared by both models because it is not where they differ: they differ in
 * how they arrive at the crest row. src/main.c paints the crest at full scale
 * with one dimmer pixel above and below, then overwrites the whole crest
 * column white on a beat. Its set_px() drops writes outside the panel, and its
 * row index is unsigned, so a crest row of -1 arrives as 0xFFFFFFFF and is
 * dropped exactly as a row of 13 is; comparing signed rows against 0..11
 * reproduces that.
 */
function paint(crestRows, { colour, beat, phaseMs }) {
  const crest = (colour >>> 0) & COLOUR_MASK;
  const body = bodyColour(colour);
  const flashColumn = beat ? crestColumn(phaseMs) : -1;
  const frame = new Uint32Array(PIXEL_COUNT);
  for (let y = 0; y < HEIGHT; ++y) {
    for (let x = 0; x < WIDTH; ++x) {
      let value = 0;
      if (x === flashColumn) {
        value = 0x00ffffff;
      } else {
        const row = crestRows[x];
        if (y === row) value = crest;
        else if (y === row - 1 || y === row + 1) value = body;
      }
      frame[y * WIDTH + x] = value;
    }
  }
  return frame;
}

// ---------------------------------------------------------------------------
// The canonical float model.
// ---------------------------------------------------------------------------

/**
 * The real-valued wave offset per column, as src/main.c defines it.
 *
 * energyQ16 is the value the host places in the RGBX v2 audio input, and
 * energyQ16 / 65536 is the float src/main.c's v1 host would have written into
 * audio_display_bucket[0] for the same measured energy. The low clamp in
 * src/main.c cannot fire on an unsigned input; the high one still can.
 */
export function floatOffsets(phaseMs, energyQ16) {
  const energy = Math.min(energyQ16, 65536) / 65536;
  const amplitude = 2 + energy * (MID_ROW - 1);
  const t = phaseMs / 1000;
  const offsets = new Float64Array(WIDTH);
  for (let x = 0; x < WIDTH; ++x) {
    offsets[x] = Math.sin((x / WIDTH) * TAU + t * TAU * 0.25) * amplitude;
  }
  return offsets;
}

/** Crest rows from the float offsets: MID_ROW + trunc(offset), toward zero. */
export function floatRows(phaseMs, energyQ16) {
  const offsets = floatOffsets(phaseMs, energyQ16);
  const rows = new Int32Array(WIDTH);
  for (let x = 0; x < WIDTH; ++x) rows[x] = MID_ROW + Math.trunc(offsets[x]);
  return rows;
}

/** The animation as src/main.c defines it, in double precision. */
export function floatFrame(phaseMs, { energyQ16 = 0, beat = false, colour }) {
  return paint(floatRows(phaseMs, energyQ16), { colour, beat, phaseMs });
}

// ---------------------------------------------------------------------------
// The fixed-point model.
// ---------------------------------------------------------------------------

// Angle and wave-offset scale. TAU_Q24 = round(TAU * 2^24), and the half and
// quarter turns are rounded from the same literal rather than halved from
// TAU_Q24, matching the C.
const TAU_Q24 = 105414357;
const PI_Q24 = 52707178;
const HALF_PI_Q24 = 26353589;

// round(2^36 / (2k+1)!) for k = 0..6: the Maclaurin coefficients of
// sin(x)/x, in Q36, alternating in sign. Q36 and the x^13 term because the
// series is one-sided and truncating it earlier costs the crest pixel at the
// peak of the wave; the guest's own comment carries the derivation.
const POLY_Q36 = [68719476736n, -11453246123n, 572662306n, -13634817n, 189372n, -1722n, 11n];

/**
 * Round-to-nearest arithmetic right shift of a 64-bit value, ties away from
 * zero, in and out as BigInt.
 *
 * BigInt on purpose, and not only for tidiness. The sine's Horner accumulator
 * is a Q36 value that does not fit int32, and the widest product it forms is
 * HALF_PI_Q24 * 2^36 = 1.8e18, which is past 2^53 and therefore not exactly
 * representable as a double. The C forms these in int64_t; anything less than
 * BigInt here would model a different function.
 */
function roundShift(value, shift) {
  const half = 1n << BigInt(shift - 1);
  return value >= 0n ? (value + half) >> BigInt(shift) : -((-value + half) >> BigInt(shift));
}

/** C's truncating remainder, which is not JavaScript's for negative values. */
function truncatedRemainder(value, modulus) {
  return value < 0 ? -(-value % modulus) : value % modulus;
}

/**
 * sin(x) for x in Q24, returned in Q24.
 *
 * Range-reduce into [-pi/2, pi/2] by symmetry, then Horner the odd Maclaurin
 * series through x^13, with the accumulator in Q36. Every named intermediate
 * below fits int32, which is asserted rather than assumed: a model that silently
 * carried more range than the guest would stop being a model of it.
 */
export function boundedSinQ24(angleQ24) {
  let x = truncatedRemainder(angleQ24, TAU_Q24);
  if (x > PI_Q24) x -= TAU_Q24;
  else if (x < -PI_Q24) x += TAU_Q24;
  if (x > HALF_PI_Q24) x = PI_Q24 - x;
  else if (x < -HALF_PI_Q24) x = -PI_Q24 - x;

  const x2Q24 = roundShift(BigInt(x) * BigInt(x), 24);
  if (x2Q24 > 0x7fffffffn) throw new Error("x^2 left int32");
  let polynomialQ36 = POLY_Q36[6];
  for (let index = 5; index >= 1; --index) {
    polynomialQ36 = POLY_Q36[index] + roundShift(x2Q24 * polynomialQ36, 24);
  }
  const factorQ36 = POLY_Q36[0] + roundShift(x2Q24 * polynomialQ36, 24);
  const sineQ24 = roundShift(BigInt(x) * factorQ36, 36);
  if (sineQ24 > 0x7fffffffn || sineQ24 < -0x80000000n) throw new Error("sine left int32");
  return Number(sineQ24);
}

/**
 * The amplitude in Q24: 2 + energy*5 with energy in Q16, and exact.
 *
 * 5 * 2^24 / 2^16 = 1280 is a whole number, so no rounding enters the
 * amplitude for any admissible input. At the clamp it is 7 * 2^24.
 */
export function amplitudeQ24(energyQ16) {
  return 33554432 + 1280 * Math.min(energyQ16 >>> 0, 65536);
}

/**
 * The angle of column x at a given phase, in Q24.
 *
 * TAU * (x/WIDTH + phaseMs/4000) is exactly TAU * (100*x + phaseMs) / 4000
 * for WIDTH = 40, so the guest forms it as one rounded 64-bit division of
 * integers it already holds.
 */
export function angleQ24(x, phaseMs) {
  return Number((BigInt(TAU_Q24) * BigInt(100 * x + phaseMs) + 2000n) / 4000n);
}

/** The wave offset per column in Q24, as the guest computes it. */
export function fixedOffsetsQ24(phaseMs, energyQ16) {
  const amplitude = amplitudeQ24(energyQ16);
  const offsets = new Int32Array(WIDTH);
  for (let x = 0; x < WIDTH; ++x) {
    offsets[x] =
        Number(roundShift(BigInt(boundedSinQ24(angleQ24(x, phaseMs))) * BigInt(amplitude), 24));
  }
  return offsets;
}

/** Crest rows from the Q24 offsets, truncating toward zero as the C does. */
export function fixedRows(phaseMs, energyQ16) {
  const offsets = fixedOffsetsQ24(phaseMs, energyQ16);
  const rows = new Int32Array(WIDTH);
  for (let x = 0; x < WIDTH; ++x) {
    const offset = offsets[x];
    rows[x] = MID_ROW + (offset >= 0 ? offset >> 24 : -((-offset) >> 24));
  }
  return rows;
}

/** The animation as the RGBX v2 guest computes it, in fixed point. */
export function fixedFrame(phaseMs, { energyQ16 = 0, beat = false, colour }) {
  return paint(fixedRows(phaseMs, energyQ16), { colour, beat, phaseMs });
}

// ---------------------------------------------------------------------------
// Comparisons.
// ---------------------------------------------------------------------------

/** Largest absolute difference between the two models' offsets, in rows. */
export function offsetError(phaseMs, energyQ16) {
  const fixed = fixedOffsetsQ24(phaseMs, energyQ16);
  const exact = floatOffsets(phaseMs, energyQ16);
  let worst = 0;
  for (let x = 0; x < WIDTH; ++x) worst = Math.max(worst, Math.abs(fixed[x] / 2 ** 24 - exact[x]));
  return worst;
}

/** Index of the first differing pixel, or -1 when two frames are identical. */
export function firstDifference(actual, expected) {
  for (let index = 0; index < PIXEL_COUNT; ++index) {
    if (actual[index] !== expected[index]) return index;
  }
  return -1;
}

/**
 * Columns whose float offset sits within `bound` rows of a whole row.
 *
 * These are the only columns where the two models are allowed to paint
 * different pixels: everywhere else the truncation to a row has more than
 * `bound` of margin, so an offset error smaller than `bound` cannot change
 * the row. Used to state the fidelity claim as a property rather than as a
 * count of tolerated failures.
 */
export function boundaryColumns(phaseMs, energyQ16, bound) {
  const offsets = floatOffsets(phaseMs, energyQ16);
  const columns = [];
  for (let x = 0; x < WIDTH; ++x) {
    const distance = Math.abs(offsets[x] - Math.round(offsets[x]));
    if (distance <= bound) columns.push(x);
  }
  return columns;
}
