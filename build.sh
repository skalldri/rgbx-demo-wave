#!/usr/bin/env bash
# Build both targets: the device .llext (build/arm/) and the simulator .wasm
# (build/wasm/). Extra arguments pass through to both cmake configures, e.g.:
#
#   ./build.sh                              # normal build
#   ./build.sh -DRGBX_STRICT_TOOLCHAIN=ON   # CI: pin deviations are fatal
#   ./build.sh -DRGBX_SDK_SOURCE_DIR=<dir>  # build against a local SDK tree
#
# (This wrapper exists instead of a CMake workflow preset because workflow
# presets need CMake >= 3.25 and the project supports 3.21.)

set -euo pipefail
cd "$(dirname "$0")"

for preset in arm wasm; do
    cmake --preset "$preset" "$@"
    cmake --build --preset "$preset"
done

echo
echo "Artifacts:"
ls build/arm/*.llext build/wasm/*.wasm
