# Fortrust 静态资源中心

基于 GitHub + Cloudflare Pages 的静态资源导航中心：构建时自动扫描 `fortrust/` 目录生成索引，前端渲染卡片，支持在线预览、下载与访问密码保护。

## 目录结构

```text
https-website-cloudflare/
├── index.html                     # 根 landing page（公开访问）
├── _worker.js                     # 服务端密码门（保护 /fortrust/* 全部资源）
├── package.json
├── scripts/
│   └── generate-fortrust.js       # 构建时目录扫描脚本
└── fortrust/                      # ★ 资源根目录（受密码保护）
    ├── index.html                 # 导航中心页面
    ├── directory.json             # 自动生成，勿手动修改
    ├── 沃达/
    │   ├── 沃达数据报表/*.html
    │   └── 沃达维修模块/*.html + .docx
    ├── App2.0/
    │   └── App2服务到期提醒功能/*.html
    └── Test/                      # 各类型文件预览测试
```

## 使用方式

### 新增项目

在 `fortrust/` 下新建文件夹，放入任意支持类型的文件，然后 `git push`：

- Cloudflare Pages 自动执行 `npm run build`（即 `node scripts/generate-fortrust.js`）；
- 脚本递归扫描 `fortrust/`，生成 `directory.json`；
- 首页自动展示新目录与文件，无需改任何导航代码。

### 支持的文件类型与交互

| 交互 | 文件类型 | 说明 |
| :--- | :--- | :--- |
| 新标签打开 ↗ | `.html` `.htm` | 原型页面在新标签页运行（`index.html` 显示为「首页」并置顶） |
| 预览 | `.pdf` `.png/.jpg/.svg/.webp/.gif` `.mp4/.webm` `.mp3` `.md` `.txt` | 弹窗内直接预览 |
| 预览（富文本解析） | `.docx` `.xls/.xlsx` | mammoth.js / SheetJS 按需解析为 HTML，Excel 多 Sheet 可切换 |
| 启动下载 ⤓ | `.doc` `.pptx/.ppt` `.zip/.rar/.7z/.tar/.gz` | 浏览器原生下载 |

浏览器端解析库（mammoth / SheetJS / marked）按需从 jsDelivr CDN 加载，仅在首次点击对应类型「预览」时下载。

## 访问密码保护

`/fortrust/*` 的全部请求（含 `directory.json`、原型直链、文档直链）由 `_worker.js` 在服务端拦截，未通过验证一律返回密码页，**无法通过直接拼 URL 绕过**。

- **默认密码**：`fortrust` / `fortrust2026` / `fortrust888`（源码中仅存 SHA-256 哈希）
- **验证有效期**：7 天（HttpOnly 签名 Cookie），期间免重复输入
- **登出**：页面右上角「🔒 锁定退出」，或直接访问 `/_auth?logout=1`

### 建议加固（可选）

源码属于公开仓库，默认密码哈希与回退签名逻辑可被读取（弱密码可被穷举）。若需更强管控，在 Cloudflare Dashboard → Pages 项目 → Settings → Environment variables 配置：

| 变量 | 作用 |
| :--- | :--- |
| `AUTH_PASSWORD` | 设置后默认密码列表失效，仅此密码可登录 |
| `AUTH_SECRET` | Cookie 签名密钥，设置后 Cookie 不可被推算伪造 |

如需企业级权限（SSO、按邮箱放行），请改用 Cloudflare Zero Trust → Access。

## 本地开发

```bash
npm run build        # 重新生成 fortrust/directory.json
npx wrangler pages dev .   # 本地模拟 Pages（含 _worker.js 鉴权）
```
