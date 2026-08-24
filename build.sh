#!/usr/bin/env bash
# Build both targets: the device .llext (build/arm/) and the simulator .wasm
# (build/wasm/). Extra arguments pass through to both cmake configures, e.g.:
#
#   ./build.sh                              # normal build
#   ./build.sh -DRGBX_STRICT_TOOLCHAIN=ON   # CI: pin deviations are fatal
#   ./build.sh -DRGBX_SDK_SOURCE_DIR=<dir>  # build against a local SDK tree
#   ./build.sh -URGBX_NODE                  # re-detect node after upgrading it
#
# (This wrapper exists instead of a CMake workflow preset because workflow
# presets need CMake >= 3.25 and the project supports 3.21.)

set -euo pipefail
cd "$(dirname "$0")"

# The SDK's wasm gate (check-wasm.mjs) uses top-level await, so an older node
# fails the wasm link with a bare SyntaxError pointing into the SDK tarball,
# naming neither node nor a version. Check it here instead, before the
# first-run SDK + toolchain download.
#
# Check the interpreter the build will actually USE: the SDK's
# find_program(RGBX_NODE node) caches its result, so an already-configured
# tree keeps running whatever node was first on PATH when it was configured,
# even after a newer one is installed. Only the wasm tree caches it (the SDK's
# find_program is inside its `if(RGBX_TARGET STREQUAL "wasm")` block).
wasm_cache="build/wasm/CMakeCache.txt"
for arg in "$@"; do
    # This invocation drops or overrides the cache entry, so PATH decides.
    case "$arg" in -URGBX_NODE | -DRGBX_NODE=*) wasm_cache="" ;; esac
done

node_bin=""
node_hint="hint: install Node.js >= 20, e.g. via nvm:  nvm install 22"
if [ -n "$wasm_cache" ] && [ -f "$wasm_cache" ]; then
    node_bin="$(sed -n 's/^RGBX_NODE:FILEPATH=//p' "$wasm_cache")"
    case "$node_bin" in *-NOTFOUND) node_bin="" ;; esac
    if [ -n "$node_bin" ]; then
        node_hint="hint: build/wasm cached this node when it was configured — after installing a newer one, re-run ./build.sh -URGBX_NODE"
    fi
fi
if [ -z "$node_bin" ]; then
    node_bin="$(command -v node || true)"
fi

if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
    echo "error: node not found — Node.js >= 20 is required to run the wasm module gate (check-wasm.mjs)" >&2
    echo "hint: install Node.js >= 20, e.g. via nvm:  nvm install 22" >&2
    exit 1
fi

node_version="$("$node_bin" --version 2>/dev/null || true)"  # e.g. v22.14.0
node_major="${node_version#v}"
node_major="${node_major%%.*}"
case "$node_major" in
    '' | *[!0-9]*)
        echo "error: could not read a version from '$node_bin --version' (got '$node_version')" >&2
        exit 1
        ;;
esac
if [ "$node_major" -lt 20 ]; then
    echo "error: node $node_version at '$node_bin' is too old — Node.js >= 20 is required to run the wasm module gate (check-wasm.mjs)" >&2
    echo "$node_hint" >&2
    exit 1
fi

for preset in arm wasm; do
    cmake --preset "$preset" "$@"
    cmake --build --preset "$preset"
done

echo
echo "Artifacts:"
ls build/arm/*.llext build/wasm/*.wasm
