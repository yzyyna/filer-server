/**
 * 国际化配置与切换逻辑
 * - 初次进入根据系统语言自动检测并存入 localStorage
 * - 提供 t(key, params) 翻译函数
 * - 提供 setLanguage(lang) 切换并应用
 * - HTML 中通过 data-i18n="key" 标记的元素会自动应用翻译
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'filer-server-lang';
  const SUPPORTED_LANGS = ['en', 'zh'];
  const DEFAULT_LANG = 'en';

  const I18N_DICT = {
    en: {
      'app.title': 'File Server',
      'app.explorer': 'File Explorer',
      'app.version': 'v1.0.0 - STABLE',

      'dropzone.hint': 'Drop objects here or browse locally',
      'dropzone.button': 'Open Files',
      'dropzone.disabledHint': 'Please enter a subfolder before uploading (root directory upload disabled)',
      'dropzone.enabledHint': 'Upload to: {dir} (drop or click to select)',

      'progress.transferring': 'Transferring...',
      'progress.uploading': 'UPLOADING',
      'progress.complete': 'SYNC COMPLETE',

      'breadcrumb.root': 'Root',
      'breadcrumb.sep': '›',

      'file.parent': 'Parent Directory',
      'file.directory': 'Directory',
      'file.empty': 'No files uploaded yet',

      'action.open': 'OPEN',
      'action.download': 'DOWNLOAD',
      'action.copyLink': 'COPY LINK',
      'action.preview': 'PREVIEW',
      'action.delete': 'DELETE',

      'state.loadFailed': 'Failed to load ({status})',
      'state.connectionError': 'Connection error',

      'toast.previewCopied': '✓ Preview link copied',
      'toast.downloadCopied': '✓ Download link copied',
      'toast.linkCopied': '✓ Link copied',
      'toast.copyFailed': '✗ Copy failed',
      'toast.previewFailed': '✗ Preview failed',
      'toast.uploadFailed': 'Upload failed ({status})',
      'toast.networkError': '✗ Network error, upload failed',
      'toast.requireSubdir': '✗ Please enter a subfolder before uploading',
      'toast.deleteDenied': 'ACCESS DENIED: Please contact the system administrator to remove objects.',

      'title.copyDownload': 'Copy download link',
      'title.copyPreview': 'Copy preview link',

      'lang.label': 'Language',
      'lang.en': 'English',
      'lang.zh': '中文'
    },

    zh: {
      'app.title': '文件服务器',
      'app.explorer': '文件浏览器',
      'app.version': 'v1.0.0 - 稳定版',

      'dropzone.hint': '拖放文件到此处或点击本地浏览',
      'dropzone.button': '打开文件',
      'dropzone.disabledHint': '请先进入子文件夹再上传文件（主目录禁止上传）',
      'dropzone.enabledHint': '上传到：{dir}（拖放或点击选择）',

      'progress.transferring': '传输中...',
      'progress.uploading': '上传中',
      'progress.complete': '同步完成',

      'breadcrumb.root': '根目录',
      'breadcrumb.sep': '›',

      'file.parent': '上级目录',
      'file.directory': '文件夹',
      'file.empty': '暂无上传文件',

      'action.open': '打开',
      'action.download': '下载',
      'action.copyLink': '复制链接',
      'action.preview': '预览',
      'action.delete': '删除',

      'state.loadFailed': '加载失败 ({status})',
      'state.connectionError': '连接错误',

      'toast.previewCopied': '✓ 预览链接已复制',
      'toast.downloadCopied': '✓ 下载链接已复制',
      'toast.linkCopied': '✓ 链接已复制',
      'toast.copyFailed': '✗ 复制失败',
      'toast.previewFailed': '✗ 预览失败',
      'toast.uploadFailed': '上传失败 ({status})',
      'toast.networkError': '✗ 网络错误，上传失败',
      'toast.requireSubdir': '✗ 请先进入子文件夹再上传',
      'toast.deleteDenied': '访问被拒绝：请联系系统管理员删除文件。',

      'title.copyDownload': '复制下载链接',
      'title.copyPreview': '复制预览链接',

      'lang.label': '语言',
      'lang.en': 'English',
      'lang.zh': '中文'
    }
  };

  /** 检测系统语言 */
  function detectSystemLang() {
    const sysLang = (navigator.language || navigator.userLanguage || '').toLowerCase();
    if (sysLang.startsWith('zh')) return 'zh';
    if (sysLang.startsWith('en')) return 'en';
    // 兜底匹配其他支持语言
    for (const lang of SUPPORTED_LANGS) {
      if (sysLang.startsWith(lang)) return lang;
    }
    return DEFAULT_LANG;
  }

  /** 获取当前语言（首次进入从 localStorage 读取，无则检测并存储） */
  function getCurrentLang() {
    let stored = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      // localStorage 不可用时降级
    }
    if (stored && SUPPORTED_LANGS.includes(stored)) return stored;
    const detected = detectSystemLang();
    try {
      localStorage.setItem(STORAGE_KEY, detected);
    } catch (e) {}
    return detected;
  }

  let currentLang = getCurrentLang();

  /** 翻译函数 t(key, params) 支持占位符 {xxx} */
  function t(key, params) {
    const dict = I18N_DICT[currentLang] || I18N_DICT[DEFAULT_LANG];
    let str = dict[key];
    if (str === undefined) {
      // 回退到默认语言
      str = I18N_DICT[DEFAULT_LANG][key];
    }
    if (str === undefined) return key;
    if (params) {
      Object.keys(params).forEach((k) => {
        str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
      });
    }
    return str;
  }

  /** 应用所有 data-i18n 标记的静态元素翻译 */
  function applyStaticI18n() {
    const elements = document.querySelectorAll('[data-i18n]');
    elements.forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const translated = t(key);
      el.textContent = translated;
    });
    // 单独处理 title 属性
    const titleEls = document.querySelectorAll('[data-i18n-title]');
    titleEls.forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      el.setAttribute('title', t(key));
    });
    document.title = t('app.title');
  }

  /** 切换语言并应用，刷新动态内容 */
  function setLanguage(lang) {
    if (!SUPPORTED_LANGS.includes(lang)) lang = DEFAULT_LANG;
    currentLang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {}
    applyStaticI18n();
    // 同步语言选择器
    const selectors = document.querySelectorAll('.lang-select');
    selectors.forEach((sel) => { sel.value = lang; });
    // 触发自定义事件，让动态内容刷新
    document.dispatchEvent(new CustomEvent('languagechange', { detail: { lang } }));
  }

  function getLang() {
    return currentLang;
  }

  function getSupportedLangs() {
    return SUPPORTED_LANGS.slice();
  }

  global.I18n = {
    t,
    setLanguage,
    getLang,
    getSupportedLangs,
    applyStaticI18n,
    STORAGE_KEY
  };
})(window);
