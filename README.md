# rgbx-demo-wave

`demo_wave` — the worked example of a **standalone rgbx animation extension**
for the [RGB Sunglasses](https://github.com/skalldri/rgb-sunglasses), built
from [rgbx-extension-template](https://github.com/skalldri/rgbx-extension-template)
and registered in the main repo's `extensions/registry.json`.

A wave rolls across the 40×12 panel: crest color and speed are BLE-settable
parameters, the wave's amplitude swells with audio energy, and a beat fires a
full-column flash at the crest. Integer math plus single-precision float only
— the device exports no math library, and the SDK's build gate enforces that.

## Build

```bash
./build.sh
```

produces three artifacts:

| Path | What it is |
| --- | --- |
| `build/arm/demo_wave.llext` | Device extension, native code in a memory-protected sandbox. |
| `build/wasm/demo_wave.wasm` | Simulator build; drag it onto <https://rgb-sunglasses.autom8ed.com/sim/> and try the `metronome-120` audio scenario to see the beat response. |
| `build/rgbx-v2/demo_wave.rgbx` | RGBX v2 package, the format newer firmware installs. |

Build one target on its own with
`cmake --preset rgbx-v2 && cmake --build --preset rgbx-v2`, substituting
`arm` or `wasm` for the other two.

Prerequisites: bash, cmake ≥ 3.21, Node.js ≥ 20, curl, tar. `build.sh` checks the
Node version before it configures anything — the SDK's wasm gate
(`check-wasm.mjs`) needs ≥ 20, and an older one fails the wasm link with a bare
`SyntaxError` from inside the SDK. If you upgrade Node after a build, re-run
`./build.sh -URGBX_NODE`: CMake cached the old interpreter's path at configure
time and keeps using it otherwise.

## The RGBX v2 package

RGBX v2 loads a memoryless WebAssembly guest and drives it through a small
import surface, rather than loading native code. A guest gets no linear
memory, no C library and no floating-point opcodes, so `src/main.c` cannot be
recompiled for it: `src/main_v2.c` is the same animation written in integer
fixed point, and the framebuffer it used to fill becomes 60 ordered
`set_span8` calls.

Two things change shape in the port, and both are visible in the source.

The wave. `sinf()` becomes a range-reduced odd Maclaurin polynomial through
`x^13` evaluated in Q24, with each column's angle formed as an exact rational,
`TAU * (100*x + phase_ms) / 4000`, in one rounded 64-bit division. The
accumulator's `dt_ms * Speed` product is widened to 64 bits along the way,
which `src/main.c` does not do: in 32 bits it wraps at the top of the uint32
range and freezes the animation at the fastest Speed the app can ask for.

That polynomial runs once per PIXEL: 480 evaluations per frame, not 40. A guest
has no linear memory and at most 8 globals, so there is nowhere to cache the 40
crest rows between the rows that reuse them, and the span order is fixed
row-major. This is the sharpest cost difference from the plasma extension,
which seeds six sines per frame and walks the rest by integer angle addition.
`rgbx_tick` measures 7.4 to 7.6 us here across three runs of 20000 ticks after
a 2000-tick warm-up on a desktop JIT, so plausibly a fraction of a millisecond
on the device's interpreter.

A maintainer tightening the frame budget should know where that work is, and
also why the recurrence is not the answer. Modelled on this animation and
reseeded per row, a Q15 sin/cos pair rotation is 4.5e-3 rows from the ideal and
the cheaper two-term form is 2.8e-2, against the 7.2e-7 the polynomial achieves
below: thousands to tens of thousands of times worse. Plasma can afford that
because it quantizes to an 8-bit luma; this animation truncates its offset to a
whole panel row, which has no tolerance at all.

The module also sits at exactly 8 of the 8 functions the profile admits, 4
imported and 4 defined. It cannot gain another non-inlined helper without
failing admission, which is worth knowing before splitting one up.

The audio. `src/main.c` reads `audio_display_bucket[0]` and the four per-band
beat flags out of `struct rgbx_inputs`. RGBX v2 has no such struct: the guest
asks for them through the `input_u32` import, one Q16 energy and one beat
mask, and `rgbx-v2.json` declares the `audio` capability that entitles it to
them. A package that reads those selectors without declaring the capability is
refused at install time.

The two sources are both first-class. `src/main.c` builds the `.llext` and the
simulator `.wasm`; `src/main_v2.c` builds the `.rgbx`. They are the same
animation, and the parity tests below are what keeps them that way.

`rgbx-v2.json` is the manifest describing the package: identity, version, ABI,
geometry, capabilities, compiler pin, and the parameter list the companion app
shows. Its `parameters` block mirrors the `RGBX_PARAM` table in `src/main.c`,
so Speed and Color keep their slots and defaults across both formats. The
build hashes the exact translation unit it compiled into the package's
provenance field, and refuses to run if `sourceFile` names anything else.

Building the `rgbx-v2` preset runs the SDK's post-link pass, its structural
admission gate, its tick oracle, this repo's parity tests, and the container
builder. Any of them failing fails the build, so a module a device would
refuse cannot be produced here. The
[template's README](https://github.com/skalldri/rgbx-extension-template)
documents that flow, the memoryless profile and every manifest field in full;
this repo only pins and uses it.

The container bytes are a function of the source revision, the manifest and
the SDK pin, and of nothing else. Two clean builds of an unchanged tree
produce an identical file, and CI proves it on every change by building the
package a second time in a differently named directory, comparing bytes, and
checking both artifacts against the digests recorded below.

```bash
rm -rf build && ./build.sh
shasum -a 256 build/rgbx-v2/demo_wave.rgbx   # sha256sum on Linux
```

## Canonical source for the RGBX v2 demo_wave

`src/main_v2.c` is meant to be the one place the RGBX v2 demo_wave exists. The
intent is that the firmware repository consumes this repository at a pinned
revision and digest rather than carrying a second copy of the animation.
Nothing here claims it does so today; that is a firmware-side change, and this
README will not tell you whether it has happened.

What already holds is the part such a pin would rest on: the module bytes are
the byte-for-byte output of the pinned SDK toolchain over this source. Same
source plus same pin equals the same module, on any machine and on either
supported host OS.

Treat an edit to `src/main_v2.c` as a change to what every device running this
effect would ship, and one that surfaces downstream as a changed module
digest. Two rules follow:

- Do not adjust the arithmetic to make a test pass. The expectations in
  `tests/` are derived from the animation, not recorded from a build, so a
  failure means the animation moved.
- Bump `version` in `rgbx-v2.json` when the module changes. It is the only
  thing that tells an installed device the package is not the one it has.

Recorded at the port to RGBX v2, against the `fw-v3.5.0` SDK pin, and asserted
by CI on every change:

| Artifact | SHA-256 | Moves when |
| --- | --- | --- |
| `build/rgbx-v2/demo_wave.wasm` | `72bd42a5d2721f358770a7d1b99f3274c1ed978769a5f85f069e43118b5bbc56` | The compiled content of `src/main_v2.c` changes, or the SDK pin does. The module is compiled, post-linked and gated before the packager ever reads `rgbx-v2.json`, so neither the manifest nor a comment-only source edit reaches these bytes. |
| `build/rgbx-v2/demo_wave.rgbx` | `54f49703bed403e735fd732703aac5a7e2a78bad3ce97ab26bfbac63ffca7cce` | Any of those, or `rgbx-v2.json`, or the source file's bytes. The container carries the manifest, and the manifest records the SHA-256 of the translation unit, so a `version` bump or even a comment-only source edit moves this digest while leaving the module identical. |

Recompute both with the `shasum` line above. When a change is supposed to move
one of them, the CI assertion moves with it in the same commit; that is the
point at which someone has to say so out loud.

## Parity guarantees

The SDK's gate proves the module is admissible and paints a complete frame. It
never looks at a pixel, so it would pass a module whose animation had quietly
changed. `tests/rgbx-v2-parity.mjs` closes that gap, and runs as part of the
`rgbx-v2` build rather than only in CI:

```bash
node tests/rgbx-v2-parity.mjs build/rgbx-v2/demo_wave.wasm
```

It drives the built module and compares each frame against two models in
`tests/demo-wave-reference.mjs`, neither of which reads the module:

- **The canonical float animation**, which is `src/main.c`'s formula in
  double-precision `Math.sin`. Note what this is and is not: it is the ideal
  animation, not the compiled `src/main.c`, which evaluates the same formula in
  float32 and is itself an approximation of it. Measured over 2880000
  `(column, phase, energy)` points, the compiled float original is 1.9e-5 rows
  from the ideal and the fixed-point port is 7.2e-7, so the port is the closer
  of the two by a factor of 26. The two agree on every pixel of that grid, and
  can only differ at knife-edge points where an offset lands on a whole row; at
  those the port is the more exact. The comparison is therefore the fidelity
  claim for the port, and evidence that the two sources paint the same picture,
  but it is not a direct comparison against the compiled `.llext`.
- **An independent re-derivation of the fixed-point method** in JavaScript,
  written from the arithmetic rather than compiled from the C, with the wide
  products in BigInt because the guest forms them in `int64_t` and they do not
  fit a double. The module has to match it exactly, which pins every rounding
  decision.

The fidelity claim is a property, not a tolerance. The guest's sine is within
1.65 Q24 units of the true sine over every one of the 320000 angles this
animation can form, the amplitude is exact in Q24 for every admissible audio
energy, and it never exceeds 7, so the wave offset is within
`1.65 * 2^-24 * 7 + 2^-25 = 7.2e-7` rows of the double-precision original for
every input. The crest row is a truncation of that offset, so an error that
small can only change a pixel in a column whose float offset is itself within
7.2e-7 of a whole row. The tests therefore require exact agreement with the
float animation at every other column, rather than tolerating a count of wrong
pixels.

The cases are the ones where the arithmetic is load-bearing: a `t = 0` frame
checked against ten columns whose crest row is computable by hand, a
mid-animation frame, the 8000 ms accumulator wrap (where the frame after the
wrap must be the frame before the animation started, byte for byte), a step
larger than the whole period, both 64-bit multiplications the guest performs,
the audio energy and beat inputs including the clamp above full scale, and the
Speed and Color parameters. Each case carries its arithmetic in a comment and
a literal expected value in the assertion, so a regression names the step that
broke.

A final case sweeps 25 sampled points: twenty evenly spaced times across the
period, plus five `(time, energy)` pairs derived by perturbing each constant of
the fixed-point arithmetic and covering the points whose frames move. The
comment above it records that derivation, and two findings from it that are
worth knowing before trusting the sweep:

- The sweep probes each constant at **powers of two, at four energies** (0,
  16384, 32768 and 65536). That is weaker than it sounds. Searching every one of
  the 65537 admissible energies at every angle the animation can form finds
  perturbations an order of magnitude smaller that move a frame somewhere:
  `68719476736 - 290` moves the frame at t = 93, column 14, energy 65465, for
  instance. Of the fourteen smallest-visible perturbations of the seven
  polynomial coefficients, this sweep catches **three**. The other eleven are
  covered by the digest assertion and by nothing else. The comment above the
  case carries the full table, both columns and a per-row yes or no.
- A single-unit change to any coefficient does change **no** frame this
  animation can paint, at any phase, column or energy; that part was confirmed
  exhaustively. The reason is not the rounding of the Q24 result, which for most
  coefficients does move, at up to 114 of the 11900 distinct angles. It is the
  last step: the wave offset is truncated to a whole panel row, and one unit
  moves the offset by at most `7 * 2^-24` of a row. The smallest perturbation of
  any coefficient that survives that truncation is 7 units, on the `x^13` term.
- `HALF_PI_Q24` is a branch threshold rather than an operand, and moving it by
  up to 2^20 either way changes no frame either.

Sampling narrows the gap rather than closing it. The check that the module did
not change at all is the digest CI asserts.

## Firmware pin

`cmake/fw-release.cmake` pins the firmware release, and the sha256 of its
`rgbx-sdk-*.tar.gz` asset, that this extension builds against. The digest is
checked before the archive is extracted, so a wrong or corrupted download
fails configure instead of building against whatever arrived.

Four fields in `rgbx-v2.json` move with the pin: `compilerVersion` and
`rgbxAbi` must equal the SDK's, `geometry` must equal the release's frame size,
and `minimumFirmwareAbi` may not exceed the SDK's ABI version. The packager
checks all four and fails when they drift, so a pin bump that moves any of them
is an edit to that file too.

## How this repo gets onto real devices

It's listed in the main repo's extension registry pinned at a specific
commit; every firmware release rebuilds it from that commit and ships
`demo_wave.llext` as a release asset, which the companion app installs
automatically. See the template's README for the full publishing flow.

The `.rgbx` package follows the same pinned-revision route on firmware that
supports RGBX v2.
