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

const storage = multer.diskStorage({
  destination: uploadDir,
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

// 文件列表（带大小 + 时间）
app.get('/api/files', (req, res) => {
  const files = fs.readdirSync(uploadDir).map(name => {
    const stat = fs.statSync(path.join(uploadDir, name));
    return {
      name,
      size: stat.size,
      time: stat.mtimeMs
    };
  });

  res.json(files);
});

// 下载
app.get('/api/download/:name', (req, res) => {
  const filePath = path.join(uploadDir, req.params.name);
  res.download(filePath);
});

// 删除
app.delete('/api/delete/:name', (req, res) => {
  const filePath = path.join(uploadDir, req.params.name);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    res.json({ message: '删除成功' });
  } else {
    res.status(404).json({ message: '文件不存在' });
  }
});

app.listen(port, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`文件服务器已启动：`);
  console.log(`- 本机访问:   http://localhost:${port}`);
  console.log(`- 局域网访问: http://${ip}:${port}`);
});
