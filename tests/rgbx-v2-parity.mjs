#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Stuart Alldritt
//
// Known-answer parity tests for the RGBX v2 demo_wave guest.
//
//   node tests/rgbx-v2-parity.mjs build/rgbx-v2/demo_wave.wasm
//
// The SDK's own gate (check-rgbx-v2.mjs) proves the module is ADMISSIBLE: the
// right sections, no floats, no memory, and a complete frame emitted within
// the firmware's per-tick call budgets. It does not look at a single pixel, so
// it would pass a module whose animation had quietly changed.
//
// These tests close that gap. Every expectation comes from
// tests/demo-wave-reference.mjs, which models the animation without reading
// the module, on two levels:
//
//   * the canonical float definition of demo_wave (src/main.c's formula in
//     double-precision Math.sin), checked as a stated property rather than a
//     tolerance, because the fixed-point guest is an approximation of it and
//     the size of that approximation is the claim worth guarding;
//   * an independent re-derivation of the fixed-point method itself, checked
//     exactly, because that pins every rounding decision the C makes.
//
// Parameter defaults and slot order are read out of rgbx-v2.json rather than
// copied here, so a manifest that drifts out of step with the guest's slot
// contract fails case 0 instead of quietly changing what every later case is
// testing. Anything unexpected in the manifest fails closed.
//
// The accumulator cases carry their arithmetic in the comment above them and a
// literal expected value in the assertion, so a reader can check the number
// without running anything, and a regression names the step it broke.
//
// Nothing here is a golden captured from a previous build. If an edit to
// src/main_v2.c makes a test fail, the fix is a re-derived expectation, never
// a refreshed recording.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  advanceAccumulator,
  bodyColour,
  boundaryColumns,
  crestColumn,
  firstDifference,
  fixedFrame,
  fixedRows,
  floatFrame,
  HEIGHT,
  offsetError,
  PERIOD_MS,
  PIXEL_COUNT,
  WIDTH,
} from "./demo-wave-reference.mjs";

// The fidelity claim, in rows.
//
// The guest's sine agrees with the true sine to within 1.65 Q24 units over
// every one of the 320000 angles this animation can form; the amplitude is
// exact in Q24 for every admissible energy and is at most 7; and multiplying
// the two rounds once more. So the wave offset is within
//
//   1.65 * 2^-24 * 7 + 2^-25 = 7.2e-7
//
// rows of the double-precision original for EVERY input, not merely for the
// inputs tested here. Measured over the whole period at twelve amplitudes
// including both extremes, the worst seen is 7.16e-7.
//
// That bound is what the frame check below turns into a property. A row is a
// truncation, so an offset error can only change a pixel where the float
// offset is itself within the bound of a whole row; anywhere else the guest
// has to paint the same pixel. The tests therefore require exact agreement
// with the float model at every column that is not within OFFSET_TOLERANCE of
// a row boundary, rather than tolerating a count of wrong pixels.
const OFFSET_TOLERANCE = 8e-7;

// Parameter slots. The guest hardcodes these ids: it reads slot 0 as the speed
// percentage and slot 1 as the crest colour. rgbx-v2.json decides what the
// device puts in them, so the two have to agree on the order, and the defaults
// the tests run against have to be the defaults the package ships.
const SPEED = 0;
const COLOR = 1;
const MANIFEST_SLOTS = ["Speed", "Color"];

// rgbx_v2_input_kind selectors this animation is allowed to read, from the
// ABI header. Reading anything else, or reading these at a nonzero index,
// would be a different animation and is rejected by the host below.
const INPUT_AUDIO_DISPLAY_Q16 = 1;
const INPUT_AUDIO_BEAT_MASK = 2;

function loadManifest() {
  const path = new URL("../rgbx-v2.json", import.meta.url);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read rgbx-v2.json: ${error.message}`);
  }
}

function manifestDefaults(spec) {
  const params = spec.parameters;
  if (!Array.isArray(params) || params.length !== MANIFEST_SLOTS.length) {
    throw new Error(`rgbx-v2.json declares ${Array.isArray(params) ? params.length : "no"} ` +
                    `parameters, but the guest reads ${MANIFEST_SLOTS.length}`);
  }
  return params.map((param, slot) => {
    const expected = MANIFEST_SLOTS[slot];
    if (param === null || typeof param !== "object" || param.name !== expected) {
      throw new Error(`rgbx-v2.json parameter ${slot} is ` +
                      `${JSON.stringify(param && param.name)}, but the guest reads slot ` +
                      `${slot} as ${expected}`);
    }
    if (param.type !== "uint32" && param.type !== "color") {
      throw new Error(`${expected} has type ${param.type}, which these tests cannot drive`);
    }
    if (!Number.isInteger(param.default) || param.default < 0 || param.default > 0xffffffff) {
      throw new Error(`${expected} has a default outside uint32`);
    }
    return param.default;
  });
}

const MANIFEST = loadManifest();
const DEFAULT_PARAMS = manifestDefaults(MANIFEST);

let failures = 0;

function check(description, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${description}`);
    return;
  }
  ++failures;
  console.log(`  FAIL ${description}${detail ? `: ${detail}` : ""}`);
}

function checkEqual(description, actual, expected) {
  check(description, actual === expected, `expected ${expected}, got ${actual}`);
}

function describePixel(index, actual, expected) {
  return `pixel ${index} (x=${index % WIDTH}, y=${Math.floor(index / WIDTH)}) is ` +
         `0x${(actual >>> 0).toString(16).padStart(6, "0")}, expected ` +
         `0x${(expected >>> 0).toString(16).padStart(6, "0")}`;
}

/** The module has to reproduce the fixed-point model byte for byte. */
function checkFrameExact(description, actual, expected) {
  const index = firstDifference(actual, expected);
  check(description, index < 0, index < 0 ? "" : describePixel(index, actual[index], expected[index]));
}

/**
 * The module has to reproduce the canonical float animation everywhere the
 * truncation to a row has margin, which is everywhere except the columns whose
 * float offset sits within OFFSET_TOLERANCE of a whole row.
 */
function checkAgainstFloat(description, actual, phaseMs, options) {
  const expected = floatFrame(phaseMs, options);
  const allowed = new Set(boundaryColumns(phaseMs, options.energyQ16 ?? 0, OFFSET_TOLERANCE));
  let detail = "";
  for (let index = 0; index < PIXEL_COUNT; ++index) {
    if (actual[index] !== expected[index] && !allowed.has(index % WIDTH)) {
      detail = describePixel(index, actual[index], expected[index]);
      break;
    }
  }
  check(description, detail === "", detail);
  const worst = offsetError(phaseMs, options.energyQ16 ?? 0);
  check(`${description}, wave offset within ${OFFSET_TOLERANCE} rows`, worst <= OFFSET_TOLERANCE,
        `largest offset error ${worst.toExponential(3)} rows`);
}

/**
 * A running instance of the guest, with a host that records what it paints.
 *
 * The host is deliberately strict about the ABI: spans must arrive in
 * ascending pixel order and cover the frame exactly once, set_good_moment must
 * be called exactly once per tick, and input_u32 may only ask for the two
 * audio values this animation is entitled to. A guest that skipped or repeated
 * a span could otherwise leave stale bytes in the frame and still compare
 * equal.
 */
function loadGuest(modulePath) {
  const frame = new Uint32Array(PIXEL_COUNT);
  const params = DEFAULT_PARAMS.slice();
  const audio = { energyQ16: 0, beatMask: 0 };
  let nextPixel = 0;
  let goodMoment = null;
  let inputReads = [];

  const host = {
    param_u32: (id) => params[id >>> 0] ?? 0,
    input_u32: (kind, index) => {
      inputReads.push(`${kind >>> 0}/${index >>> 0}`);
      if ((index >>> 0) !== 0) {
        throw new Error(`guest read input selector ${kind >>> 0} at index ${index >>> 0}`);
      }
      if ((kind >>> 0) === INPUT_AUDIO_DISPLAY_Q16) return audio.energyQ16 >>> 0;
      if ((kind >>> 0) === INPUT_AUDIO_BEAT_MASK) return audio.beatMask >>> 0;
      throw new Error(`guest read input selector ${kind >>> 0}, which it may not use`);
    },
    set_good_moment: (value) => {
      if (goodMoment !== null) throw new Error("guest set the good moment twice in one tick");
      goodMoment = value >>> 0;
    },
    set_span8: (first, ...colours) => {
      if ((first >>> 0) !== nextPixel) {
        throw new Error(`span starts at pixel ${first >>> 0}, expected ${nextPixel}`);
      }
      for (const colour of colours) {
        if ((colour >>> 0) > 0xffffff) throw new Error(`colour ${colour} has a high byte set`);
        frame[nextPixel++] = colour >>> 0;
      }
    },
  };

  const bytes = readFileSync(resolve(modulePath));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { rgbx_v2: host });
  instance.exports.rgbx_init();

  return {
    /** Call rgbx_init again, as a host does when the effect is re-activated. */
    init() {
      instance.exports.rgbx_init();
    },
    /** Set the parameter slots the next tick will read. */
    setParams(values) {
      for (const [slot, value] of Object.entries(values)) params[slot] = value;
    },
    /** Set the audio snapshot the next tick will read. */
    setAudio(values) {
      Object.assign(audio, values);
    },
    /** Run one tick and return the frame it painted, plus what else it did. */
    tick(dtMs) {
      frame.fill(0);
      nextPixel = 0;
      goodMoment = null;
      inputReads = [];
      instance.exports.rgbx_tick(dtMs);
      if (nextPixel !== PIXEL_COUNT) {
        throw new Error(`guest painted ${nextPixel} pixels, expected ${PIXEL_COUNT}`);
      }
      if (goodMoment === null) throw new Error("guest did not set the good moment");
      return { frame: frame.slice(), goodMoment, inputReads: inputReads.slice() };
    },
  };
}

const [moduleArg] = process.argv.slice(2);
if (!moduleArg) {
  console.error("usage: rgbx-v2-parity.mjs <module.wasm>");
  process.exit(2);
}

const DEFAULT_COLOR = DEFAULT_PARAMS[COLOR];
const DEFAULT_BODY = bodyColour(DEFAULT_COLOR);

// ---------------------------------------------------------------------------
// Case 0: the manifest's half of the contract.
//
// The expectations further down are written against a 1x Speed and the shipped
// Color, because that is what the package installs, and against the audio
// capability being granted, because a guest that reads input_u32 without it is
// refused at install time rather than running with zeros. Those are manifest
// values, not constants of this file, so state the dependency here: if one
// moves, the failure should say which rather than showing up as a frame full
// of wrong pixels several cases later.
// ---------------------------------------------------------------------------
console.log("case 0: manifest contract");
{
  checkEqual("Speed defaults to 1x", DEFAULT_PARAMS[SPEED], 50);
  check("Color default is 24-bit", DEFAULT_COLOR <= 0xffffff,
        `0x${DEFAULT_COLOR.toString(16)}`);
  // The exact set, not a superset. A package that asks for buttons or the IMU
  // as well would install and run, but it would be asking the device for reach
  // this animation has no use for, and includes() would not notice.
  check("the manifest asks for the audio capability and nothing else",
        Array.isArray(MANIFEST.capabilities) &&
            JSON.stringify(MANIFEST.capabilities) === JSON.stringify(["audio"]),
        JSON.stringify(MANIFEST.capabilities));
  check("the manifest covers src/main_v2.c", MANIFEST.sourceFile === "src/main_v2.c",
        JSON.stringify(MANIFEST.sourceFile));
  check("the manifest declares the panel geometry",
        Array.isArray(MANIFEST.geometry) && MANIFEST.geometry[0] === WIDTH &&
            MANIFEST.geometry[1] === HEIGHT,
        JSON.stringify(MANIFEST.geometry));
}

// ---------------------------------------------------------------------------
// Case 1: t = 0.
//
// rgbx_init zeroes the accumulator, and a dt of 0 leaves it there:
//   step = (0 * 50 / 50) mod 8000 = 0, phase = (0 + 0) mod 8000 = 0.
//
// With no audio the amplitude is 2.0 exactly, and the wave reduces to
// off(x) = 2*sin(TAU*x/40), which is exactly computable at the columns below.
// The crest row is 6 + trunc(off), truncating toward zero, and the crest pixel
// is the Color parameter with one pixel of Color/3 above and below it.
//
// These anchors are the one place in this file where the expected picture is
// derived with pen and paper rather than by a model, so they are the check
// that the models themselves describe demo_wave and not merely each other.
// ---------------------------------------------------------------------------
console.log("case 1: t = 0");
{
  const guest = loadGuest(moduleArg);
  const { frame, goodMoment, inputReads } = guest.tick(0);

  checkFrameExact("frame matches the fixed-point model at t = 0", frame, fixedFrame(0, {
    colour: DEFAULT_COLOR,
  }));
  checkAgainstFloat("frame matches the canonical float animation at t = 0", frame, 0, {
    colour: DEFAULT_COLOR,
  });

  const anchors = [
    // x, crest row, with the arithmetic that produces it.
    // sin(0) = 0            -> off 0            -> trunc  0 -> row 6
    [0, 6],
    // sin(0.075*TAU) = 0.45399050 -> off 0.90798100 -> trunc  0 -> row 6
    [3, 6],
    // sin(0.100*TAU) = 0.58778525 -> off 1.17557050 -> trunc  1 -> row 7
    [4, 7],
    // sin(TAU/8)   =  0.70710678 -> off  1.41421356 -> trunc  1 -> row 7
    [5, 7],
    // sin(TAU/4)   =  1          -> off  2          -> trunc  2 -> row 8
    [10, 8],
    // sin(3*TAU/8) =  0.70710678 -> off  1.41421356 -> trunc  1 -> row 7
    [15, 7],
    // sin(TAU/2)   =  0          -> off  0          -> trunc  0 -> row 6
    [20, 6],
    // sin(5*TAU/8) = -0.70710678 -> off -1.41421356 -> trunc -1 -> row 5
    [25, 5],
    // sin(3*TAU/4) = -1          -> off -2          -> trunc -2 -> row 4
    [30, 4],
    // sin(7*TAU/8) = -0.70710678 -> off -1.41421356 -> trunc -1 -> row 5
    [35, 5],
  ];
  for (const [x, row] of anchors) {
    let detail = "";
    for (let y = 0; y < HEIGHT; ++y) {
      const expected = y === row ? DEFAULT_COLOR : (y === row - 1 || y === row + 1 ? DEFAULT_BODY : 0);
      const actual = frame[y * WIDTH + x];
      if (actual !== expected) {
        detail = `y=${y} is 0x${actual.toString(16)}, expected 0x${expected.toString(16)}`;
        break;
      }
    }
    check(`column ${x} crests on row ${row} by hand`, detail === "", detail);
  }

  checkEqual("the crest colour is the Color parameter", frame[6 * WIDTH + 0], DEFAULT_COLOR);
  checkEqual("the body colour is Color/3 per channel", frame[5 * WIDTH + 0], DEFAULT_BODY);
  checkEqual("Color/3 of the shipped default", DEFAULT_BODY, 0x000a5520);

  // crest_x = (0 / 40) mod 40 = 0, which is the wrap point the animation
  // reports as a good moment to switch effects.
  checkEqual("crest column at t = 0", crestColumn(0), 0);
  checkEqual("t = 0 is a good moment", goodMoment, 1);

  // The audio reads are the whole reason this package asks for a capability:
  // one display-bucket energy and one beat mask, each read once, each at
  // index 0.
  checkEqual("audio is read exactly twice per tick", inputReads.length, 2);
  check("audio reads are the display bucket and the beat mask",
        inputReads.join(",") === `${INPUT_AUDIO_DISPLAY_Q16}/0,${INPUT_AUDIO_BEAT_MASK}/0`,
        inputReads.join(","));
}

// ---------------------------------------------------------------------------
// Case 2: mid-animation.
//
// One 3333 ms tick at the default Speed of 50, which is 1x:
//   step  = (3333 * 50 / 50) mod 8000 = 3333
//   phase = (0 + 3333) mod 8000 = 3333
// 3333 ms is not a multiple of 40, so the crest column and the wave are both
// off the grid the t = 0 frame sits on, and the sine is evaluated at arbitrary
// phase rather than at the eighths of a turn that t = 0 lands on.
// ---------------------------------------------------------------------------
console.log("case 2: mid-animation at t = 3333 ms");
{
  const guest = loadGuest(moduleArg);
  const { frame, goodMoment } = guest.tick(3333);
  const phase = advanceAccumulator(0, 3333, 50);
  checkEqual("accumulator arithmetic", phase, 3333);
  checkFrameExact("frame matches the fixed-point model at t = 3333 ms", frame,
                  fixedFrame(phase, { colour: DEFAULT_COLOR }));
  checkAgainstFloat("frame matches the canonical float animation at t = 3333 ms", frame, phase,
                    { colour: DEFAULT_COLOR });
  // crest_x = (3333 / 40) mod 40 = 83 mod 40 = 3, so this is not a good moment.
  checkEqual("crest column at t = 3333 ms", crestColumn(phase), 3);
  checkEqual("mid-animation is not a good moment", goodMoment, 0);
}

// ---------------------------------------------------------------------------
// Case 3: the 8000 ms accumulator wrap.
//
// 8000 ms is the lcm of the sine's 4000 ms period and the crest column's
// 1600 ms period, which is why src/main.c chose it: both consumers resume
// exactly where they left off. The accumulator wraps there so the sine
// argument stays small; the animation is only allowed to do that because the
// wrap is seamless.
//
//   3333 + 4667 = 8000, and 8000 mod 8000 = 0
//
// so the frame after the wrap has to be the frame at t = 0, byte for byte.
// That is a known answer that needs no model at all.
// ---------------------------------------------------------------------------
console.log("case 3: accumulator wrap at 8000 ms");
{
  const guest = loadGuest(moduleArg);
  const zeroFrame = guest.tick(0).frame;
  const midFrame = guest.tick(3333).frame;
  const wrapped = guest.tick(4667);

  checkEqual("wrap arithmetic", advanceAccumulator(3333, 4667, 50), 0);
  checkFrameExact("the frame after the wrap is the frame at t = 0", wrapped.frame, zeroFrame);
  check("the wrap is not a freeze", firstDifference(midFrame, zeroFrame) >= 0,
        "t = 3333 painted the t = 0 frame");
  checkEqual("the wrap is a good moment again", wrapped.goodMoment, 1);

  // One ms past the wrap: step = 8001 mod 8000 = 1, so the accumulator lands
  // on 1 rather than on 8001. A build that wrapped the RATE instead of the
  // accumulator, or that did not wrap at all, would disagree here.
  const guestPast = loadGuest(moduleArg);
  checkEqual("one ms past the wrap", advanceAccumulator(0, 8001, 50), 1);
  checkFrameExact("the frame one ms past the wrap", guestPast.tick(8001).frame,
                  fixedFrame(1, { colour: DEFAULT_COLOR }));

  // The bound is on the accumulator, not on the rate, so it holds for any
  // Speed. At Speed = 1000000 a single 1001 ms tick advances
  //   step = (1001 * 1000000 / 50) mod 8000 = 20020000 mod 8000
  //        = 20020000 - 2502*8000 = 4000
  const guestFast = loadGuest(moduleArg);
  guestFast.setParams({ [SPEED]: 1000000 });
  checkEqual("a step larger than the period wraps too", advanceAccumulator(0, 1001, 1000000),
             4000);
  checkFrameExact("the frame after a step larger than the period", guestFast.tick(1001).frame,
                  fixedFrame(4000, { colour: DEFAULT_COLOR }));
}

// ---------------------------------------------------------------------------
// Case 3b: rgbx_init resets the accumulator.
//
// Every other case in this file gets a guest that was just instantiated, and a
// module's globals are already zero at instantiation, so rgbx_init could have
// an empty body and nothing above would notice. The host calls it again when
// the effect is re-activated, and an rgbx_init that did not reset would restart
// the wave wherever the previous activation left it.
//
// So drive the accumulator away from zero, call rgbx_init, and require the
// t = 0 frame back byte for byte. Deleting `phase_ms = 0;` from the guest
// passes the SDK gate and fails here.
// ---------------------------------------------------------------------------
console.log("case 3b: rgbx_init resets the accumulator");
{
  const guest = loadGuest(moduleArg);
  const zeroFrame = guest.tick(0).frame;
  const moved = guest.tick(3333);
  check("the accumulator moved off zero before the reset",
        firstDifference(moved.frame, zeroFrame) >= 0, "t = 3333 painted the t = 0 frame");

  guest.init();
  const reset = guest.tick(0);
  checkFrameExact("the frame after a second rgbx_init is the frame at t = 0", reset.frame,
                  zeroFrame);
  checkEqual("the reset restores the good moment too", reset.goodMoment, 1);
}

// ---------------------------------------------------------------------------
// Case 4a: the accumulator's 64-bit multiplication.
//
// Speed is a uint32 the host writes without a range check, so dt_ms * Speed
// has to be widened before the divide:
//
//   dt = Speed = 0xFFFFFFFF = 4294967295
//   dt * Speed = 18446744065119617025
//   / 50       = 368934881302392340   (floor)
//   mod 8000   = 340
//
// In 32 bits the product is (2^32-1)^2 mod 2^32 = 1, so the step would be
// 1/50 = 0 and the animation would FREEZE at maximum Speed. src/main.c has
// exactly that defect; the assertion below is what stops the fixed-point port
// inheriting it.
// ---------------------------------------------------------------------------
console.log("case 4a: 64-bit accumulator step at the top of the uint32 range");
{
  const guest = loadGuest(moduleArg);
  guest.setParams({ [SPEED]: 0xffffffff });
  const phase = advanceAccumulator(0, 0xffffffff, 0xffffffff);
  checkEqual("64-bit step arithmetic", phase, 340);
  check("a 32-bit product would freeze the animation", phase !== 0);
  const { frame } = guest.tick(0xffffffff);
  checkFrameExact("frame matches the fixed-point model after the 64-bit step", frame,
                  fixedFrame(phase, { colour: DEFAULT_COLOR }));
  checkAgainstFloat("frame matches the canonical float animation after the 64-bit step", frame,
                    phase, { colour: DEFAULT_COLOR });
}

// ---------------------------------------------------------------------------
// Case 4b: the per-column angle multiplication.
//
// Each column's angle is TAU_Q24 * (100*x + phase) / 4000 in Q24, and at the
// top of the accumulator's range the numerator leaves 32 bits far behind:
//
//   105414357 * (100*39 + 7999) = 105414357 * 11899 = 1254324134943
//
// which is about 292x UINT32_MAX, so a build that formed the numerator in 32
// bits would wrap and paint a completely different frame. 7999 ms is also one
// ms before the wrap, so the frame has to be within one millisecond of motion
// of the t = 0 frame, which is a second, independent reading of the same
// result.
// ---------------------------------------------------------------------------
console.log("case 4b: 64-bit angle multiplication at the top of the period");
{
  const guest = loadGuest(moduleArg);
  const zeroFrame = guest.tick(0).frame;
  const phase = advanceAccumulator(0, PERIOD_MS - 1, 50);
  checkEqual("accumulator reaches the top of the period", phase, 7999);
  const { frame } = guest.tick(PERIOD_MS - 1);
  checkFrameExact("frame matches the fixed-point model at t = 7999 ms", frame,
                  fixedFrame(phase, { colour: DEFAULT_COLOR }));
  checkAgainstFloat("frame matches the canonical float animation at t = 7999 ms", frame, phase,
                    { colour: DEFAULT_COLOR });

  // One millisecond of the wave is TAU*0.25/1000 = 0.00157 rad. At the
  // amplitude of 2 this frame runs at, that moves the offset by at most
  // 0.0031 rows, so only columns already within that of a row boundary can
  // change: the crest and trough columns, whose offsets are exactly 2 and -2
  // at t = 0. Each such column loses a crest pixel and gains one, and takes
  // its two body pixels with it, so eight pixels differ and no more.
  let differing = 0;
  for (let index = 0; index < PIXEL_COUNT; ++index) {
    if (frame[index] !== zeroFrame[index]) ++differing;
  }
  checkEqual("one ms before the wrap is one ms of motion", differing, 8);
}

// ---------------------------------------------------------------------------
// Case 5: audio.
//
// src/main.c reads audio_display_bucket[0] as a float, clamps it to [0, 1] and
// forms amp = 2 + energy*5; RGBX v2 delivers the same quantity as an unsigned
// Q16 value, so the guest reads it through input_u32 and the low clamp cannot
// fire. The amplitude is exact in Q24 for every input, so these cases can name
// the resulting offsets outright.
//
// At silence the wave spans rows 4..8 (offset +-2 around row 6). At full
// energy amp = 7 and the crest reaches offsets +-7, which puts the extreme
// columns at rows 13 and -1: outside the panel, where src/main.c's set_px()
// drops the write. Losing those is the animation's own behaviour, not the
// port's, and the models reproduce it.
// ---------------------------------------------------------------------------
console.log("case 5: audio energy and beat");
{
  for (const [energyQ16, label] of [[0, "silence"], [16384, "quarter"], [32768, "half"],
                                    [65536, "full scale"]]) {
    const guest = loadGuest(moduleArg);
    guest.setAudio({ energyQ16 });
    const { frame } = guest.tick(3333);
    checkFrameExact(`frame at ${label} matches the fixed-point model`, frame,
                    fixedFrame(3333, { colour: DEFAULT_COLOR, energyQ16 }));
    checkAgainstFloat(`frame at ${label} matches the canonical float animation`, frame, 3333,
                      { colour: DEFAULT_COLOR, energyQ16 });
  }

  // The amplitude grows with energy: the crest of the wave sits further from
  // the middle row. Read the extreme rows out of the model rather than the
  // frame, and check the frames the guest painted agree with them.
  const spread = (energyQ16) => {
    const rows = fixedRows(3333, energyQ16);
    return Math.max(...rows) - Math.min(...rows);
  };
  check("louder audio widens the wave", spread(0) < spread(32768) && spread(32768) < spread(65536),
        `${spread(0)}, ${spread(32768)}, ${spread(65536)}`);

  // Above full scale the float animation clamps, so the guest has to as well:
  // the frame at an energy of 100000 is the frame at 65536, exactly.
  const clamped = loadGuest(moduleArg);
  clamped.setAudio({ energyQ16: 100000 });
  const clampedFrame = clamped.tick(3333).frame;
  const fullScale = loadGuest(moduleArg);
  fullScale.setAudio({ energyQ16: 65536 });
  checkFrameExact("energy above full scale clamps", clampedFrame, fullScale.tick(3333).frame);

  // A beat on any band flashes the crest column white, top to bottom, over
  // whatever the wave painted there. src/main.c ORs the four per-band flags
  // together, so band 3 alone has to do it just as band 0 does.
  for (const beatMask of [0b0001, 0b1000, 0b1111]) {
    const guest = loadGuest(moduleArg);
    guest.setAudio({ beatMask });
    const { frame } = guest.tick(3333);
    checkFrameExact(`beat mask 0b${beatMask.toString(2)} matches the fixed-point model`, frame,
                    fixedFrame(3333, { colour: DEFAULT_COLOR, beat: true }));
    const column = crestColumn(3333);
    let detail = "";
    for (let y = 0; y < HEIGHT; ++y) {
      if (frame[y * WIDTH + column] !== 0x00ffffff) {
        detail = `row ${y} of column ${column} is 0x${frame[y * WIDTH + column].toString(16)}`;
        break;
      }
    }
    check(`beat mask 0b${beatMask.toString(2)} flashes column ${column} white`, detail === "",
          detail);
  }

  // No beat, no flash: the crest column is painted like any other.
  const quiet = loadGuest(moduleArg);
  const quietFrame = quiet.tick(3333).frame;
  const column = crestColumn(3333);
  let whiteRows = 0;
  for (let y = 0; y < HEIGHT; ++y) {
    if (quietFrame[y * WIDTH + column] === 0x00ffffff) ++whiteRows;
  }
  checkEqual("without a beat the crest column is not flashed", whiteRows, 0);
}

// ---------------------------------------------------------------------------
// Case 6: parameters.
//
// Speed scales the accumulator step: 100 is 2x, so a 1000 ms tick advances
// 2000 ms of animation. Color sets the crest, and the body is Color divided by
// three PER CHANNEL, which is not the same as dividing the packed value:
//
//   0x123456 -> (0x12/3, 0x34/3, 0x56/3) = (6, 17, 28) = 0x06111c
//
// src/main.c takes the three low bytes of the parameter, so a high byte the
// host leaves set has to be masked off rather than reaching the panel.
// ---------------------------------------------------------------------------
console.log("case 6: parameters");
{
  const fast = loadGuest(moduleArg);
  fast.setParams({ [SPEED]: 100 });
  checkEqual("Speed 100 is 2x", advanceAccumulator(0, 1000, 100), 2000);
  checkFrameExact("a 1000 ms tick at Speed 100 lands on t = 2000 ms", fast.tick(1000).frame,
                  fixedFrame(2000, { colour: DEFAULT_COLOR }));

  const tinted = loadGuest(moduleArg);
  tinted.setParams({ [COLOR]: 0x123456 });
  const { frame } = tinted.tick(3333);
  checkFrameExact("a non-default Color matches the fixed-point model", frame,
                  fixedFrame(3333, { colour: 0x123456 }));
  checkEqual("Color/3 per channel", bodyColour(0x123456), 0x06111c);

  const masked = loadGuest(moduleArg);
  masked.setParams({ [COLOR]: 0xab123456 });
  checkFrameExact("a Color with a high byte set is masked to 24 bits",
                  masked.tick(3333).frame, frame);
}

// ---------------------------------------------------------------------------
// Case 7: a sampled sweep of the period.
//
// The cases above check the exact fixed-point model at the handful of times
// the accumulator arithmetic lands on, which leaves room for an edit that
// changes the animation only at times none of them visit. So sweep: twenty
// evenly spaced times, k*400 for k in 0..19, which is arbitrary by design and
// covers the period.
//
// The five (time, energy) pairs added after them are not arbitrary. They were
// derived by perturbing each constant of the fixed-point arithmetic by powers
// of two, at four energies (0, 16384, 32768 and 65536), recording the points
// whose frames move, and covering those lists. Re-derive them the same way if
// the arithmetic changes.
//
// Read the middle column below for exactly what it is. It is the smallest
// POWER OF TWO that moves a frame AT ONE OF THOSE FOUR ENERGIES, which is not
// the same thing as the smallest perturbation that is visible at all. The
// right column is the smallest visible perturbation full stop, found by
// checking every one of the 65537 admissible energies at every angle the
// animation can form. They are far apart, and the sweep catches only three of
// the fourteen.
//
//   constant          power of two at    smallest visible   caught by the
//                     4 energies         anywhere           sweep?
//   68719476736       -2048 / +65536     -290 / +855        no  / no
//   -11453246123      -1024 / +32768     -370 / +1086       no  / no
//   572662306          -256 / +16384     -181 / +570        no  / no
//   -13634817          -128 /  +4096      -89 / +277        no  / no
//   189372              -64 /  +2048      -40 / +127        YES / no
//   -1722               -16 /  +1024      -16 /  +59        YES / no
//   11                   -8 /   +256       -7 /  +27        YES / no
//   TAU_Q24            -512 /   +128      not searched
//   PI_Q24              -64 /  +2048      not searched
//   amp base 33554432     -1 /    +64     not searched
//   amp slope 1280        -1 /     +1     not searched
//   angle round 2000 -262144 / +262144    not searched
//
// The eleven "no" rows are the honest limit of this case: a perturbation an
// order of magnitude smaller than the one the sweep trips on is visible
// SOMEWHERE in the input space, and this suite would not see it. What sees it
// is the module digest CI asserts. The witnesses are real points, not
// hypotheticals: 68719476736 - 290 moves the frame at t = 93, column 14,
// energy 65465, and the three the sweep does catch all show at t = 0, column
// 10, energy 0, which is the crest column at silence.
//
// Two findings from that search are worth writing down rather than hiding.
//
// First, a single-unit change to any polynomial coefficient changes NO frame
// this animation can paint, at any of the 8000 phases, 40 columns, or any of
// the 65537 energies. That is not the result's rounding absorbing it: for most
// of the coefficients the Q24 sine really does move, at up to 114 of the 11900
// distinct angles the animation forms. What absorbs it is the last step, the
// truncation of the wave offset to a whole panel row: a one-unit change moves
// the offset by at most 7 * 2^-24 of a row, so it can only matter where the
// offset already sits within that of a row boundary, and at no angle and no
// energy does it. The smallest perturbation of any coefficient that survives
// that truncation is 7 units, on the x^13 term.
//
// Second, HALF_PI_Q24 is a branch threshold rather than an operand, and moving
// it by up to 2^20 either way changes no frame either: the two sides of the
// reduction agree to well past Q24 near the fold. It is covered only by the
// digest.
//
// Sampling narrows the gap rather than closing it. The check that the module
// did not change at all is the digest, not a sample of times.
// ---------------------------------------------------------------------------
console.log("case 7: sampled sweep of the period");
{
  const sampled = [];
  for (let k = 0; k < 20; ++k) sampled.push([k * 400, 0]);
  sampled.push([0, 65536], [1, 0], [3, 32768], [22, 16384], [78, 16384]);

  let mismatch = "";
  let fidelity = "";
  let worstOffset = 0;
  for (const [time, energyQ16] of sampled) {
    // One tick of dt = time at the default 1x Speed puts the accumulator at
    // exactly `time`, since time < 8000 and the step is unwrapped there.
    const guest = loadGuest(moduleArg);
    guest.setAudio({ energyQ16 });
    const { frame } = guest.tick(time);
    const options = { colour: DEFAULT_COLOR, energyQ16 };
    if (!mismatch) {
      const index = firstDifference(frame, fixedFrame(time, options));
      if (index >= 0) {
        mismatch = `t = ${time}, energy ${energyQ16}: ` +
                   describePixel(index, frame[index], fixedFrame(time, options)[index]);
      }
    }
    worstOffset = Math.max(worstOffset, offsetError(time, energyQ16));
    if (!fidelity) {
      const expected = floatFrame(time, options);
      const allowed = new Set(boundaryColumns(time, energyQ16, OFFSET_TOLERANCE));
      for (let index = 0; index < PIXEL_COUNT; ++index) {
        if (frame[index] !== expected[index] && !allowed.has(index % WIDTH)) {
          fidelity = `t = ${time}, energy ${energyQ16}: ` +
                     describePixel(index, frame[index], expected[index]);
          break;
        }
      }
    }
  }
  check(`all ${sampled.length} sampled points match the fixed-point model exactly`,
        mismatch === "", mismatch);
  check(`all ${sampled.length} sampled points match the canonical float animation`,
        fidelity === "", fidelity);
  check(`the wave offset stays within ${OFFSET_TOLERANCE} rows across the sweep`,
        worstOffset <= OFFSET_TOLERANCE, `largest offset error ${worstOffset.toExponential(3)}`);
}

console.log(`\n${failures === 0 ? "RGBX v2 parity tests passed" : `${failures} parity check(s) FAILED`}` +
            ` (${WIDTH}x${HEIGHT} frame, ${PIXEL_COUNT} pixels)`);
process.exit(failures === 0 ? 0 : 1);
