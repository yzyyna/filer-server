const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');

const port = 8888;

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
  if (resolved !== uploadDir && !resolved.startsWith(uploadDir + '/')) {
    throw new Error('Access denied');
  }
  return resolved;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const dir = (req.body && req.body.dir) ? req.body.dir : '';
      const dest = safePath(dir);
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    // 修复中文乱码
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const unique = Date.now() + '-' + original;
    cb(null, unique);
  }
});
const upload = multer({ storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 多文件上传
app.post('/api/upload', upload.array('files', 50), (req, res) => {
  const filenames = req.files.map(f => f.filename);
  res.json({ message: '上传成功', filenames });
});

// 文件列表（支持子目录浏览）
app.get('/api/files', (req, res) => {
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
app.get('/api/download', (req, res) => {
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

// 删除（支持子目录路径）
app.delete('/api/delete', (req, res) => {
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

app.listen(port, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`文件服务器已启动：`);
  console.log(`- 本机访问:   http://localhost:${port}`);
  console.log(`- 局域网访问: http://${ip}:${port}`);
});
