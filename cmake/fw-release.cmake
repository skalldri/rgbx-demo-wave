# The single pin tying this extension to a firmware release. Bumping to a
# new firmware release = editing these two lines. The sha256 is the digest
# of the rgbx-sdk-<ver>.tar.gz asset on that release (GitHub shows it on
# the release page; or sha256sum the downloaded file).
set(RGBX_FW_RELEASE "fw-v3.0.0")
set(RGBX_SDK_SHA256 "9049bad06148ccfcf205f4fb4f6573ad86f17a8648cdb75292f9ece487030074")
