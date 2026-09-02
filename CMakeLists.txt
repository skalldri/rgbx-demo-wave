# rgbx extension: builds a device .llext, a simulator .wasm, and a device
# RGBX v2 .rgbx package from single translation units, using the rgbx-sdk
# pinned in cmake/fw-release.cmake.
#
# Ordering below is LOAD-BEARING: the SDK must be downloaded and
# CMAKE_TOOLCHAIN_FILE set BEFORE project(), because that is where CMake
# loads the toolchain. Everything SDK-related after project() is a plain
# include().
#
#   ./build.sh                      # build/arm + build/wasm + build/rgbx-v2
#   cmake --preset arm && cmake --build --preset arm    # one target
#
# To rename your extension, change the project() name below - the output
# files follow it. Keep it matching ^[a-z0-9_]{1,25}$ (it becomes the
# .llext filename on the device, and must equal your future registry-entry
# name in the rgb-sunglasses repo). "extensionId" in rgbx-v2.json is a
# separate field with a separate shape (^[a-z0-9][a-z0-9._-]{0,30}$) that
# nothing derives from the project name; the two are kept equal here on
# purpose, so a rename is an edit in both places.
#
# src/main.c is the llext and simulator translation unit. The rgbx-v2 target
# is separate and always builds src/main_v2.c; see below.

cmake_minimum_required(VERSION 3.21)

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/fw-release.cmake")
include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/get-rgbx-sdk.cmake")  # sets RGBX_SDK_DIR

if(NOT DEFINED RGBX_TARGET)
    message(FATAL_ERROR "configure via a preset: cmake --preset arm | cmake --preset wasm | cmake --preset rgbx-v2 (or pass -DRGBX_TARGET=...)")
endif()
# Spell out every target: a typo such as -DRGBX_TARGET=rgbx_v2 should say so
# rather than quietly building whichever one the fallback happened to name.
if(RGBX_TARGET STREQUAL "arm")
    set(CMAKE_TOOLCHAIN_FILE "${RGBX_SDK_DIR}/cmake/toolchains/arm-llext.cmake")
elseif(RGBX_TARGET STREQUAL "wasm")
    set(CMAKE_TOOLCHAIN_FILE "${RGBX_SDK_DIR}/cmake/toolchains/wasm.cmake")
elseif(RGBX_TARGET STREQUAL "rgbx-v2")
    set(CMAKE_TOOLCHAIN_FILE "${RGBX_SDK_DIR}/cmake/toolchains/rgbx-v2.cmake")
else()
    message(FATAL_ERROR "unknown RGBX_TARGET '${RGBX_TARGET}': expected arm, wasm or rgbx-v2")
endif()

project(demo_wave C CXX)

include("${RGBX_SDK_DIR}/cmake/rgbx-sdk-config.cmake")

if(RGBX_TARGET STREQUAL "rgbx-v2")
    # The v2 guest is a different ABI, not a recompile of the .llext/.wasm
    # source: no framebuffer, no linear memory, no floating point, and the
    # audio inputs arriving as capability-gated integer reads rather than as
    # floats in a struct. So it gets its own translation unit, and its own
    # manifest describing the package the firmware installs. rgbx-v2.json
    # names src/main_v2.c as the source it covers, and the packager refuses to
    # run unless that is the same file this line compiled, so keep the two in
    # step when renaming either.
    rgbx_add_extension(${PROJECT_NAME}
        SOURCES src/main_v2.c
        MANIFEST rgbx-v2.json)

    # Known-answer parity tests over the gated module. The SDK's own gate
    # proves the module is admissible and paints a full frame; these prove it
    # still paints the CANONICAL frame, which is what stops a future edit to
    # src/main_v2.c from silently changing the animation on every device.
    # Wired into the build (not left to CI) so a local ./build.sh is the same
    # gate CI runs.
    set(_parity_stamp "${CMAKE_CURRENT_BINARY_DIR}/parity.stamp")
    add_custom_command(
        OUTPUT "${_parity_stamp}"
        COMMAND "${RGBX_NODE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/rgbx-v2-parity.mjs"
                "${CMAKE_CURRENT_BINARY_DIR}/${PROJECT_NAME}.wasm"
        COMMAND "${CMAKE_COMMAND}" -E touch "${_parity_stamp}"
        DEPENDS "${CMAKE_CURRENT_BINARY_DIR}/${PROJECT_NAME}.wasm"
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/rgbx-v2-parity.mjs"
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/demo-wave-reference.mjs"
        COMMENT "Running RGBX v2 parity tests for ${PROJECT_NAME}.wasm"
        VERBATIM)
    add_custom_target(${PROJECT_NAME}_parity ALL DEPENDS "${_parity_stamp}")
else()
    rgbx_add_extension(${PROJECT_NAME} SOURCES src/main.c)
endif()
