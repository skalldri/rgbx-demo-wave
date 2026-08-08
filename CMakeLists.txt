# rgbx extension — builds a device .llext and a simulator .wasm from one
# translation unit, using the rgbx-sdk pinned in cmake/fw-release.cmake.
#
# Ordering below is LOAD-BEARING: the SDK must be downloaded and
# CMAKE_TOOLCHAIN_FILE set BEFORE project(), because that is where CMake
# loads the toolchain. Everything SDK-related after project() is a plain
# include().
#
#   ./build.sh                      # both targets: build/arm + build/wasm
#   cmake --preset arm && cmake --build --preset arm    # one target
#
# To rename your extension, change the project() name below — the output
# files follow it. Keep it matching ^[a-z0-9_]{1,25}$ (it becomes the
# .llext filename on the device, and must equal your future registry-entry
# name in the rgb-sunglasses repo).

cmake_minimum_required(VERSION 3.21)

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/fw-release.cmake")
include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/get-rgbx-sdk.cmake")  # sets RGBX_SDK_DIR

if(NOT DEFINED RGBX_TARGET)
    message(FATAL_ERROR "configure via a preset: cmake --preset arm | cmake --preset wasm (or pass -DRGBX_TARGET=...)")
endif()
if(RGBX_TARGET STREQUAL "arm")
    set(CMAKE_TOOLCHAIN_FILE "${RGBX_SDK_DIR}/cmake/toolchains/arm-llext.cmake")
else()
    set(CMAKE_TOOLCHAIN_FILE "${RGBX_SDK_DIR}/cmake/toolchains/wasm.cmake")
endif()

project(my_extension C CXX)

include("${RGBX_SDK_DIR}/cmake/rgbx-sdk-config.cmake")

rgbx_add_extension(${PROJECT_NAME} SOURCES src/main.c)
