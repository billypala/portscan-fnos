'use strict';
// 端到端测试：POST /scan -> SSE /events -> done -> 历史记录
const http = require('node:http');

const BASE = 'http://127.0.0.1:5083/app/portscan';

function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, {
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
        headers || {}
      )
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve({ _raw: buf, _status: res.statusCode }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const target = process.argv[2] || '127.0.0.1';
  const ports = process.argv[3] || '';
  const uid = process.argv[4] || '1000';

  console.log(`--- 扫描 ${target} ports="${ports}" uid=${uid} ---`);
  const started = await req('POST', '/api/scan', { target, ports }, { 'X-Trim-Userid': uid });
  console.log('scan create:', JSON.stringify(started));
  if (!started.ok) { process.exit(1); }

  // SSE
  await new Promise((resolve) => {
    const r = http.get(BASE + '/api/events?id=' + encodeURIComponent(started.taskId),
      { headers: { 'X-Trim-Userid': uid } }, (res) => {
        console.log('sse status:', res.statusCode, res.headers['content-type']);
        let progressCount = 0;
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          let idx;
          while ((idx = buf.indexOf('\n\n')) > -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = (frame.match(/^event: (.+)$/m) || [])[1];
            const dt = (frame.match(/^data: (.+)$/m) || [])[1];
            if (!ev || !dt) continue;
            if (ev === 'progress') {
              progressCount++;
              if (progressCount <= 2 || progressCount % 40 === 0) {
                console.log('  progress:', dt);
              }
            } else if (ev === 'done') {
              const d = JSON.parse(dt);
              console.log('  DONE openCount=', d.record.openPorts.length,
                          'scanned=', d.record.scanned, '/', d.record.total,
                          'elapsed=', d.record.elapsedMs + 'ms');
              console.log('  openText:', d.openText);
              console.log('  historyCount:', d.historyCount);
            } else if (ev === 'fail') {
              console.log('  FAIL:', dt);
            }
          }
        });
        res.on('end', () => {
          console.log('  SSE 流结束, progress 帧数 =', progressCount);
          resolve();
        });
      });
    r.on('error', (e) => { console.log('sse error', e.message); resolve(); });
  });

  console.log('--- 历史记录 ---');
  const h = await req('GET', '/api/history', null, { 'X-Trim-Userid': uid });
  console.log('history items:', h.items.length,
    '| first:', h.items[0] ? `${h.items[0].target} / ${h.items[0].portSpec} / 命中${h.items[0].openPorts.length}` : 'none');

  console.log('--- 用户隔离检查 ---');
  const other = await req('GET', '/api/history', null, { 'X-Trim-Userid': '2000' });
  console.log('uid=2000 可见记录数:', other.items.length, '(应为 0)');

  console.log('--- 越权访问他人任务 ---');
  const t2 = await req('POST', '/api/scan', { target: '127.0.0.1', ports: '1-2' }, { 'X-Trim-Userid': '1000' });
  const cross = await req('GET', '/api/events?id=' + encodeURIComponent(t2.taskId), null, { 'X-Trim-Userid': '2000' });
  console.log('跨用户读任务:', JSON.stringify(cross));

  console.log('--- 清理测试记录 ---');
  const cl = await req('POST', '/api/history/clear', {}, { 'X-Trim-Userid': uid });
  console.log('clear ->', cl.items.length);
})();
