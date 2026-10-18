'use strict';
// 有头浏览器验证 v1.1 改动：
// 1) 占位符显示本机 IP（非容器 IP）
// 2) 端口结果渲染为独立方框
// 3) 双击方框 → 输入备注 → 回车保存 → 显示为 端口(备注)
// 4) 备注持久化（重新加载页面仍在）
// 5) 历史抽屉里的方框也能编辑
// 6) 清空备注恢复内置服务名

const path = require('node:path');
const { chromium } = require(process.env.PW_PATH || 'playwright-core');

// The test must run against a LAN IP, never 127.0.0.1: browsers treat
// 127.0.0.1 / localhost as a secure context even over plain HTTP, which would
// hide the clipboard problem this suite exists to verify.
// Substitute your own machine's LAN address.
const URL = process.argv[2] || 'http://192.168.1.100:5083/app/portscan/';
const CHROME = process.env.CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1223', 'chrome-win64', 'chrome.exe');

const pass = [];
const fail = [];
function check(name, ok, detail) {
  (ok ? pass : fail).push(name + (detail ? ` → ${detail}` : ''));
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ' → ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch({ headless: false, executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 430, height: 940 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  console.log('=== 1. 本机 IP 检测（关键修复）===');
  const net = await page.evaluate(() => ({
    placeholder: document.getElementById('inputTarget').placeholder,
    hint: document.getElementById('hintTarget').textContent.trim(),
    secure: window.isSecureContext
  }));
  console.log('  placeholder =', JSON.stringify(net.placeholder));
  console.log('  hint        =', net.hint);
  check('占位符是真实网卡 IP', /^192\.168\.\d+\.\d+$/.test(net.placeholder), net.placeholder);
  check('占位符不是容器/VPN 网段', !/^172\.(1[6-9]|2\d|3[01])\./.test(net.placeholder), net.placeholder);
  check('处于非安全上下文（复现 fnOS HTTP 场景）', net.secure === false);

  console.log('=== 2. 扫描并渲染方框 ===');
  await page.fill('#inputPorts', '18000-18100,19443,80,443,8080');
  await page.click('#btnScan');
  await page.waitForSelector('#modalMask:not([hidden])', { timeout: 60000 });
  await page.click('#modalOk');
  await page.waitForTimeout(400);

  const chips = await page.$$eval('#resultBody .chip', (els) => els.map((e) => ({
    text: e.textContent.trim(),
    port: e.getAttribute('data-port'),
    custom: e.classList.contains('custom')
  })));
  console.log('  方框数量 =', chips.length);
  console.log('  方框内容 =', chips.map((c) => c.text).join(' | '));
  check('端口渲染为独立方框', chips.length > 0, `${chips.length} 个`);
  check('方框含内置服务名', chips.some((c) => /\(\w/.test(c.text)));

  const targetUsed = await page.evaluate(() =>
    (document.querySelector('.meta') || {}).textContent || '');
  check('目标留空回落到本机 IP（无「目标为空」报错）',
    /目标 \d+\.\d+\.\d+\.\d+/.test(targetUsed), targetUsed.replace(/\s+/g, ' ').trim().slice(0, 60));

  await page.screenshot({ path: 'v2-1-chips.png' });

  console.log('=== 3. 双击方框改备注 ===');
  const firstChip = await page.$('#resultBody .chip');
  const firstPort = await firstChip.getAttribute('data-port');
  await firstChip.dblclick();
  await page.waitForTimeout(250);

  const editing = await page.$('#resultBody .chip-edit');
  check('双击进入编辑态', !!editing, firstPort ? `端口 ${firstPort}` : '');

  if (editing) {
    await page.fill('#resultBody .chip-edit', '我的自定义服务');
    await page.screenshot({ path: 'v2-2-editing.png' });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);

    const after = await page.evaluate((p) => {
      const el = document.querySelector(`#resultBody .chip[data-port="${p}"]`);
      if (!el) return null;
      return { text: el.textContent.trim(), custom: el.classList.contains('custom') };
    }, firstPort);
    console.log('  保存后方框 =', JSON.stringify(after));
    check('备注显示为 端口(备注) 格式',
      after && after.text === `${firstPort}(我的自定义服务)`, after ? after.text : 'null');
    check('自定义备注有视觉区分（虚线框）', after && after.custom === true);

    const persisted = await page.evaluate((p) =>
      fetch('/app/portscan/api/labels').then((r) => r.json()).then((d) => d.labels[p]), firstPort);
    check('备注已持久化到服务端', persisted === '我的自定义服务', String(persisted));

    await page.screenshot({ path: 'v2-3-saved.png' });
  }

  console.log('=== 4. 刷新后备注仍在 ===');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const labelsAfterReload = await page.evaluate(() =>
    fetch('/app/portscan/api/labels').then((r) => r.json()).then((d) => d.labels));
  check('刷新后备注仍存在',
    !!labelsAfterReload[firstPort] && labelsAfterReload[firstPort] === '我的自定义服务',
    JSON.stringify(labelsAfterReload));

  console.log('=== 5. 历史抽屉 ===');
  await page.click('#btnHistory');
  await page.waitForTimeout(700);
  const hist = await page.evaluate(() => ({
    open: document.getElementById('drawer').classList.contains('open'),
    items: document.querySelectorAll('.hist-item').length,
    chips: document.querySelectorAll('.hist-item .chip').length
  }));
  console.log('  抽屉打开 =', hist.open, '记录数 =', hist.items, '方框数 =', hist.chips);
  check('历史记录内也渲染方框', hist.chips > 0, `${hist.chips} 个`);

  const histChip = await page.$('.hist-item .chip');
  if (histChip) {
    await histChip.dblclick();
    await page.waitForTimeout(250);
    const histEditing = await page.$('.hist-item .chip-edit');
    check('历史里的方框也能双击编辑', !!histEditing);
    if (histEditing) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
  }
  await page.screenshot({ path: 'v2-4-history.png' });
  await page.click('#btnCloseDrawer');
  await page.waitForTimeout(400);

  console.log('=== 6. 清空备注恢复内置名 ===');
  const restore = await page.evaluate((p) =>
    fetch('/app/portscan/api/labels/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: Number(p), label: '' })
    }).then((r) => r.json()), firstPort);
  check('清空备注后该端口条目被移除',
    restore && restore.ok && !(restore.labels || {})[firstPort],
    JSON.stringify(restore && restore.labels));

  console.log('=== 7. 极快扫描不卡住（SSE 晚到回放）===');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.fill('#inputTarget', '127.0.0.1');
  await page.fill('#inputPorts', '5083');
  await page.click('#btnScan');
  // 1 个端口的扫描几毫秒就完成，SSE 很可能晚到 —— 必须仍能渲染结果
  await page.waitForSelector('#modalMask:not([hidden])', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(600);
  const fastResult = await page.evaluate(() => ({
    stuck: !!document.querySelector('#resultBody .progress'),
    chips: document.querySelectorAll('#resultBody .chip').length,
    modal: !document.getElementById('modalMask').hidden
  }));
  console.log('  方框数 =', fastResult.chips, '弹窗 =', fastResult.modal, '仍在转圈 =', fastResult.stuck);
  check('极快扫描也能渲染结果（不卡在正在扫描）',
    fastResult.chips > 0 && !fastResult.stuck, `${fastResult.chips} 个方框`);
  if (fastResult.modal) await page.click('#modalOk');

  console.log('=== 8. 桌面响应式 ===');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'v2-5-desktop.png' });

  console.log('');
  console.log('页面错误数 =', errors.length);
  errors.forEach((e) => console.log('  !', e));
  check('无 JS 报错', errors.length === 0);

  console.log('');
  console.log(`结果：${pass.length} 通过 / ${fail.length} 失败`);
  if (fail.length) { console.log('失败项：'); fail.forEach((f) => console.log('  -', f)); }

  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e.message); process.exit(1); });
