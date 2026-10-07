# Changes in this fork

Modified version of [MrCreativ3001/moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream),
based on tag `v3.0.0-prerelease.7`. License: GPL-3.0-or-later (unchanged).

Release tags of this fork use the form `v<upstream-version>-lightning.<n>`.

## Unreleased (next: lightning.8)

- Auto HDR (`web/stream/video/auto_hdr.ts`, new): on an HDR screen, an SDR stream is shown with
  HDR highlights. A WebGPU canvas in "extended" tone mapping mode is laid over the picture (or
  over the upscaler, which hands it each frame): content below a knee is left unchanged, the
  highlights above it rise smoothly up to 1.8x / 2.6x / 3.6x SDR white (light / medium / strong),
  and large bright areas rise less than small ones, so a white menu doesn't glare while a lamp
  or a reflection shines. Measured why a real HDR stream doesn't help on iPhone: Safari 26's
  decoder hands WebCodecs/WebGPU an 8-bit SDR frame with the highlights already compressed.
  Only on screens reporting `dynamic-range: high` whose browser accepts the extended mode (iOS
  26 Safari, Chrome on Android or desktop with HDR); never on a real HDR stream. Setting
  `autoHdr` (default "medium") and a live choice in the in-stream menu, remembered.
- Dev dependency: `@webgpu/types` (BSD-3-Clause), type declarations only.

## v3.0.0-prerelease.7-lightning.7 (2026-10-04)

- On-screen controller (`web/stream/touch_gamepad.ts`, new, self-contained): an Xbox controller
  drawn over the game on phones and tablets, plugged in as one more player controller. Built for
  a screen that can't be felt: floating sticks born under the thumb whose base follows an
  overshooting thumb, small dead zone plus an "anti dead zone" (the first millimetres already
  move the game), face buttons with a larger touch area than drawn that roll from one to the
  next and press two at once between them, 8-way D-pad, double-tap a stick for L3/R3, a tick on
  every press and at the stick's rim (Vibration API; on iOS 17.4–26.4 the switch-control
  haptic), the game's rumble on Android. Four layouts: standard, action (drag to look; RT fires
  and aims), retro (floating D-pad) and racing (sliding steering, analog pedals by thumb
  height). Settings: mode (automatic on phones/tablets, always, off), layout, size,
  visibility, camera (stick or drag), camera sensitivity, haptics, L3 when the stick is held
  at its rim. The in-stream menu switches it live and remembers the choice; a real controller
  hides it; it collapses into a small button to use the touch modes.
- Controllers (upstream bugs): a gamepad reusing a freed slot was announced with the wrong
  number; disconnecting announced the browser's gamepad index instead of the slot; polling
  stopped at the first empty slot; rumble for any gamepad but the first threw.
- Audio: the stream starts with sound when the browser allows it (it always started muted and
  waited for a tap, so playing with a controller stayed silent); otherwise a hint asks for one
  tap. Coming back from the background revives the audio element and resumes a suspended or
  interrupted AudioContext.

## v3.0.0-prerelease.7-lightning.6 (2026-10-01)

- Controllers: the standard-mapping table had the face buttons swapped (b, a, y, x), so every
  controller came out with A<->B and X<->Y inverted. Indices 0-3 now map to A, B, X, Y
  (bottom, right, left, top; Xbox layout like the Moonlight protocol). The "invert A/B" and
  "invert X/Y" settings still work on top of it.

## v3.0.0-prerelease.7-lightning.5 (2026-09-30)

- Restarting the stream (turning upscaling on/off, the automatic codec fallback, "Try again")
  now stops the current stream on the host first and waits a moment. Before, the page just
  reloaded: the old session stayed alive, Sunshine had two sessions and only applies the
  display mode for the first one, so the new resolution was silently not applied.
- Settings opened directly inside an embedding page (`?view=settings&ponte=1`): "Back" tells
  the parent to close the player (there is nothing to go back to inside the iframe).
- Settings page on phones: one row per setting with a hairline between rows, full-width
  selects, on/off switches, number + slider rows; compact header; no logout button (the user is
  given by the forwarded header); the source code link sits after the settings.
- In-stream menu: blurred backdrop, spring entrance, staggered tiles, press feedback, icon
  pills, selected option pops; two columns on phones held sideways. Honors reduced motion.

## v3.0.0-prerelease.7-lightning.4 (2026-09-30)

- Embedding bridge (`web/ponte.ts`): a page of the player opened with `?ponte=1` inside a
  same-origin iframe sends its API requests (`<path_prefix>/api/...`) to the parent window with
  `postMessage` instead of the network; the parent answers with the HTTP response (status,
  headers and body in chunks). Static files and the WebRTC stream itself are unchanged. The
  protocol is documented at the top of `web/ponte.ts`. Used by pages that already have their
  own channel to the host (for example a WebRTC data channel).
- Leaving the stream inside such an iframe tells the parent (`{ type: "lt-exit" }`) instead of
  navigating back.
- A small link to this source code (GPL-3.0) at the bottom of the hosts/settings page.

## v3.0.0-prerelease.7-lightning.3 (2026-09-29)

- Depends on a fork of moonlight-common-rust with the AV1 negotiation:
  [Ian-Daniel-Alves-Nascimento/moonlight-common-rust](https://github.com/Ian-Daniel-Alves-Nascimento/moonlight-common-rust)
  (branch `lightning`), in `Cargo.toml` and `ubrn.config.yaml`.
- Settings: `?view=settings` opens the settings page directly.

- Upscaling resolution (client setting, **off by default**): with it on, the client asks the
  host for less than its screen so the PC renders less — the upscaling itself comes later.
  - With a virtual display (Sunshine `ensure_only_display`): half the device's physical
    screen, at least 720p; screens up to 1080p are not reduced. iPhone 15 Pro (2556×1179)
    asks 1560×720, a 4K TV asks 1920×1080. Manual 75% / 67% / 50% also available.
  - With the physical monitor: the monitor's own resolution (it is never changed).
  - Unknown host display: the normal resolution is kept.
- New `GET /api/host/display?host_id=`: whether the host (when it is this machine) streams a
  virtual display, read from `sunshine.conf` (`lightning.sunshine_config_path` in the config,
  default `%LOCALAPPDATA%\LightningLauncher\Sunshine\config\sunshine.conf`), and the primary
  monitor resolution (Windows).
- Settings menu: "Upscaling" checkbox and "PC Resolution (with upscaling)"; translated in all
  five languages. Query params `upscaling` and `upscalingRenderScale` for the stream page.
- Upscaler on the client (WebGL2): with upscaling on, the video is drawn through an upscaler
  onto a canvas laid over the picture, at the screen's physical resolution
  (`web/stream/video/upscale.ts`). Algorithms: FSR 1 (EASU + RCAS, default), NIS (up to 2×,
  otherwise FSR 1), SGSR 1, and sharpening only (bilinear + RCAS). Video element renderer only
  (the WebRTC default); HDR skips it; no WebGL2 keeps the plain video. Setting
  `upscalingAlgorithm` + menu entry + query param.
- Shaders (`upscale_shaders.ts`) and NIS tables (`upscale_nis_tables.ts`) adapted from
  [MoonlightWeb](https://github.com/linckosz/moonlight-web) by Bruno Martin (GPL-3.0-or-later),
  with divide-by-zero guards added to RCAS.
- Video codec "Automatic" (new default, `web/stream/codec.ts`): announces H.265 and AV1 only
  when this device decodes them in hardware (Media Capabilities, `type: "webrtc"`,
  `powerEfficient`) and the browser offers them over WebRTC; H.264 always. The host then
  takes the best (AV1 > H.265 > H.264). If a codec above H.264 shows no picture, it's left
  out on this device from then on and the stream restarts. The menu shows the codec in use.
- AV1 streaming: the negotiation now picks AV1 when both ends support it (the frame handling,
  the SDP to the host and the AV1 RTP payloader were already there). This change is in
  moonlight-common-rust (`src/stream/proto/mod.rs`, `ServerCodecModeSupport::MASK_AV1`).
  AV1 RTP `profile` mapping fixed (0 = Main, 1 = High); Main also announces 10 bit.
- Fixed: the WebRTC transport never knew the codec in use (`findOutCodec` gave up after 1 s
  and always answered "h264"). It now reads it from the WebRTC stats, or from the host's answer
  when no video arrives. The renderer pipeline for a WebRTC track is still picked as before
  (the browser decodes the track itself).
- 10 bit formats (H.265 Main10, AV1 Main10) are only announced with HDR on, as the official
  clients do: the host takes the best format offered.
- Upscaling "Automatic" (new default): a governor (`web/stream/video/upscale_governor.ts`,
  idea from MoonlightWeb's EnhancerGovernor by Bruno Martin) picks the best level this device
  keeps up with — FSR 1 → NIS → SGSR → sharpening only → off. Each frame it checks, with a
  WebGL2 fence, whether the GPU had finished the previous frame when the next one arrived
  (works everywhere, iPhone Safari included) and, where `EXT_disjoint_timer_query_webgl2`
  exists, the GPU time of the passes. Over ~1.5 s: more than 15% late frames (or GPU above
  80% of the frame time) goes one level down; climbing back is tried after 10 s of comfort,
  and the wait doubles (up to 160 s) after each climb that didn't hold. NIS is skipped
  outside its 2× range. The level that worked is remembered on the device per stream and
  screen size, and the next stream starts from it. The fixed upscalers stay available.
  Stats line: level in use, GPU/CPU time, share of late frames, last governor decision.
- Interface (Lightning look, `web/styles/lightning.css` applied over the chosen page style):
  - Connect screen instead of the connection dialog: app cover and name, three steps in
    plain words (reaching the PC, starting the game, receiving the video) and, on failure,
    the reason and what to do (no direct path from this network, unsupported codec, PC
    refused, dropped while starting, stream ended) with "Try again" / "Exit"; the raw log
    stays under "Details". New `stage` and `failure` stream info events feed it.
  - In-game menu: a small floating button opens a panel with large labelled actions
    (keyboard, fullscreen when the browser has it, mouse lock only with a mouse, stats,
    send key, exit) and the live options as segmented choices (upscaler, touch mode, mouse
    mode — only those the device has). Tapping outside closes it.
  - Turn-the-phone hint redrawn; stats overlay compact on phones.
  - Home: app names under the covers, icon + label buttons, a single ready PC opens its apps
    directly. Settings grouped in Quality / Controls / Advanced (folded), fixed FPS choices
    (30/60/90/120), options that don't apply are hidden.
  - Language "Automatic" (new default) follows the device; French is now actually selectable.
- Resolution: new default "Automatic" — the monitor's resolution when the host streams its
  physical monitor, this screen's resolution with a virtual display (read from
  `/api/host/display`). New "Full screen of this device" (physical pixels) and "Safe area"
  (without the notch/home bar; the picture is fitted inside it). The old "native" used CSS
  pixels (852×393 on an iPhone 15 Pro) and becomes "full".
- Any device with a virtual display: `/api/host/display` also returns `virtual_modes`, the
  resolutions the virtual display driver lists (`lightning.vdd_settings_path`, default
  `C:\VirtualDisplayDriver\vdd_settings.xml`). Sizes taken from the screen (automatic, full
  screen, safe area, and the upscaling fraction) are replaced by the listed mode with the
  closest shape and size, so a phone whose exact resolution isn't listed gets its shape
  (e.g. a 20:9 Pixel 8, 2402×1082, gets 2532×1170) instead of the host's generic 1920×1080.
- Every requested size is rounded down to even numbers: NVENC refuses odd sizes ("couldn't
  create input texture") and the stream had no video — the iPhone 15 Pro screen is 2556×1179.
- "Safe area" only narrows the width (notch sides); the full height is kept.
- In-game menu: turning upscaling on/off restarts the stream when it changes what the host has
  to render (virtual display: upscaling renders a fraction of the screen), otherwise it switches
  live; switching between upscalers is always live. The choice is remembered for the next
  streams, and the menu shows "PC W×H → screen W×H".
- The menu button is hidden over the game: it shows for 5 s after connecting (with a "tap with
  3 fingers" hint the first 3 times) and when the mouse comes near it; a quick three-finger tap
  opens the menu (three-finger swipes stay the keyboard gesture).
- Fullscreen on phones/tablets that allow it (Android): a "Fullscreen" button on the connect
  screen, and the first tap into the game enters fullscreen locked sideways (the existing
  "fullscreen on first interaction", now on by default for touch-only devices). The manifest
  asks for fullscreen (`display_override`) when opened from the home screen; iPhone Safari
  has no Fullscreen API, so nothing changes there.
- Fixed: the keyboard opened from the menu closed right away on iOS (its hidden field was inside
  the menu panel, which hides as the keyboard opens).
- Connected but no picture after 12 s (video element renderer) now shows a failure with the
  likely cause instead of a black screen.
- `dataTransport: "auto"` no longer falls back to the Web Socket transport (it would carry
  the video over the signaling path); `"websocket"` can still be chosen explicitly.

## v3.0.0-prerelease.7-lightning.2 (2026-09-26)

- WebRTC: IPv6 enabled (`Udp4` + `Udp6`, sockets bound on `0.0.0.0` and `[::]`). Upstream
  limited ICE to IPv4 when moving to the new webrtc-rs; with IPv6 on both ends, networks
  behind carrier CGNAT can connect directly.
- WebRTC: connection probe. New `POST /api/host/stream/webrtc/probe` answers with a
  data-channel-only peer (same network settings as the stream, never starts Sunshine).
  The web client runs it before requesting a stream and stops if it doesn't fully connect
  within 12 s, so a network that cannot connect directly no longer wakes the host.
- Server: network settings and local UDP addresses shared by the stream and the probe
  (`network_setting_engine`, `local_udp_addrs`).

## v3.0.0-prerelease.7-lightning.1 (2026-09-26)

- CI: build and publish only the Windows target (`x86_64-pc-windows-gnu`).
- CI: removed the Docker jobs (they pushed to the upstream author's Docker Hub).
- README: modified-fork notice.

No changes to the server or the web client yet.
