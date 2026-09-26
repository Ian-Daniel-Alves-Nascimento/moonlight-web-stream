# Changes in this fork

Modified version of [MrCreativ3001/moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream),
based on tag `v3.0.0-prerelease.7`. License: GPL-3.0-or-later (unchanged).

Release tags of this fork use the form `v<upstream-version>-lightning.<n>`.

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
