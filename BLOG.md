# Express + multer 打造全功能 Node.js 文件服务器：拖拽上传 / 目录浏览 / 在线预览 / 国际化

> 从一行 `app.post('/upload', ...)` 到一个可生产使用的文件服务器，中间到底要走多少坑？
> 本文记录了基于 Express 5 + multer 2 构建一个支持多选拖拽上传、子目录浏览、多类型资源预览、链接复制嵌入、权限控制和中英文切换的文件服务器完整过程。

## 一、项目背景

团队内部需要一个轻量的文件共享服务，用于在局域网内分发 APK / IPA 安装包、共享设计资源、临时托管图片视频等。市面上的网盘产品要么太重，要么上传需要登录，难以满足「丢一个链接就能下载/预览」的极简诉求。

于是用 Node.js 写了一个：单文件后端 + 原生 HTML/CSS/JS 前端，零构建零依赖（除 Express 和 multer），`node server.js` 即可启动，局域网内任意设备打开 `http://<server-ip>:8888` 就能用。

## 二、功能全景

| 模块 | 能力 |
|------|------|
| 上传 | 多文件选择 + 拖拽上传 + 实时进度 + 中文文件名 |
| 浏览 | 面包屑导航 + 子目录层层进入/返回 + 目录/文件分组排序 |
| 下载 | 单文件下载 + 复制下载链接（供外部应用嵌入） |
| 预览 | 图片/视频/音频/PDF/文本在线预览 + 复制预览链接 |
| 安全 | 路径穿越防护 + 主目录禁上传 + 删除接口前端禁用 |
| 体验 | 暗色主题 + Toast 提示 + ESC 关闭模态框 + 移动端适配 |
| 国际化 | 中英文切换 + 系统语言自动检测 + localStorage 缓存 |

## 三、技术栈

```
后端:  Node.js >= 18, Express 5.2.1, multer 2.1.1
前端:  原生 HTML5 / CSS3 / ES2015+ （无框架无构建）
启动:  node server.js  →  http://localhost:8888
```

为什么不上 Vue/React？因为这个工具的受众是「打开浏览器即用」，引入构建链反而增加了维护成本。原生 JS + 事件委托 + 模板字符串足以应对这种规模的 UI。

## 四、快速开始

```bash
git clone <repo-url> filer-server
cd filer-server
npm install
node server.js
```

启动后控制台会输出本机和局域网访问地址：

```
文件服务器已启动：
- 本机访问:   http://localhost:8888
- 局域网访问: http://192.168.x.x:8888
```

## 五、核心实现

### 5.1 多文件拖拽上传

multer 的配置是后端的核心。用 `diskStorage` 自定义存储路径和文件名：

```javascript
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = (req.body && req.body.dir) ? req.body.dir.trim() : '';
    if (!dir) return cb(new Error('禁止在主目录上传文件，请先进入子文件夹'));
    const dest = safePath(dir);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    // 修复中文乱码：multer 默认 latin1 解码，需转回 utf8
    const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const unique = Date.now() + '-' + original;
    cb(null, unique);
  }
});
const upload = multer({ storage });
```

前端的拖拽上传用 `FormData + XMLHttpRequest`，因为我们需要 `xhr.upload.onprogress` 拿到上传进度，`fetch` 在这方面支持不友好。

```javascript
function uploadFiles() {
  if (!currentDir) {
    showToast(t('toast.requireSubdir'));
    return;
  }
  const form = new FormData();
  // ⚠️ dir 必须先于 files append（原因见踩坑章节）
  form.append('dir', currentDir);
  pendingFiles.forEach((f) => form.append('files', f));

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.upload.onprogress = (e) => {
    const percent = Math.round((e.loaded / e.total) * 100);
    progressFill.style.width = percent + '%';
    progressPercent.textContent = percent + '%';
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      loadFiles();
    } else {
      const resp = JSON.parse(xhr.responseText);
      showToast(`✗ ${resp.message}`);
    }
  };
  xhr.send(form);
}
```

### 5.2 子目录浏览与面包屑导航

后端 `/api/files` 接受 `?dir=subdir1/subdir2` 查询参数，返回该目录下的条目列表，每个条目标注 `type: 'directory' | 'file'`：

```javascript
app.get('/api/files', (req, res) => {
  const dir = req.query.dir || '';
  const targetDir = safePath(dir);

  const items = fs.readdirSync(targetDir)
    .filter(name => !name.startsWith('.'))
    .map(name => {
      const st = fs.statSync(path.join(targetDir, name));
      return {
        name,
        size: st.size,
        time: st.mtimeMs,
        type: st.isDirectory() ? 'directory' : 'file'
      };
    });

  // 目录在前按名排，文件在后按时间倒序
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

  res.json({ currentDir: dir, parentDir, items });
});
```

前端用面包屑 + 父目录 `..` 双重回退方式：

```
📂 Root › App FortrustRC › builds
└─ 点击 Root / 任意层级 → 跳转到该层
└─ 点击 📁 .. → 回到上一级
```

### 5.3 路径穿越防护

所有涉及路径的接口都必须经过 `safePath` 校验：

```javascript
function safePath(relativePath) {
  const resolved = path.resolve(uploadDir, relativePath || '');
  if (resolved !== uploadDir && !resolved.startsWith(uploadDir + '/')) {
    throw new Error('Access denied');
  }
  return resolved;
}
```

`path.resolve` 会自动消解 `..` 等相对片段，再校验最终路径是否仍属于 `uploadDir` 子树。这样无论攻击者传 `?dir=../../etc` 还是 `?path=/etc/passwd`，都会被拒绝。

### 5.4 主目录上传权限控制

团队规范要求：根目录禁止堆放散乱文件，必须进入子文件夹才能上传。这层校验做了双保险：

**后端**：multer `destination` 回调中检查 `req.body.dir`，为空就 `cb(new Error(...))`，并通过全局错误中间件转 403 响应。

**前端**：`loadFiles` 时根据 `currentDir` 切换 dropzone 状态：

```javascript
if (data.currentDir) {
  dropzone.classList.remove('disabled');
  dropzoneText.textContent = t('dropzone.enabledHint', { dir: data.currentDir });
} else {
  dropzone.classList.add('disabled');
  dropzoneText.textContent = t('dropzone.disabledHint');
}
```

`.dropzone.disabled` 用 `pointer-events: none` + 半透明 + 灰度滤镜，视觉上一目了然。

### 5.5 多类型资源在线预览

新增 `/api/preview` 接口，与 `/api/download` 的唯一区别是 `Content-Disposition` 头：

```javascript
app.get('/api/preview', (req, res) => {
  const filePath = safePath(req.query.path);
  res.setHeader('Content-Disposition', 'inline');   // 内联显示而非下载
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(filePath);
});
```

`inline` 让浏览器直接渲染（图片直接显示、视频播放器自动加载、PDF 内置查看器打开），而 `download` 会触发保存对话框。**这个 header 的差异，就是「下载链接」与「预览链接」的全部秘密**。

前端按扩展名识别类型，分别用模态框（图片/视频/音频）、新标签页（PDF）、文本渲染（代码/文档）处理：

```javascript
const PREVIEW_TYPES = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'],
  video: ['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'],
  pdf:   ['pdf'],
  text:  ['txt', 'md', 'json', 'js', 'css', 'html', 'xml', 'csv', 'log', 'yaml', 'yml']
};
```

### 5.6 智能复制链接

**这个功能是项目里最实用的设计**：每个文件行都有一个 `COPY LINK` 按钮，复制后粘贴到 WPS 文档、IM 对话、网页 iframe 等任意位置，点击就能直接打开。

按钮行为根据文件类型智能切换：

```javascript
const copyType = previewType ? 'preview' : 'download';
const copyTitle = previewType ? t('title.copyPreview') : t('title.copyDownload');
```

- **可预览文件**（图片/视频/音频/PDF/文本）→ 复制 `/api/preview?path=xxx`，点击进入预览页面
- **不可预览文件**（apk/ipa/zip 等）→ 复制 `/api/download?path=xxx`，点击触发下载

链接是基于 `window.location.origin` 拼接的绝对 URL，离开本机也能访问（前提是同一局域网）。

### 5.7 国际化

不引入 i18next 等库，自己写了一个轻量实现 `public/i18n.js`：

**字典 + 翻译函数**：

```javascript
const I18N_DICT = {
  en: { 'app.explorer': 'File Explorer', 'action.download': 'DOWNLOAD', ... },
  zh: { 'app.explorer': '文件浏览器', 'action.download': '下载', ... }
};

function t(key, params) {
  let str = I18N_DICT[currentLang][key] || I18N_DICT[DEFAULT_LANG][key] || key;
  if (params) {
    Object.keys(params).forEach(k => {
      str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
    });
  }
  return str;
}
```

**自动检测系统语言 + 缓存**：

```javascript
function getCurrentLang() {
  let stored = localStorage.getItem(STORAGE_KEY);
  if (stored && SUPPORTED_LANGS.includes(stored)) return stored;
  const sysLang = (navigator.language || '').toLowerCase();
  const detected = sysLang.startsWith('zh') ? 'zh' : 'en';
  localStorage.setItem(STORAGE_KEY, detected);
  return detected;
}
```

**HTML 静态文本**用 `data-i18n` 属性标记，切换语言时遍历自动应用：

```html
<h1 data-i18n="app.explorer">File Explorer</h1>
<button data-i18n="dropzone.button">Open Files</button>
```

**动态文本**（JS 渲染的按钮、Toast）直接调用 `t('action.download')`。

切换语言后派发自定义事件 `languagechange`，让文件列表重新渲染：

```javascript
document.addEventListener('languagechange', () => loadFiles());
```

## 六、踩坑记录

### 6.1 multer destination 回调中 `req.body` 是空的

**现象**：在 `destination` 回调里读取 `req.body.dir`，结果是 `undefined`，导致权限校验把所有上传请求都拒了。

**根因**：multer 解析 `multipart/form-data` 是**按字段顺序**进行的。前端代码原本是：

```javascript
pendingFiles.forEach((f) => form.append('files', f));  // 先 files
form.append('dir', currentDir);                         // 后 dir
```

multer 一遇到文件字段就立即调用 `destination`，此时 `dir` 字段还没被解析到。

**修复**：调整 FormData 字段顺序，**文本字段必须先于文件字段 append**：

```javascript
form.append('dir', currentDir);                          // 先 dir
pendingFiles.forEach((f) => form.append('files', f));    // 后 files
```

这是 multipart 协议和 multer 实现的固有特性，不是 bug，但确实是新手必踩的坑。

### 6.2 中文文件名乱码

multer 默认按 `latin1` 解码文件名，中文会变成 `ç¤ºä¾‹.txt` 这种乱码。

修复：在 `filename` 回调里手动转回 utf8：

```javascript
const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
```

### 6.3 `xhr.onload` 不区分成功失败

原本的代码：

```javascript
xhr.onload = () => {
  progressStatus.textContent = 'SYNC COMPLETE';
  loadFiles();
};
```

问题在于 `xhr.onload` 在请求**完成**时触发，无论 HTTP 状态码是多少。即使后端返回 403，前端也会显示「SYNC COMPLETE」并刷新列表，用户误以为上传成功了。

修复：

```javascript
xhr.onload = () => {
  if (xhr.status >= 200 && xhr.status < 300) {
    // 真正成功
  } else {
    // 解析后端错误信息并 Toast 提示
    const resp = JSON.parse(xhr.responseText);
    showToast(`✗ ${resp.message}`);
  }
};
```

### 6.4 单 COPY LINK 设计的演进

需求最初是「PREVIEW 旁边加个复制预览链接按钮」，后来又要求「DOWNLOAD 旁边也加个复制下载链接按钮」。结果可预览文件出现了两个 `COPY LINK`，用户反馈「看起来像 bug」。

最终方案：**每个文件只保留一个 COPY LINK 按钮**，根据文件类型智能切换复制目标。同名按钮 + 不同功能 + Toast 提示区分，是用户体验和功能完整性的平衡点。

## 七、项目结构

```
filer-server/
├── public/
│   ├── index.html       # 前端单页（含 CSS + JS 内联）
│   └── i18n.js          # 国际化配置与切换逻辑
├── uploads/             # 文件存储根目录（按子文件夹组织）
├── server.js            # Express 后端（197 行）
├── package.json
├── BLOG.md              # 本文
└── README.md
```

后端 197 行，前端 934 行（含内联 CSS/JS），i18n 配置 208 行。**总计不到 1500 行代码**，覆盖了上传/下载/预览/目录/权限/i18n 六大模块。

## 八、API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/files?dir=subdir` | 列出目录内容（含 type/size/time） |
| POST | `/api/upload` | 多文件上传（FormData: dir + files[]） |
| GET  | `/api/download?path=xxx` | 下载文件（Content-Disposition: attachment） |
| GET  | `/api/preview?path=xxx` | 在线预览（Content-Disposition: inline） |
| DELETE | `/api/delete?path=xxx` | 删除文件（前端禁用，仅 API 保留） |

## 九、总结与展望

### 收获

1. **multer 的坑要早知道**：`destination` 中拿不到 `req.body` 不是 bug，是字段顺序问题。文档不写，全靠踩坑。
2. **`Content-Disposition` 的 inline vs attachment** 是下载与预览的全部区别，一行 header 决定行为。
3. **路径安全不能省**：哪怕内网工具，也要防 `..` 跨目录访问，`path.resolve` + 前缀校验是最小代价的方案。
4. **原生 JS 也能写出好交互**：事件委托 + 模板字符串 + CSS 变量，不需要任何框架。
5. **国际化从设计开始**：用 `data-i18n` 标记 + `t()` 函数的组合，比事后改造省事十倍。

### 后续可优化方向

- 大文件分片上传（multer 默认全量接收，>1GB 容易超时）
- 文件秒传 / MD5 校验
- 简易鉴权（局域网内可省，公网部署必须）
- 缩略图生成（图片预览时性能更好）
- WebSocket 实时通知（多人协作场景）
- PWA 离线访问

### 适用场景

- 团队内部 APK / IPA 分发
- 局域网文件快传
- 设计稿/视频素材共享
- 临时静态资源托管
- 嵌入 WPS / 飞书 / 钉钉文档的图片预览链接源

---

**仓库地址**：[filer-server](https://github.com/your-name/filer-server)

**运行环境**：Node.js >= 18

**License**：ISC

> 写完这个项目最大的感触是：**简单功能背后藏着无数细节**。一个「上传文件」看似一行 `multer.array('files')` 就能搞定，真要做到可用、好用、安全、国际化，每一步都是学问。希望这篇博客能帮你少踩几个坑。
