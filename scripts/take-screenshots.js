'use strict';
// 为 README 截取三张界面图：初始态（灰色占位）、扫描结果（端口方框）、历史抽屉
const path = require('node:path');
const { chromium } = require(process.env.PW_PATH || 'playwright-core');

const BASE = process.argv[2] || 'http://192.168.1.100:5083/app/portscan/';
const OUT = path.join(__dirname, '..', 'assets');
const CHROME = process.env.CHROME_PATH ||
  path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1223', 'chrome-win64', 'chrome.exe');

const fs = require('node:fs');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: false, executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'screenshot-1-idle.png') });
  console.log('shot 1: idle');

  await page.fill('#inputPorts', '80,443,8080,21,22,3306,5432,6379,9000,18080');
  await page.click('#btnScan');
  await page.waitForSelector('#modalMask:not([hidden])', { timeout: 60000 });
  await page.click('#modalOk');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'screenshot-2-result.png') });
  console.log('shot 2: result');

  // 双击一个端口加个备注，展示自定义态
  const chip = await page.$('#resultBody .chip');
  if (chip) {
    const p = await chip.getAttribute('data-port');
    await chip.dblclick();
    await page.waitForTimeout(250);
    await page.fill('#resultBody .chip-edit', 'My service');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    console.log('labeled port', p);
  }
  await page.screenshot({ path: path.join(OUT, 'screenshot-3-label.png') });
  console.log('shot 3: labeled');

  await page.click('#btnHistory');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'screenshot-4-history.png') });
  console.log('shot 4: history');
  await page.click('#btnCloseDrawer');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'screenshot-5-desktop.png') });
  console.log('shot 5: desktop');

  await browser.close();
})().catch((e) => { console.error('截图失败:', e.message); process.exit(1); });
