'use strict';
// 无头验证前端关键逻辑：剪贴板三级降级 + 非安全上下文行为
// 直接抽取 index.html 中的 copyText/fallbackCopy 逻辑，用最小 DOM 桩执行。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');

// ---------- 最小 DOM 桩 ----------
function makeEl(tag) {
  const el = {
    tagName: tag,
    style: {},
    children: [],
    value: '',
    textContent: '',
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    appendChild(c) { this.children.push(c); },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    focus() { doc.activeElement = this; },
    select() {},
    setSelectionRange() {},
    closest() { return null; },
    addEventListener() {}
  };
  return el;
}

const doc = {
  activeElement: null,
  createElement: (t) => makeEl(t),
  body: makeEl('body'),
  execCommand: null,
  getElementById: () => makeEl('div'),
  addEventListener() {}
};

let execResult = false;
let execCalled = 0;
doc.execCommand = (cmd) => {
  execCalled++;
  return execResult;
};

// ---------- 从 HTML 抽取待测函数 ----------
function extractFn(name) {
  const m = html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n  \\}`));
  if (!m) throw new Error(`未找到函数 ${name}`);
  return m[0];
}

const src = [
  extractFn('fallbackCopy'),
  extractFn('copyText')
].join('\n\n');

const sandbox = {
  document: doc,
  navigator: {},
  console,
  setTimeout,
  Promise
};

console.log('=== 场景 1：navigator.clipboard 不存在（HTTP 非安全上下文，fnOS 内网访问的实际情况）===');
{
  execResult = true;
  execCalled = 0;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  console.log('  navigator.clipboard =', sandbox.navigator.clipboard);
  sandbox.copyText('hello world').then((ok) => {
    console.log('  copyText 结果 =', ok, '(应为 true，走 execCommand 降级)');
    console.log('  execCommand 调用次数 =', execCalled, '(应为 1)');

    console.log('');
    console.log('=== 场景 2：execCommand 也失败（第三级：手动浮层提示）===');
    execResult = false;
    execCalled = 0;
    return sandbox.copyText('hello world').then((ok2) => {
      console.log('  copyText 结果 =', ok2, '(应为 false，触发手动复制提示)');

      console.log('');
      console.log('=== 场景 3：navigator.clipboard 存在且成功（HTTPS 场景）===');
      const sb2 = Object.assign({}, sandbox, {
        navigator: { clipboard: { writeText: () => Promise.resolve() } },
        document: Object.assign({}, doc, { execCommand: () => { throw new Error('不应被调用'); } })
      });
      vm.createContext(sb2);
      vm.runInContext(src, sb2);
      return sb2.copyText('x').then((ok3) => {
        console.log('  copyText 结果 =', ok3, '(应为 true，走原生 API)');

        console.log('');
        console.log('=== 场景 4：原生 API 存在但 reject → 应回退到 execCommand ===');
        const sb3 = Object.assign({}, sandbox, {
          navigator: { clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) } },
          document: Object.assign({}, doc, { execCommand: () => { execResult = true; return true; } })
        });
        vm.createContext(sb3);
        vm.runInContext(src, sb3);
        return sb3.copyText('y').then((ok4) => {
          console.log('  copyText 结果 =', ok4, '(应为 true，已回退)');
          console.log('');
          console.log('全部场景执行完毕');
        });
      });
    });
  });
}
