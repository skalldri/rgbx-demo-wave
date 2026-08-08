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

produces `build/arm/demo_wave.llext` (device) and `build/wasm/demo_wave.wasm`
(simulator). Drag the `.wasm` onto
<https://rgb-sunglasses.autom8ed.com/sim/> to watch it run — try the
`metronome-120` audio scenario to see the beat response.

## How this repo gets onto real devices

It's listed in the main repo's extension registry pinned at a specific
commit; every firmware release rebuilds it from that commit and ships
`demo_wave.llext` as a release asset, which the companion app installs
automatically. See the template's README for the full publishing flow.
