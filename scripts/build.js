'use strict';
// 构建脚本：把 src/ 装配进 fpk 包并调用 fnpack build
// 用法：node scripts/build.js
// 依赖：fnpack 必须在 PATH 中（npm i -g @fnnas/fnpack 或使用 fnos skill 提供的 fnpack）

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'src');
const packDir = path.join(root, 'apps', 'portscan');
const serverDir = path.join(packDir, 'app', 'server');
const publishDir = path.join(root, 'publish');

function log(msg) {
  console.log(`[build] ${msg}`);
}

function emptyDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (filter && !filter(src)) continue;
    if (entry.isDirectory()) copyDir(src, dst, filter);
    else fs.copyFileSync(src, dst);
  }
}

// 1. 清理并装配 server 目录
emptyDir(serverDir);
copyDir(srcDir, serverDir, (p) => !p.endsWith(path.sep + 'data'));

// 2. package.json（零依赖）
fs.writeFileSync(
  path.join(serverDir, 'package.json'),
  JSON.stringify({
    name: 'portscan-server',
    version: '1.0.0',
    private: true,
    main: 'server.js',
    type: 'commonjs',
    scripts: { start: 'node server.js' },
    dependencies: {}
  }, null, 2),
  'utf8'
);

// 3. Linux LF 校验 + 强制转换（fnOS 端 bash 遇 CR 会 command not found）
const lifecritical = [
  path.join(packDir, 'cmd', 'main'),
  path.join(packDir, 'wizard', 'install')
];
for (const f of lifecritical) {
  if (!fs.existsSync(f)) continue;
  const buf = fs.readFileSync(f);
  const crCount = buf.filter((b) => b === 0x0d).length;
  if (crCount > 0) {
    log(`converting CRLF -> LF: ${path.relative(root, f)} (${crCount} CR)`);
    fs.writeFileSync(f, buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  } else {
    log(`LF verified: ${path.relative(root, f)}`);
  }
}
try {
  fs.chmodSync(path.join(packDir, 'cmd', 'main'), 0o755);
} catch { /* Windows 上可能不支持，忽略 */ }

// 4. fnpack build
const FNPACK = process.env.FNPACK_BIN || 'fnpack';
log(`running ${FNPACK} build...`);
execSync(`"${FNPACK}" build --directory "${packDir}"`, { stdio: 'inherit', cwd: root });

// 5. 收集产物（fnpack 输出位置随版本而异：cwd 或 packDir 都找）
function findFpk() {
  const candidates = [
    ...fs.readdirSync(packDir).map((f) => path.join(packDir, f)),
    ...fs.readdirSync(root).map((f) => path.join(root, f))
  ];
  return candidates.find((f) => f.endsWith('.fpk')) || null;
}

const src = findFpk();
if (!src) {
  log('ERROR: fpk not generated');
  process.exit(1);
}
fs.mkdirSync(publishDir, { recursive: true });
const dst = path.join(publishDir, path.basename(src));
fs.copyFileSync(src, dst);
if (path.resolve(src) !== path.resolve(dst)) fs.rmSync(src, { force: true });

const size = fs.statSync(dst).size;
log(`OK -> ${dst} (${size} bytes, ${(size / 1024).toFixed(1)} KB)`);
