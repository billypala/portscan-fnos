A lightweight native TCP port scanner for fnOS — **zero npm dependencies, zero build toolchain, ~34 KB `.fpk`**.

飞牛 fnOS 原生端口扫描应用 —— 零第三方依赖、零构建工具链，单个 fpk 仅约 34 KB。

## Install / 安装

Download `portscan.fpk` below, then on your fnOS device go to **App Center → Manual Install** and pick the file.

下载下方的 `portscan.fpk`，在 fnOS 设备上进入「应用中心 → 手动安装」选择该文件。

Requires fnOS ≥ 1.2.0 and the `nodejs_v22` runtime (available in App Center; the dependency is resolved automatically).

## What's new in 1.0.1 / 1.0.1 更新内容

**Fixed / 修复**

- **Local IP detection picked Docker bridges.** A naive `os.networkInterfaces()` call ranks `docker0` (`172.17.0.1`) and `br-*` (`172.19.0.1`) above the real NIC, so the placeholder showed a container address instead of your LAN IP. Detection now combines a 30-rule virtual-interface blacklist with a `/sys/class/net/<name>/device` physical-NIC probe on Linux, plus a relaxed retry pass so it never falls back to `127.0.0.1` when a real address exists.
- **An empty target field returned "target is empty"** instead of scanning the local machine, contradicting the on-screen hint. It now falls back to the detected local IP.
- **Very fast scans could freeze the UI.** A 1-port scan finishes in milliseconds and deleted its task before the frontend connected to SSE, so `/events` answered 404 and the progress bar never resolved. The server now retains the terminal payload and replays it to late subscribers, and the frontend re-reads history as a second safety net.

**Added / 新增**

- Open ports render as **individual boxes** instead of one comma-separated line.
- **Double-click any port box to attach your own note** — it then displays as `21(FTP)`. Notes are persisted per user, applied to every future scan and to history entries, marked with a dashed border, and cleared by emptying the text.

## Highlights / 主要特性

- Native application (no Docker, no bundled Node.js), served through the fnOS unified gateway at `/app/portscan` over a Unix Socket
- Backend is `node:http` + `node:net`; frontend is a single vanilla-JS HTML file — no `npm install`, no build step
- Targets: single IP, CIDR block, IP range, domain, or empty for the local host
- Ports: empty for `1-65535`, or comma/dash mixes such as `80,443,8000-8100`
- TCP connect pool, 512 concurrent, 800 ms timeout — 65,535 ports in ~16 s on loopback
- SSE progress streaming with terminal-payload replay
- History drawer (50 records) with copy, reuse, delete and clear-all; boxes inside history are editable too
- Clipboard fallback chain: native API → hidden `textarea` + `execCommand` → manual prompt (required because `navigator.clipboard` is unavailable over plain HTTP)
- Responsive layout with dark mode support

## Checksums / 校验和

```
portscan.fpk   34,924 bytes
MD5      417a5e45cb11a11f3171f5c79c8f26b3
SHA256   a807eaa9cf09712d2bd69b6f17bba575637532099d4b2a52dd820ad2ad7b7023
```

## Source / 源码

Build from source with `node scripts/make-icons.js` and `FNPACK_BIN=/path/to/fnpack node scripts/build.js`. See [README.md](https://github.com/billypala/portscan-fnos#readme) for details.
