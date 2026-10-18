'use strict';
// 端口扫描服务：node:http 零依赖
// - 统一网关前缀 /app/portscan
// - Unix Socket 监听（fnOS 部署）或 PORT（本地开发）
// - SSE 推送扫描进度与命中端口
// - 历史记录按 X-Trim-Userid 隔离持久化到 data-share

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  detectNetwork,
  resolveTarget,
  resolvePorts,
  parsePortSummary,
  serviceName,
  runScan
} = require('./scanner.js');

const PORT = Number(process.env.PORT || 5083);
const HOST = process.env.HOST || '127.0.0.1';
const SOCKET_PATH = process.env.SOCKET_PATH || '';
const GATEWAY_PREFIX = process.env.GATEWAY_PREFIX || '/app/portscan';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_HISTORY = 50;
const SCAN_TTL_MS = 30 * 60 * 1000; // 30 分钟未活动自动回收

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- 工具 ----------

function getUserId(req) {
  const raw = req.headers['x-trim-userid'] || 'local';
  const safe = String(raw).replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe || 'local';
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- 历史记录 ----------

function historyDir() {
  return path.join(DATA_DIR, 'history');
}

function historyFile(userId) {
  return path.join(historyDir(), `${userId}.json`);
}

function loadHistory(userId) {
  try {
    const raw = fs.readFileSync(historyFile(userId), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function saveHistory(userId, items) {
  fs.mkdirSync(historyDir(), { recursive: true });
  const trimmed = items.slice(0, MAX_HISTORY);
  const tmp = `${historyFile(userId)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items: trimmed }, null, 2), 'utf8');
  fs.renameSync(tmp, historyFile(userId));
  return trimmed;
}

function addHistory(userId, record) {
  const items = loadHistory(userId);
  items.unshift(record);
  return saveHistory(userId, items);
}

function deleteHistory(userId, id) {
  const items = loadHistory(userId);
  const next = items.filter((it) => it.id !== id);
  saveHistory(userId, next);
  return next;
}

function clearHistory(userId) {
  saveHistory(userId, []);
  return [];
}

function formatOpenPorts(openPorts, limit = 200) {
  return openPorts.slice(0, limit).map((it) => (it.service ? `${it.port}(${it.service})` : `${it.port}`)).join(', ');
}

// ---------- 端口备注（跨扫描持久化，按用户隔离） ----------

function labelsDir() {
  return path.join(DATA_DIR, 'labels');
}

function labelsFile(userId) {
  return path.join(labelsDir(), `${userId}.json`);
}

// 备注键 = "<host>:<port>"。
// 同一个端口在不同主机上作用完全不同（5000 在一台是 UPNP，在另一台可能是你自己的服务），
// 因此绝不能只按端口号全局共享备注。
function labelKey(host, port) {
  return `${host}:${port}`;
}

const LABEL_KEY_RE = /^([^\s:]+):(\d{1,5})$/;

function loadLabels(userId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(labelsFile(userId), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const m = LABEL_KEY_RE.exec(k);
      // 旧版（v1.0.1）是按纯端口号存的，语义已不成立 → 直接丢弃，不做跨主机继承
      if (!m) continue;
      const port = Number(m[2]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const label = String(v == null ? '' : v).trim().slice(0, 32);
      if (label) out[labelKey(m[1], port)] = label;
    }
    return out;
  } catch {
    return {};
  }
}

function saveLabels(userId, labels) {
  fs.mkdirSync(labelsDir(), { recursive: true });
  const tmp = `${labelsFile(userId)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(labels, null, 2), 'utf8');
  fs.renameSync(tmp, labelsFile(userId));
  return labels;
}

function setLabel(userId, host, port, label) {
  const labels = loadLabels(userId);
  const key = labelKey(host, port);
  const text = String(label == null ? '' : label).trim().slice(0, 32);
  if (text) labels[key] = text;
  else delete labels[key];   // 传空 = 只清掉这一台主机这一端口的备注
  return saveLabels(userId, labels);
}

// 把用户备注叠加到扫描结果上（备注优先于内置服务名，按 host:port 精确匹配）
function applyLabels(openPorts, labels) {
  return openPorts.map((it) => ({
    host: it.host,
    port: it.port,
    service: it.service || null,
    label: labels[labelKey(it.host, it.port)] || null
  }));
}

// ---------- 任务管理 ----------

/** id -> { id, userId, target, ports, portSpec, sse:Set, result, startedAt, aborted, abortSignal } */
const tasks = new Map();
let taskSeq = 1;

function createAbortController() {
  const controller = new AbortController();
  return controller;
}

function gcTasks() {
  const now = Date.now();
  for (const [id, task] of tasks) {
    // 已结束的任务按其结束时间计时，运行中的按开始时间计时
    const since = task.done ? (task.finishedAt || task.startedAt) : task.startedAt;
    if (now - since > SCAN_TTL_MS) {
      try { task.abortSignal.abort(); } catch { /* ignore */ }
      tasks.delete(id);
    }
  }
}
setInterval(gcTasks, 5 * 60 * 1000).unref();

// ---------- SSE ----------

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  return res;
}

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* 客户端已断开 */
  }
}

function broadcast(task, event, data) {
  for (const res of task.sse) sseSend(res, event, data);
}

// 任务收尾：不立即删除，保留终态供晚到的 SSE 客户端回放。
// 原因：极快的扫描（几个端口）会在前端拿到 taskId 并连上 /events 之前就跑完，
// 若立刻删除任务，前端会收到 404 而界面卡在「正在扫描」。
function finishTask(task, event, data) {
  task.running = false;
  task.done = true;
  task.finalEvent = event;
  task.finalData = data;
  task.finishedAt = Date.now();

  broadcast(task, event, data);
  broadcast(task, 'end', {});

  for (const res of task.sse) {
    try { res.end(); } catch { /* ignore */ }
  }
  task.sse.clear();
}

// ---------- 路由 ----------

const routes = [];

function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.pattern === pathname) return { handler: r.handler };
  }
  return null;
}

route('GET', `${GATEWAY_PREFIX}/api/net`, async (req, res, ctx) => {
  sendJson(res, 200, { ok: true, network: detectNetwork() });
});

route('GET', `${GATEWAY_PREFIX}/api/history`, async (req, res, ctx) => {
  sendJson(res, 200, { ok: true, items: loadHistory(ctx.userId) });
});

route('GET', `${GATEWAY_PREFIX}/api/labels`, async (req, res, ctx) => {
  sendJson(res, 200, { ok: true, labels: loadLabels(ctx.userId) });
});

route('POST', `${GATEWAY_PREFIX}/api/labels/set`, async (req, res, ctx) => {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }

  const host = String(body.host || '').trim();
  const port = Number(body.port);

  if (!host) {
    return sendJson(res, 400, { ok: false, error: '缺少主机地址（备注按 IP + 端口 分别保存）' });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return sendJson(res, 400, { ok: false, error: '端口号非法（1-65535）' });
  }

  const labels = setLabel(ctx.userId, host, port, body.label);
  sendJson(res, 200, { ok: true, labels });
});

route('POST', `${GATEWAY_PREFIX}/api/history/delete`, async (req, res, ctx) => {
  const body = await readBody(req);
  const id = String(body.id || '');
  if (!id) return sendJson(res, 400, { ok: false, error: '缺少记录 id' });
  sendJson(res, 200, { ok: true, items: deleteHistory(ctx.userId, id) });
});

route('POST', `${GATEWAY_PREFIX}/api/history/clear`, async (req, res, ctx) => {
  sendJson(res, 200, { ok: true, items: clearHistory(ctx.userId) });
});

route('POST', `${GATEWAY_PREFIX}/api/scan`, async (req, res, ctx) => {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }

  let target;
  let ports;
  try {
    // 目标留空 = 扫描本机 IP（前端占位符显示的地址），不是报错
    const rawTarget = String(body.target || '').trim();
    const effectiveTarget = rawTarget || detectNetwork().ip;
    target = await resolveTarget(effectiveTarget);
    ports = resolvePorts(body.ports);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }

  const total = target.hosts.length * ports.length;
  if (total === 0) return sendJson(res, 400, { ok: false, error: '扫描目标为空' });

  const id = `task-${Date.now()}-${taskSeq++}`;
  const abortSignal = createAbortController().signal;
  const task = {
    id,
    userId: ctx.userId,
    target,
    ports,
    targetLabel: target.label,
    portSpec: parsePortSummary(body.ports),
    sse: new Set(),
    startedAt: Date.now(),
    aborted: false,
    abortSignal,
    running: true
  };
  tasks.set(id, task);

  // 前端拿到 id 后立刻连 /events?id=xxx
  sendJson(res, 200, {
    ok: true,
    taskId: id,
    hosts: target.hosts.length,
    ports: ports.length,
    total
  });

  runScan({
    target,
    ports,
    onProgress: (scanned, tot, openCount) => {
      broadcast(task, 'progress', { scanned, total: tot, openCount });
    },
    signal: abortSignal
  })
    .then(async (result) => {
      const labels = loadLabels(ctx.userId);
      const portsWithLabels = applyLabels(result.openPorts, labels);
      const record = {
        id: `${id}-done`,
        time: new Date().toISOString(),
        target: task.targetLabel,
        hosts: target.hosts.length,
        portSpec: task.portSpec,
        total: result.total,
        scanned: result.scanned,
        openPorts: portsWithLabels,
        openText: formatOpenPorts(result.openPorts),
        elapsedMs: result.elapsedMs,
        cancelled: result.cancelled
      };
      const items = addHistory(ctx.userId, record);
      finishTask(task, 'done', {
        ok: true,
        record,
        labels,
        historyCount: items.length,
        openText: record.openText
      });
    })
    .catch((err) => {
      finishTask(task, 'fail', { ok: false, error: err.message || '扫描异常' });
    });
});

route('GET', `${GATEWAY_PREFIX}/api/events`, async (req, res, ctx) => {
  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('id') || '';
  const task = tasks.get(id);

  if (!task) {
    return sendJson(res, 404, { ok: false, error: '任务不存在或已结束' });
  }
  if (task.userId !== ctx.userId) {
    return sendJson(res, 403, { ok: false, error: '无权访问该任务' });
  }

  // 任务已结束（扫描太快，客户端晚到）：直接回放终态，避免前端卡住
  if (task.done) {
    const sse = openSse(res);
    if (task.finalEvent) sseSend(sse, task.finalEvent, task.finalData);
    sseSend(sse, 'end', {});
    try { sse.end(); } catch { /* ignore */ }
    return;
  }

  const sse = openSse(res);
  task.sse.add(sse);

  const keepalive = setInterval(() => {
    try { sse.write(': ping\n\n'); } catch { /* ignore */ }
  }, 15000);

  const cleanup = () => {
    clearInterval(keepalive);
    task.sse.delete(sse);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

// ---------- 静态资源 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  let rel = pathname;
  if (rel === '/' || rel === '') rel = '/index.html';
  rel = rel.replace(/^\/+/, '');

  const full = path.join(PUBLIC_DIR, rel);
  // 目录穿越防护
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(full, (err, buf) => {
    if (err) {
      // SPA 回退
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(idx);
      });
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

// ---------- 服务器 ----------

const server = http.createServer(async (req, res) => {
  // 网关会把原始路径透传，也可能在剥离前缀后转发，两种都兼容
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    pathname = req.url;
  }

  const ctx = { userId: getUserId(req) };

  const matched = matchRoute(req.method, pathname);
  if (matched) {
    try {
      await matched.handler(req, res, ctx);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message || '服务器内部错误' });
      else { try { res.end(); } catch { /* ignore */ } }
    }
    return;
  }

  // 兼容无前缀 / 根路径的 API（本地开发调试）
  if (pathname.startsWith('/api/')) {
    const stripped = `${GATEWAY_PREFIX}${pathname}`;
    const alt = matchRoute(req.method, stripped);
    if (alt) {
      try {
        await alt.handler(req, res, ctx);
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message || '服务器内部错误' });
      }
      return;
    }
  }

  serveStatic(req, res, pathname);
});

function listen() {
  if (SOCKET_PATH) {
    fs.rmSync(SOCKET_PATH, { force: true });
    server.listen(SOCKET_PATH, () => {
      console.log(`portscan server running on unix socket ${SOCKET_PATH}`);
    });
  } else {
    server.listen(PORT, HOST, () => {
      console.log(`portscan server running at http://${HOST}:${PORT}${GATEWAY_PREFIX}`);
    });
  }
}

function shutdown() {
  for (const task of tasks.values()) {
    try { task.abortSignal.abort(); } catch { /* ignore */ }
  }
  tasks.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

listen();

module.exports = { server };
