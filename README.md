# filer-server

轻量级局域网文件共享服务器，零构建、极简依赖（Express 5 + multer 2），单命令即开即用。

---

## 核心特性

- 🚀 **零构建启动**：纯原生前端（HTML5 / CSS3 / ES2015+）+ 单文件后端，`npm start` 即用。
- 🔒 **访问安全认证**：默认启用密码认证（默认密码 `fortrust888`），7 天有效 Cookie Session，内置防爆破限速（429）。
- 📂 **目录层级浏览**：支持面包屑导航、子目录进入/返回、目录与文件分组排序。
- 📤 **多文件拖拽上传**：支持批量文件选择与拖拽上传，实时显示传输进度条，自动处理中文文件名与同名冲突。
- 👁️ **在线媒体预览**：支持图片、音视频、PDF、文本/代码文件内联预览。
- 📋 **一键复制链接**：支持一键复制下载链接与预览链接，便于团队协作与外部文档嵌入。
- 🌐 **多语言支持**：内置英文、中文、日文、韩文四语字典，支持系统语言自动检测与本地持久化切换。
- 🛡️ **安全防护**：后端防路径穿越（Directory Traversal）、禁止主目录根路径上传。

---

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

#### 模式 A：密码认证模式（默认）
```bash
npm start
# 或 node server.js
```
> 默认密码为 `fortrust888`，首次进入浏览器即弹出登录框，登录后 7 天内免重复登录。

自定义密码：
```bash
AUTH_PASSWORD=你的密码 npm start
```

#### 模式 B：开放免密模式（不推荐）
```bash
AUTH_ENABLED=false npm start
```

启动成功后，控制台将输出局域网访问地址：
```text
文件服务器已启动：
- 本机访问:   http://localhost:8888/file-server
- 局域网访问: http://192.168.x.x:8888/file-server
- 访问认证:   已启用 (7天有效 Cookie Session，默认密码 fortrust888)
- 资源中心:   http://192.168.x.x:8888/fortrust (独立密码门)
```
> 注：根路径 `http://<IP>:8888/` 会自动 302 重定向到 `/file-server/`。

---

## 环境变量说明

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8888` | 服务监听端口 |
| `AUTH_ENABLED` | `true` | 是否启用文件服务器访问认证。设为 `false` 关闭鉴权（免密模式） |
| `AUTH_PASSWORD` | `fortrust888` | 文件服务器密码（仅在启用鉴权时生效） |
| `AUTH_SECRET` | *(自动基于密码生成)* | HMAC 签名密钥，可自定义固定密钥 |
| `FORTREST_PASSWORD` | `fortrust999` | `/fortrust` 静态资源中心独立访问密码（与文件服务器密码相互独立） |
| `FORTREST_SECRET` | *(自动基于密码生成)* | 资源中心 Cookie 签名密钥 |
| `BIG_FILE_PASSWORD` | `fortrust666` | 大文件上传密码 |
| `BIG_FILE_MB` | `100` | 大文件阈值（MB），超过需携带大文件密码 |

---

## /fortrust 静态资源中心

`fortrust/` 目录承载产品原型、需求文档等静态资源（由 Git 仓库 `https-website-cloudflare` 迁移而来），提供与原 Cloudflare Pages 一致的访问体验：

- **独立密码门**：访问 `http://<IP>:8888/fortrust` 需输入资源中心密码（默认 `fortrust999`），与文件服务器密码相互独立，Cookie 7 天有效；未登录访问任何直链（含原型、文档、媒体）均跳转登录页。
- **实时目录导航**：访问与刷新页面时动态实时扫描 `fortrust/` 目录，本地新增、修改或删除文件后，浏览器一刷新立即呈现最新结构，无需重启服务；静态文件启用协商缓存，文件更新即刻生效。
- **在线预览**：HTML/图片/音视频/PDF 浏览器直接打开；`md`/`docx`/`xlsx`/`txt` 经 `/view?u=` 查看器渲染（marked/mammoth/SheetJS 按需加载，输出已消毒防 XSS）。
- **目录卡片折叠**：支持单卡片与整树折叠/展开（状态本地记忆）、搜索、一键复制预览/下载链接。

## 大文件上传

单文件超过 **100MB** 时，上传前需输入大文件上传密码（默认 `fortrust666`）：前端会弹窗索取密码并以 `x-upload-password` 请求头携带；后端在 `content-length` 超阈值时校验该头，未携带或错误返回 403。100MB 以内文件不受影响。

---

## API 列表

接口统一前缀为 `/file-server/api`（同时兼容历史 `/api` 路径）：

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/file-server/api/auth/status` | `GET` | 公开 | 查询当前服务鉴权启用状态与会话认证状态 |
| `/file-server/api/login` | `POST` | 公开 | 密码登录（5 分钟内最多尝试 5 次） |
| `/file-server/api/logout` | `POST` | 公开 | 退出登录并清除会话 Cookie |
| `/file-server/api/files` | `GET` | 需认证 | 获取当前目录的文件与文件夹列表 |
| `/file-server/api/upload` | `POST` | 需认证 | 上传文件（`dir` 指定目标子目录，`files` 携带多文件） |
| `/file-server/api/download` | `GET` | 需认证 | 下载指定路径的文件 |
| `/file-server/api/preview` | `GET` | 需认证 | 在线预览指定路径的文件（`inline` 展示） |
| `/file-server/api/delete` | `DELETE` | 需认证 | 删除指定路径的文件 |

---

## 许可证

ISC License
