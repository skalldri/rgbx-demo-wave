# The single pin tying this extension to a firmware release. Bumping to a
# new firmware release = editing these two lines. The sha256 is the digest
# of the rgbx-sdk-<ver>.tar.gz asset on that release (GitHub shows it on
# the release page; or sha256sum the downloaded file).
set(RGBX_FW_RELEASE "fw-v3.1.0")
set(RGBX_SDK_SHA256 "3917c655ae215c2f240021310e77e75b56bff981f876bd468e5738e7e25043e0")
