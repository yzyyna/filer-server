const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'fortrust');
const OUTPUT = path.join(ROOT, 'directory.json');
const IGNORE_DIRS = new Set(['.git', '.github', 'node_modules', '.DS_Store']);
// 根目录自身的导航首页与生成产物不进入索引
const ROOT_IGNORE_FILES = new Set(['index.html', 'directory.json', '.DS_Store', 'README.md', 'Thumbs.db', 'package.json']);
// 子目录允许 index.html 进入文件列表（作为「首页」条目）
const SUB_IGNORE_FILES = new Set(['.DS_Store', 'README.md', 'Thumbs.db', 'package.json', 'directory.json']);

const ALLOWED_EXTS = new Set([
  // 网页（新标签页打开）
  '.html', '.htm',
  // 可预览文档/媒体（弹窗直接预览）
  '.pdf', '.md', '.markdown', '.txt',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
  '.mp4', '.webm', '.mp3',
  // 可解析预览的 Office 文档
  '.docx', '.xlsx', '.xls',
  // 需下载文档/附件（直接启动下载）
  '.doc', '.pptx', '.ppt',
  '.zip', '.rar', '.7z', '.tar', '.gz'
]);

function getFileType(ext) {
  ext = (ext || '').toLowerCase();
  const label = ext.replace(/^\./, '').toUpperCase() || 'FILE';
  if (['.html', '.htm'].includes(ext)) {
    return { category: 'html', icon: '📄', actionType: 'new_tab' };
  }
  if (ext === '.pdf') {
    return { category: 'pdf', icon: '📕', actionType: 'preview' };
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) {
    return { category: 'image', icon: '🖼️', actionType: 'preview' };
  }
  if (['.mp4', '.webm'].includes(ext)) {
    return { category: 'video', icon: '🎬', actionType: 'preview' };
  }
  if (ext === '.mp3') {
    return { category: 'audio', icon: '🎵', actionType: 'preview' };
  }
  if (['.md', '.markdown'].includes(ext)) {
    return { category: 'md', icon: '📃', actionType: 'preview' };
  }
  if (ext === '.txt') {
    return { category: 'text', icon: '📃', actionType: 'preview' };
  }
  if (ext === '.docx') {
    return { category: 'docx', icon: '📝', actionType: 'preview' };
  }
  if (['.xlsx', '.xls'].includes(ext)) {
    return { category: 'xlsx', icon: '📊', actionType: 'preview' };
  }
  if (['.pptx', '.ppt'].includes(ext)) {
    return { category: 'ppt', icon: '📑', actionType: 'download' };
  }
  if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) {
    return { category: 'archive', icon: '📦', actionType: 'download' };
  }
  return { category: 'file', icon: '📎', actionType: 'download' };
}

function encodePath(parts, fileName = '') {
  const segs = ['fortrust', ...parts];
  if (fileName) {
    segs.push(fileName);
    return '/' + segs.map(encodeURIComponent).join('/');
  }
  return '/' + segs.map(encodeURIComponent).join('/') + '/';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function buildFileEntry(fileName, ext, stat, url, isIndex) {
  const typeInfo = getFileType(ext);
  const title = isIndex ? '首页 (index.html)' : fileName.replace(new RegExp(`\\${ext}$`, 'i'), '');
  return {
    fileName,
    title,
    ext: ext.toLowerCase(),
    category: typeInfo.category,
    icon: typeInfo.icon,
    actionType: typeInfo.actionType,
    url,
    size: formatSize(stat.size),
    isIndex
  };
}

function scan(dir, relativeParts = []) {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !IGNORE_DIRS.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));

  const nodes = [];

  // fortrust/ 根目录下直接放置的独立文件，归入「独立文件」分组
  if (relativeParts.length === 0) {
    const directFiles = entries
      .filter(e => {
        if (!e.isFile() || ROOT_IGNORE_FILES.has(e.name)) return false;
        const ext = path.extname(e.name).toLowerCase();
        return ALLOWED_EXTS.has(ext);
      })
      .map(e => {
        const ext = path.extname(e.name);
        const stat = fs.statSync(path.join(dir, e.name));
        return buildFileEntry(e.name, ext, stat, encodePath([], e.name), false);
      });

    if (directFiles.length > 0) {
      nodes.push({
        name: '独立文件 / 根目录资源',
        path: '/fortrust/',
        url: directFiles[0].url,
        hasIndex: false,
        files: directFiles,
        children: []
      });
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const abs = path.join(dir, entry.name);
    const parts = [...relativeParts, entry.name];

    const subEntries = fs.readdirSync(abs, { withFileTypes: true })
      .filter(e => !IGNORE_DIRS.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));

    // hasIndex 必须在文件过滤之前判断，否则永远为 false
    const hasIndex = subEntries.some(e => e.isFile() && e.name.toLowerCase() === 'index.html');

    const validFiles = subEntries
      .filter(e => {
        if (!e.isFile() || SUB_IGNORE_FILES.has(e.name)) return false;
        const ext = path.extname(e.name).toLowerCase();
        return ALLOWED_EXTS.has(ext);
      })
      .map(e => {
        const ext = path.extname(e.name);
        const stat = fs.statSync(path.join(abs, e.name));
        const isIndex = e.name.toLowerCase() === 'index.html';
        // index.html 条目直接指向目录本身（目录默认页）
        const url = isIndex ? encodePath(parts) : encodePath(parts, e.name);
        return buildFileEntry(e.name, ext, stat, url, isIndex);
      })
      // 首页条目排在最前，其余按名称自然排序
      .sort((a, b) => (b.isIndex - a.isIndex) || a.title.localeCompare(b.title, 'zh-CN', { numeric: true }));

    const children = scan(abs, parts);

    const node = {
      name: entry.name,
      path: encodePath(parts),
      url: hasIndex ? encodePath(parts) : (validFiles.length ? validFiles[0].url : null),
      hasIndex,
      files: validFiles,
      children
    };

    if (node.files.length > 0 || node.children.length > 0) {
      nodes.push(node);
    }
  }

  return nodes;
}

function generateDirectoryData() {
  if (!fs.existsSync(ROOT)) {
    throw new Error(`目录不存在: ${ROOT}`);
  }
  const tree = scan(ROOT);
  return {
    buildTime: new Date().toISOString(),
    data: tree
  };
}

function writeDirectoryJson() {
  const outputData = generateDirectoryData();
  fs.writeFileSync(OUTPUT, JSON.stringify(outputData, null, 2), 'utf8');
  console.log(`Fortrust directory generated: ${OUTPUT}`);
  console.log(`Top-level items: ${outputData.data.length}`);
  return outputData;
}

if (require.main === module) {
  writeDirectoryJson();
}

module.exports = {
  ROOT,
  OUTPUT,
  scan,
  generateDirectoryData,
  writeDirectoryJson
};

