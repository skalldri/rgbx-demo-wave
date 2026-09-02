# The single pin tying this extension to a firmware release. Bumping to a
# new firmware release = editing these two lines. The sha256 is the digest
# of the rgbx-sdk-<ver>.tar.gz asset on that release (GitHub shows it on
# the release page; or sha256sum the downloaded file).
set(RGBX_FW_RELEASE "fw-v3.5.0")
set(RGBX_SDK_SHA256 "dc899bd009523eb84d35b446533e11908367ec642dafe47e761dd25960c7d0b3")
