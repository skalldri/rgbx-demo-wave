# rgbx-extension-template

Template for building **rgbx animation extensions** for the
[RGB Sunglasses](https://github.com/skalldri/rgb-sunglasses) — standalone, with
no firmware-repo checkout and no Zephyr toolchain. One C (or C++) file becomes
both a device-loadable `.llext` and a `.wasm` you can test instantly in the
hosted web simulator.

## Quick start

1. **Use this template** (or fork) → clone your new repo.
2. Build both artifacts (first run downloads the pinned SDK + toolchains,
   ~5 min; afterwards it's seconds):

   ```bash
   ./build.sh
   ```

   Prerequisites: bash, cmake ≥ 3.21, Node.js ≥ 20, curl, tar
   (Linux or macOS; on Windows use WSL).

3. **Test without hardware**: drag `build/wasm/my_extension.wasm` onto
   <https://rgb-sunglasses.autom8ed.com/sim/>. The simulator runs your real
   code against the firmware's tick semantics — parameters, IMU/audio/button
   inputs, brightness behavior and all.
4. Edit `src/main.c` (it's the kitchen-sink "hello" reference — every
   parameter type and every input source) and iterate.
5. **Rename your extension**: change `project(my_extension ...)` in
   `CMakeLists.txt`. The name must match `^[a-z0-9_]{1,25}$` — it becomes the
   `.llext` filename on the device and must equal your future registry-entry
   name (below).

## Testing on real hardware (optional)

Copy `build/arm/<name>.llext` onto the glasses' USB mass-storage disk under
`ext/`, then sync, eject, and reboot the board. The firmware discovers
extensions at boot; select yours from the companion app or the `ext` shell
command.

## Publishing your extension

When it's ready, submit a PR to the
[rgb-sunglasses](https://github.com/skalldri/rgb-sunglasses) repo adding one
entry to `extensions/registry.json`:

```json
{
  "name": "my_extension",
  "repo": "https://github.com/you/your-extension-repo",
  "rev": "<full 40-hex commit SHA to publish>",
  "description": "One line about what it looks like",
  "author": "you",
  "license": "MIT"
}
```

`name` must equal your CMake project name; `rev` is the exact commit the
maintainers review and build. Once merged, every firmware release rebuilds
your extension from that pinned commit and ships it as a release asset — the
companion app then installs it onto devices automatically. Your repo must
carry an OSI-approved license.

## Rules of the sandbox

Your extension runs in a memory-protected sandbox with a per-tick CPU budget.
The build gates enforce most of this, but know the constraints:

- **One translation unit** (`src/main.c` — a single `.c` or `.cpp`).
- **40×12 framebuffer**, RGB8. Render near full-scale (255) channel values —
  the firmware applies a global brightness factor (default 0.02), so dim
  drawing is invisible on the panel.
- **≤ 16 parameters, ≤ 4 of them strings** (see the manifest in `src/main.c`).
- **No heap, no exceptions, no RTTI, no libm** — nothing links a math library
  on-device, so `sinf()` etc. fail the build gate (use integer math or plain
  single-precision float arithmetic, which the FPU handles inline).
- **≤ 24 KB** total loaded size (build gate checks this).
- **Globals reset on every activation** — the firmware reloads your extension
  each time it's selected; persist nothing.
- Only `str*`/`mem*` functions and `printk` are callable; `printk` output
  shows in the simulator's console and the device's debug shell.

## Updating the SDK pin

`cmake/fw-release.cmake` pins the firmware release (and its `rgbx-sdk`
tarball sha256) this extension builds against. To move to a newer firmware
release, update both lines from the release page's `rgbx-sdk-*.tar.gz` asset
and rebuild. The ABI is append-only within a version, so newer SDKs build
older extension source unchanged; a genuine ABI version bump is announced in
the firmware release notes.
