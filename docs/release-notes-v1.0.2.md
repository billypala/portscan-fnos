### Fixed / 修复

- **Port notes leaked across hosts / 备注跨 IP 串台.** Notes were keyed by port number alone, so a note set on `192.168.5.1:49152` also appeared on `192.168.5.5:49152` — wrong, because the same port number usually means something different on each machine. Notes are now keyed by **`host:port`** and are fully isolated per IP. Clearing a note only affects that one host's port. Legacy port-only entries from 1.0.1 are discarded rather than guessed onto a host.

### Changed / 变更

- **App Center developer & publisher now point at GitHub.** Both `maintainer` and `distributor` are `billypala`, with `maintainer_url` / `distributor_url` linking to <https://github.com/billypala>.

## Install / 安装

Download `portscan.fpk` below, then on your fnOS device go to **App Center → Manual Install** and pick the file.

下载下方的 `portscan.fpk`，在 fnOS 设备上进入「应用中心 → 手动安装」选择该文件。

Requires fnOS ≥ 1.2.0 and the `nodejs_v22` runtime (available in App Center; the dependency is resolved automatically).

> **Upgrading from 1.0.0 / 1.0.1?** Existing port notes were stored per port number and cannot be mapped to a host unambiguously, so they are cleared on upgrade. Re-add them per host — from 1.0.2 on they stay isolated.

## Highlights / 主要特性

- Native application (no Docker, no bundled Node.js), served through the fnOS unified gateway at `/app/portscan` over a Unix Socket
- Backend is `node:http` + `node:net`; frontend is a single vanilla-JS HTML file — no `npm install`, no build step
- Local IP detection filters Docker bridges, `veth` and VPN interfaces and prefers physical NICs
- Targets: single IP, CIDR block, IP range, domain, or empty for the local host
- Ports: empty for `1-65535`, or comma/dash mixes such as `80,443,8000-8100`
- TCP connect pool, 512 concurrent, 800 ms timeout — 65,535 ports in ~16 s on loopback
- Per-host editable port notes, SSE progress streaming, 50-record history drawer
- Clipboard fallback chain: native API → hidden `textarea` + `execCommand` → manual prompt
- Responsive layout with dark mode support

## Checksums / 校验和

```
portscan.fpk   35,612 bytes
MD5      541ffcec3d5e10ae75997a030f96c68f
SHA256   1421054a957f3304dc7c79afd0d3affc7a6796092acff7d7c69179bad163ba19
```

## Verification / 验证

22/22 headed-browser assertions pass, including the new cross-host isolation cases: a note on host A's port never appears when scanning host B on the same port, both notes coexist, and history entries each render their own host's note.

## Source / 源码

Build from source with `node scripts/make-icons.js` and `FNPACK_BIN=/path/to/fnpack node scripts/build.js`. See [README.md](https://github.com/billypala/portscan-fnos#readme) for details.
