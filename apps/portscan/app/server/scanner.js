'use strict';
// 端口扫描核心：目标解析 + 端口解析 + TCP connect 并发池
// 零第三方依赖，仅使用 node 内置模块。

const net = require('node:net');
const dns = require('node:dns').promises;
const os = require('node:os');

const MAX_HOSTS = 4096;
const MAX_PORTS = 65535; // 有效端口 1-65535

const CONCURRENCY = 512;
const TIMEOUT_MS = 800;

// 常用端口服务名映射（覆盖 NAS / 家用 / 开发常见端口）
const SERVICE_NAMES = {
  20: 'FTP-DATA', 21: 'FTP', 22: 'SSH', 23: 'TELNET', 25: 'SMTP', 53: 'DNS',
  67: 'DHCP', 68: 'DHCP', 69: 'TFTP', 80: 'HTTP', 110: 'POP3', 111: 'RPC',
  119: 'NNTP', 123: 'NTP', 135: 'MSRPC', 137: 'NETBIOS-NS', 138: 'NETBIOS-DGM',
  139: 'NETBIOS-SSN', 143: 'IMAP', 161: 'SNMP', 162: 'SNMP-TRAP', 179: 'BGP',
  389: 'LDAP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 514: 'SHELL',
  515: 'LPD', 548: 'AFP', 554: 'RTSP', 587: 'SUBMISSION', 623: 'IPMI',
  636: 'LDAPS', 873: 'RSYNC', 989: 'FTPS-DATA', 990: 'FTPS', 993: 'IMAPS',
  995: 'POP3S', 1080: 'SOCKS', 1433: 'MSSQL', 1521: 'ORACLE',
  1883: 'MQTT', 2049: 'NFS', 2181: 'ZOOKEEPER', 2375: 'DOCKER',
  2379: 'ETCD', 3000: 'GRAFANA', 3128: 'SQUID', 3260: 'ISCSI',
  3306: 'MYSQL', 3389: 'RDP', 4369: 'EPOLL', 4840: 'GLASSFISH',
  5000: 'UPNP', 5001: 'HTTPS-ALT', 5432: 'POSTGRES', 5672: 'AMQP',
  5900: 'VNC', 5985: 'WINRM', 6379: 'REDIS', 6443: 'K8S-API',
  7001: 'WEBSPEEDY', 7443: 'OPENSTACK', 8000: 'HTTP-ALT', 8008: 'GOOGLE',
  8080: 'HTTP-PROXY', 8081: 'HTTP-ALT', 8443: 'HTTPS-ALT',
  8888: 'HTTP-ALT', 9000: 'PHP-FPM', 9001: 'SUPERVISOR', 9090: 'PROMETHEUS',
  9200: 'ELASTIC', 9300: 'ELASTIC-TRANS', 10000: 'WEBADMIN', 10250: 'KUBELET',
  11211: 'MEMCACHED', 15672: 'RABBITMQ', 27017: 'MONGODB', 27018: 'MONGO-SHARD',
  28017: 'MONGO-WEB', 50000: 'DB2', 50070: 'HADOOP', 61616: 'ACTIVEMQ'
};

function serviceName(port) {
  return SERVICE_NAMES[port] || null;
}

// ---------- 网段检测 ----------

// 虚拟 / 容器 / VPN 网卡命名特征。
// Docker 网桥（docker0、br-xxxx）、容器 veth、libvirt、VPN 隧道都必须排除，
// 否则会误报成 172.17.0.1 / 172.19.0.1 这类网关地址，而不是真实局域网 IP。
const VIRTUAL_IFACE_PATTERNS = [
  /^lo$/i,
  /^docker/i,
  /^br-/i,
  /^br\d/i,
  /^veth/i,
  /^virbr/i,
  /^vmnet/i,
  /^vboxnet/i,
  /^vethernet/i,
  /^vmware/i,
  /^virtualbox/i,
  /^host-?only/i,
  /^default\s*switch/i,
  /^tun\d/i,
  /^tap\d/i,
  /^ppp\d/i,
  /^wg\d/i,
  /^tailscale/i,
  /^zt/i,
  /^cni/i,
  /^cali/i,
  /^weave/i,
  /^flannel/i,
  /^kube/i,
  /^lxc/i,
  /^podman/i,
  /^nerdctl/i,
  /^dummy/i,
  /^ifb/i,
  /^ovs/i,
  /^npcap/i,
  /^bluetooth/i,
  /^蓝牙/i
];

function isVirtualIface(name) {
  return VIRTUAL_IFACE_PATTERNS.some((re) => re.test(name));
}

// Linux 上只有真实物理网卡在 /sys/class/net/<name>/device 有设备节点。
// 这是区分物理网卡与虚拟网卡最可靠的手段（比名字匹配更稳）。
function hasPhysicalDevice(name) {
  try {
    return require('node:fs').existsSync(`/sys/class/net/${name}/device`);
  } catch {
    return false;
  }
}

function detectNetwork() {
  const ifaces = os.networkInterfaces();

  // 两轮：先严格过滤虚拟网卡；若全被滤掉（如系统用网桥承载 LAN），
  // 再放宽一次，只排除回环与 APIPA —— 绝不能在有真实 IP 时返回 127.0.0.1。
  const strict = collectCandidates(ifaces, true);
  const candidates = strict.length > 0 ? strict : collectCandidates(ifaces, false);

  if (candidates.length === 0) {
    return { ip: '127.0.0.1', cidr: '127.0.0.0/8', netmask: '255.0.0.0', iface: null };
  }

  // 同分时优先掩码更长（网段更小、更精确）
  candidates.sort((a, b) => (a.score - b.score) || (maskBits(b.netmask) - maskBits(a.netmask)));

  const best = candidates[0];
  const bits = maskBits(best.netmask);
  return {
    ip: best.ip,
    cidr: `${networkAddress(best.ip, best.netmask)}/${bits}`,
    netmask: best.netmask,
    iface: best.name
  };
}

function collectCandidates(ifaces, strict) {
  const candidates = [];

  for (const [name, list] of Object.entries(ifaces)) {
    if (strict && isVirtualIface(name)) continue;

    for (const item of list || []) {
      const family = typeof item.family === 'number' ? `IPv${item.family}` : item.family;
      if (family !== 'IPv4' || item.internal) continue;

      const ip = item.address;
      if (!ip) continue;
      if (ip.startsWith('169.254.')) continue;   // APIPA 自动私有地址
      if (ip.startsWith('127.')) continue;       // 回环
      if (ip.startsWith('100.64.')) continue;    // CGNAT 运营商级 NAT

      // 得分越低越优先
      let score = 0;
      if (hasPhysicalDevice(name)) score -= 100;      // 物理网卡最高优先
      if (isPrivate(ip)) score -= 10;                 // 私有网段优先
      if (ip.startsWith('192.168.')) score -= 5;      // 家用/办公局域网最常见
      if (ip.startsWith('172.')) score += 5;          // 172.x 多为容器 / VPN 段
      if (strict && isVirtualIface(name)) score += 200; // 宽松轮里仍靠后

      candidates.push({ name, ip, netmask: item.netmask, score });
    }
  }

  return candidates;
}

function isPrivate(ip) {
  return (
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

function maskBits(netmask) {
  if (!netmask) return 24;
  return netmask.split('.').reduce((acc, oct) => acc + ((Number(oct) >>> 0).toString(2).match(/1/g) || []).length, 0);
}

function ipToInt(ip) {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function networkAddress(ip, netmask) {
  const ipN = ipToInt(ip);
  const maskN = ipToInt(netmask);
  if (ipN === null || maskN === null) return ip;
  return intToIp((ipN & maskN) >>> 0);
}

// ---------- 目标解析 ----------

async function resolveTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('目标为空');

  // 域名 / 网址（允许带 scheme）
  if (/[a-zA-Z]/.test(raw)) {
    let host = raw
      .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');
    if (!host) throw new Error('无法解析目标');
    let addrs;
    try {
      addrs = await dns.lookup(host, { all: true, verbatim: true });
    } catch {
      throw new Error(`域名解析失败：${host}`);
    }
    const v4 = addrs.filter((a) => (a.family === 4 || a.family === 'IPv4')).map((a) => a.address);
    if (v4.length === 0) throw new Error(`域名无可用 IPv4 地址：${host}`);
    return { label: raw, hosts: v4.slice(0, MAX_HOSTS) };
  }

  // CIDR
  const cidrMatch = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (cidrMatch) {
    const base = ipToInt(cidrMatch[1]);
    const bits = Number(cidrMatch[2]);
    if (base === null) throw new Error('CIDR 地址非法');
    if (bits < 0 || bits > 32) throw new Error('CIDR 掩码位数非法（0-32）');
    const maskN = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const netN = (base & maskN) >>> 0;
    const size = bits === 32 ? 1 : 2 ** (32 - bits);
    if (size > MAX_HOSTS) {
      throw new Error(`网段过大：${size} 台主机，上限 ${MAX_HOSTS} 台，请缩小范围`);
    }
    const hosts = [];
    for (let i = 0; i < size; i++) hosts.push(intToIp((netN + i) >>> 0));
    return { label: raw, hosts };
  }

  // IP 范围 a.b.c.d-e.f.g.h
  const rangeMatch = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s*-\s*(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (rangeMatch) {
    const start = ipToInt(rangeMatch[1]);
    const end = ipToInt(rangeMatch[2]);
    if (start === null || end === null) throw new Error('IP 范围格式非法');
    if (end < start) throw new Error('IP 范围结束地址小于起始地址');
    if (end - start + 1 > MAX_HOSTS) {
      throw new Error(`IP 范围过大：${end - start + 1} 台主机，上限 ${MAX_HOSTS} 台`);
    }
    const hosts = [];
    for (let n = start; n <= end; n++) hosts.push(intToIp(n >>> 0));
    return { label: raw, hosts };
  }

  // 单 IP
  const single = ipToInt(raw);
  if (single === null) throw new Error('IP / 网址格式非法');
  return { label: raw, hosts: [raw] };
}

// ---------- 端口解析 ----------

function resolvePorts(input) {
  const raw = String(input || '').trim();
  if (!raw) return Array.from({ length: MAX_PORTS }, (_, i) => i + 1); // 1-65535 全部有效端口

  const set = new Set();
  const parts = raw.split(/[,，\s]+/).filter(Boolean);

  for (const part of parts) {
    const seg = part.trim();
    if (!seg) continue;

    const rangeMatch = seg.match(/^(\d{1,5})\s*[-~]\s*(\d{1,5})$/);
    if (rangeMatch) {
      let start = Number(rangeMatch[1]);
      let end = Number(rangeMatch[2]);
      if (start > end) [start, end] = [end, start];
      if (start < 1 || end > 65535) throw new Error(`端口区间越界：${seg}（有效 1-65535）`);
      for (let p = start; p <= end; p++) set.add(p);
      continue;
    }

    if (!/^\d{1,5}$/.test(seg)) throw new Error(`端口格式非法：${seg}`);
    const p = Number(seg);
    if (p < 1 || p > 65535) throw new Error(`端口越界：${p}（有效 1-65535）`);
    set.add(p);
  }

  if (set.size === 0) throw new Error('端口范围为空');
  return Array.from(set).sort((a, b) => a - b);
}

function parsePortSummary(input) {
  const raw = String(input || '').trim();
  return raw || '1-65535（全端口范围）';
}

// ---------- TCP connect 扫描 ----------

function probePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new net.Socket();
    const finish = (open, reason) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({ port, open, reason });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (err) => finish(false, err.code || 'error'));
    socket.connect(port, host);
  });
}

/**
 * 顺序执行一次完整扫描。
 * onProgress: 每完成一个探测回调一次（节流由调用方处理）
 * 返回 { openPorts, scanned, total, elapsedMs, cancelled }
 */
async function runScan(options) {
  const {
    target,
    ports,
    concurrency = CONCURRENCY,
    timeoutMs = TIMEOUT_MS,
    onProgress,
    signal
  } = options;

  const hosts = target.hosts;
  const total = hosts.length * ports.length;
  const startedAt = Date.now();

  const openPorts = [];
  let scanned = 0;
  let cancelled = false;

  // 任务队列（扁平化 host × port）
  let cursor = 0;
  const queueLength = total;
  const next = () => (cursor < queueLength ? cursor++ : -1);

  const worker = async () => {
    for (;;) {
      if (cancelled || signal.aborted) { cancelled = true; return; }
      const idx = next();
      if (idx === -1) return;

      const host = hosts[Math.floor(idx / ports.length)];
      const port = ports[idx % ports.length];

      const result = await probePort(host, port, timeoutMs);
      scanned++;

      if (result.open) {
        openPorts.push({
          host,
          port,
          service: serviceName(result.port)
        });
      }

      if (onProgress && scanned % 32 === 0) onProgress(scanned, total, openPorts.length);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, queueLength)) }, worker);
  await Promise.all(workers);

  // 结果按 主机 / 端口 排序
  openPorts.sort((a, b) => (a.host === b.host ? a.port - b.port : a.host.localeCompare(b.host)));

  if (onProgress) onProgress(scanned, total, openPorts.length);

  return {
    openPorts,
    scanned,
    total,
    elapsedMs: Date.now() - startedAt,
    cancelled
  };
}

module.exports = {
  detectNetwork,
  resolveTarget,
  resolvePorts,
  parsePortSummary,
  serviceName,
  runScan,
  CONCURRENCY,
  TIMEOUT_MS
};
