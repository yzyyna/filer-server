# Fortrust 静态资源中心

基于 filer-server（Express）的静态资源导航中心：服务端实时扫描 `fortrust/` 目录生成索引，前端渲染卡片，支持在线预览、下载与访问密码保护。

## 目录结构

```text
filer-server/
├── server.js                      # 服务端鉴权门 + 动态索引路由
├── scripts/
│   └── generate-fortrust.js       # 目录扫描脚本（服务启动落盘 + 动态路由内存调用）
└── fortrust/                      # ★ 资源根目录（受密码保护）
    ├── index.html                 # 导航中心页面
    ├── directory.json             # 启动时生成的镜像，运行时由动态路由实时覆盖
    ├── vendor/                    # 本地解析库（marked / mammoth / SheetJS），不进索引
    ├── 沃达/
    │   ├── 沃达数据报表/*.html
    │   ├── 沃达维修模块/*.html + .docx
    │   └── 燃气发电服务报表/*.html + .xlsx
    ├── App2.0/
    │   └── App2服务到期提醒功能/*.html
    └── Test/                      # 各类型文件预览测试
```

## 使用方式

### 新增项目

在 `fortrust/` 下新建文件夹，放入任意支持类型的文件即可：

- 浏览器访问或刷新 `/fortrust/` 时，服务端**实时扫描**目录并返回最新 `directory.json`（毫秒级），首页自动展示新目录与文件；
- **无需重启服务、无需改任何导航代码、无需手动跑脚本**。

### 支持的文件类型与交互

| 交互 | 文件类型 | 说明 |
| :--- | :--- | :--- |
| 新标签打开 ↗ | `.html` `.htm` | 原型页面在新标签页运行（`index.html` 显示为「首页」并置顶） |
| 预览 | `.pdf` `.png/.jpg/.svg/.webp/.gif` `.mp4/.webm` `.mp3` `.md` `.txt` | 弹窗内直接预览 |
| 预览（富文本解析） | `.docx` `.xls/.xlsx` | mammoth.js / SheetJS 解析为 HTML，Excel 多 Sheet 可切换 |
| 启动下载 ⤓ | `.doc` `.pptx/.ppt` `.zip/.rar/.7z/.tar/.gz` | 浏览器原生下载 |

浏览器端解析库（mammoth / SheetJS / marked）已本地化至 `fortrust/vendor/`，同源按需加载，**不依赖任何外网 CDN**；输出均经 `sanitizeHtml` 消毒防 XSS 注入。

## 访问密码保护

`/fortrust/*` 的全部请求（含 `directory.json`、原型直链、文档直链、`/view` 查看器）由 `server.js` 的 `fortrestGate` 中间件在服务端拦截，未通过验证一律跳转密码页，**无法通过直接拼 URL 绕过**。

- **密码**：通过环境变量 `FORTREST_PASSWORD` 设置（未设置时使用 `server.js` 中的默认值），与文件服务器密码（`AUTH_PASSWORD`）相互独立
- **验证有效期**：7 天（HttpOnly 签名 Cookie），期间免重复输入
- **登出**：页面右上角「🔒 锁定退出」，或直接访问 `/fortrust/logout`
- **防爆破**：同一 IP 5 分钟内最多错误尝试 5 次，超限锁定 5 分钟

### 建议加固（可选）

源码属于公开仓库，默认密码可被读取（弱密码可被穷举）。若需更强管控，通过环境变量覆盖：

| 变量 | 作用 |
| :--- | :--- |
| `FORTREST_PASSWORD` | 设置后仅此密码可登录资源中心 |
| `FORTRUST_SECRET` | Cookie 签名密钥，设置后 Cookie 不可被推算伪造 |

## 本地开发

```bash
node scripts/generate-fortrust.js   # 手动重新生成 fortrust/directory.json 镜像
npm start                           # 启动服务（启动时自动生成一次镜像）
```
