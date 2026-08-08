# Download and extract the pinned rgbx-sdk BEFORE project() runs, so its
# toolchain files exist when CMake needs them. Sets RGBX_SDK_DIR.
#
# Override for CI / local development against an unreleased SDK:
#   -DRGBX_SDK_SOURCE_DIR=<extracted rgbx-sdk tree>  (a package-sdk.sh output)

if(DEFINED RGBX_SDK_SOURCE_DIR)
    get_filename_component(RGBX_SDK_DIR "${RGBX_SDK_SOURCE_DIR}" ABSOLUTE)
    if(NOT EXISTS "${RGBX_SDK_DIR}/cmake/rgbx-sdk-config.cmake")
        message(FATAL_ERROR "RGBX_SDK_SOURCE_DIR='${RGBX_SDK_SOURCE_DIR}' does not look like an extracted rgbx-sdk tree")
    endif()
    return()
endif()

string(REGEX REPLACE "^fw-v" "" _rgbx_sdk_version "${RGBX_FW_RELEASE}")
# Shared across presets: both configure passes reuse one download/extraction.
set(_rgbx_sdk_store "${CMAKE_CURRENT_SOURCE_DIR}/build/_rgbx-sdk")
set(_rgbx_sdk_tarball "${_rgbx_sdk_store}/rgbx-sdk-${_rgbx_sdk_version}.tar.gz")
set(RGBX_SDK_DIR "${_rgbx_sdk_store}/rgbx-sdk-${_rgbx_sdk_version}")

if(NOT EXISTS "${RGBX_SDK_DIR}/cmake/rgbx-sdk-config.cmake")
    set(_rgbx_sdk_url "https://github.com/skalldri/rgb-sunglasses/releases/download/${RGBX_FW_RELEASE}/rgbx-sdk-${_rgbx_sdk_version}.tar.gz")
    message(STATUS "Downloading rgbx-sdk ${_rgbx_sdk_version} from ${RGBX_FW_RELEASE} ...")
    file(DOWNLOAD "${_rgbx_sdk_url}" "${_rgbx_sdk_tarball}"
         EXPECTED_HASH SHA256=${RGBX_SDK_SHA256}
         STATUS _rgbx_sdk_dl
         SHOW_PROGRESS)
    list(GET _rgbx_sdk_dl 0 _rgbx_sdk_dl_code)
    if(NOT _rgbx_sdk_dl_code EQUAL 0)
        list(GET _rgbx_sdk_dl 1 _rgbx_sdk_dl_msg)
        message(FATAL_ERROR "rgbx-sdk download failed: ${_rgbx_sdk_dl_msg} (${_rgbx_sdk_url})")
    endif()
    file(ARCHIVE_EXTRACT INPUT "${_rgbx_sdk_tarball}" DESTINATION "${_rgbx_sdk_store}")
endif()
