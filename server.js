const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const port = process.env.PORT || 8888;

// 鉴权配置：默认启用密码认证，默认密码 fortrust888
// - 通过 AUTH_PASSWORD 覆盖默认密码
// - 通过 AUTH_ENABLED=false 显式关闭鉴权（回到免密模式）
const AUTH_ENABLED = process.env.AUTH_ENABLED !== 'false';
const AUTH_PASSWORD = AUTH_ENABLED ? (process.env.AUTH_PASSWORD || 'fortrust888') : '';
const AUTH_SECRET = process.env.AUTH_SECRET || (AUTH_PASSWORD ? crypto.createHash('sha256').update(AUTH_PASSWORD + '_filer_secret_salt').digest('hex') : crypto.randomBytes(32).toString('hex'));

// 生成 7 天有效期的签名 Token
function generateToken() {
  const payload = {
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  };
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payloadStr).digest('base64url');
  return `${payloadStr}.${signature}`;
}

// 验证 Token
function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadStr, signature] = parts;
  const expectedSignature = crypto.createHmac('sha256', AUTH_SECRET).update(payloadStr).digest('base64url');
  if (signature.length !== expectedSignature.length) return false;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return false;
    }
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8'));
    if (!payload.exp || typeof payload.exp !== 'number') return false;
    if (Date.now() > payload.exp) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// Cookie 解析与设置辅助
function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const name = parts[0] ? parts[0].trim() : '';
    if (!name) return;
    const value = parts.slice(1).join('=').trim();
    try {
      list[name] = decodeURIComponent(value);
    } catch (e) {
      list[name] = value;
    }
  });
  return list;
}

function setAuthCookie(res, token) {
  const maxAge = 7 * 24 * 60 * 60; // 7 天（秒）
  res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `auth_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

// 登录防爆破限速（5分钟内最多错误尝试5次）
const loginAttempts = new Map();

function cleanupLoginAttempts() {
  const now = Date.now();
  for (const [ip, record] of loginAttempts.entries()) {
    if (now > record.resetTime) {
      loginAttempts.delete(ip);
    }
  }
}

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) return true;
  if (now > record.resetTime) {
    loginAttempts.delete(ip);
    return true;
  }
  return record.count < 5;
}

function recordFailedLogin(ip) {
  if (loginAttempts.size > 1000) {
    cleanupLoginAttempts();
  }
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, resetTime: now + 5 * 60 * 1000 };
  record.count++;
  loginAttempts.set(ip, record);
}

function clearFailedLogin(ip) {
  loginAttempts.delete(ip);
}

// 鉴权检查函数与中间件
function isAuthenticated(req) {
  if (!AUTH_PASSWORD) return true;
  const cookies = parseCookies(req);
  return verifyToken(cookies.auth_token);
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) {
    return next();
  }
  return res.status(401).json({ message: '未登录或登录已过期' });
}

const app = express();
const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// 获取本机局域网 IP
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// 安全路径解析，防止目录穿越
function safePath(relativePath) {
  const resolved = path.resolve(uploadDir, relativePath || '');
  if (resolved !== uploadDir && !resolved.startsWith(uploadDir + path.sep)) {
    throw new Error('Access denied');
  }
  return resolved;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const dir = (req.body && req.body.dir) ? req.body.dir.trim() : '';
      // 权限控制：禁止在主目录上传，必须进入子文件夹
      if (!dir) {
        return cb(new Error('禁止在主目录上传文件，请先进入子文件夹'));
      }
      const dest = safePath(dir);
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      req._uploadDest = dest;
      cb(null, dest);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    // 修复中文乱码
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const destDir = req._uploadDest || uploadDir;

    // 同批次已分配的文件名（防止同一次上传多个同名文件冲突）
    if (!req._assignedNames) req._assignedNames = new Set();

    const ext = path.extname(original);
    const base = path.basename(original, ext);
    let filename = original;
    let counter = 1;

    while (fs.existsSync(path.join(destDir, filename)) || req._assignedNames.has(filename)) {
      filename = `${base}-${counter}${ext}`;
      counter++;
    }

    req._assignedNames.add(filename);
    cb(null, filename);
  }
});
const upload = multer({ storage });

// ============================================================
// /fortrust 静态资源中心（独立密码门，密码与文件服务器相互独立）
// 环境变量：FORTREST_PASSWORD（默认 fortrust999）、FORTREST_SECRET
// ============================================================
const FORTREST_PASSWORD = process.env.FORTREST_PASSWORD || 'fortrust999';
const FORTREST_SECRET = process.env.FORTREST_SECRET || crypto.createHash('sha256').update(FORTREST_PASSWORD + '_fortrust_gate_salt').digest('hex');
const FORTREST_COOKIE = 'fortrust_auth';
const fortrestDir = path.join(__dirname, 'fortrust');
const { generateDirectoryData, writeDirectoryJson } = require('./scripts/generate-fortrust.js');

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function generateFortrestToken() {
  const payloadStr = Buffer.from(JSON.stringify({ exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', FORTREST_SECRET).update(payloadStr).digest('base64url');
  return `${payloadStr}.${signature}`;
}

function verifyFortrestToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadStr, signature] = parts;
  const expected = crypto.createHmac('sha256', FORTREST_SECRET).update(payloadStr).digest('base64url');
  if (signature.length !== expected.length) return false;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8'));
    return payload.exp && typeof payload.exp === 'number' && Date.now() <= payload.exp;
  } catch (e) {
    return false;
  }
}

function isFortrestAuthed(req) {
  return verifyFortrestToken(parseCookies(req)[FORTREST_COOKIE]);
}

// 防开放重定向：仅允许站内资源中心相关路径
function safeFortrestNext(raw) {
  if (typeof raw === 'string' && (raw.startsWith('/fortrust') || raw.startsWith('/view') || raw.startsWith('/_view')) && !raw.startsWith('//')) {
    return raw;
  }
  return '/fortrust/';
}

// /fortrust 登录防爆破（独立计数，与文件服务器登录互不影响）
const fortrestLoginAttempts = new Map();

function fortrestRateOk(ip) {
  const now = Date.now();
  const rec = fortrestLoginAttempts.get(ip);
  if (!rec) return true;
  if (now > rec.resetTime) {
    fortrestLoginAttempts.delete(ip);
    return true;
  }
  return rec.count < 5;
}

function fortrestRecordFail(ip) {
  if (fortrestLoginAttempts.size > 1000) {
    const now = Date.now();
    for (const [ip2, rec] of fortrestLoginAttempts.entries()) {
      if (now > rec.resetTime) fortrestLoginAttempts.delete(ip2);
    }
  }
  const now = Date.now();
  const rec = fortrestLoginAttempts.get(ip) || { count: 0, resetTime: now + 5 * 60 * 1000 };
  rec.count++;
  fortrestLoginAttempts.set(ip, rec);
}

// 未登录访问 /fortrust/* 时展示的登录页（error/next 均经 HTML 转义）
function fortrestLoginPage(error, next) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🔐 请输入访问密钥</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%)}
.box{background:#fff;border-radius:18px;width:min(440px,100%);padding:36px 32px;text-align:center;
  box-shadow:0 25px 50px -12px rgba(0,0,0,.45)}
h2{font-size:20px;font-weight:800;margin:0 0 22px;color:#0f172a;letter-spacing:-.02em}
input{width:100%;padding:13px 16px;border:1px solid #cbd5e1;border-radius:10px;font-size:15px;
  outline:none;background:#f8fafc;transition:all .15s ease}
input:focus{background:#fff;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}
.err{color:#ef4444;font-size:12px;font-weight:600;min-height:18px;margin:10px 0 4px}
button{width:100%;padding:13px;border:none;border-radius:10px;background:#2563eb;color:#fff;
  font-size:14px;font-weight:700;cursor:pointer;transition:background .15s ease}
button:hover{background:#1d4ed8}
</style>
</head>
<body>
<form method="POST" action="/fortrust/login">
  <div class="box">
    <h2>🔐 请输入访问密钥</h2>
    <input type="password" name="password" placeholder="请输入访问密钥..." autocomplete="current-password" autofocus>
    <div class="err">${escapeHtml(error)}</div>
    <button type="submit">确认进入</button>
    <input type="hidden" name="next" value="${escapeHtml(next)}">
  </div>
</form>
</body>
</html>`;
  return res => res.status(error ? 401 : 200).type('html').send(html);
}

// 鉴权门：/fortrust 静态资源统一拦截
function fortrestGate(req, res, next) {
  if (isFortrestAuthed(req)) return next();
  return res.redirect('/fortrust/login?next=' + encodeURIComponent(req.originalUrl));
}

app.get('/fortrust/login', (req, res) => {
  if (isFortrestAuthed(req)) return res.redirect('/fortrust/');
  const next = safeFortrestNext(typeof req.query.next === 'string' ? req.query.next : '/fortrust/');
  fortrestLoginPage('', next)(res);
});

app.post('/fortrust/login', (req, res) => {
  // 表单提交，需自行解析 application/x-www-form-urlencoded
  express.urlencoded({ extended: false })(req, res, () => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!fortrestRateOk(ip)) {
      return fortrestLoginPage('尝试次数过多，请5分钟后再试', '/fortrust/')(res);
    }
    const password = String((req.body && req.body.password) || '');
    const next = safeFortrestNext(String((req.body && req.body.next) || '/fortrust/'));
    if (password === FORTREST_PASSWORD) {
      fortrestLoginAttempts.delete(ip);
      res.setHeader('Set-Cookie', `${FORTREST_COOKIE}=${generateFortrestToken()}; Path=/; Max-Age=${7 * 24 * 60 * 60}; HttpOnly; SameSite=Lax`);
      return res.redirect(next);
    }
    fortrestRecordFail(ip);
    return fortrestLoginPage('密钥错误，请重新输入', next)(res);
  });
});

app.get('/fortrust/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${FORTREST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  res.redirect('/fortrust/login');
});

// /fortrust 动态目录索引（每次刷新实时毫秒级扫描目录，增删文件立即生效）
app.get('/fortrust/directory.json', fortrestGate, (req, res) => {
  try {
    const data = generateDirectoryData();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '目录扫描失败: ' + err.message });
  }
});

// /fortrust 静态资源（导航首页、原型、文档、媒体全部受密码门保护）
// 配置 Cache-Control: no-cache，确保浏览器每次刷新都协商校验最新修改，有改动立即取最新
app.use('/fortrust', fortrestGate, express.static(fortrestDir, {
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

// ============================================================
// /view 新标签页查看器：渲染浏览器无法原生预览的 md/docx/xlsx/txt
// ============================================================
const VIEWER_EXTS = new Set(['.md', '.markdown', '.docx', '.xlsx', '.xls', '.txt']);

function viewerPage(targetUrl) {
  const safeTarget = JSON.stringify(targetUrl);
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>预览 · Fortrust 静态资源中心</title>
<style>
*{box-sizing:border-box}
body{margin:0;display:flex;flex-direction:column;min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  background:#f1f5f9;color:#1f2937}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:12px 20px;background:#fff;border-bottom:1px solid #e2e8f0}
.title{font-size:15px;font-weight:700;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.actions{display:flex;gap:8px;flex-shrink:0}
.btn{padding:6px 12px;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none;
  border:1px solid #e2e8f0;background:#fff;color:#475569}
.btn:hover{border-color:#2563eb;color:#2563eb}
main{flex:1;overflow:auto;padding:28px 32px;background:#fff}
.status{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
  height:60vh;color:#64748b;font-size:14px}
.spinner{width:28px;height:28px;border:3px solid #e2e8f0;border-top-color:#2563eb;border-radius:50%;
  animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.md h1,.md h2,.md h3,.md h4{color:#0f172a;line-height:1.3;margin:1.4em 0 .5em}
.md h1{font-size:26px;border-bottom:2px solid #e2e8f0;padding-bottom:8px}
.md h2{font-size:21px;border-bottom:1px solid #eef2f7;padding-bottom:6px}
.md h3{font-size:17px}
.md p{margin:.7em 0;line-height:1.75}
.md a{color:#2563eb}
.md code{background:#f1f5f9;border:1px solid #e2e8f0;padding:1px 6px;border-radius:4px;
  font-family:ui-monospace,Consolas,Menlo,monospace;font-size:13px;color:#dc2626}
.md pre{background:#0f172a;color:#f8fafc;padding:14px 16px;border-radius:8px;overflow:auto;margin:.8em 0}
.md pre code{background:none;border:none;color:inherit;padding:0}
.md blockquote{margin:.8em 0;padding:8px 16px;border-left:4px solid #93c5fd;background:#eff6ff;
  color:#334155;border-radius:0 6px 6px 0}
.md ul,.md ol{padding-left:1.6em}
.md table{border-collapse:collapse;margin:.9em 0}
.md th,.md td{border:1px solid #cbd5e1;padding:6px 12px;font-size:13px}
.md th{background:#f1f5f9}
.md img{max-width:100%}
.md hr{border:none;border-top:1px solid #e2e8f0;margin:1.5em 0}
.word{line-height:1.8;font-size:15px}
.word h1,.word h2,.word h3{color:#0f172a;margin:1.2em 0 .5em}
.word table{border-collapse:collapse;margin:12px 0}
.word td,.word th{border:1px solid #cbd5e1;padding:6px 12px;font-size:13px;min-width:64px}
.word img{max-width:100%}
.sheet-tab{display:flex;gap:6px;padding:10px 0;overflow-x:auto}
.sheet-tab button{padding:6px 14px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;
  color:#475569;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
.sheet-tab button.active{background:#2563eb;border-color:#2563eb;color:#fff}
.sheet{display:none}
.sheet.active{display:block}
.sheet table{border-collapse:collapse}
.sheet td,.sheet th{border:1px solid #cbd5e1;padding:6px 12px;font-size:13px;white-space:nowrap}
</style>
</head>
<body>
<header>
  <div class="title" id="docTitle">加载中…</div>
  <div class="actions">
    <a class="btn" id="dlBtn" download>下载 ⤓</a>
  </div>
</header>
<main><div class="status"><div class="spinner"></div><div>正在加载预览…</div></div></main>
<script>
const TARGET = ${safeTarget};
const name = decodeURIComponent(TARGET.split('/').pop() || '');
document.getElementById('docTitle').textContent = name;
const dl = document.getElementById('dlBtn');
dl.href = TARGET;
dl.setAttribute('download', name);

const ext = (name.match(/\\.[^.]+$/) || [''])[0].toLowerCase();
const main = document.querySelector('main');
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// 消毒：剔除危险标签块、on* 事件属性与 javascript: 等危险协议
function sanitizeHtml(dirty) {
  const blockTags = ['script','iframe','object','embed','style','link','meta','form','base','svg','math'];
  let out = String(dirty || '');
  for (const tag of blockTags) {
    const pair = new RegExp('<\\\\s*' + tag + '\\\\b[^>]*>[\\\\s\\\\S]*?<\\\\s*/\\\\s*' + tag + '\\\\s*>', 'gi');
    const single = new RegExp('<\\\\s*/?\\\\s*' + tag + '\\\\b[^>]*>', 'gi');
    out = out.replace(pair, '').replace(single, '');
  }
  const onAttr = /\\son[a-z]+\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)/gi;
  const badProto = /(href|src|xlink:href|data)\\s*=\\s*(?:["']?\\s*(?:javascript|vbscript|data:text\\/html)[^"'>]*)/gi;
  return out.replace(onAttr, '').replace(badProto, '$1="#"');
}

function loadScript(src, check) {
  if (check()) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => check() ? res() : rej(new Error('lib init failed'));
    s.onerror = () => rej(new Error('lib load failed'));
    document.head.appendChild(s);
  });
}

async function render() {
  try {
    if (ext === '.md' || ext === '.markdown') {
      const txt = await (await fetch(TARGET)).text();
      await loadScript('https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js', () => window.marked);
      main.innerHTML = '<div class="md">' + sanitizeHtml(marked.parse(txt, { breaks: true, gfm: true })) + '</div>';
    } else if (ext === '.docx') {
      const buf = await (await fetch(TARGET)).arrayBuffer();
      await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js', () => window.mammoth);
      const r = await window.mammoth.convertToHtml({ arrayBuffer: buf });
      main.innerHTML = '<div class="word">' + sanitizeHtml(r.value) + '</div>';
    } else if (ext === '.xlsx' || ext === '.xls') {
      const buf = await (await fetch(TARGET)).arrayBuffer();
      await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', () => window.XLSX);
      const wb = window.XLSX.read(buf, { type: 'array' });
      const tabs = wb.SheetNames.map((n, i) =>
        '<button class="' + (i === 0 ? 'active' : '') + '" data-i="' + i + '">' + esc(n) + '</button>').join('');
      const panes = wb.SheetNames.map((n, i) => {
        // sheet_to_html 输出同样消毒，防单元格内容注入
        const html = sanitizeHtml(window.XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' }));
        return '<div class="sheet ' + (i === 0 ? 'active' : '') + '" data-i="' + i + '">' + html + '</div>';
      }).join('');
      main.innerHTML =
        '<div class="sheet-tab">' + tabs + '</div>' + panes;
      main.querySelectorAll('.sheet-tab button').forEach(b => b.addEventListener('click', () => {
        main.querySelectorAll('.sheet').forEach(p => p.classList.toggle('active', p.dataset.i === b.dataset.i));
        main.querySelectorAll('.sheet-tab button').forEach(x => x.classList.toggle('active', x === b));
      }));
    } else {
      const txt = await (await fetch(TARGET)).text();
      main.innerHTML = '<pre style="background:#0f172a;color:#f8fafc;padding:20px;border-radius:8px;' +
        'overflow:auto;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all">' + esc(txt) + '</pre>';
    }
  } catch (e) {
    main.innerHTML = '<div class="status"><div style="font-size:32px">😵</div>' +
      '<div>预览加载失败，请尝试下载后查看</div></div>';
  }
}
render();
</script>
</body>
</html>`;
  return html;
}

app.get(['/view', '/_view'], (req, res) => {
  if (!isFortrestAuthed(req)) {
    // 登录后回跳到原查看地址
    return res.redirect('/fortrust/login?next=' + encodeURIComponent(req.originalUrl));
  }
  const raw = typeof req.query.u === 'string' ? req.query.u : '';
  const target = raw.startsWith('/fortrust/') ? raw : '';
  const ext = (target.match(/\.([^./]+)$/i) || [''])[0].toLowerCase();
  if (!target || !VIEWER_EXTS.has(ext)) {
    // 非查看器类型直接回到原文件（浏览器可原生预览或下载）
    return res.redirect(target || '/fortrust/');
  }
  res.type('html').send(viewerPage(target));
});

// ============================================================
// 大文件上传门：单次请求体超过 100MB 需附加密码 fortrust666
// 环境变量：BIG_FILE_PASSWORD、BIG_FILE_MB
// ============================================================
const BIG_FILE_PASSWORD = process.env.BIG_FILE_PASSWORD || 'fortrust666';
const BIG_FILE_BYTES = (parseInt(process.env.BIG_FILE_MB, 10) || 100) * 1024 * 1024;

function bigFileGate(req, res, next) {
  // multipart 表单本身有少量开销，阈值放宽 2MB 避免边界误判
  const len = parseInt(req.headers['content-length'] || '0', 10);
  if (len > BIG_FILE_BYTES + 2 * 1024 * 1024) {
    const pw = String(req.headers['x-upload-password'] || '');
    if (pw !== BIG_FILE_PASSWORD) {
      return res.status(403).json({ message: '上传内容超过 100MB，需输入大文件上传密码', needBigPassword: true });
    }
  }
  next();
}

// 根路径默认重定向至文件服务
app.get('/', (req, res) => {
  res.redirect('/file-server/');
});

// 文件服务器前端静态资源挂载于 /file-server
app.use('/file-server', express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 文件服务 API 路由
const fileApi = express.Router();

// 鉴权状态查询
fileApi.get('/auth/status', (req, res) => {
  res.json({
    enabled: Boolean(AUTH_PASSWORD),
    authenticated: isAuthenticated(req)
  });
});

// 登录
fileApi.post('/login', (req, res) => {
  if (!AUTH_PASSWORD) {
    return res.json({ message: '未启用密码认证', enabled: false });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ message: '尝试登录次数过多，请5分钟后再试' });
  }

  const { password } = req.body || {};
  if (password && password === AUTH_PASSWORD) {
    clearFailedLogin(ip);
    const token = generateToken();
    setAuthCookie(res, token);
    return res.json({ message: '登录成功' });
  } else {
    recordFailedLogin(ip);
    return res.status(401).json({ message: '密码错误' });
  }
});

// 退出登录
fileApi.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ message: '已退出登录' });
});

// 多文件上传（大文件门：>100MB 需大文件密码，见 bigFileGate）
fileApi.post('/upload', requireAuth, bigFileGate, upload.array('files', 50), (req, res) => {
  const filenames = req.files.map(f => f.filename);
  res.json({ message: '上传成功', filenames });
});

// 文件列表（支持子目录浏览）
fileApi.get('/files', requireAuth, (req, res) => {
  try {
    const dir = req.query.dir || '';
    const targetDir = safePath(dir);

    if (!fs.existsSync(targetDir)) {
      return res.status(404).json({ message: '目录不存在' });
    }

    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      return res.status(400).json({ message: '不是目录' });
    }

    const items = fs.readdirSync(targetDir)
      .filter(name => !name.startsWith('.'))
      .map(name => {
        const fullPath = path.join(targetDir, name);
        const st = fs.statSync(fullPath);
        return {
          name,
          size: st.size,
          time: st.mtimeMs,
          type: st.isDirectory() ? 'directory' : 'file'
        };
      });

    // 排序：目录在前（按名称），文件在后（按时间倒序）
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      if (a.type === 'directory') return a.name.localeCompare(b.name);
      return b.time - a.time;
    });

    let parentDir = null;
    if (dir) {
      const p = path.dirname(dir);
      parentDir = p === '.' ? '' : p;
    }

    res.json({
      currentDir: dir,
      parentDir,
      items
    });
  } catch (e) {
    if (e.message === 'Access denied') {
      return res.status(403).json({ message: '访问被拒绝' });
    }
    res.status(500).json({ message: e.message });
  }
});

// 下载（支持子目录路径）
fileApi.get('/download', requireAuth, (req, res) => {
  try {
    const filePath = safePath(req.query.path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: '文件不存在' });
    }
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return res.status(400).json({ message: '不能下载目录' });
    }
    res.download(filePath);
  } catch (e) {
    if (e.message === 'Access denied') {
      return res.status(403).json({ message: '访问被拒绝' });
    }
    res.status(500).json({ message: e.message });
  }
});

// 预览（内联显示，支持图片/视频/PDF等，可供外部应用嵌入）
fileApi.get('/preview', requireAuth, (req, res) => {
  try {
    const filePath = safePath(req.query.path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: '文件不存在' });
    }
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return res.status(400).json({ message: '不能预览目录' });
    }
    // 使用 inline 让浏览器内联显示而非下载，便于 WPS 等外部应用嵌入预览
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(filePath);
  } catch (e) {
    if (e.message === 'Access denied') {
      return res.status(403).json({ message: '访问被拒绝' });
    }
    res.status(500).json({ message: e.message });
  }
});

// 删除（支持子目录路径）
fileApi.delete('/delete', requireAuth, (req, res) => {
  try {
    const filePath = safePath(req.query.path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: '文件不存在' });
    }
    fs.unlinkSync(filePath);
    res.json({ message: '删除成功' });
  } catch (e) {
    if (e.message === 'Access denied') {
      return res.status(403).json({ message: '访问被拒绝' });
    }
    res.status(500).json({ message: e.message });
  }
});

// 挂载 API：主路由 /file-server/api，同时保留 /api 兼容存量调用
app.use('/file-server/api', fileApi);
app.use('/api', fileApi);

// 全局错误处理（捕获 multer 与业务抛出的错误）
app.use((err, req, res, next) => {
  if (!err) return next();
  const msg = err.message || '服务器内部错误';
  const status = msg.includes('禁止') ? 403 : 500;
  res.status(status).json({ message: msg });
});

// 启动时同步写入 /fortrust/directory.json 镜像文件
try {
  writeDirectoryJson();
} catch (e) {
  console.warn('- fortrust 索引生成失败:', e.message);
}

app.listen(port, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.info(`文件服务器已启动：`);
  console.info(`- 本机访问:   http://localhost:${port}/file-server`);
  console.info(`- 局域网访问: http://${ip}:${port}/file-server`);
  if (AUTH_PASSWORD) {
    const usingDefault = !process.env.AUTH_PASSWORD;
    console.info(`- 访问认证:   已启用 (7天有效 Cookie Session${usingDefault ? '，默认密码 fortrust888' : ''})`);
  } else {
    console.info(`- 访问认证:   未启用 (AUTH_ENABLED=false)`);
  }
  console.info(`- 资源中心:   http://${ip}:${port}/fortrust (独立密码门)`);
});
