const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const port = process.env.PORT || 8888;

// 鉴权配置
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 鉴权状态查询
app.get('/api/auth/status', (req, res) => {
  res.json({
    enabled: Boolean(AUTH_PASSWORD),
    authenticated: isAuthenticated(req)
  });
});

// 登录
app.post('/api/login', (req, res) => {
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
app.post('/api/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ message: '已退出登录' });
});

// 多文件上传
app.post('/api/upload', requireAuth, upload.array('files', 50), (req, res) => {
  const filenames = req.files.map(f => f.filename);
  res.json({ message: '上传成功', filenames });
});

// 文件列表（支持子目录浏览）
app.get('/api/files', requireAuth, (req, res) => {
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
app.get('/api/download', requireAuth, (req, res) => {
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
app.get('/api/preview', requireAuth, (req, res) => {
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
app.delete('/api/delete', requireAuth, (req, res) => {
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

// 全局错误处理（捕获 multer 与业务抛出的错误）
app.use((err, req, res, next) => {
  if (!err) return next();
  const msg = err.message || '服务器内部错误';
  const status = msg.includes('禁止') ? 403 : 500;
  res.status(status).json({ message: msg });
});

app.listen(port, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.info(`文件服务器已启动：`);
  console.info(`- 本机访问:   http://localhost:${port}`);
  console.info(`- 局域网访问: http://${ip}:${port}`);
  if (AUTH_PASSWORD) {
    console.info(`- 访问认证:   已启用 (7天有效 Cookie Session)`);
  } else {
    console.info(`- 访问认证:   未启用 (可通过 AUTH_PASSWORD 环境变量开启)`);
  }
});
