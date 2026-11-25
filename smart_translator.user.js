// ==UserScript==
// @name         Smart Page & GitHub Translator
// @namespace    http://tampermonkey.net/
// @version      5.5.0
// @description  边缘可拖拽图标翻译按钮（关闭 / 双语 / CH / 设置），Google+Microsoft 双引擎竞速与局部补齐；GitHub README 顶栏无边框蓝字切换（双语 / CH / EN / 设置）优先机翻并后台无缝切换中文 README（完整 GFM Markdown 支持）；增量 DOM 扫描、Shadow DOM / Portal 交互弹窗精准翻译、图片与组件外观无损保留；Dark 交互式特殊词库。
// @author       Translator
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      translate.googleapis.com
// @connect      edge.microsoft.com
// @connect      api-edge.cognitive.microsofttranslator.com
// @connect      api.mymemory.translated.net
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      github.com
// @connect      127.0.0.1
// @connect      api.ocr.space
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================================
  // 1. 默认特殊词库配置与常量
  // ============================================================================
  // 仅保留极简内置兜底词库；完整 180+ 词库请通过词库弹窗导入 smart_translator_glossary.json 或由本机采集服务同步
  const DEFAULT_GLOSSARY = {
    keep: ['Claude', 'Gemini', 'OpenAI', 'API', 'SDK', 'CLI', 'GitHub', 'Git', 'README', 'JSON'],
    replace: {
      'Prompt': '提示词',
      'Agent': '智能体',
      'Workflow': '工作流',
      'Repository': '代码仓库',
    },
  };

  const STORAGE_KEYS = {
    GLOSSARY: 'smart_translator_glossary_v2',
    POS: 'smart_translator_btn_pos_v1',
    NAV_INTENTS: 'smart_translator_nav_intents_v1',
    PAGE_MODES: 'smart_translator_page_modes_v1',
    ORIGIN_MODES: 'smart_translator_origin_modes_v1',
    BLOCKED_SITES: 'smart_translator_blocked_sites_v1',
    LAN_SYNC_TS: 'smart_translator_lan_sync_ts_v1',
  };

  const LAN_GLOSSARY_ENDPOINT = 'http://127.0.0.1:18765/glossary.json';
  const LAN_OCR_ENDPOINT = 'http://127.0.0.1:18765/ocr';
  const LAN_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 低频：每 6 小时最多静默同步一次
  const MAX_SINGLE_ITEM_CHARS = 1800; // 单条智能截断阈值，杜绝 Google/Microsoft 过长报错

  const CN_README_ROOT_CANDIDATES = [
    'README_cn.md',
    'README.zh-CN.md',
    'README_zh-CN.md',
    'README.zh.md',
    'README_zh.md',
    'README-zh.md',
    'README-CN.md',
    'README.cn.md',
    'README.zh_CN.md',
    'README_zh_CN.md',
    'README.zh-Hans.md',
    'README_zh-Hans.md',
    'README-zh-CN.md',
    'README-zh_CN.md',
    'README-zh-Hans.md',
    'README_zh_Hans.md',
    'README.zh_Hans.md',
    'README_CN.md',
    'README.CN.md',
    'README_CHS.md',
    'README.chs.md',
    'README_ZH.md',
    'README.ZH.md',
    'README-zh-Hant.md',
    'README.zh-TW.md',
    'README_zh-TW.md',
  ];

  const CN_README_FILENAME_REGEX =
    /^readme([._-]?(zh|cn|zh[-_]?cn|zh[-_]?hans|zh[-_]?hant|zh[-_]?tw|chinese|chs|cht))\.md$/i;

  const REQUEST_TIMEOUT_MS = 8500;
  const MAX_TRANSLATION_CACHE_SIZE = 3000;
  const MAX_CN_README_CACHE_SIZE = 40;

  // ============================================================================
  // 2. 通用数据结构：LRU 缓存、任务取消、词库编译缓存
  // ============================================================================
  class LRUCache {
    constructor(maxSize = 2000) {
      this.maxSize = maxSize;
      this.map = new Map();
    }
    has(key) {
      return this.map.has(key);
    }
    get(key) {
      if (!this.map.has(key)) return undefined;
      const val = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, val);
      return val;
    }
    set(key, value) {
      if (this.map.has(key)) {
        this.map.delete(key);
      } else if (this.map.size >= this.maxSize) {
        const oldestKey = this.map.keys().next().value;
        this.map.delete(oldestKey);
      }
      this.map.set(key, value);
    }
    clear() {
      this.map.clear();
    }
    get size() {
      return this.map.size;
    }
  }

  let cachedGlossary = null;
  let compiledGlossaryRules = null;
  let glossaryVersion = 1;

  function loadLocalResourceGlossary() {
    if (typeof GM_getResourceText !== 'function') return null;
    try {
      const txt = GM_getResourceText('localGlossary');
      if (!txt) return null;
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed === 'object') {
        return {
          keep: Array.isArray(parsed.keep) ? parsed.keep : [],
          replace: parsed.replace && typeof parsed.replace === 'object' ? parsed.replace : {},
        };
      }
    } catch (_) {
      // 本地文件解析失败时静默回退
    }
    return null;
  }

  function loadGlossary() {
    if (cachedGlossary) return cachedGlossary;
    // 1. 优先读取 @resource 词库（发布版默认不配置）
    const resourceData = loadLocalResourceGlossary();
    try {
      const raw = GM_getValue(STORAGE_KEYS.GLOSSARY, null);
      if (raw && typeof raw === 'object') {
        cachedGlossary = {
          keep: Array.isArray(raw.keep) ? raw.keep : [...(resourceData?.keep || DEFAULT_GLOSSARY.keep)],
          replace: raw.replace && typeof raw.replace === 'object' ? raw.replace : { ...(resourceData?.replace || DEFAULT_GLOSSARY.replace) },
        };
        return cachedGlossary;
      }
    } catch (_) {
      // 忽略存储读取异常
    }
    if (resourceData) {
      cachedGlossary = resourceData;
      return cachedGlossary;
    }
    cachedGlossary = {
      keep: [...DEFAULT_GLOSSARY.keep],
      replace: { ...DEFAULT_GLOSSARY.replace },
    };
    return cachedGlossary;
  }

  const glossaryUpdateListeners = new Set();

  function onGlossaryUpdated(fn) {
    glossaryUpdateListeners.add(fn);
    return () => glossaryUpdateListeners.delete(fn);
  }

  function saveGlossary(glossary) {
    cachedGlossary = {
      keep: Array.isArray(glossary.keep) ? [...glossary.keep] : [],
      replace: glossary.replace ? { ...glossary.replace } : {},
    };
    compiledGlossaryRules = null;
    glossaryVersion++;
    try {
      GM_setValue(STORAGE_KEYS.GLOSSARY, cachedGlossary);
    } catch (_) {
      // 忽略存储写入异常
    }
    for (const fn of glossaryUpdateListeners) {
      try {
        fn();
      } catch (_) {
        // 忽略单个监听器异常
      }
    }
  }

  function loadBlockedSites() {
    try {
      const raw = GM_getValue(STORAGE_KEYS.BLOCKED_SITES, []);
      if (Array.isArray(raw)) return raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    } catch (_) {}
    return [];
  }

  let cachedBlockedSites = null;

  function saveBlockedSites(list) {
    const clean = Array.from(new Set((list || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)));
    cachedBlockedSites = clean;
    try {
      GM_setValue(STORAGE_KEYS.BLOCKED_SITES, clean);
    } catch (_) {}
    return clean;
  }

  function isHostBlocked(hostname = location.hostname) {
    const host = String(hostname || '').trim().toLowerCase();
    if (!host) return false;
    const list = cachedBlockedSites !== null ? cachedBlockedSites : (cachedBlockedSites = loadBlockedSites());
    for (const rule of list) {
      if (rule === host) return true;
      if (rule.startsWith('*.')) {
        const suffix = rule.slice(2);
        if (host === suffix || host.endsWith('.' + suffix)) return true;
      } else if (host.endsWith('.' + rule)) {
        return true;
      }
    }
    return false;
  }

  function toggleBlockCurrentSite() {
    const host = (location.hostname || '').toLowerCase();
    if (!host) return;
    const list = loadBlockedSites();
    const exists = list.includes(host);
    if (exists) {
      saveBlockedSites(list.filter((h) => h !== host));
      location.reload();
    } else {
      list.push(host);
      saveBlockedSites(list);
      const floating = document.getElementById('st-floating-host');
      if (floating) floating.remove();
      const ghBar = document.querySelector('.st-gh-standalone-bar');
      if (ghBar) ghBar.remove();
    }
  }

  // ============================================================================
  // 2.5 按来源页面继承翻译模式（A->D 继承 A，C->E 继承 C；兼容新开标签、同标签、重定向与 Chrome origin-only referrer）
  // ============================================================================
  const NAV_INTENT_TTL_MS = 30 * 1000;
  const MAX_PAGE_MODE_RECORDS = 120;
  let currentActivePageMode = 'off'; // 统一值: 'off' | 'bilingual' | 'ch'

  function normalizeLineageUrl(rawUrl, stripSearch = false) {
    try {
      const u = new URL(rawUrl, location.href);
      let p = u.pathname;
      if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
      return stripSearch ? `${u.origin}${p}` : `${u.origin}${p}${u.search}`;
    } catch (_) {
      const noHash = String(rawUrl || '').split('#')[0];
      return stripSearch ? noHash.split('?')[0] : noHash;
    }
  }

  function setCurrentPageLineageMode(mode) {
    const normalized = mode === 'bilingual' || mode === 'ch' ? mode : 'off';
    currentActivePageMode = normalized;
    const urlKey = normalizeLineageUrl(location.href, false);
    const originKey = location.origin || '';
    const now = Date.now();
    try {
      const map = GM_getValue(STORAGE_KEYS.PAGE_MODES, {}) || {};
      map[urlKey] = { mode: normalized, ts: now };
      const entries = Object.entries(map);
      if (entries.length > MAX_PAGE_MODE_RECORDS) {
        entries.sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
        GM_setValue(STORAGE_KEYS.PAGE_MODES, Object.fromEntries(entries.slice(0, MAX_PAGE_MODE_RECORDS)));
      } else {
        GM_setValue(STORAGE_KEYS.PAGE_MODES, map);
      }
      if (originKey && /^https?:/i.test(originKey)) {
        const omap = GM_getValue(STORAGE_KEYS.ORIGIN_MODES, {}) || {};
        omap[originKey] = { mode: normalized, ts: now };
        GM_setValue(STORAGE_KEYS.ORIGIN_MODES, omap);
      }
    } catch (_) {}
    try {
      window.sessionStorage?.setItem('st_tab_mode_v1', normalized);
    } catch (_) {}
  }

  function extractUnwrappedRedirectUrl(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      for (const param of ['url', 'q', 'target', 'u', 'redirect', 'dest']) {
        const val = u.searchParams.get(param);
        if (val && /^https?:\/\//i.test(val)) return val;
      }
    } catch (_) {}
    return '';
  }

  function recordNavigationIntent(targetHref) {
    if (!targetHref) return;
    const fullKey = normalizeLineageUrl(targetHref, false);
    const pathKey = normalizeLineageUrl(targetHref, true);
    if (!fullKey || !/^https?:/i.test(fullKey)) return;
    const now = Date.now();
    try {
      const intents = GM_getValue(STORAGE_KEYS.NAV_INTENTS, {}) || {};
      for (const [k, v] of Object.entries(intents)) {
        if (!v || now - (v.ts || 0) > NAV_INTENT_TTL_MS) delete intents[k];
      }
      const record = {
        mode: currentActivePageMode,
        from: normalizeLineageUrl(location.href, false),
        ts: now,
      };
      intents[fullKey] = record;
      if (pathKey && pathKey !== fullKey) intents[pathKey] = record;

      // 兼容 Google / YouTube / Reddit 等带跳转参数的重定向链接，同步记录解包后的真实目标 URL
      const unwrapped = extractUnwrappedRedirectUrl(targetHref);
      if (unwrapped) {
        const uFull = normalizeLineageUrl(unwrapped, false);
        const uPath = normalizeLineageUrl(unwrapped, true);
        if (uFull && /^https?:/i.test(uFull)) intents[uFull] = record;
        if (uPath && uPath !== uFull) intents[uPath] = record;
      }
      GM_setValue(STORAGE_KEYS.NAV_INTENTS, intents);
    } catch (_) {}
  }

  function resolveInheritedModeForCurrentPage() {
    const now = Date.now();
    const curFullKey = normalizeLineageUrl(location.href, false);
    const curPathKey = normalizeLineageUrl(location.href, true);

    // 1. 优先匹配来源页点击/中键/右键/window.open 写入的跳转意图（兼容完整 URL 与带 ?utm 参数跳转）
    try {
      const intents = GM_getValue(STORAGE_KEYS.NAV_INTENTS, {}) || {};
      const hitKey =
        (intents[curFullKey] && now - (intents[curFullKey].ts || 0) <= NAV_INTENT_TTL_MS)
          ? curFullKey
          : ((intents[curPathKey] && now - (intents[curPathKey].ts || 0) <= NAV_INTENT_TTL_MS) ? curPathKey : null);
      if (hitKey) {
        const hit = intents[hitKey];
        delete intents[curFullKey];
        if (curPathKey !== curFullKey) delete intents[curPathKey];
        GM_setValue(STORAGE_KEYS.NAV_INTENTS, intents);
        return hit.mode === 'bilingual' || hit.mode === 'ch' ? hit.mode : 'off';
      }
    } catch (_) {}

    // 2. 次选匹配 document.referrer（先精确匹配来源页 URL，再兼容 Chrome 默认 strict-origin-when-cross-origin 的 origin-only referrer）
    if (document.referrer) {
      try {
        const refFullKey = normalizeLineageUrl(document.referrer, false);
        const refPathKey = normalizeLineageUrl(document.referrer, true);
        const map = GM_getValue(STORAGE_KEYS.PAGE_MODES, {}) || {};
        const refHit = map[refFullKey] || map[refPathKey];
        if (refHit && (refHit.mode === 'bilingual' || refHit.mode === 'ch' || refHit.mode === 'off')) {
          return refHit.mode;
        }
        const refOrigin = new URL(document.referrer).origin;
        // 同标签同源跳转优先使用当前标签自己的 sessionStorage（区分同站点下不同标签页 A/C 的各自状态！）
        if (refOrigin === location.origin) {
          const tabMode = window.sessionStorage?.getItem('st_tab_mode_v1');
          if (tabMode === 'bilingual' || tabMode === 'ch' || tabMode === 'off') return tabMode;
        }
        // 跨站跳转且 Chrome 裁掉了路径时，回退匹配来源域名最近记录的状态
        const omap = GM_getValue(STORAGE_KEYS.ORIGIN_MODES, {}) || {};
        const oHit = omap[refOrigin];
        if (oHit && (oHit.mode === 'bilingual' || oHit.mode === 'ch' || oHit.mode === 'off')) {
          return oHit.mode;
        }
      } catch (_) {}
    }

    // 直接地址栏/书签新开页面，不跨无关标签继承，默认正常状态
    return 'off';
  }

  function bindNavigationLineageTracker() {
    if (window.__stLineageBound) return;
    window.__stLineageBound = true;
    const captureLink = (e) => {
      const a = e.target?.closest?.('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
      recordNavigationIntent(a.href);
    };
    document.addEventListener('mousedown', captureLink, true);
    document.addEventListener('click', captureLink, true);
    document.addEventListener('auxclick', captureLink, true);
    document.addEventListener('contextmenu', captureLink, true);

    // 捕获 JS window.open(url) 打开新标签页的来源继承
    if (!window.__stOpenPatched && typeof window.open === 'function') {
      window.__stOpenPatched = true;
      const origOpen = window.open;
      window.open = function (url, ...rest) {
        if (typeof url === 'string' && url) {
          recordNavigationIntent(url);
        }
        return origOpen.call(this, url, ...rest);
      };
    }
  }

  // 低频静默从本机服务（127.0.0.1:18765）增量合并新发现的专用名词，失败静默忽略，绝不阻塞翻译
  function maybeSyncLanGlossary() {
    try {
      const lastTs = Number(GM_getValue(STORAGE_KEYS.LAN_SYNC_TS, 0)) || 0;
      if (Date.now() - lastTs < LAN_SYNC_INTERVAL_MS) return;
      GM_setValue(STORAGE_KEYS.LAN_SYNC_TS, Date.now());
      GM_xmlhttpRequest({
        method: 'GET',
        url: LAN_GLOSSARY_ENDPOINT,
        timeout: 2500,
        onload: (res) => {
          if (res.status !== 200 || !res.responseText) return;
          try {
            const remote = JSON.parse(res.responseText);
            if (!remote || !Array.isArray(remote.keep) || remote.keep.length === 0) return;
            const current = loadGlossary();
            const existing = new Set((current.keep || []).map((k) => k.toLowerCase()));
            const mergedKeep = [...(current.keep || [])];
            let added = 0;
            for (const term of remote.keep) {
              const clean = String(term).trim();
              if (clean && !existing.has(clean.toLowerCase())) {
                mergedKeep.push(clean);
                existing.add(clean.toLowerCase());
                added++;
              }
            }
            if (added > 0) {
              saveGlossary({ keep: mergedKeep, replace: current.replace || {} });
            }
          } catch (_) {}
        },
        onerror: () => {},
        ontimeout: () => {},
      });
    } catch (_) {}
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function getCompiledGlossaryRules() {
    if (compiledGlossaryRules) return compiledGlossaryRules;
    const glossary = loadGlossary();
    const entries = [];
    for (const term of glossary.keep || []) {
      const clean = String(term).trim();
      if (clean) entries.push({ source: clean, target: clean, isKeep: true });
    }
    for (const [src, dst] of Object.entries(glossary.replace || {})) {
      const cleanSrc = String(src).trim();
      const cleanDst = String(dst).trim();
      if (cleanSrc && cleanDst) entries.push({ source: cleanSrc, target: cleanDst, isKeep: false });
    }
    entries.sort((a, b) => b.source.length - a.source.length || (a.isKeep ? 1 : -1));

    if (entries.length === 0) {
      compiledGlossaryRules = { combinedRegex: null, map: new Map() };
      return compiledGlossaryRules;
    }

    const map = new Map();
    const parts = [];
    for (const entry of entries) {
      const key = entry.source.toLowerCase();
      if (!map.has(key)) {
        map.set(key, entry);
        parts.push(escapeRegExp(entry.source));
      }
    }
    // 大小写不敏感合并正则，兼顾大小写变体（如 github / FastAPI / DEEPSEEK）且保留原词大小写
    const combinedRegex = new RegExp(`(?<![A-Za-z0-9_])(?:${parts.join('|')})(?![A-Za-z0-9_])`, 'gi');
    compiledGlossaryRules = { combinedRegex, map };
    return compiledGlossaryRules;
  }

  // 高频短 UI 词精准直译表（0ms 本地命中、零网络延迟，彻底杜绝 "Home -> 家"、"Docs -> 医生" 等无上下文机翻误译）
  const UI_EXACT_DICT = new Map(Object.entries({
    'home': '首页', 'docs': '文档', 'documentation': '文档', 'guide': '指南', 'guides': '指南',
    'tutorials': '教程', 'tutorial': '教程', 'reference': '参考文档', 'examples': '示例', 'playground': '演练场',
    'overview': '概览', 'getting started': '快速开始', 'get started': '快速开始', 'quick start': '快速开始',
    'learn more': '了解更多', 'read more': '阅读更多', 'view more': '查看更多', 'see more': '查看更多',
    'show more': '展开更多', 'show less': '收起', 'view all': '查看全部', 'see all': '查看全部',
    'sign in': '登录', 'log in': '登录', 'login': '登录', 'sign up': '注册', 'register': '注册',
    'sign out': '退出登录', 'log out': '退出登录', 'logout': '退出登录',
    'settings': '设置', 'preferences': '偏好设置', 'profile': '个人资料', 'account': '账户',
    'billing': '账单', 'pricing': '定价', 'plans': '方案', 'enterprise': '企业版', 'upgrade': '升级',
    'dashboard': '控制台', 'workspace': '工作区', 'projects': '项目', 'templates': '模板',
    'notifications': '通知', 'integrations': '集成', 'analytics': '数据分析', 'insights': '洞察',
    'security': '安全', 'privacy': '隐私政策', 'privacy policy': '隐私政策', 'terms': '服务条款',
    'terms of service': '服务条款', 'about': '关于', 'about us': '关于我们', 'contact': '联系我们',
    'contact us': '联系我们', 'blog': '博客', 'news': '新闻', 'careers': '加入我们', 'community': '社区',
    'support': '技术支持', 'help': '帮助', 'help center': '帮助中心', 'feedback': '反馈', 'status': '服务状态',
    'changelog': '更新日志', 'releases': '发布版本', 'roadmap': '路线图', 'features': '核心特性',
    'solutions': '解决方案', 'products': '产品', 'resources': '资源', 'download': '下载', 'install': '安装',
    'copy': '复制', 'copied': '已复制', 'copied!': '已复制！', 'share': '分享', 'export': '导出', 'import': '导入',
    'save': '保存', 'cancel': '取消', 'confirm': '确认', 'submit': '提交', 'apply': '应用', 'reset': '重置',
    'delete': '删除', 'remove': '移除', 'edit': '编辑', 'create': '创建', 'new': '新建', 'add': '添加',
    'search': '搜索', 'filter': '筛选', 'sort': '排序', 'refresh': '刷新', 'reload': '重新加载',
    'close': '关闭', 'back': '返回', 'next': '下一页', 'previous': '上一页', 'prev': '上一页', 'continue': '继续',
    'loading...': '加载中...', 'loading': '加载中', 'dark': '深色', 'light': '浅色', 'system': '跟随系统',
    'star': '星标', 'starred': '已加星标', 'watch': '关注', 'fork': '派生', 'sponsor': '赞助',
    'contributors': '贡献者', 'packages': '软件包', 'discussions': '讨论', 'issues': '议题',
    'pull requests': '拉取请求', 'actions': '自动化', 'wiki': '维基', 'code': '代码',
    'table of contents': '目录', 'on this page': '本页目录', 'skip to content': '跳至正文',
    'yes': '是', 'no': '否', 'enabled': '已启用', 'disabled': '已禁用', 'active': '启用中', 'inactive': '未启用',
    'supported': '已支持', 'unsupported': '不支持', 'deprecated': '已弃用', 'experimental': '实验性',
    'required': '必填', 'optional': '可选', 'default': '默认', 'read-only': '只读', 'readonly': '只读',
    'public': '公开', 'private': '私有', 'internal': '内部', 'recommended': '推荐', 'beta': '测试版',
    'stable': '稳定版', 'latest': '最新', 'new': '新增', 'updated': '已更新', 'fixed': '已修复',
    'warning': '警告', 'note': '提示', 'tip': '技巧', 'important': '重要', 'caution': '注意',
    'description': '说明', 'type': '类型', 'value': '值', 'name': '名称', 'parameters': '参数',
    'returns': '返回值', 'example': '示例', 'usage': '用法', 'installation': '安装', 'configuration': '配置',
    'license': '许可证', 'contributing': '参与贡献', 'acknowledgments': '致谢', 'faq': '常见问题',
    'view source': '查看源码', 'copy link': '复制链接', 'open in new tab': '在新标签页打开',
    'quick links': '快捷链接', 'edit this page': '编辑此页', 'last updated': '最后更新',
    'related articles': '相关文章', 'all rights reserved': '保留所有权利', 'cookie settings': 'Cookie 设置',
    'accept all': '全部接受', 'reject all': '全部拒绝', 'try for free': '免费试用',
    'book a demo': '预约演示', 'request access': '申请访问', 'join waitlist': '加入候补名单',
    'view pricing': '查看定价', 'release notes': '发布说明', 'api reference': 'API 参考',
    'quickstart': '快速入门', 'architecture': '架构设计', 'troubleshooting': '故障排查',
    'best practices': '最佳实践', 'migration guide': '迁移指南', 'security policy': '安全策略',
    'code of conduct': '行为准则', 'commit history': '提交历史', 'raw': '原始文件',
    'blame': '逐行追溯', 'history': '历史记录', 'download zip': '下载 ZIP', 'clone': '克隆',
    'latest commit': '最新提交', 'branches': '分支', 'tags': '标签', 'commits': '提交记录',
    'subscribe': '订阅', 'unsubscribe': '取消订阅', 'follow': '关注', 'following': '正在关注',
    'followers': '粉丝', 'trending': '热门趋势', 'popular': '热门', 'explore': '探索',
    'discover': '发现', 'bookmarks': '书签', 'favorites': '收藏', 'archive': '归档',
    'trash': '回收站', 'drafts': '草稿', 'published': '已发布', 'scheduled': '已排期',
    'reports': '报表', 'activity': '动态', 'members': '成员', 'team': '团队',
    'roles': '角色', 'permissions': '权限', 'api keys': 'API 密钥', 'appearance': '外观',
    'language': '语言', 'timezone': '时区', 'keyboard shortcuts': '快捷键', 'notifications': '通知',
    'dark mode': '深色模式', 'light mode': '浅色模式', 'open source': '开源', 'changelog': '更新日志',
  }));

  function lookupExactUiTerm(text) {
    if (!text || text.length > 42) return null;
    if (text.includes('[[') || text.includes(']]')) return null;
    const trimmed = text.replace(/\s+/g, ' ').trim();
    const direct = UI_EXACT_DICT.get(trimmed.toLowerCase());
    if (direct) return direct;
    // 兼容带箭头/计数徽章/标点后缀的 UI 按钮与标签（如 "Get Started →"、"Issues 42"、"Notifications (3)"）
    const suffixMatch = trimmed.match(/^([A-Za-z][A-Za-z\s-]{1,26}?)(\s*(?:[→➔➜▸►›»>↗+:]|\(\d+[kKmM+]?\)|\d+[kKmM+]?))$/);
    if (suffixMatch) {
      const hit = UI_EXACT_DICT.get(suffixMatch[1].trim().toLowerCase());
      if (hit) return `${hit}${suffixMatch[2]}`;
    }
    return null;
  }

  /**
   * 翻译前清洗噪声字符（软连字符、零宽字符、不换行空格），避免英文单词被拆碎导致机翻失真
   */
  function preprocessForMT(text) {
    if (!text) return '';
    return text
      .replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 译后中文排版润色（盘古中英间距 + 清理中文标点前多余空格，绝不破坏占位符与 URL）
   */
  let cachedTechPageUrl = '';
  let cachedTechPageResult = false;
  const TECH_HOST_RE =
    /(?:^|\.)(?:github\.com|gitlab\.com|bitbucket\.org|stackoverflow\.com|stackexchange\.com|developer\.mozilla\.org|npmjs\.com|pypi\.org|crates\.io|pkg\.go\.dev|huggingface\.co|arxiv\.org|vercel\.com|cloudflare\.com|docker\.com|kubernetes\.io|react\.dev|vuejs\.org|nextjs\.org|nodejs\.org|python\.org|rust-lang\.org|typescriptlang\.org|learn\.microsoft\.com|web\.dev|dev\.to|hackernews\.com|ycombinator\.com)$|^docs\.|^dev\.|^api\./i;

  function isTechPageContext() {
    const curUrl = location.href;
    if (curUrl === cachedTechPageUrl) return cachedTechPageResult;
    cachedTechPageUrl = curUrl;
    if (TECH_HOST_RE.test(location.hostname)) {
      cachedTechPageResult = true;
      return true;
    }
    const title = (document.title || '').toLowerCase();
    const titleHit = /(?:documentation|api reference|developer|sdk|cli|github|programming|tutorial|framework|changelog|release notes)/i.test(title);
    const codeDensity = typeof document.querySelectorAll === 'function' && document.querySelectorAll('pre, code').length >= 6;
    cachedTechPageResult = Boolean(titleHit || codeDensity);
    return cachedTechPageResult;
  }

  function polishChineseTypography(text, originalText = '') {
    if (!text || !/[\u4e00-\u9fff]/.test(text)) return text;
    let out = text
      .replace(/\s+([，。！？；：、）】》])/g, '$1')
      .replace(/([，。！？；：、])\s+/g, '$1')
      .replace(/([（【《])\s+/g, '$1')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      // 修复机翻拆断的百分比、版本号、C++ 与 .js 框架名
      .replace(/(\d)\s+%/g, '$1%')
      .replace(/\b(Node|Next|Vue|Nuxt|React|Three|Chart|Express|Nest)\.\s+js\b/gi, '$1.js')
      .replace(/\bC\s+\+\+/g, 'C++')
      .replace(/\bv\s+(\d+\.\d+)/gi, 'v$1')
      // 清理机翻偶发的重复中文标点与中英混杂引号
      .replace(/([，。；：、])\1+/g, '$1')
      .replace(/"([\u4e00-\u9fff][^"]{0,40})”/g, '“$1”')
      .replace(/“([\u4e00-\u9fff][^“”]{0,40})"/g, '“$1”')
      .replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2')
      .replace(/([A-Za-z0-9%])([\u4e00-\u9fff])/g, '$1 $2')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    // 若原文为短标题/按钮/标签且末尾无句号，去掉机翻擅自添加的中文句号与多余外层引号
    if (originalText) {
      const origClean = originalText.replace(/(?:\[|【){1,2}\s*(?:C|L|\/[\s]*L|GTERM_?)\s*\d*\s*(?:\]|】){1,2}/gi, '').trim();
      if (origClean.length > 0 && origClean.length <= 60 && !/[.!?。！？]$/.test(origClean) && /。$/.test(out)) {
        out = out.slice(0, -1).trim();
      }
      if (!/^["“'‘]/.test(origClean) && /^“[^”]+”$/.test(out)) {
        out = out.slice(1, -1).trim();
      }
    }
    // 上下文驱动的常见机翻错译精准校正（结合句内技术词与页面级技术语境，避免误改）
    if (originalText) {
      const origLow = originalText.toLowerCase();
      const isTechCtx =
        /(?:code|api|sdk|git|repo|react|vue|node|python|docker|cloud|server|app|web|browser|dev|software|framework|package|state|memory|bug|build|deploy|css|html|js|ts|gterm_)/i.test(origLow) ||
        isTechPageContext();
      if (/\bdark mode\b/.test(origLow)) out = out.replace(/黑暗模式/g, '深色模式');
      if (/\blight mode\b/.test(origLow)) out = out.replace(/(?:灯光|光明|轻)模式/g, '浅色模式');
      if (/\bstate management\b/.test(origLow)) out = out.replace(/国家管理/g, '状态管理');
      if (/\bmemory leak/.test(origLow)) out = out.replace(/(?:记忆丧失|记忆泄[露漏])/g, '内存泄漏');
      if (/\brate limit/.test(origLow)) out = out.replace(/汇率限制/g, '速率限制');
      if (/\bcookie/i.test(origLow)) out = out.replace(/饼干/g, 'Cookie');
      if (/\bserver\b/.test(origLow)) out = out.replace(/服务员/g, '服务器');
      if (/\bcache\b/.test(origLow)) out = out.replace(/藏匿处/g, '缓存');
      if (/\bopen[- ]source\b/.test(origLow)) out = out.replace(/打开源/g, '开源');
      if (isTechCtx) {
        if (/\blibrar(?:y|ies)\b/.test(origLow)) out = out.replace(/图书馆/g, '代码库');
        if (/\bpackages?\b/.test(origLow)) out = out.replace(/包裹/g, '软件包');
        if (/\bbranch(?:es)?\b/.test(origLow)) out = out.replace(/(?:分支机构|树枝)/g, '分支');
        if (/\bbugs?\b/.test(origLow)) out = out.replace(/(?:臭虫|虫子)/g, 'Bug');
        if (/\bcontainers?\b/.test(origLow)) out = out.replace(/集装箱/g, '容器');
        if (/\bconsole\b/.test(origLow)) out = out.replace(/安慰/g, '控制台');
        if (/\bdebug(?:ging)?\b/.test(origLow)) out = out.replace(/除虫/g, '调试');
        if (/\bendpoints?\b/.test(origLow)) out = out.replace(/终点/g, '接口端点');
        if (/\bresponsive\b/.test(origLow)) out = out.replace(/有反应的/g, '响应式');
        if (/\bpipelines?\b/.test(origLow)) out = out.replace(/管道/g, '流水线');
        if (/\bthreads?\b/.test(origLow)) out = out.replace(/(?:细线|丝线)/g, '线程');
        if (/\bkernels?\b/.test(origLow)) out = out.replace(/(?:果仁|谷粒)/g, '内核');
        if (/\bhooks?\b/.test(origLow)) out = out.replace(/挂钩/g, '钩子');
        if (/\bschemas?\b/.test(origLow)) out = out.replace(/图式/g, '数据结构');
      }
    }
    return out;
  }

  function normalizeForEquality(text) {
    return String(text || '')
      .replace(/(?:\[|【){1,2}\s*(?:C|L|\/[\s]*L)\s*\d+\s*(?:\]|】){1,2}/gi, '')
      .replace(/[\s\p{P}\p{S}]+/gu, '')
      .toLowerCase();
  }

  /**
   * 译文质量评分（0~100）：评估占位符完整性、中译比例、未译残留与神经机翻复读幻觉
   */
  function scoreTranslationQuality(originalMasked, translatedRestored) {
    if (!translatedRestored || !translatedRestored.trim()) return 0;
    if (hasCorruptedPlaceholders(translatedRestored)) return 5;
    let score = 100;
    // 检测典型 NMT 复读幻觉（同一 4 字以上短语连续重复 3 次）
    if (/(.{4,})\1{2,}/.test(translatedRestored)) score -= 55;

    const origPlain = originalMasked
      .replace(/(?:\[|【){1,2}\s*(?:C|L|\/[\s]*L|GTERM_?)\s*\d*\s*(?:\]|】){1,2}/gi, '')
      .trim();
    const transPlain = translatedRestored
      .replace(/(?:\[|【){1,2}\s*(?:C|L|\/[\s]*L)\s*\d+\s*(?:\]|】){1,2}/gi, '')
      .trim();

    if (origPlain.length >= 24) {
      const ratio = transPlain.length / Math.max(1, origPlain.length);
      if (ratio < 0.16) score -= 45; // 严重截断漏译
      if (ratio > 3.2) score -= 40;  // 异常膨胀
      // 检查多词英文长句中是否仍有大量常见英文虚词未翻译
      const leftoverCommon = (transPlain.match(/\b(?:the|and|that|with|from|this|which|their|have|will|should|would|about)\b/gi) || []).length;
      if (leftoverCommon >= 3) score -= Math.min(50, leftoverCommon * 14);
    }
    return Math.max(0, score);
  }

  // 智能自动屏蔽模式：大小写不敏感规则（URL/包名/CLI参数/版本号/AI模型代号）+ 大小写敏感规则（NODE_ENV 环境变量 / useEffect 驼峰 API）
  const SMART_AUTO_KEEP_CI_RE =
    /(?:(?<![A-Za-z0-9_])(?:CI\/CD|I\/O|UI\/UX|TCP\/IP|HTTP\/[123]|A\/B|B2B|B2C|SaaS|PaaS|IaaS)(?![A-Za-z0-9_])|https?:\/\/[^\s<>()]+|(?<![A-Za-z0-9_])@[a-z0-9_-]+\/[a-z0-9._-]+|(?<!\S)--[a-z0-9][a-z0-9-]{1,32}|(?<![A-Za-z0-9_])(?:Ctrl|Cmd|Alt|Shift|Meta)(?:\s*\+\s*(?:Ctrl|Cmd|Alt|Shift|Meta|[A-Z0-9]|Enter|Esc|Tab|Space))+|(?<![A-Za-z0-9_])(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cpp|json|yaml|yml|toml|md|css|scss|html|sql|sh|env|lock|dockerfile)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])v\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.]+)?|(?<![A-Za-z0-9_])(?:gpt|claude|gemini|llama|qwen|deepseek|mistral|grok|o[134])[-_.\s]?\d+(?:[.-][a-z0-9]+)*)(?![A-Za-z0-9_])/gi;
  const SMART_AUTO_KEEP_CS_RE =
    /(?:(?<![A-Za-z0-9_])[A-Za-z_$][A-Za-z0-9_$]{1,18}(?:\.[A-Za-z_$][A-Za-z0-9_$]{1,22}){1,3}(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])[A-Z][A-Z0-9]{1,12}(?:_[A-Z0-9]{2,14})+(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])[a-z]{2,12}[A-Z][a-zA-Z0-9]{2,24}(?![A-Za-z0-9_]))/g;

  function protectGlossaryTerms(text) {
    if (!text) return { maskedText: text, placeholders: [] };
    const cleanedInput = preprocessForMT(text);
    const { combinedRegex, map } = getCompiledGlossaryRules();
    const placeholders = [];

    const maskAuto = (matched) => {
      if (/^\[\[/.test(matched) || /^GTERM_\d+$/i.test(matched)) return matched;
      const idx = placeholders.length;
      placeholders.push({ idx, source: matched, value: matched });
      return `[[GTERM_${idx}]]`;
    };

    // 第一步：智能自动保护技术标识符（避免被机翻拆碎或误译）
    let maskedText = cleanedInput.replace(SMART_AUTO_KEEP_CI_RE, maskAuto).replace(SMART_AUTO_KEEP_CS_RE, maskAuto);

    // 第二步：应用用户词库 Keep / Replace 规则
    if (combinedRegex) {
      combinedRegex.lastIndex = 0;
      maskedText = maskedText.replace(combinedRegex, (matched) => {
        const entry = map.get(matched.toLowerCase());
        if (!entry) return matched;
        const idx = placeholders.length;
        placeholders.push({
          idx,
          source: matched,
          value: entry.isKeep ? matched : entry.target,
        });
        return `[[GTERM_${idx}]]`;
      });
    }

    return { maskedText, placeholders };
  }

  function restoreGlossaryTerms(translatedText, placeholders) {
    if (!translatedText || !placeholders || placeholders.length === 0) {
      return translatedText;
    }
    let result = translatedText;
    for (const item of placeholders) {
      const loosePattern = new RegExp(`(?:\\[|【)\\s*(?:\\[|【)\\s*GTERM[_\\s-]*${item.idx}\\s*(?:\\]|】)\\s*(?:\\]|】)`, 'gi');
      result = result.replace(loosePattern, () => item.value);
    }
    return result;
  }

  function hasCorruptedPlaceholders(text) {
    if (!text) return false;
    return /(?:\[|【)\s*(?:\[|【)\s*GTERM[_\s-]*\d+\s*(?:\]|】)\s*(?:\]|】)/i.test(text) || /<\s*ST\s*9981\s*>/i.test(text);
  }

  function preserveLeadingEmoji(originalText, translatedText) {
    if (!originalText || !translatedText) return translatedText;
    const m = originalText.match(/^((?:[\p{Extended_Pictographic}\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]+\s*)+)/u);
    if (!m) return translatedText;
    const prefix = m[1];
    const firstEmoji = prefix.trim().split(/\s+/)[0];
    if (firstEmoji && !translatedText.includes(firstEmoji)) {
      return `${prefix}${translatedText}`;
    }
    return translatedText;
  }

  // ============================================================================
  // 3. 中文页面检测与译文质量校验
  // ============================================================================
  function countChineseChars(text) {
    const matches = (text || '').match(/[\u4e00-\u9fff]/g);
    return matches ? matches.length : 0;
  }

  function isChineseTextSample(text, htmlLang = '') {
    const cleaned = (text || '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[\s\d\p{P}\p{S}]+/gu, '');
    if (!cleaned) return false;
    // 含日文假名（平假名/片假名）时为日语而非中文，防止日语汉字被误判为中文跳过翻译
    const kanaCount = (cleaned.match(/[\u3040-\u30FF]/g) || []).length;
    if (kanaCount >= 2 && kanaCount / cleaned.length >= 0.12) return false;

    const sample = cleaned.slice(0, 3000);
    const cnCount = countChineseChars(sample);
    const ratio = cnCount / sample.length;

    const lang = (htmlLang || '').toLowerCase();
    const isZhLang = lang.startsWith('zh');

    if (isZhLang && cnCount >= 12 && ratio >= 0.15) return true;
    return cnCount >= 20 && ratio >= 0.25;
  }

  function isGeneralPageChinese() {
    const body = document.body;
    if (!body) return false;
    // 使用 TreeWalker 采样前 4000 字符，避免整页 body.innerText 触发昂贵的全局重排
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'CODE' || tag === 'PRE') {
          return NodeFilter.FILTER_REJECT;
        }
        if (p.hasAttribute('hidden') || p.style?.display === 'none' || p.closest?.('[hidden], [aria-hidden="true"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let sample = '';
    let cur;
    while (sample.length < 4000 && (cur = walker.nextNode())) {
      sample += ' ' + cur.nodeValue;
    }
    return isChineseTextSample(sample, document.documentElement.lang);
  }

  function isGitHubReadmeChinese(markdownBodyEl) {
    if (!markdownBodyEl) return false;
    const walker = document.createTreeWalker(markdownBodyEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || p.closest('pre, code, script, style')) return NodeFilter.FILTER_REJECT;
        return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let sample = '';
    let cur;
    while (sample.length < 5000 && (cur = walker.nextNode())) {
      sample += ' ' + cur.nodeValue;
    }
    return isChineseTextSample(sample, '');
  }

  const EXTERNAL_TRANSLATION_SELECTOR =
    '.immersive-translate-target-wrapper, .immersive-translate-target-inner, [data-immersive-translate-paragraph], .kiss-a, [data-kiss-translated], [data-twp-translated], [data-translated="true"], [data-translation-result], [class*="translate-target"], [class*="bilingual-trans"]';

  function isAlreadyInlineBilingual(plain) {
    if (!plain) return false;
    if (/[\u3040-\u30FF]/.test(plain)) return false;
    const cnCount = countChineseChars(plain);
    if (cnCount < 2) return false;

    // 1. 明显的中英对照格式：Settings (设置) / Quick Start / 快速开始 / Title - 标题
    if (/[A-Za-z]{2,}\s*(?:[（(][\s\S]*?[\u4e00-\u9fff]{2,}[\s\S]*?[）)]|[|/—–\-:]\s*[\u4e00-\u9fff]{2,})/.test(plain)) {
      return true;
    }
    // 2. 短中文本中已含较高比例中文（如 "Quick Start 快速开始"、"Features 特性"）
    const nonSpace = plain.replace(/\s+/g, '');
    const cnRatio = cnCount / Math.max(1, nonSpace.length);
    if (nonSpace.length <= 80 && cnCount >= 2 && cnRatio >= 0.2) {
      return true;
    }
    return false;
  }

  function hasExternalTranslation(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    // 1. 元素本身或其祖先/后代带有第三方翻译插件标记（沉浸式翻译、简约翻译、TWP 等）
    if (el.matches?.(EXTERNAL_TRANSLATION_SELECTOR) || el.closest?.(EXTERNAL_TRANSLATION_SELECTOR)) {
      return true;
    }
    if (el.childElementCount > 0 && el.querySelector(EXTERNAL_TRANSLATION_SELECTOR)) {
      return true;
    }
    // 2. 浏览器内置翻译或第三方插件注入的含中文 <font> 节点
    if (el.childElementCount > 0) {
      const fonts = el.querySelectorAll('font');
      for (const f of fonts) {
        if (countChineseChars(f.textContent || '') >= 2) return true;
      }
    }
    // 3. 紧邻的下一个兄弟节点已是外部插件译文，或页面原生紧跟的中文翻译对照块
    const next = el.nextElementSibling;
    if (next && !isOwnNode(next)) {
      if (next.matches?.(EXTERNAL_TRANSLATION_SELECTOR) || next.querySelector?.(EXTERNAL_TRANSLATION_SELECTOR)) {
        return true;
      }
      const isBlockLike = /^(P|H[1-6]|BLOCKQUOTE|LI|DIV|FIGCAPTION)$/.test(el.tagName);
      const isNextTextBlock = /^(P|DIV|FONT|SPAN|BLOCKQUOTE|FIGCAPTION)$/.test(next.tagName) || next.tagName === el.tagName;
      if (isBlockLike && isNextTextBlock && !computeNodeSelfHidden(next, null)) {
        const nextText = (next.textContent || '').replace(/\s+/g, ' ').trim();
        const elText = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const nextCn = countChineseChars(nextText);
        const nextAlpha = (nextText.match(/[A-Za-z]/g) || []).length;
        if (
          nextCn >= 4 &&
          !/[\u3040-\u30FF]/.test(nextText) &&
          nextCn / Math.max(1, nextCn + nextAlpha) >= 0.55 &&
          elText.length > 0 &&
          nextText.length >= Math.max(4, elText.length * 0.12) &&
          nextText.length <= Math.max(80, elText.length * 2.6)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  const TECHNICAL_NOISE_ONLY_RE =
    /^(?:https?:\/\/\S+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|0x[0-9a-f]+|[0-9a-f]{7,40}|v?\d+(?:\.\d+){1,3}(?:-[a-z0-9.]+)?|\d+(?:\.\d+)?\s*(?:ms|s|us|ns|fps|hz|khz|mhz|ghz|kb|mb|gb|tb|pb|kib|mib|gib|px|em|rem|vw|vh|pt|dpi|p|k|m|b|%)\b|UTC[+-]?\d*(?::\d{2})?|GMT[+-]?\d*|HTTP\s*\d{3}|SHA-?\d+|MD5|CRC32|@[a-z0-9_.-]+)$/i;

  function isForeignTextValid(text) {
    const plain = (text || '')
      .replace(/\[\[\s*\/?(?:C|L|GTERM_)\d*\s*\]\]/gi, '')
      .trim();
    if (plain.length < 2) return false;
    if (TECHNICAL_NOISE_ONLY_RE.test(plain)) return false;
    return (
      /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\uAC00-\uD7AF]/.test(plain) &&
      !isChineseTextSample(plain) &&
      !isAlreadyInlineBilingual(plain)
    );
  }

  /**
   * 严格验证引擎返回的译文是否真正完成翻译，杜绝 HTTP 200 空译文、原文照抄、占位符损坏或错误提示覆盖页面
   */
  function isValidTranslationResult(originalMasked, translatedRaw, placeholders) {
    if (typeof translatedRaw !== 'string') return false;
    const trimmed = translatedRaw.trim();
    if (!trimmed) return false;
    if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID TARGET LANGUAGE|<!DOCTYPE\s+html|<html[\s>]/i.test(trimmed)) {
      return false;
    }
    const restored = restoreGlossaryTerms(trimmed, placeholders);
    if (hasCorruptedPlaceholders(restored)) return false;

    const origPlain = originalMasked.replace(/\[\[\s*\/?(?:C|L|GTERM_)\d*\s*\]\]/gi, '').trim();
    const transPlain = trimmed.replace(/\[\[\s*\/?(?:C|L|GTERM_)\d*\s*\]\]/gi, '').trim();
    if (!transPlain) return false;

    // 原文含非中文外语词汇时，必须检查还原词库占位符之前的原始译文（避免仅靠词库替换就误判引擎已翻译）
    const origHasForeignWords = /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\uAC00-\uD7AF]{2,}/.test(origPlain);
    if (origHasForeignWords) {
      if (transPlain.toLowerCase() === origPlain.toLowerCase()) return false;
      const rawCnCount = countChineseChars(transPlain);
      if (rawCnCount > 0) return true;
      // 若除占位符外几乎无外语实词，允许通过
      if (placeholders && placeholders.length > 0 && origPlain.length <= 2) return true;
      return false;
    }
    return true;
  }

  // ============================================================================
  // 4. 网络层与双引擎翻译核心（并发限制、AbortSignal 取消、请求去重、Google+MS 竞速与局部补齐）
  // ============================================================================
  function createConcurrencyPool(maxConcurrent) {
    let active = 0;
    const queue = [];
    return function run(taskFn, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        const entry = { cancelled: false, exec: null, onAbort: null };
        const cleanupAbort = () => {
          if (signal && entry.onAbort) signal.removeEventListener('abort', entry.onAbort);
        };
        entry.onAbort = () => {
          entry.cancelled = true;
          const idx = queue.indexOf(entry);
          if (idx !== -1) {
            queue.splice(idx, 1);
            cleanupAbort();
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          }
        };
        if (signal) signal.addEventListener('abort', entry.onAbort, { once: true });

        entry.exec = () => {
          if (entry.cancelled || signal?.aborted) {
            cleanupAbort();
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          active++;
          taskFn()
            .then(resolve, reject)
            .finally(() => {
              cleanupAbort();
              active--;
              while (queue.length > 0) {
                const next = queue.shift();
                if (!next.cancelled) {
                  next.exec();
                  break;
                }
              }
            });
        };

        if (active < maxConcurrent) entry.exec();
        else queue.push(entry);
      });
    };
  }

  // 翻译请求与 GitHub 后台 README 探测使用独立并发池，防止探测请求阻塞翻译通道
  const runTransGmPool = createConcurrencyPool(12);
  const runGhDiscoveryPool = createConcurrencyPool(3);

  function rawGmXhr(options, timeoutMs, signal) {
    const poolRunner = options.pool === 'discovery' ? runGhDiscoveryPool : runTransGmPool;
    return poolRunner(
      () =>
        new Promise((resolve, reject) => {
          if (signal?.aborted) {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          let settled = false;
          let gmHandle = null;

          const onAbort = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
              if (gmHandle && typeof gmHandle.abort === 'function') gmHandle.abort();
            } catch (_) {
              // 忽略 abort 异常
            }
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          };

          if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
          }

          const finish = (fn, val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            fn(val);
          };

          const timer = setTimeout(() => {
            if (!settled) {
              try {
                if (gmHandle && typeof gmHandle.abort === 'function') gmHandle.abort();
              } catch (_) {
                // 忽略
              }
              const err = new Error(`Hard timeout (${timeoutMs}ms): ${options.url}`);
              err.isTimeout = true;
              finish(reject, err);
            }
          }, timeoutMs + 500);

          try {
            gmHandle = GM_xmlhttpRequest({
              method: options.method || 'GET',
              url: options.url,
              headers: options.headers || {},
              data: options.data,
              timeout: timeoutMs,
              onload: (res) => {
                if (res.status >= 200 && res.status < 300) {
                  finish(resolve, res.responseText);
                } else {
                  const err = new Error(`HTTP ${res.status}: ${options.url}`);
                  err.status = res.status;
                  finish(reject, err);
                }
              },
              onerror: (err) => finish(reject, new Error(err?.error || `Network error: ${options.url}`)),
              ontimeout: () => {
                const err = new Error(`Timeout: ${options.url}`);
                err.isTimeout = true;
                finish(reject, err);
              },
              onabort: () => {
                const err = new Error('Aborted');
                err.name = 'AbortError';
                finish(reject, err);
              },
            });
          } catch (err) {
            finish(reject, err);
          }
        }),
      signal
    );
  }

  let directFetchBlockedByCsp =
    location.hostname === 'github.com' || location.hostname.endsWith('.github.com');

  async function gmRequest(options) {
    const timeoutMs = options.timeout || REQUEST_TIMEOUT_MS;
    const externalSignal = options.signal || null;
    if (externalSignal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }

    const canTryFetch = options.allowDirectFetch && !directFetchBlockedByCsp && typeof fetch === 'function';
    if (canTryFetch) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const onExtAbort = () => controller?.abort();
      if (externalSignal && controller) {
        externalSignal.addEventListener('abort', onExtAbort, { once: true });
      }
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const res = await fetch(options.url, {
          method: options.method || 'GET',
          headers: options.headers || {},
          body: options.data,
          credentials: 'omit',
          signal: controller ? controller.signal : undefined,
        });
        if (timer) clearTimeout(timer);
        if (externalSignal && controller) externalSignal.removeEventListener('abort', onExtAbort);
        if (res.ok) {
          return await res.text();
        }
        const httpErr = new Error(`HTTP ${res.status}: ${options.url}`);
        httpErr.status = res.status;
        throw httpErr;
      } catch (err) {
        if (timer) clearTimeout(timer);
        if (externalSignal && controller) externalSignal.removeEventListener('abort', onExtAbort);
        if (externalSignal?.aborted) {
          const abortErr = new Error('Aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        if (err && err.name !== 'AbortError' && !err.status) {
          directFetchBlockedByCsp = true;
        }
      }
    }

    return rawGmXhr(options, timeoutMs, externalSignal);
  }

  // --- Google Translate (gtx) ---
  async function requestGoogleTranslateRaw(joinedText, signal) {
    const params = new URLSearchParams({
      client: 'gtx',
      sl: 'auto',
      tl: 'zh-CN',
      dt: 't',
      q: joinedText,
    }).toString();

    const baseUrl = 'https://translate.googleapis.com/translate_a/single';
    const useGet = params.length <= 1500;

    const raw = await gmRequest(
      useGet
        ? {
            method: 'GET',
            url: `${baseUrl}?${params}`,
            headers: { 'Accept': 'application/json, text/plain, */*' },
            allowDirectFetch: true,
            timeout: REQUEST_TIMEOUT_MS,
            signal,
          }
        : {
            method: 'POST',
            url: baseUrl,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'Accept': 'application/json, text/plain, */*',
            },
            data: params,
            allowDirectFetch: true,
            timeout: REQUEST_TIMEOUT_MS,
            signal,
          }
    );

    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      throw new Error('Malformed JSON from Google Translate');
    }
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      throw new Error('Invalid Google Translate response structure');
    }
    return data[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
  }

  async function translateWithGoogleBatch(texts, signal) {
    if (!texts || texts.length === 0) return [];
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (texts.length === 1) {
      const single = await requestGoogleTranslateRaw(texts[0], signal);
      return [single.trim()];
    }

    const sep = '\n<ST9981>\n';
    const joined = texts.join(sep);
    const translatedFull = await requestGoogleTranslateRaw(joined, signal);
    const parts = translatedFull.split(/\n?\s*<\s*ST\s*9981\s*>\s*\n?/i);

    if (parts.length === texts.length) {
      return parts.map((p) => p.trim());
    }

    // 分隔符被破坏时：若微软原生 JSON 数组通道健康则直接 1 次请求接管（零递归开销），否则再二分重试
    if (Date.now() >= msCooldownUntil) {
      try {
        return await translateWithMicrosoftBatch(texts, signal);
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw err;
      }
    }
    const mid = Math.floor(texts.length / 2);
    const [left, right] = await Promise.all([
      translateWithGoogleBatch(texts.slice(0, mid), signal),
      translateWithGoogleBatch(texts.slice(mid), signal),
    ]);
    return left.concat(right);
  }

  // --- Microsoft Edge Translator（直连 + Cognitive v3 JWT 自动刷新双通道）---
  let msAuthToken = null;
  let msAuthExpiry = 0;
  let msAuthPromise = null;

  async function getMicrosoftAuthToken(forceRefresh = false, signal = null) {
    const now = Date.now();
    if (!forceRefresh && msAuthToken && now < msAuthExpiry) {
      return msAuthToken;
    }
    if (!forceRefresh && msAuthPromise) {
      return msAuthPromise;
    }

    msAuthPromise = (async () => {
      try {
        const token = (
          await gmRequest({
            method: 'GET',
            url: 'https://edge.microsoft.com/translate/auth',
            headers: { 'Accept': 'text/plain, */*' },
            allowDirectFetch: true,
            timeout: 5500,
            signal,
          })
        ).trim();
        if (!token || token.length < 20 || token.startsWith('<')) {
          throw new Error('Invalid Microsoft auth token');
        }
        msAuthToken = token;
        msAuthExpiry = Date.now() + 8 * 60 * 1000;
        return token;
      } finally {
        msAuthPromise = null;
      }
    })();

    return msAuthPromise;
  }

  async function translateWithMicrosoftDirect(texts, signal) {
    const raw = await gmRequest({
      method: 'POST',
      url: 'https://edge.microsoft.com/translate/translatetext?from=&to=zh-Hans&isEnterpriseClient=false',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
      },
      data: JSON.stringify(texts),
      allowDirectFetch: true,
      timeout: REQUEST_TIMEOUT_MS,
      signal,
    });

    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      throw new Error('Malformed JSON from Microsoft direct');
    }
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error('Invalid Microsoft direct response');
    }
    return data.map((item) => (typeof item?.translations?.[0]?.text === 'string' ? item.translations[0].text.trim() : ''));
  }

  async function translateWithMicrosoftCognitive(texts, isRetry = false, signal = null) {
    const token = await getMicrosoftAuthToken(isRetry, signal);
    try {
      const payload = texts.map((t) => ({ Text: t }));
      const raw = await gmRequest({
        method: 'POST',
        url: 'https://api-edge.cognitive.microsofttranslator.com/translate?from=&to=zh-Hans&api-version=3.0&includeSentenceLength=true',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        data: JSON.stringify(payload),
        allowDirectFetch: true,
        timeout: REQUEST_TIMEOUT_MS,
        signal,
      });

      let data;
      try {
        data = JSON.parse(raw);
      } catch (_) {
        throw new Error('Malformed JSON from Microsoft cognitive');
      }
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error('Invalid Microsoft cognitive response');
      }
      return data.map((item) => (typeof item?.translations?.[0]?.text === 'string' ? item.translations[0].text.trim() : ''));
    } catch (err) {
      if (!isRetry && !signal?.aborted && (err?.status === 401 || err?.status === 403)) {
        msAuthToken = null;
        msAuthExpiry = 0;
        return translateWithMicrosoftCognitive(texts, true, signal);
      }
      throw err;
    }
  }

  let msDirectCooldownUntil = 0;

  async function translateWithMicrosoftBatch(texts, signal) {
    if (!texts || texts.length === 0) return [];
    if (Date.now() >= msDirectCooldownUntil) {
      try {
        return await translateWithMicrosoftDirect(texts, signal);
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw err;
        msDirectCooldownUntil = Date.now() + 5 * 60 * 1000;
        getMicrosoftAuthToken(false, null).catch(() => {});
      }
    }
    return await translateWithMicrosoftCognitive(texts, false, signal);
  }

  // --- MyMemory 兜底引擎 ---
  async function translateWithMyMemoryBatch(texts, signal) {
    if (!texts || texts.length === 0) return [];
    return Promise.all(
      texts.map(async (text) => {
        if (signal?.aborted) return '';
        try {
          const srcLang = /[\u3040-\u30FF]/.test(text) ? 'ja' : (/[\uAC00-\uD7AF]/.test(text) ? 'ko' : (/[\u0400-\u04FF]/.test(text) ? 'ru' : 'en'));
          const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 480))}&langpair=${srcLang}|zh-CN`;
          const raw = await gmRequest({ url, allowDirectFetch: true, timeout: 5500, signal });
          const data = JSON.parse(raw);
          const trans = data?.responseData?.translatedText;
          if (trans && typeof trans === 'string' && !/MYMEMORY WARNING/i.test(trans)) {
            return trans.trim();
          }
          return '';
        } catch (_) {
          return '';
        }
      })
    );
  }

  const translationCache = new LRUCache(MAX_TRANSLATION_CACHE_SIZE);
  const L2_CACHE_KEY = 'st_l2_trans_cache_v1';
  const L2_CACHE_MAX_ENTRIES = 500;
  let l2SaveTimer = null;

  function hydrateL2Cache() {
    try {
      const raw = window.sessionStorage?.getItem(L2_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const pair of parsed) {
          if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
            translationCache.set(pair[0], pair[1]);
          }
        }
      }
    } catch (_) {
      // 忽略私密模式或沙箱 sessionStorage 限制
    }
  }

  function scheduleL2CacheSave() {
    if (l2SaveTimer) return;
    l2SaveTimer = setTimeout(() => {
      l2SaveTimer = null;
      const write = () => {
        try {
          if (!window.sessionStorage) return;
          const entries = Array.from(translationCache.map.entries()).slice(-L2_CACHE_MAX_ENTRIES);
          // 仅持久化单条 <= 400 字的短/中段文本，防止撑爆 sessionStorage 配额
          const compact = entries.filter(([k, v]) => k.length <= 420 && v.length <= 420);
          window.sessionStorage.setItem(L2_CACHE_KEY, JSON.stringify(compact));
        } catch (_) {}
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(write, { timeout: 2000 });
      else write();
    }, 1000);
  }

  function clearAllTranslationCaches() {
    translationCache.clear();
    try { window.sessionStorage?.removeItem(L2_CACHE_KEY); } catch (_) {}
    clearL3Cache();
  }

  const L3_IDB_NAME = 'SmartTranslatorCacheDB_v1';
  const L3_STORE_NAME = 'translations';
  const L3_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  let l3DbPromise = null;
  const l3PendingWrites = new Map();
  let l3FlushTimer = null;

  function openL3Db() {
    if (l3DbPromise) return l3DbPromise;
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    l3DbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(L3_IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(L3_STORE_NAME)) {
            db.createObjectStore(L3_STORE_NAME, { keyPath: 'k' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
    return l3DbPromise;
  }

  function hydrateL3Cache() {
    openL3Db().then((db) => {
      if (!db) return;
      try {
        const tx = db.transaction(L3_STORE_NAME, 'readonly');
        const store = tx.objectStore(L3_STORE_NAME);
        const now = Date.now();
        let count = 0;
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || count >= 2000) return;
          const rec = cursor.value;
          if (rec && rec.k && rec.v && (!rec.t || now - rec.t < L3_TTL_MS)) {
            if (!translationCache.has(rec.k)) {
              translationCache.set(rec.k, rec.v);
            }
            count++;
          }
          cursor.continue();
        };
      } catch (_) {}
    });
  }

  function queueL3Write(key, val) {
    if (!key || !val || key.length > 600 || val.length > 600) return;
    l3PendingWrites.set(key, val);
    if (l3FlushTimer) return;
    l3FlushTimer = setTimeout(() => {
      l3FlushTimer = null;
      const batch = Array.from(l3PendingWrites.entries());
      l3PendingWrites.clear();
      if (batch.length === 0) return;
      openL3Db().then((db) => {
        if (!db) return;
        try {
          const tx = db.transaction(L3_STORE_NAME, 'readwrite');
          const store = tx.objectStore(L3_STORE_NAME);
          const now = Date.now();
          for (const [k, v] of batch) {
            store.put({ k, v, t: now });
          }
        } catch (_) {}
      });
    }, 1500);
  }

  function clearL3Cache() {
    l3PendingWrites.clear();
    openL3Db().then((db) => {
      if (!db) return;
      try {
        const tx = db.transaction(L3_STORE_NAME, 'readwrite');
        tx.objectStore(L3_STORE_NAME).clear();
      } catch (_) {}
    });
  }

  hydrateL2Cache();
  hydrateL3Cache();
  // 进行中文本去重：相同文本在不同组件同时请求时复用同一个 Promise
  const inFlightTextPromises = new Map();

  let googleFailCount = 0;
  let googleCooldownUntil = 0;
  let msFailCount = 0;
  let msCooldownUntil = 0;
  let googleEmaMs = 0;
  let msEmaMs = 0;
  let adaptiveBatchCounter = 0;

  function makeCacheKey(text) {
    return `${glossaryVersion}::${text}`;
  }

  /**
   * Google + Microsoft 双引擎并行竞速 + 响应质量校验 + 局部未译条目另一引擎补齐 + MyMemory 兜底
   */
  async function translateBatchCore(pendingMasked, pendingPlaceholders, signal) {
    const count = pendingMasked.length;
    const accepted = new Array(count).fill(null);

    // 判断条目是否为需要强行跨引擎补齐的长外语句子（单个品牌词/专有名词如 "Discord" / "FAQ" 不应阻塞整批等待兜底）
    const needsCrossEngineRepair = (masked) => {
      const plain = masked.replace(/(?:\[|【)\s*(?:\[|【)\s*(?:C|L|\/[\s]*L|GTERM_?)\s*\d*\s*(?:\]|】)\s*(?:\]|】)/gi, '').trim();
      const words = plain.split(/\s+/).filter(Boolean);
      return words.length >= 2 || plain.length >= 14;
    };

    let anyEngineSucceeded = false;
    const rawFallbackValues = new Array(count).fill(null);
    const acceptedScores = new Array(count).fill(-1);

    const finalizeCandidate = (idx, raw) => {
      const restored = restoreGlossaryTerms(raw.trim(), pendingPlaceholders[idx]);
      return polishChineseTypography(preserveLeadingEmoji(pendingMasked[idx], restored), pendingMasked[idx]);
    };

    const mergeValid = (candidateArr) => {
      if (!Array.isArray(candidateArr) || candidateArr.length !== count) return 0;
      anyEngineSucceeded = true;
      let filled = 0;
      for (let i = 0; i < count; i++) {
        const raw = candidateArr[i];
        if (typeof raw === 'string' && raw.trim() && !hasCorruptedPlaceholders(restoreGlossaryTerms(raw.trim(), pendingPlaceholders[i]))) {
          if (rawFallbackValues[i] === null) {
            rawFallbackValues[i] = finalizeCandidate(i, raw);
          }
        }
        if (isValidTranslationResult(pendingMasked[i], raw, pendingPlaceholders[i])) {
          const candidate = finalizeCandidate(i, raw);
          const qScore = scoreTranslationQuality(pendingMasked[i], candidate);
          if (accepted[i] === null || qScore > acceptedScores[i]) {
            accepted[i] = candidate;
            acceptedScores[i] = qScore;
            filled++;
          }
        }
      }
      return filled;
    };

    // 高质量快速完成判定：若第一引擎质量分 >= 75 则立刻返回（零等待）；低分/幻觉/残缺项自动等另一引擎择优替换
    const isComplete = () =>
      accepted.every(
        (v, i) =>
          (v !== null && acceptedScores[i] >= 75) ||
          (anyEngineSucceeded && !needsCrossEngineRepair(pendingMasked[i]))
      );

    const now = Date.now();
    const canGoogle = now >= googleCooldownUntil;
    const canMs = now >= msCooldownUntil;

    const updateEma = (cur, sample) => (cur === 0 ? sample : cur * 0.7 + sample * 0.3);

    const runGoogle = (subTexts) => {
      const t0 = Date.now();
      return translateWithGoogleBatch(subTexts, signal).then(
        (data) => {
          googleFailCount = 0;
          googleEmaMs = updateEma(googleEmaMs, Math.max(10, Date.now() - t0));
          return data;
        },
        (err) => {
          if (err?.name !== 'AbortError') {
            if (err?.status === 429) {
              googleCooldownUntil = Date.now() + 60 * 1000;
            } else {
              googleFailCount++;
              if (googleFailCount >= 2) googleCooldownUntil = Date.now() + 30 * 1000;
            }
          }
          throw err;
        }
      );
    };

    const runMs = (subTexts) => {
      const t0 = Date.now();
      return translateWithMicrosoftBatch(subTexts, signal).then(
        (data) => {
          msFailCount = 0;
          msEmaMs = updateEma(msEmaMs, Math.max(10, Date.now() - t0));
          return data;
        },
        (err) => {
          if (err?.name !== 'AbortError') {
            if (err?.status === 429) {
              msCooldownUntil = Date.now() + 60 * 1000;
            } else {
              msFailCount++;
              if (msFailCount >= 2) msCooldownUntil = Date.now() + 30 * 1000;
            }
          }
          throw err;
        }
      );
    };

    adaptiveBatchCounter++;
    const shouldProbeBoth =
      adaptiveBatchCounter <= 1 ||
      adaptiveBatchCounter % 20 === 0 ||
      (googleEmaMs === 0 && msEmaMs === 0);

    if (canGoogle && canMs && shouldProbeBoth) {
      // 冷启动与周期探测：双引擎真竞速，自动测出当前网络环境的最优引擎
      const pGoogle = runGoogle(pendingMasked).then(
        (res) => ({ engine: 'google', ok: true, res }),
        (err) => ({ engine: 'google', ok: false, err })
      );
      const pMs = runMs(pendingMasked).then(
        (res) => ({ engine: 'ms', ok: true, res }),
        (err) => ({ engine: 'ms', ok: false, err })
      );

      const first = await Promise.race([pGoogle, pMs]);
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }

      if (first.ok) {
        mergeValid(first.res);
      }
      if (!isComplete()) {
        const second = first.engine === 'google' ? await pMs : await pGoogle;
        if (signal?.aborted) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        }
        if (second.ok) {
          mergeValid(second.res);
        }
      }
    } else if (canGoogle && canMs) {
      // 自适应主选 + 对冲容灾（Hedged Request）：优先单发更快引擎省 50% 请求，超时或质量不足时自动起用备选引擎补齐
      const hasAngleBrackets = pendingMasked.length > 1 && pendingMasked.some((t) => /<[A-Za-z/]/.test(t));
      const preferGoogle = !hasAngleBrackets && googleEmaMs > 0 && (msEmaMs === 0 || googleEmaMs <= msEmaMs * 1.15);
      const primaryFn = preferGoogle ? runGoogle : runMs;
      const backupFn = preferGoogle ? runMs : runGoogle;
      const primaryEma = preferGoogle ? googleEmaMs : msEmaMs;
      const hedgeDelayMs = Math.min(1800, Math.max(450, Math.round((primaryEma || 300) * 2.2)));

      let backupPromise = null;
      const startBackup = (subTexts) => {
        if (!backupPromise) {
          backupPromise = backupFn(subTexts).then(
            (res) => ({ ok: true, res }),
            (err) => ({ ok: false, err })
          );
        }
        return backupPromise;
      };

      const hedgeTimer = setTimeout(() => {
        if (!signal?.aborted) startBackup(pendingMasked);
      }, hedgeDelayMs);

      try {
        const res1 = await primaryFn(pendingMasked);
        clearTimeout(hedgeTimer);
        if (signal?.aborted) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        }
        mergeValid(res1);
      } catch (err) {
        clearTimeout(hedgeTimer);
        if (signal?.aborted || err?.name === 'AbortError') throw err;
      }

      if (!isComplete() && !signal?.aborted) {
        if (backupPromise) {
          const bRes = await backupPromise;
          if (bRes.ok) mergeValid(bRes.res);
        } else {
          // 仅把缺失/低质量条目发给备选引擎补齐
          const missingIdx = [];
          const missingTexts = [];
          for (let i = 0; i < count; i++) {
            if (accepted[i] === null || (acceptedScores[i] < 75 && needsCrossEngineRepair(pendingMasked[i]))) {
              missingIdx.push(i);
              missingTexts.push(pendingMasked[i]);
            }
          }
          if (missingTexts.length > 0) {
            try {
              const res2 = await backupFn(missingTexts);
              for (let k = 0; k < missingIdx.length; k++) {
                const origIdx = missingIdx[k];
                const raw = res2[k];
                if (isValidTranslationResult(pendingMasked[origIdx], raw, pendingPlaceholders[origIdx])) {
                  const cand = finalizeCandidate(origIdx, raw);
                  const qScore = scoreTranslationQuality(pendingMasked[origIdx], cand);
                  if (accepted[origIdx] === null || qScore > acceptedScores[origIdx]) {
                    accepted[origIdx] = cand;
                    acceptedScores[origIdx] = qScore;
                  }
                }
              }
            } catch (err) {
              if (signal?.aborted || err?.name === 'AbortError') throw err;
            }
          }
        }
      }
    } else {
      const primary = canGoogle ? runGoogle : runMs;
      const secondary = canGoogle ? runMs : runGoogle;

      try {
        const res1 = await primary(pendingMasked);
        mergeValid(res1);
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw err;
      }

      if (!isComplete() && !signal?.aborted) {
        const missingIdx = [];
        const missingTexts = [];
        for (let i = 0; i < count; i++) {
          if (accepted[i] === null) {
            missingIdx.push(i);
            missingTexts.push(pendingMasked[i]);
          }
        }
        try {
          const res2 = await secondary(missingTexts);
          for (let k = 0; k < missingIdx.length; k++) {
            const origIdx = missingIdx[k];
            const raw = res2[k];
            if (isValidTranslationResult(pendingMasked[origIdx], raw, pendingPlaceholders[origIdx])) {
              accepted[origIdx] = preserveLeadingEmoji(pendingMasked[origIdx], restoreGlossaryTerms(raw.trim(), pendingPlaceholders[origIdx]));
            }
          }
        } catch (err) {
          if (signal?.aborted || err?.name === 'AbortError') throw err;
        }
      }
    }

    // 仅当双引擎均异常失败，或长句在双引擎下仍未译出时才调用 MyMemory 兜底（绝不为品牌词/专有名词浪费 5 秒）
    if (!isComplete() && !signal?.aborted) {
      const missingIdx = [];
      const missingTexts = [];
      for (let i = 0; i < count; i++) {
        if (accepted[i] === null && (!anyEngineSucceeded || needsCrossEngineRepair(pendingMasked[i]))) {
          missingIdx.push(i);
          missingTexts.push(pendingMasked[i]);
        }
      }
      if (missingTexts.length > 0) {
        const fallbackRes = await translateWithMyMemoryBatch(missingTexts, signal);
        for (let k = 0; k < missingIdx.length; k++) {
          const origIdx = missingIdx[k];
          const raw = fallbackRes[k];
          if (isValidTranslationResult(pendingMasked[origIdx], raw, pendingPlaceholders[origIdx])) {
            accepted[origIdx] = preserveLeadingEmoji(pendingMasked[origIdx], restoreGlossaryTerms(raw.trim(), pendingPlaceholders[origIdx]));
          }
        }
      }
    }

    // 对主引擎确认无中文对应词的短专有名词，回填词库还原后的安全值
    for (let i = 0; i < count; i++) {
      if (accepted[i] === null && !needsCrossEngineRepair(pendingMasked[i]) && rawFallbackValues[i] !== null) {
        accepted[i] = rawFallbackValues[i];
      }
    }

    return accepted;
  }

  async function translateBatchWithFallback(texts, signal) {
    const results = new Array(texts.length).fill(null);
    const awaitingInFlight = [];
    const newUniqueKeys = new Map(); // cacheKey -> { text, indices: [], maskedText, placeholders, resolve, reject }

    for (let i = 0; i < texts.length; i++) {
      const original = texts[i];
      const sanitized = typeof original === 'string' ? original.replace(/\u0000/g, '') : '';
      if (!sanitized || !sanitized.trim()) {
        results[i] = original;
        continue;
      }

      const key = makeCacheKey(sanitized);
      if (translationCache.has(key)) {
        results[i] = translationCache.get(key);
        continue;
      }

      if (inFlightTextPromises.has(key)) {
        awaitingInFlight.push({
          index: i,
          promise: inFlightTextPromises.get(key),
        });
        continue;
      }

      if (newUniqueKeys.has(key)) {
        newUniqueKeys.get(key).indices.push(i);
        continue;
      }

      const { maskedText, placeholders } = protectGlossaryTerms(sanitized);
      let resolveFn, rejectFn;
      const sharedPromise = new Promise((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
      inFlightTextPromises.set(key, sharedPromise);
      newUniqueKeys.set(key, {
        key,
        text: sanitized,
        indices: [i],
        maskedText,
        placeholders,
        resolve: resolveFn,
        reject: rejectFn,
      });
    }

    const uniqueEntries = Array.from(newUniqueKeys.values());

    if (uniqueEntries.length > 0) {
      const pendingMasked = uniqueEntries.map((e) => e.maskedText);
      const pendingPlaceholders = uniqueEntries.map((e) => e.placeholders);

      try {
        const translatedArr = await translateBatchCore(pendingMasked, pendingPlaceholders, signal);
        for (let j = 0; j < uniqueEntries.length; j++) {
          const entry = uniqueEntries[j];
          const val = translatedArr[j]; // null 表示翻译失败
          if (val !== null) {
            translationCache.set(entry.key, val);
            scheduleL2CacheSave();
            queueL3Write(entry.key, val);
          }
          for (const idx of entry.indices) {
            results[idx] = val;
          }
          inFlightTextPromises.delete(entry.key);
          entry.resolve(val);
        }
      } catch (err) {
        for (const entry of uniqueEntries) {
          inFlightTextPromises.delete(entry.key);
          entry.resolve(null);
        }
        if (err?.name === 'AbortError') throw err;
      }
    }

    if (awaitingInFlight.length > 0) {
      const resolved = await Promise.all(awaitingInFlight.map((item) => item.promise.catch(() => null)));
      const retryIndices = [];
      const retryTexts = [];
      for (let k = 0; k < awaitingInFlight.length; k++) {
        const idx = awaitingInFlight[k].index;
        if (resolved[k] !== null) {
          results[idx] = resolved[k];
        } else if (!signal?.aborted) {
          retryIndices.push(idx);
          retryTexts.push(texts[idx]);
        }
      }
      if (retryTexts.length > 0 && !signal?.aborted) {
        try {
          const retried = await translateBatchWithFallback(retryTexts, signal);
          for (let r = 0; r < retryIndices.length; r++) {
            results[retryIndices[r]] = retried[r];
          }
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
        }
      }
    }

    return results;
  }

  /**
   * 智能安全截断：当单条文本超过 MAX_SINGLE_ITEM_CHARS 时，按段落 -> 句末标点 -> 分句标点 -> 空格切分，
   * 绝不在 [[C0]] / [[L0]]...[[/L0]] 占位符中间断开，防止 Google/Microsoft 翻译接口因超长报错。
   */
  function splitLongTextSafely(text, maxLen = MAX_SINGLE_ITEM_CHARS) {
    if (!text || text.length <= maxLen) return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > maxLen) {
      let cut = -1;
      const slice = rest.slice(0, maxLen);
      // 1. 优先按段落换行或真正句末标点切分（自动避开 e.g. / i.e. / vs. / Dr. / Mr. / etc. 等英文缩写）
      const paraBreak = slice.lastIndexOf('\n\n');
      if (paraBreak >= Math.floor(maxLen * 0.4)) {
        cut = paraBreak + 2;
      }
      if (cut === -1) {
        const boundaryRe = /[.!?。！？](?:\s+|$)/g;
        let lastGoodEnd = -1;
        let bm;
        while ((bm = boundaryRe.exec(slice)) !== null) {
          const endPos = bm.index + bm[0].length;
          const prefix = slice.slice(Math.max(0, bm.index - 8), bm.index + 1);
          if (/(?:^|\s)(?:e\.g\.|i\.e\.|vs\.|etc\.|dr\.|mr\.|mrs\.|ms\.|prof\.|inc\.|ltd\.|fig\.|no\.)$/i.test(prefix)) {
            continue;
          }
          lastGoodEnd = endPos;
        }
        if (lastGoodEnd >= Math.floor(maxLen * 0.4)) {
          cut = lastGoodEnd;
        }
      }
      // 2. 次选按逗号/分号切分
      if (cut === -1) {
        const clauseIdx = Math.max(slice.lastIndexOf(', '), slice.lastIndexOf('; '), slice.lastIndexOf('，'), slice.lastIndexOf('；'));
        if (clauseIdx >= Math.floor(maxLen * 0.45)) cut = clauseIdx + 1;
      }
      // 3. 再按空格切分
      if (cut === -1) {
        const spIdx = slice.lastIndexOf(' ');
        cut = spIdx >= Math.floor(maxLen * 0.3) ? spIdx + 1 : maxLen;
      }
      // 防止切在 [[L0]] / [[C0]] 占位符内部
      const openTok = rest.lastIndexOf('[[', cut);
      const closeTok = rest.indexOf(']]', openTok);
      if (openTok !== -1 && openTok < cut && closeTok !== -1 && closeTok + 2 > cut) {
        cut = openTok > 0 ? openTok : closeTok + 2;
      }
      const part = rest.slice(0, cut).trim();
      if (part) chunks.push(part);
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  async function translateMany(texts, onItemDone, shouldAbort, signal) {
    const batches = [];
    let current = [];
    let currentChars = 0;
    const chunkedAssemblers = new Map(); // origIndex -> { parts: [], remaining: N, origClean }

    const pushToBatch = (itemObj) => {
      const isFirstBatch = batches.length === 0;
      const maxItems = isFirstBatch ? 10 : 45;
      const maxChars = isFirstBatch ? 1100 : 5200;
      const len = itemObj.text.length;
      if (current.length > 0 && (current.length >= maxItems || currentChars + len > maxChars)) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(itemObj);
      currentChars += len;
    };

    for (let index = 0; index < texts.length; index++) {
      const text = texts[index];
      const clean = typeof text === 'string' ? text.replace(/\u0000/g, '') : '';
      if (!clean || !clean.trim()) {
        onItemDone(index, null);
        continue;
      }
      // 0ms 精准高频 UI 词表直译（零网络延迟、杜绝无上下文误译）
      const uiExact = lookupExactUiTerm(clean);
      if (uiExact) {
        onItemDone(index, uiExact);
        continue;
      }
      // 命中缓存直接回调，不进入网络队列
      const key = makeCacheKey(clean);
      if (translationCache.has(key)) {
        onItemDone(index, translationCache.get(key));
        continue;
      }
      // 超长单条文本自动按句界智能截断，分片并发翻译后无缝拼回
      if (clean.length > MAX_SINGLE_ITEM_CHARS) {
        const parts = splitLongTextSafely(clean, MAX_SINGLE_ITEM_CHARS);
        if (parts.length > 1) {
          chunkedAssemblers.set(index, { parts: new Array(parts.length).fill(''), remaining: parts.length, origClean: clean });
          parts.forEach((pText, partIdx) => {
            pushToBatch({ text: pText, index, chunkPartIdx: partIdx });
          });
          continue;
        }
      }
      pushToBatch({ text: clean, index, chunkPartIdx: -1 });
    }


    if (current.length > 0) batches.push(current);
    if (batches.length === 0) return;

    const CONCURRENCY = 6;
    let cursor = 0;
    async function worker() {
      while (cursor < batches.length) {
        if ((shouldAbort && shouldAbort()) || signal?.aborted) return;
        const batch = batches[cursor++];
        try {
          const translated = await translateBatchWithFallback(
            batch.map((b) => b.text),
            signal
          );
          if ((shouldAbort && shouldAbort()) || signal?.aborted) return;
          for (let i = 0; i < batch.length; i++) {
            const bItem = batch[i];
            if (bItem.chunkPartIdx >= 0) {
              const asm = chunkedAssemblers.get(bItem.index);
              if (!asm) continue;
              asm.parts[bItem.chunkPartIdx] = translated[i] || bItem.text;
              asm.remaining--;
              if (asm.remaining <= 0) {
                const joined = asm.parts.join(' ').trim();
                if (joined) translationCache.set(makeCacheKey(asm.origClean), joined);
                chunkedAssemblers.delete(bItem.index);
                onItemDone(bItem.index, joined);
              }
            } else {
              onItemDone(bItem.index, translated[i]);
            }
          }
        } catch (err) {
          if (err?.name !== 'AbortError') {
            console.warn('[SmartTranslator] Batch failed:', err);
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  }

  // ============================================================================
  // 5. Dark 交互式特殊词库配置弹窗（严格保留原 UI 与交互逻辑）
  // ============================================================================
  const MODAL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(5, 8, 15, 0.72);
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
    }
    .panel {
      width: min(620px, 94vw);
      max-height: 86vh;
      background: #111318;
      color: #e4e4e7;
      border: 1px solid #272a34;
      border-radius: 10px;
      box-shadow: 0 24px 56px rgba(0, 0, 0, 0.55);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px;
      border-bottom: 1px solid #232630;
      background: #151820;
    }
    .title {
      font-size: 15px;
      font-weight: 600;
      color: #f4f4f5;
      margin: 0;
    }
    .icon-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #9ca3af;
      cursor: pointer;
    }
    .icon-close:hover { background: #232734; color: #f4f4f5; }
    .tabs-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 18px 0;
      border-bottom: 1px solid #232630;
      background: #111318;
    }
    .tabs { display: flex; gap: 4px; }
    .tab-btn {
      border: none;
      background: transparent;
      color: #94a3b8;
      font-size: 13px;
      font-weight: 500;
      padding: 8px 12px;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .tab-btn:hover { color: #e2e8f0; }
    .tab-btn.active { color: #60a5fa; border-bottom-color: #2563eb; }
    .count-badge {
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 999px;
      background: #1e222d;
      color: #94a3b8;
    }
    .tab-btn.active .count-badge {
      background: rgba(37, 99, 235, 0.2);
      color: #93c5fd;
    }
    .search-wrap {
      position: relative;
      margin-bottom: 8px;
      width: 190px;
    }
    .search-wrap svg {
      position: absolute;
      left: 9px;
      top: 50%;
      transform: translateY(-50%);
      color: #64748b;
      pointer-events: none;
    }
    .search-input {
      width: 100%;
      padding: 5px 10px 5px 28px;
      border-radius: 6px;
      border: 1px solid #272b36;
      background: #181b23;
      color: #e4e4e7;
      font-size: 12px;
      outline: none;
    }
    .search-input:focus { border-color: #2563eb; }
    .add-bar {
      display: flex;
      gap: 8px;
      padding: 12px 18px;
      background: #14171f;
      border-bottom: 1px solid #232630;
    }
    .add-input {
      flex: 1;
      padding: 7px 10px;
      border-radius: 6px;
      border: 1px solid #2b303c;
      background: #0d0f14;
      color: #f4f4f5;
      font-size: 13px;
      outline: none;
    }
    .add-input:focus { border-color: #2563eb; }
    .add-input::placeholder { color: #64748b; }
    .btn {
      padding: 7px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid #2e3340;
      background: #1c202a;
      color: #e2e8f0;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .btn:hover { background: #262b38; }
    .btn.primary { background: #2563eb; border-color: #2563eb; color: #ffffff; }
    .btn.primary:hover { background: #1d4ed8; }
    .btn.danger-text { color: #f87171; }
    .btn.danger-text:hover { background: rgba(239, 68, 68, 0.14); border-color: rgba(239, 68, 68, 0.35); }
    .body-list {
      padding: 14px 18px;
      overflow-y: auto;
      flex: 1;
      min-height: 220px;
      max-height: 360px;
    }
    .chips-grid { display: flex; flex-wrap: wrap; gap: 8px; }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px 5px 10px;
      background: #1b1f2a;
      border: 1px solid #2c3140;
      border-radius: 6px;
      font-size: 12px;
      color: #e2e8f0;
    }
    .chip:hover { border-color: #3b4254; }
    .chip-del {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: transparent;
      color: #94a3b8;
      cursor: pointer;
      padding: 2px;
      border-radius: 4px;
    }
    .chip-del:hover { color: #f87171; background: rgba(239, 68, 68, 0.15); }
    .replace-list { display: flex; flex-direction: column; gap: 6px; }
    .replace-row {
      display: grid;
      grid-template-columns: 1fr auto 1fr auto;
      align-items: center;
      gap: 10px;
      padding: 7px 10px;
      background: #171a23;
      border: 1px solid #262a36;
      border-radius: 6px;
      font-size: 13px;
    }
    .replace-row:hover { border-color: #373d4e; }
    .replace-src {
      color: #93c5fd;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .replace-dst {
      color: #e4e4e7;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .arrow { color: #64748b; display: inline-flex; }
    .empty-hint { text-align: center; color: #64748b; font-size: 12px; padding: 36px 0; }
    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 18px;
      border-top: 1px solid #232630;
      background: #151820;
    }
    .footer-right { display: flex; gap: 8px; }
    .status-tip { font-size: 12px; color: #94a3b8; }
  `;

  function applyShadowStyles(shadow, cssText) {
    try {
      const style = document.createElement('style');
      style.textContent = cssText;
      shadow.appendChild(style);
      if (style.sheet) return;
    } catch (_) {
      // 回退到 adoptedStyleSheets
    }
    if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet === 'function') {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(cssText);
        shadow.adoptedStyleSheets = [...(shadow.adoptedStyleSheets || []), sheet];
      } catch (_) {
        // 忽略
      }
    }
  }

  function createSvgIcon(size, paths, strokeWidth = '2') {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', String(strokeWidth));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const def of paths) {
      const node = document.createElementNS(ns, def.tag);
      for (const [k, v] of Object.entries(def.attrs)) {
        node.setAttribute(k, String(v));
      }
      svg.appendChild(node);
    }
    return svg;
  }

  function createDomEl(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') el.className = v;
      else if (k === 'textContent') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v);
    }
    for (const child of children) {
      if (child != null) el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
  }

  function openGlossaryModal() {
    const existing = document.getElementById('st-glossary-modal-host');
    if (existing) existing.remove();

    const host = document.createElement('div');
    host.id = 'st-glossary-modal-host';
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('inset', '0', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('display', 'block', 'important');
    host.style.setProperty('pointer-events', 'auto', 'important');

    const shadow = host.attachShadow({ mode: 'open' });
    applyShadowStyles(shadow, MODAL_CSS);

    const draft = loadGlossary();
    let keepList = [...(draft.keep || [])];
    let replaceMap = { ...(draft.replace || {}) };
    let blockedList = loadBlockedSites();
    let activeTab = 'keep';
    let searchQuery = '';

    const closeBtn = createDomEl('button', { className: 'icon-close', id: 'btn-x', title: '关闭', type: 'button' }, [
      createSvgIcon(15, [{ tag: 'path', attrs: { d: 'M18 6 6 18M6 6l12 12' } }]),
    ]);
    const header = createDomEl('div', { className: 'header' }, [
      createDomEl('h3', { className: 'title', textContent: '特殊词库管理' }),
      closeBtn,
    ]);

    const keepCountEl = createDomEl('span', { className: 'count-badge', id: 'keep-count', textContent: '0' });
    const replaceCountEl = createDomEl('span', { className: 'count-badge', id: 'replace-count', textContent: '0' });
    const blockedCountEl = createDomEl('span', { className: 'count-badge', id: 'blocked-count', textContent: '0' });
    const tabKeepBtn = createDomEl('button', { className: 'tab-btn active', type: 'button', dataset: { tab: 'keep' } }, [
      '保留原词 ',
      keepCountEl,
    ]);
    const tabReplaceBtn = createDomEl('button', { className: 'tab-btn', type: 'button', dataset: { tab: 'replace' } }, [
      '特殊译法 ',
      replaceCountEl,
    ]);
    const tabBlockedBtn = createDomEl('button', { className: 'tab-btn', type: 'button', dataset: { tab: 'blocked' } }, [
      '屏蔽网站 ',
      blockedCountEl,
    ]);
    const searchInput = createDomEl('input', {
      className: 'search-input',
      id: 'search-input',
      type: 'text',
      placeholder: '搜索词条...',
    });
    const searchWrap = createDomEl('div', { className: 'search-wrap' }, [
      createSvgIcon(13, [
        { tag: 'circle', attrs: { cx: '11', cy: '11', r: '8' } },
        { tag: 'path', attrs: { d: 'm21 21-4.3-4.3' } },
      ]),
      searchInput,
    ]);
    const tabsRow = createDomEl('div', { className: 'tabs-row' }, [
      createDomEl('div', { className: 'tabs' }, [tabKeepBtn, tabReplaceBtn, tabBlockedBtn]),
      searchWrap,
    ]);

    const addBar = createDomEl('div', { className: 'add-bar', id: 'add-bar' });
    const bodyList = createDomEl('div', { className: 'body-list', id: 'body-list' });
    const resetBtn = createDomEl('button', { className: 'btn danger-text', id: 'reset-btn', type: 'button', textContent: '恢复默认' });
    const importBtn = createDomEl('button', { className: 'btn', id: 'import-btn', type: 'button', textContent: '导入 JSON' });
    const exportBtn = createDomEl('button', { className: 'btn', id: 'export-btn', type: 'button', textContent: '导出 JSON' });
    const fileInput = createDomEl('input', { type: 'file', accept: '.json,application/json', id: 'glossary-file-input' });
    fileInput.style.display = 'none';
    const statusTip = createDomEl('span', { className: 'status-tip', id: 'status-tip' });
    const cancelBtn = createDomEl('button', { className: 'btn', id: 'cancel-btn', type: 'button', textContent: '取消' });
    const saveBtn = createDomEl('button', { className: 'btn primary', id: 'save-btn', type: 'button', textContent: '保存并应用' });
    const footer = createDomEl('div', { className: 'footer' }, [
      createDomEl('div', { className: 'footer-right' }, [resetBtn, importBtn, exportBtn, fileInput]),
      statusTip,
      createDomEl('div', { className: 'footer-right' }, [cancelBtn, saveBtn]),
    ]);

    const panel = createDomEl('div', { className: 'panel' }, [header, tabsRow, addBar, bodyList, footer]);
    const backdrop = createDomEl('div', { className: 'backdrop' }, [panel]);
    shadow.appendChild(backdrop);

    const mountRoot = document.fullscreenElement || document.body || document.documentElement;
    mountRoot.appendChild(host);

    function setTip(msg) {
      statusTip.textContent = msg;
      if (msg) setTimeout(() => { if (statusTip.textContent === msg) statusTip.textContent = ''; }, 2200);
    }

    function renderAddBar() {
      addBar.replaceChildren();
      if (activeTab === 'keep') {
        const input = createDomEl('input', {
          className: 'add-input',
          id: 'keep-add-input',
          type: 'text',
          placeholder: '输入保留英文词（支持逗号分隔批量添加，如 Claude, Token）',
        });
        const addBtn = createDomEl('button', { className: 'btn primary', id: 'keep-add-btn', type: 'button', textContent: '添加' });
        const addFn = () => {
          const items = input.value
            .split(/[,，\n]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (items.length === 0) return;
          let added = 0;
          for (const item of items) {
            if (!keepList.some((k) => k.toLowerCase() === item.toLowerCase())) {
              keepList.unshift(item);
              added++;
            }
          }
          input.value = '';
          setTip(added > 0 ? `已添加 ${added} 个保留词` : '词条已存在');
          renderList();
        };
        addBtn.addEventListener('click', addFn);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addFn(); });
        addBar.append(input, addBtn);
      } else if (activeTab === 'blocked') {
        const curHost = (location.hostname || '').toLowerCase();
        const hostInput = createDomEl('input', {
          className: 'add-input',
          id: 'blocked-add-input',
          type: 'text',
          placeholder: '输入屏蔽域名或通配符（如 example.com, *.corp.local）',
        });
        const addBtn = createDomEl('button', { className: 'btn primary', id: 'blocked-add-btn', type: 'button', textContent: '添加' });
        const blockCurBtn = createDomEl('button', { className: 'btn', id: 'blocked-cur-btn', type: 'button', textContent: '屏蔽当前网站' });
        const addHostFn = (val) => {
          const items = String(val || '').split(/[,，\n]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
          if (items.length === 0) return;
          let added = 0;
          for (const item of items) {
            if (!blockedList.includes(item)) {
              blockedList.unshift(item);
              added++;
            }
          }
          hostInput.value = '';
          setTip(added > 0 ? `已添加 ${added} 个屏蔽域名` : '域名已在屏蔽列表中');
          renderList();
        };
        addBtn.addEventListener('click', () => addHostFn(hostInput.value));
        hostInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addHostFn(hostInput.value); });
        blockCurBtn.addEventListener('click', () => { if (curHost) addHostFn(curHost); });
        addBar.append(hostInput, addBtn, blockCurBtn);
      } else {
        const srcInput = createDomEl('input', {
          className: 'add-input',
          id: 'rep-src-input',
          type: 'text',
          placeholder: '英文原词（如 Prompt）',
        });
        const dstInput = createDomEl('input', {
          className: 'add-input',
          id: 'rep-dst-input',
          type: 'text',
          placeholder: '中文译法（如 提示词）',
        });
        const addBtn = createDomEl('button', { className: 'btn primary', id: 'rep-add-btn', type: 'button', textContent: '添加 / 更新' });
        const addFn = () => {
          const src = srcInput.value.trim();
          const dst = dstInput.value.trim();
          if (!src || !dst) return;
          replaceMap[src] = dst;
          srcInput.value = '';
          dstInput.value = '';
          setTip(`已更新 ${src} -> ${dst}`);
          renderList();
        };
        addBtn.addEventListener('click', addFn);
        dstInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addFn(); });
        addBar.append(srcInput, dstInput, addBtn);
      }
    }

    function renderList() {
      keepCountEl.textContent = String(keepList.length);
      replaceCountEl.textContent = String(Object.keys(replaceMap).length);
      blockedCountEl.textContent = String(blockedList.length);
      const q = searchQuery.trim().toLowerCase();
      bodyList.replaceChildren();

      if (activeTab === 'blocked') {
        const filtered = blockedList.filter((item) => !q || item.includes(q));
        if (filtered.length === 0) {
          bodyList.appendChild(createDomEl('div', { className: 'empty-hint', textContent: '暂无屏蔽网站（屏蔽后该站点将不显示浮球且不自动翻译）' }));
          return;
        }
        const grid = createDomEl('div', { className: 'chips-grid' });
        for (const domain of filtered) {
          const delBtn = createDomEl('button', { className: 'chip-del', type: 'button', title: '移除屏蔽', dataset: { blocked: domain } }, [
            createSvgIcon(12, [{ tag: 'path', attrs: { d: 'M18 6 6 18M6 6l12 12' } }], '2.2'),
          ]);
          grid.appendChild(createDomEl('span', { className: 'chip' }, [
            createDomEl('span', { textContent: domain }),
            delBtn,
          ]));
        }
        bodyList.appendChild(grid);
        return;
      }

      if (activeTab === 'keep') {
        const filtered = keepList.filter((item) => !q || item.toLowerCase().includes(q));
        if (filtered.length === 0) {
          bodyList.appendChild(createDomEl('div', { className: 'empty-hint', textContent: '暂无匹配的保留词条' }));
          return;
        }
        const grid = createDomEl('div', { className: 'chips-grid' });
        for (const term of filtered) {
          const delBtn = createDomEl('button', { className: 'chip-del', type: 'button', title: '删除', dataset: { term } }, [
            createSvgIcon(12, [{ tag: 'path', attrs: { d: 'M18 6 6 18M6 6l12 12' } }], '2.2'),
          ]);
          grid.appendChild(createDomEl('span', { className: 'chip' }, [
            createDomEl('span', { textContent: term }),
            delBtn,
          ]));
        }
        bodyList.appendChild(grid);
      } else {
        const entries = Object.entries(replaceMap).filter(
          ([k, v]) => !q || k.toLowerCase().includes(q) || v.toLowerCase().includes(q)
        );
        if (entries.length === 0) {
          bodyList.appendChild(createDomEl('div', { className: 'empty-hint', textContent: '暂无匹配的特殊译法' }));
          return;
        }
        const listEl = createDomEl('div', { className: 'replace-list' });
        for (const [k, v] of entries) {
          const delBtn = createDomEl('button', { className: 'chip-del', type: 'button', title: '删除', dataset: { key: k } }, [
            createSvgIcon(13, [{ tag: 'path', attrs: { d: 'M18 6 6 18M6 6l12 12' } }]),
          ]);
          const arrowEl = createDomEl('span', { className: 'arrow' }, [
            createSvgIcon(13, [
              { tag: 'path', attrs: { d: 'M5 12h14' } },
              { tag: 'path', attrs: { d: 'm12 5 7 7-7 7' } },
            ]),
          ]);
          listEl.appendChild(createDomEl('div', { className: 'replace-row', dataset: { key: k } }, [
            createDomEl('span', { className: 'replace-src', title: '点击编辑', textContent: k }),
            arrowEl,
            createDomEl('span', { className: 'replace-dst', title: '点击编辑', textContent: v }),
            delBtn,
          ]));
        }
        bodyList.appendChild(listEl);
      }
    }

    bodyList.addEventListener('click', (e) => {
      const delBlocked = e.target.closest('.chip-del[data-blocked]');
      if (delBlocked) {
        blockedList = blockedList.filter((item) => item !== delBlocked.dataset.blocked);
        renderList();
        return;
      }

      const delKeep = e.target.closest('.chip-del[data-term]');
      if (delKeep) {
        const term = delKeep.dataset.term;
        keepList = keepList.filter((item) => item !== term);
        renderList();
        return;
      }

      const delRep = e.target.closest('.chip-del[data-key]');
      if (delRep) {
        delete replaceMap[delRep.dataset.key];
        renderList();
        return;
      }

      const row = e.target.closest('.replace-row[data-key]');
      if (row && activeTab === 'replace') {
        const k = row.dataset.key;
        const srcInput = shadow.getElementById('rep-src-input');
        const dstInput = shadow.getElementById('rep-dst-input');
        if (srcInput && dstInput) {
          srcInput.value = k;
          dstInput.value = replaceMap[k] || '';
          dstInput.focus();
        }
      }
    });

    [tabKeepBtn, tabReplaceBtn, tabBlockedBtn].forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        tabKeepBtn.classList.toggle('active', activeTab === 'keep');
        tabReplaceBtn.classList.toggle('active', activeTab === 'replace');
        tabBlockedBtn.classList.toggle('active', activeTab === 'blocked');
        renderAddBar();
        renderList();
      });
    });

    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      renderList();
    });

    const onModalKeydown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const close = () => {
      document.removeEventListener('keydown', onModalKeydown, true);
      host.remove();
    };
    document.addEventListener('keydown', onModalKeydown, true);
    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });

    resetBtn.addEventListener('click', () => {
      const base = loadLocalResourceGlossary() || DEFAULT_GLOSSARY;
      keepList = [...base.keep];
      replaceMap = { ...base.replace };
      setTip('已重置为默认词库（未保存）');
      renderList();
    });

    importBtn.addEventListener('click', () => {
      fileInput.value = '';
      fileInput.click();
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result || ''));
          if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON');
          const nextKeep = Array.isArray(parsed.keep) ? parsed.keep.map((s) => String(s).trim()).filter(Boolean) : keepList;
          const nextReplace = parsed.replace && typeof parsed.replace === 'object' ? { ...parsed.replace } : replaceMap;
          keepList = Array.from(new Set(nextKeep));
          replaceMap = nextReplace;
          setTip(`已载入本地词库：保留 ${keepList.length} / 译法 ${Object.keys(replaceMap).length}（点击保存生效）`);
          renderList();
        } catch (_) {
          setTip('JSON 格式无效，请检查词库文件');
        }
      };
      reader.readAsText(file, 'utf-8');
    });

    exportBtn.addEventListener('click', () => {
      try {
        const payload = JSON.stringify({ version: '2.8.0', keep: keepList, replace: replaceMap }, null, 2);
        const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'smart_translator_glossary.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setTip('已导出 smart_translator_glossary.json');
      } catch (_) {
        setTip('导出失败');
      }
    });

    saveBtn.addEventListener('click', () => {
      saveGlossary({ keep: keepList, replace: replaceMap });
      saveBlockedSites(blockedList);
      clearAllTranslationCaches();
      if (isHostBlocked()) {
        const floating = document.getElementById('st-floating-host');
        if (floating) floating.remove();
      }
      close();
    });

    renderAddBar();
    renderList();
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('配置特殊词库与屏蔽网站', openGlossaryModal);
    GM_registerMenuCommand(
      isHostBlocked() ? '取消屏蔽当前网站 (恢复浮球)' : '屏蔽当前网站 (隐藏浮球)',
      toggleBlockCurrentSite
    );
  }

  // ============================================================================
  // 6. 高性能单帧布局缓存、可见性与弹出层精确判定、无损文本节点管理
  // ============================================================================
  const POPUP_ROLE_SELECTOR =
    '[role="tooltip"], [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [popover], dialog';

  const OWN_HOST_IDS = new Set(['st-floating-host', 'st-glossary-modal-host', 'st-img-dot-host', 'st-img-toast-host']);

  function isOwnNode(node) {
    if (!node) return false;
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (OWN_HOST_IDS.has(node.id)) return true;
      if (
        node.classList?.contains('st-trans-block') ||
        node.classList?.contains('st-trans-inline') ||
        node.classList?.contains('st-gh-trans-block') ||
        node.classList?.contains('st-gh-standalone-bar')
      ) {
        return true;
      }
      if (node.closest?.('#st-floating-host, #st-glossary-modal-host, .st-gh-standalone-bar')) {
        return true;
      }
    }
    return false;
  }

  /**
   * 单次扫描周期内缓存 getComputedStyle / getBoundingClientRect / selfHidden / visible，
   * 将 O(N*D) 的昂贵布局查询降至 O(N)，大幅消除强制同步回流。
   */
  class ScanLayoutCache {
    constructor() {
      this.styleMap = new Map();
      this.rectMap = new Map();
      this.selfHiddenMap = new Map();
      this.visibleMap = new Map();
    }
    getStyle(el) {
      let s = this.styleMap.get(el);
      if (s === undefined) {
        s = window.getComputedStyle(el);
        this.styleMap.set(el, s);
      }
      return s;
    }
    getRect(el) {
      let r = this.rectMap.get(el);
      if (r === undefined) {
        r = el.getBoundingClientRect();
        this.rectMap.set(el, r);
      }
      return r;
    }
    isNodeSelfHidden(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
      const cached = this.selfHiddenMap.get(el);
      if (cached !== undefined) return cached;
      const hidden = computeNodeSelfHidden(el, this);
      this.selfHiddenMap.set(el, hidden);
      return hidden;
    }
    isElementVisible(el) {
      if (!el || !el.isConnected) return false;
      const cached = this.visibleMap.get(el);
      if (cached !== undefined) return cached;
      const visible = computeElementVisible(el, this);
      this.visibleMap.set(el, visible);
      return visible;
    }
  }

  function isTransformZeroScale(transform) {
    if (!transform || transform === 'none') return false;
    // matrix(a, b, c, d, tx, ty) -> scaleX = hypot(a, b), scaleY = hypot(c, d)
    const m2 = transform.match(/^matrix\(([^)]+)\)$/);
    if (m2) {
      const nums = m2[1].split(',').map((n) => parseFloat(n.trim()));
      if (nums.length >= 4) {
        const sx = Math.hypot(nums[0], nums[1]);
        const sy = Math.hypot(nums[2], nums[3]);
        if (sx <= 0.01 || sy <= 0.01) return true;
      }
    }
    const m3 = transform.match(/^matrix3d\(([^)]+)\)$/);
    if (m3) {
      const nums = m3[1].split(',').map((n) => parseFloat(n.trim()));
      if (nums.length >= 16) {
        const sx = Math.hypot(nums[0], nums[1], nums[2]);
        const sy = Math.hypot(nums[4], nums[5], nums[6]);
        if (sx <= 0.01 || sy <= 0.01) return true;
      }
    }
    return false;
  }

  function hasClosedStateAttribute(el) {
    if (el.hasAttribute('hidden') || el.hasAttribute('inert')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.tagName === 'DIALOG' && !el.hasAttribute('open')) return true;

    // HTML Popover API
    if (el.hasAttribute('popover')) {
      try {
        if (!el.matches(':popover-open')) return true;
      } catch (_) {
        // 浏览器不支持 :popover-open 伪类时回退到样式检测
      }
    }

    const isPopupOrPanel =
      el.matches(POPUP_ROLE_SELECTOR) ||
      el.getAttribute('role') === 'tabpanel' ||
      el.getAttribute('role') === 'region' ||
      el.hasAttribute('data-radix-popper-content-wrapper') ||
      el.hasAttribute('data-side') ||
      el.hasAttribute('data-accordion-content');

    const dataState = el.getAttribute('data-state');
    if (dataState && /^(closed|hidden|collapsed|inactive)$/i.test(dataState)) {
      if (isPopupOrPanel) return true;
    }

    const dataOpen = el.getAttribute('data-open');
    if (dataOpen === 'false' && isPopupOrPanel) return true;

    const dataVisible = el.getAttribute('data-visible');
    if (dataVisible === 'false' && isPopupOrPanel) return true;

    const dataExpanded = el.getAttribute('data-expanded');
    if (dataExpanded === 'false' && isPopupOrPanel) return true;

    return false;
  }

  function computeNodeSelfHidden(el, cache) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    if (el === document.body || el === document.documentElement) return false;
    if (hasClosedStateAttribute(el)) return true;

    const style = cache ? cache.getStyle(el) : window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      parseFloat(style.opacity) <= 0.01
    ) {
      return true;
    }

    if (style.display === 'contents') return false;

    if (isTransformZeroScale(style.transform)) return true;

    // sr-only / clip 隐藏
    const clip = style.clip;
    if (clip && /^rect\(\s*0(?:px)?[,\s]+0(?:px)?[,\s]+0(?:px)?[,\s]+0(?:px)?\s*\)$/i.test(clip)) {
      return true;
    }
    const clipPath = style.clipPath;
    if (
      clipPath &&
      (/inset\(\s*(?:50|100)%/i.test(clipPath) ||
        /polygon\(\s*0(?:px)?\s+0(?:px)?\s*,\s*0(?:px)?\s+0(?:px)?/i.test(clipPath))
    ) {
      return true;
    }

    // 严格按轴向检查 overflow 折叠（含 max-height: 0 动画折叠）
    const clipsY = style.overflowY === 'hidden' || style.overflowY === 'clip';
    const clipsX = style.overflowX === 'hidden' || style.overflowX === 'clip';
    if (clipsY || clipsX) {
      const r = cache ? cache.getRect(el) : el.getBoundingClientRect();
      if ((clipsY && r.height <= 1) || (clipsX && r.width <= 1)) {
        return true;
      }
    }

    return false;
  }

  function getComposedParent(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode?.();
    if (root && root instanceof ShadowRoot) {
      return root.host || null;
    }
    return null;
  }

  function computeElementVisible(el, cache) {
    if (!el || !el.isConnected) return false;

    const closedDetails = el.closest?.('details:not([open])');
    if (closedDetails) {
      const summary = el.closest('summary');
      if (!summary || summary.parentElement !== closedDetails) {
        return false;
      }
    }

    // 先查缓存 rect 尺寸，0x0 隐藏节点 O(1) 直接淘汰，避免无谓回溯整条祖先链调用 getComputedStyle
    const rect = cache ? cache.getRect(el) : el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;

    // 遍历祖先链（支持穿透 ShadowRoot.host）
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (cache ? cache.isNodeSelfHidden(cur) : computeNodeSelfHidden(cur, null)) {
        return false;
      }
      cur = getComposedParent(cur);
    }

    // 过滤离屏隐藏的绝对/固定定位弹窗
    if (rect.right < -2000 || rect.left > window.innerWidth + 2500) {
      const st = cache ? cache.getStyle(el) : window.getComputedStyle(el);
      if (st.position === 'fixed' || st.position === 'absolute') return false;
    }

    return el.getClientRects().length > 0;
  }

  function isDescendantHiddenOrPopup(descendant, ancestor, cache) {
    let cur = descendant;
    while (cur && cur !== ancestor) {
      if (cur.nodeType === Node.ELEMENT_NODE) {
        if (cache ? cache.isNodeSelfHidden(cur) : computeNodeSelfHidden(cur, null)) return true;
        if (cur.matches(POPUP_ROLE_SELECTOR)) return true;
        if (cur.tagName === 'DETAILS' && !cur.open) return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  // rAF DOM 写队列，合并同一帧内所有 DOM 更新
  class DomWriteScheduler {
    constructor() {
      this.queue = [];
      this.scheduled = false;
      this.isFlushing = false;
    }
    enqueue(fn) {
      this.queue.push(fn);
      if (!this.scheduled) {
        this.scheduled = true;
        requestAnimationFrame(() => this.flush());
      }
    }
    enqueuePostRead(fn) {
      if (!this.postReads) this.postReads = [];
      this.postReads.push(fn);
    }
    flush() {
      this.scheduled = false;
      if (this.queue.length === 0) return;
      const tasks = this.queue.splice(0, this.queue.length);
      this.isFlushing = true;
      try {
        for (const fn of tasks) {
          try {
            fn();
          } catch (err) {
            console.warn('[SmartTranslator] DOM write error:', err);
          }
        }
        // 所有 DOM 写入完成后统一做一次集中读取校验，彻底消除每条元素读写交替导致的强制同步回流
        if (this.postReads && this.postReads.length > 0) {
          const reads = this.postReads.splice(0, this.postReads.length);
          const fixes = [];
          for (const r of reads) {
            try {
              const fix = r();
              if (typeof fix === 'function') fixes.push(fix);
            } catch (_) {}
          }
          for (const fix of fixes) {
            try { fix(); } catch (_) {}
          }
        }
      } finally {
        this.isFlushing = false;
      }
    }
    clear() {
      this.queue.length = 0;
    }
  }

  // ============================================================================
  // 7. 普通网页翻译模块（增量扫描、Shadow DOM、Portal/交互弹窗、图片与智能外观保留）
  // ============================================================================
  const TRANSLATABLE_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'BLOCKQUOTE', 'TD', 'TH', 'DD', 'DT',
    'FIGCAPTION', 'SUMMARY', 'CAPTION', 'LABEL',
    'LEGEND', 'CITE', 'Q', 'ADDRESS', 'SMALL', 'TIME',
  ]);

  const COLLECTIBLE_CONTAINER_TAGS = new Set([
    'DIV', 'SPAN', 'A', 'BUTTON',
    'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'MAIN',
  ]);

  const BLOCK_CONTAINER_TAGS = new Set([
    'DIV', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'ASIDE', 'DETAILS', 'FIGURE',
  ]);

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'TEXTAREA', 'INPUT',
    'MATH', 'MJX-CONTAINER',
  ]);

  const ICON_OR_MATH_SELECTOR =
    '.material-icons, .material-icons-outlined, .material-icons-round, .material-symbols-outlined, .material-symbols-rounded, .material-symbols-sharp, .fa, .fas, .far, .fab, .fal, .fad, .glyphicon, .codicon, .octicon, .katex, .MathJax, mjx-container, math, .blob-code, .blob-num, .diff-table, .react-file-line, .commit-tease-sha, .sha, .highlight, .cm-editor, .monaco-editor, .user-mention, .team-mention, .branch-name, .commit-link, .react-code-lines, .react-code-text, .file-diff-split, .blob-wrapper, .js-file-content';

  function isEditableOrIconOrMath(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.isContentEditable) return true;
    if (node.getAttribute('role') === 'textbox') return true;
    if (node.matches?.(ICON_OR_MATH_SELECTOR)) return true;
    return false;
  }

  const MEDIA_TAGS = new Set(['IMG', 'PICTURE', 'SOURCE', 'SVG', 'VIDEO', 'CANVAS']);
  const ATOMIC_INLINE_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'VAR', 'BR']);
  const RICH_INLINE_TAGS = new Set(['A', 'STRONG', 'B', 'EM', 'I', 'MARK', 'U', 'S', 'DEL', 'INS', 'SMALL', 'SPAN', 'ABBR', 'SUB', 'SUP', 'FONT']);

  const PAGE_TRANS_CSS = `
    .st-trans-block {
      display: block;
      margin: 5px 0 2px 0 !important;
      padding: 0 !important;
      border: 0 !important;
      box-shadow: none !important;
      background-color: transparent;
      position: static !important;
      float: none !important;
      transform: none !important;
      text-indent: 0 !important;
      font-family: inherit, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", -apple-system, sans-serif;
      font-size: 0.94em;
      line-height: 1.62;
      letter-spacing: normal !important;
      text-transform: none !important;
      color: inherit;
      opacity: 1;
      white-space: normal;
      word-break: break-word;
    }
    .st-trans-inline {
      display: inline;
      margin: 0 0 0 5px !important;
      padding: 0 !important;
      border: 0 !important;
      box-shadow: none !important;
      background-color: transparent;
      position: static !important;
      float: none !important;
      transform: none !important;
      text-indent: 0 !important;
      font-family: inherit, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", -apple-system, sans-serif;
      font-size: 0.93em;
      letter-spacing: normal !important;
      text-transform: none !important;
      color: inherit;
      opacity: 1;
    }
    .st-trans-block.st-ch-only,
    .st-trans-inline.st-ch-only {
      margin: 0 !important;
      opacity: 1 !important;
    }
    @media print {
      #st-floating-host, #st-glossary-modal-host, #st-img-dot-host, #st-img-toast-host, .st-gh-standalone-bar {
        display: none !important;
      }
    }
  `;

  function isTagCollectible(tag) {
    return TRANSLATABLE_TAGS.has(tag) || COLLECTIBLE_CONTAINER_TAGS.has(tag);
  }

  function getDirectTextContent(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue || '';
      }
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  function getElementVisibleText(el, cache) {
    if (!el) return '';
    if (el.childElementCount === 0) {
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.st-trans-block, .st-trans-inline, .st-gh-trans-block, script, style, noscript, svg, pre, code')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent !== el && isDescendantHiddenOrPopup(parent, el, cache)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '';
    let cur;
    while ((cur = walker.nextNode())) {
      text += cur.nodeValue || '';
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  function hasVisibleTranslatableChild(el, cache) {
    if (!el || el.childElementCount === 0) return false;
    for (const child of el.children) {
      if (isOwnNode(child)) continue;
      if (SKIP_TAGS.has(child.tagName)) continue;
      if (cache ? cache.isNodeSelfHidden(child) : computeNodeSelfHidden(child, null)) continue;

      if (TRANSLATABLE_TAGS.has(child.tagName) || BLOCK_CONTAINER_TAGS.has(child.tagName)) {
        if ((child.textContent || '').trim().length > 0 && (cache ? cache.isElementVisible(child) : computeElementVisible(child, null))) {
          return true;
        }
      }
    }
    return false;
  }

  function hasDedicatedInnerTextChild(el, cache) {
    if (!el || el.childElementCount === 0) return false;
    const tag = el.tagName;
    const isHeading = /^H[1-6]$/.test(tag);
    if (!isHeading && tag !== 'LI' && !COLLECTIBLE_CONTAINER_TAGS.has(tag)) return false;
    if (isHeading) {
      // 仅当标题内部唯一有效文本放在 <button> 或 <a> 中（如 Radix Accordion 标题按钮）时下沉到交互元素内，确保点击中文也能触发按钮
      const hasInteractiveChild = Array.from(el.children).some((c) => c.tagName === 'BUTTON' || c.tagName === 'A');
      if (!hasInteractiveChild) return false;
    }
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && (node.nodeValue || '').trim().length > 0) {
        return false;
      }
    }
    let collectibleTextChildren = 0;
    let uncollectibleTextChildren = 0;
    let hasNonTextSibling = false;
    for (const child of el.children) {
      if (isOwnNode(child)) continue;
      if ((cache ? cache.isNodeSelfHidden(child) : computeNodeSelfHidden(child, null)) || child.matches(POPUP_ROLE_SELECTOR)) {
        continue;
      }
      if (SKIP_TAGS.has(child.tagName) || MEDIA_TAGS.has(child.tagName)) {
        hasNonTextSibling = true;
        continue;
      }
      const txt = getElementVisibleText(child, cache);
      if (txt.length > 0 && (cache ? cache.isElementVisible(child) : computeElementVisible(child, null))) {
        if (isTagCollectible(child.tagName)) {
          collectibleTextChildren++;
        } else {
          uncollectibleTextChildren++;
        }
      } else {
        hasNonTextSibling = true;
      }
    }
    if (uncollectibleTextChildren > 0) return false;
    // 外层容器无直接文本、所有文本均落在可独立收集的子元素中时，始终下沉到最内层实际承载文本的组件（如 div > button / div > span），保证样式、Flex/Grid 布局与防重状态精准绑定到真实组件
    return collectibleTextChildren >= 1;
  }

  function hasGradientTextStyle(style) {
    if (!style) return false;
    const bgClip = style.webkitBackgroundClip || style.backgroundClip || '';
    const fill = style.webkitTextFillColor || style.color || '';
    const hasBgImg = Boolean(style.backgroundImage && style.backgroundImage !== 'none');
    return bgClip === 'text' && hasBgImg && (fill === 'transparent' || fill === 'rgba(0, 0, 0, 0)');
  }

  function findAncestorGradientStyle(el, cache) {
    let cur = el;
    for (let depth = 0; depth < 5 && cur && cur !== document.body; depth++) {
      const st = cache ? cache.getStyle(cur) : window.getComputedStyle(cur);
      if (hasGradientTextStyle(st)) return st;
      cur = getComposedParent(cur);
    }
    return null;
  }

  function findDominantTextStyleSource(el, cache) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || p.closest('.st-trans-block, .st-trans-inline, .st-gh-trans-block, .st-gh-trans-inline, script, style, svg')) {
          return NodeFilter.FILTER_REJECT;
        }
        return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const firstText = walker.nextNode();
    if (firstText && firstText.parentElement && firstText.parentElement !== el) {
      return firstText.parentElement;
    }
    return el;
  }

  function containsMediaElement(el) {
    return Boolean(el.querySelector('img, picture, svg, video, canvas'));
  }

  /**
   * 提取带内联组件占位符的文本（绝不克隆 img/picture/svg，保留原媒体元素不动）
   */
  function extractRichSegment(el, directOnly, cache) {
    if (directOnly) {
      return { text: getDirectTextContent(el), tokens: [], hasRich: false, styleSource: el, hasMedia: false, directOnly: true };
    }
    if (el.childElementCount === 0) {
      return {
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        tokens: [],
        hasRich: false,
        styleSource: el,
        hasMedia: false,
        directOnly: false,
      };
    }

    // 记录是否含媒体节点（绝不克隆 <img>/<picture>/<svg>，但仍完整保留同段落内的 <code>/<a>/<strong> 与彩色 <span>）
    const hasMedia = containsMediaElement(el);

    const tokens = [];
    let hasRich = false;

    const rootStyle = cache ? cache.getStyle(el) : window.getComputedStyle(el);
    const rootColor = rootStyle.color || '';

    function walk(node, parentColor) {
      let out = '';
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue || '';
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (isOwnNode(child)) continue;
        if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'NOSCRIPT' || MEDIA_TAGS.has(child.tagName)) continue;
        // 跳过 GitHub 标题锚点与代码复制按钮
        if (child.classList?.contains('anchor') || child.classList?.contains('zeroclipboard-container') || isEditableOrIconOrMath(child)) continue;
        if ((cache ? cache.isNodeSelfHidden(child) : computeNodeSelfHidden(child, null)) || child.matches(POPUP_ROLE_SELECTOR)) {
          continue;
        }
        if (child.tagName === 'DETAILS' && !child.open) continue;

        if (ATOMIC_INLINE_TAGS.has(child.tagName)) {
          const idx = tokens.length;
          tokens.push({ type: 'atomic', node: child });
          hasRich = true;
          out += `[[C${idx}]]`;
          continue;
        }

        if (RICH_INLINE_TAGS.has(child.tagName)) {
          const childStyle = cache ? cache.getStyle(child) : window.getComputedStyle(child);
          const childColor = childStyle.color || parentColor;
          const hasDistinctColor = Boolean(childColor && parentColor && childColor !== parentColor);
          const hasDistinctBg =
            childStyle.backgroundColor &&
            childStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
            childStyle.backgroundColor !== 'transparent';
          const hasDistinctBorder =
            parseFloat(childStyle.borderTopWidth) > 0 || parseFloat(childStyle.borderBottomWidth) > 0;
          const weightNum = parseInt(childStyle.fontWeight, 10);
          const isStyled =
            child.tagName !== 'SPAN' ||
            hasDistinctColor ||
            hasDistinctBg ||
            hasDistinctBorder ||
            hasGradientTextStyle(childStyle) ||
            weightNum >= 600 ||
            childStyle.fontWeight === 'bold';

          const inner = walk(child, childColor);
          const trimmedInner = inner.trim();
          if (!trimmedInner) continue;

          // 纯数字计数徽章（如 GitHub <span class="Counter">42</span> / 1.2k）作为原子组件原样保留，不送入翻译
          if (/^[+#]?\d+(?:[.,]\d+)?[kKmMbB+%]*$/.test(trimmedInner) && tokens.length < 16) {
            const idx = tokens.length;
            tokens.push({ type: 'atomic', node: child });
            hasRich = true;
            out += `[[C${idx}]]`;
            continue;
          }

          if (isStyled && tokens.length < 16) {
            const idx = tokens.length;
            tokens.push({ type: 'wrap', node: child });
            hasRich = true;
            out += `[[L${idx}]]${inner}[[/L${idx}]]`;
          } else {
            out += inner;
          }
          continue;
        }

        const cStyle = cache ? cache.getStyle(child) : window.getComputedStyle(child);
        out += walk(child, cStyle.color || parentColor);
      }
      return out;
    }

    const raw = walk(el, rootColor).replace(/\s+/g, ' ').trim();
    const wholeWrapMatch = raw.match(/^\[\[L0\]\]([\s\S]*)\[\[\/L0\]\]$/);
    if (wholeWrapMatch && tokens.length === 1 && tokens[0].type === 'wrap' && tokens[0].node.tagName !== 'A') {
      return {
        text: wholeWrapMatch[1].trim(),
        tokens: [],
        hasRich: false,
        styleSource: tokens[0].node,
        hasMedia,
        directOnly: false,
      };
    }

    let styleSource = el;
    if (tokens.length > 0) {
      const wrapNodes = tokens.filter((t) => t.type === 'wrap').map((t) => t.node);
      if (wrapNodes.length > 0) {
        const firstCol = (cache ? cache.getStyle(wrapNodes[0]) : window.getComputedStyle(wrapNodes[0])).color;
        if (
          firstCol &&
          firstCol !== rootColor &&
          wrapNodes.every((n) => (cache ? cache.getStyle(n) : window.getComputedStyle(n)).color === firstCol)
        ) {
          // 若容器自身无直接文本且所有富文本子节点共享同一颜色，将其作为统一色源
          if (!getDirectTextContent(el)) {
            styleSource = wrapNodes[0];
          }
        }
      }
    }
    if (hasMedia && styleSource === el) {
      styleSource = findDominantTextStyleSource(el, cache);
    }
    return { text: raw, tokens, hasRich, styleSource, hasMedia, directOnly: false };
  }

  function copyVisualStyleFromElement(sourceEl, targetEl, options = {}) {
    if (!sourceEl || !targetEl) return;
    const st = options.sourceStyle || window.getComputedStyle(sourceEl);
    const isTransparentFill =
      st.color === 'transparent' ||
      st.color === 'rgba(0, 0, 0, 0)' ||
      st.webkitTextFillColor === 'transparent' ||
      st.webkitTextFillColor === 'rgba(0, 0, 0, 0)';

    const gradSt = hasGradientTextStyle(st)
      ? st
      : (isTransparentFill ? findAncestorGradientStyle(sourceEl, null) : null);

    if (gradSt) {
      targetEl.style.setProperty('background-image', gradSt.backgroundImage, 'important');
      targetEl.style.setProperty('background-size', gradSt.backgroundSize, 'important');
      targetEl.style.setProperty('background-position', gradSt.backgroundPosition, 'important');
      targetEl.style.setProperty('background-repeat', gradSt.backgroundRepeat, 'important');
      targetEl.style.setProperty('background-clip', 'text', 'important');
      targetEl.style.setProperty('-webkit-background-clip', 'text', 'important');
      targetEl.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
      targetEl.style.setProperty('color', 'transparent', 'important');
      targetEl.style.setProperty('-webkit-box-decoration-break', 'clone', 'important');
      targetEl.style.setProperty('box-decoration-break', 'clone', 'important');
    } else if (st.color && !isTransparentFill) {
      if (!options.deferColorUntilMounted) {
        targetEl.style.setProperty('color', st.color, 'important');
      }
      if (st.webkitTextFillColor && st.webkitTextFillColor !== st.color && st.webkitTextFillColor !== 'rgba(0, 0, 0, 0)' && st.webkitTextFillColor !== 'transparent') {
        targetEl.style.setProperty('-webkit-text-fill-color', st.webkitTextFillColor, 'important');
      }
    }

    if (options.isInline || options.isInteractive) {
      targetEl.style.fontWeight = st.fontWeight;
      targetEl.style.fontStyle = st.fontStyle;
      // 中文译文避免继承负字距或超大英文字距导致字符重叠/拉散
      const lsNum = parseFloat(st.letterSpacing);
      if (!Number.isNaN(lsNum) && lsNum >= 0 && lsNum <= 1.5) {
        targetEl.style.letterSpacing = st.letterSpacing;
      }
      if (st.textShadow && st.textShadow !== 'none') {
        targetEl.style.textShadow = st.textShadow;
      }
    } else {
      targetEl.style.textAlign = st.textAlign;
      targetEl.style.fontWeight = st.fontWeight;
      if (sourceEl.tagName && /^H[1-6]$/.test(sourceEl.tagName)) {
        const fs = parseFloat(st.fontSize) || 0;
        if (fs >= 28) {
          targetEl.style.fontSize = '0.86em';
        }
        if (st.lineHeight && st.lineHeight !== 'normal') {
          targetEl.style.lineHeight = st.lineHeight;
        }
      }
      if (st.textShadow && st.textShadow !== 'none') {
        targetEl.style.textShadow = st.textShadow;
      }
      if (st.fontStyle && st.fontStyle !== 'normal') {
        targetEl.style.fontStyle = st.fontStyle;
      }
    }

    if (options.isRichClone) {
      targetEl.style.fontWeight = st.fontWeight;
      targetEl.style.fontStyle = st.fontStyle;
      targetEl.style.textDecoration = st.textDecoration;
      if (st.backgroundColor && st.backgroundColor !== 'rgba(0, 0, 0, 0)' && st.backgroundColor !== 'transparent') {
        targetEl.style.setProperty('background-color', st.backgroundColor, 'important');
        targetEl.style.borderRadius = st.borderRadius;
        targetEl.style.padding = st.padding;
      }
      if (parseFloat(st.borderTopWidth) > 0) {
        targetEl.style.border = st.border;
        targetEl.style.borderRadius = st.borderRadius;
      }
    }
  }

  function buildRichTranslationFragment(translatedText, tokens) {
    const frag = document.createDocumentFragment();
    if (!tokens || tokens.length === 0) {
      frag.appendChild(document.createTextNode(translatedText));
      return frag;
    }

    const tokenRegex = /(?:\[|【){1,2}\s*(C|L|\/[\s]*L)\s*(\d+)\s*(?:\]|】){1,2}/gi;
    const stack = [frag];
    let lastIndex = 0;
    let match;

    while ((match = tokenRegex.exec(translatedText)) !== null) {
      const before = translatedText.slice(lastIndex, match.index);
      if (before) stack[stack.length - 1].appendChild(document.createTextNode(before));
      lastIndex = tokenRegex.lastIndex;

      const kind = match[1].replace(/\s+/g, '').toUpperCase();
      const idx = parseInt(match[2], 10);
      const token = tokens[idx];
      if (!token) continue;

      if (kind === 'C' && token.type === 'atomic') {
        const cloned = token.node.cloneNode(true);
        cloned.removeAttribute?.('id');
        stack[stack.length - 1].appendChild(cloned);
      } else if (kind === 'L' && token.type === 'wrap') {
        const shallow = token.node.cloneNode(false);
        shallow.removeAttribute('id');
        copyVisualStyleFromElement(token.node, shallow, { isRichClone: true, isInline: true });
        if (token.node.tagName === 'A') {
          const origLink = token.node;
          shallow.addEventListener('click', (e) => {
            if (origLink.isConnected && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
              e.preventDefault();
              e.stopPropagation();
              origLink.click();
            }
          });
        }
        stack[stack.length - 1].appendChild(shallow);
        stack.push(shallow);
      } else if (kind === '/L') {
        if (stack.length > 1) stack.pop();
      }
    }

    const tail = translatedText.slice(lastIndex);
    if (tail) stack[stack.length - 1].appendChild(document.createTextNode(tail));
    return frag;
  }

  /**
   * 智能布局策略识别：根据元素的计算样式与父容器布局决定最佳插入方式，
   * 避免破坏 Flex/Grid/Absolute/Inline/Pseudo-element/Image 容器的外观与交互。
   */
  const TOPIC_OR_META_CLASS_RE =
    /(?:^|[-_\s])(topic|category|cat|kicker|eyebrow|tag|tags|badge|chip|pill|label|meta|byline|breadcrumb|section-name|section-label|rubric|overline|subtitle-tag|status)(?:$|[-_\s])/i;

  function isTopicOrCategoryLabel(el, elStyle) {
    const rawText = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!rawText || rawText.length > 40) return false;
    // 含句末标点的正文句子绝不当作话题/标签
    if (/[.?!。？！]$/.test(rawText) && rawText.split(/\s+/).length >= 4) return false;

    const words = rawText.split(/\s+/).filter(Boolean);
    const fontSize = parseFloat(elStyle.fontSize) || 16;
    const isUppercaseStyle = elStyle.textTransform === 'uppercase';
    const isAllCapsText = /^[A-Z0-9\s&/\-·|:+]+$/.test(rawText) && /[A-Z]{2,}/.test(rawText);
    const clsAndRole = `${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('itemprop') || ''}`;

    // 1. 全大写样式或全大写短词（如 TECHNOLOGY / WORLD NEWS / AI & ML）
    if ((isUppercaseStyle || isAllCapsText) && words.length <= 4 && rawText.length <= 32 && fontSize <= 22) {
      return true;
    }
    // 2. 带有明确 topic / category / eyebrow / kicker / tag / badge / meta 语义类名的短标签
    if (TOPIC_OR_META_CLASS_RE.test(clsAndRole) && words.length <= 5 && rawText.length <= 36) {
      return true;
    }
    // 3. 日期/时间或带分隔符（| / • / ·）的短元信息条（如 "Jennifer Hu |"、"• October 2025"）
    if (el.tagName === 'TIME') return true;
    if (rawText.length <= 36 && (/^[•·|—–/-]\s*/.test(rawText) || /\s*[|•·]$/.test(rawText))) {
      return true;
    }
    if (
      rawText.length <= 32 &&
      /^(?:[•·|/-]\s*)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,4}(?:,\s*\d{4})?$/i.test(rawText)
    ) {
      return true;
    }
    // 4. 短小独立元信息/分类词（<= 2 个词且字号 <= 14px 的 div/span/h5/h6/small/p）
    if (
      (el.tagName === 'DIV' || el.tagName === 'H5' || el.tagName === 'H6' || el.tagName === 'SMALL' || el.tagName === 'P') &&
      words.length <= 2 &&
      rawText.length <= 22 &&
      fontSize <= 14
    ) {
      return true;
    }
    return false;
  }

  function determineLayoutStrategy(el, elStyle, hasMedia, cache) {
    const tag = el.tagName;
    const isProseBlockTag = /^H[1-6]$/.test(tag) || tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'FIGCAPTION';

    // 话题 / 分类 / 眉题 / 标签（如红色 "TECHNOLOGY"）统一向右内联翻译，不换行堆叠
    if (isTopicOrCategoryLabel(el, elStyle)) {
      return 'inline';
    }

    if (
      tag === 'A' ||
      tag === 'BUTTON' ||
      tag === 'SPAN' ||
      tag === 'LABEL' ||
      tag === 'SUMMARY' ||
      (!isProseBlockTag &&
        el.closest?.(
          'a, button, nav, [role="button"], [role="option"], [role="menuitem"], [role="tab"], [role="navigation"], [role="menubar"], [role="tablist"], [role="toolbar"], [role="tooltip"]'
        ))
    ) {
      return 'inline';
    }

    const display = elStyle.display || '';
    if (display === 'inline' || display === 'inline-block' || display === 'inline-flex' || display === 'inline-grid') {
      return 'inline';
    }

    // Flex / Grid 容器或含媒体元素的容器，采用内联跟随最后文本节点的方式，避免新增 flex/grid 网格单元打乱布局
    if (display.includes('flex') || display.includes('grid') || hasMedia) {
      return 'inline';
    }

    // 位于横向 flex 行（flex-direction: row）内的短单行元信息/标签项（如 作者 | 活动 • 日期），向右内联翻译以保持整行水平对齐
    const parentEl = el.parentElement;
    if (parentEl && parentEl !== document.body && !/^H[1-3]$/.test(tag)) {
      const pStyle = cache ? cache.getStyle(parentEl) : window.getComputedStyle(parentEl);
      const isHorizontalFlex =
        pStyle.display &&
        pStyle.display.includes('flex') &&
        (!pStyle.flexDirection || pStyle.flexDirection === 'row' || pStyle.flexDirection === 'row-reverse');
      if (isHorizontalFlex) {
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (txt.length > 0 && txt.length <= 45 && !/[.?!。？！]$/.test(txt)) {
          return 'inline';
        }
      }
    }

    // 带背景/圆角的小徽章或胶囊按钮
    const hasBg = elStyle.backgroundColor && elStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' && elStyle.backgroundColor !== 'transparent';
    const hasBorder = parseFloat(elStyle.borderTopWidth) > 0 && parseFloat(elStyle.borderRadius) > 0;
    if ((hasBg || hasBorder) && (el.textContent || '').trim().length <= 45) {
      return 'inline';
    }

    // 面包屑、分页器、短术语标题 (<dt>) 及单行截断 (nowrap / ellipsis / line-clamp: 1) 统一采用内联，避免撑乱卡片高度或打断面包屑分隔符
    if (el.closest?.('[aria-label*="breadcrumb" i], [role="breadcrumb"], [class*="breadcrumb"], [class*="pagination"]')) {
      return 'inline';
    }
    if (tag === 'DT' && (el.textContent || '').trim().length <= 32) {
      return 'inline';
    }
    if (elStyle.whiteSpace === 'nowrap' || elStyle.textOverflow === 'ellipsis' || elStyle.webkitLineClamp === '1') {
      return 'inline';
    }

    return 'block';
  }

  function getVisibleTextNodes(el, directOnly = false) {
    if (directOnly || el.childElementCount === 0) {
      const out = [];
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.nodeValue && node.nodeValue.trim()) {
          out.push(node);
        }
      }
      return out;
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.st-trans-block, .st-trans-inline, .st-gh-trans-block, script, style, svg, pre, code')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent !== el && isDescendantHiddenOrPopup(parent, el, null)) {
          return NodeFilter.FILTER_REJECT;
        }
        return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const nodes = [];
    let cur;
    while ((cur = walker.nextNode())) nodes.push(cur);
    return nodes;
  }

  function initGeneralPageTranslator() {
    if (isHostBlocked()) return;
    if (document.getElementById('st-floating-host')) return;
    const pageIsChinese = isGeneralPageChinese();

    const host = document.createElement('div');
    host.id = 'st-floating-host';
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('z-index', '2147483646', 'important');
    const shadow = host.attachShadow({ mode: 'open' });

    let savedPos = GM_getValue(STORAGE_KEYS.POS, { edge: 'right', ratio: 0.42 });
    if (!savedPos || !['left', 'right', 'top', 'bottom'].includes(savedPos.edge)) {
      savedPos = { edge: 'right', ratio: 0.42 };
    }

    const widgetCss = `
      :host { all: initial; }
      .st-widget {
        position: fixed;
        z-index: 2147483646;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
        user-select: none;
        touch-action: none;
        transition: left 0.16s ease, top 0.16s ease;
      }
      .st-widget.dragging { transition: none !important; }
      .st-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        padding: 0;
        background: #ffffff;
        color: #1e293b;
        border: 1px solid #cbd5e1;
        box-shadow: 0 4px 14px rgba(15, 23, 42, 0.14);
        cursor: grab;
        border-radius: 50%;
      }
      .st-icon-btn:hover {
        background: #f8fafc;
        border-color: #2563eb;
        color: #2563eb;
      }
      .st-icon-btn:active { cursor: grabbing; }
      .st-bar {
        display: none;
        align-items: center;
        white-space: nowrap;
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 999px;
        padding: 3px;
        gap: 2px;
        box-shadow: 0 4px 16px rgba(15, 23, 42, 0.16);
        cursor: grab;
      }
      .st-bar.active { display: inline-flex; }
      .st-bar button {
        border: none;
        background: transparent;
        color: #475569;
        font-size: 12px;
        font-weight: 600;
        padding: 5px 9px;
        border-radius: 999px;
        cursor: pointer;
        line-height: 1;
        white-space: nowrap;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s, color 0.15s;
      }
      .st-bar button:hover { background: #f1f5f9; color: #0f172a; }
      .st-bar button.selected { background: #2563eb; color: #ffffff; }
      .st-bar button.close-btn { color: #64748b; padding: 5px 7px; }
      .st-bar button.close-btn:hover { background: #fee2e2; color: #dc2626; }
      .st-bar button.settings-btn { color: #64748b; padding: 5px 7px; }
      .st-bar button.settings-btn:hover { background: #f1f5f9; color: #2563eb; }
      .st-spinner {
        width: 11px;
        height: 11px;
        margin: 0 5px 0 3px;
        border: 2px solid #cbd5e1;
        border-top-color: #2563eb;
        border-radius: 50%;
        animation: st-spin 0.7s linear infinite;
        display: none;
      }
      .st-spinner.loading { display: inline-block; }
      @keyframes st-spin { to { transform: rotate(360deg); } }
    `;
    applyShadowStyles(shadow, widgetCss);

    const translateBtn = createDomEl('button', {
      className: 'st-icon-btn',
      id: 'translate-btn',
      type: 'button',
      title: '点击翻译页面 / 右键打开词库设置 / 拖拽至窗口边缘',
    }, [
      createSvgIcon(16, [
        { tag: 'path', attrs: { d: 'm5 8 6 6' } },
        { tag: 'path', attrs: { d: 'm4 14 6-6 2-3' } },
        { tag: 'path', attrs: { d: 'M2 5h12' } },
        { tag: 'path', attrs: { d: 'M7 2h1' } },
        { tag: 'path', attrs: { d: 'm22 22-5-10-5 10' } },
        { tag: 'path', attrs: { d: 'M14 18h6' } },
      ]),
    ]);

    const btnClose = createDomEl('button', { className: 'close-btn', id: 'btn-close', type: 'button', title: '关闭翻译' }, [
      createSvgIcon(13, [{ tag: 'path', attrs: { d: 'M18 6 6 18M6 6l12 12' } }], '2.4'),
    ]);
    const btnBilingual = createDomEl('button', { id: 'btn-bilingual', className: 'selected', type: 'button', textContent: '双语' });
    const btnCh = createDomEl('button', { id: 'btn-ch', type: 'button', textContent: 'CH' });
    const btnSettings = createDomEl('button', { className: 'settings-btn', id: 'btn-settings', type: 'button', title: '特殊词库设置' }, [
      createSvgIcon(13, [
        { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
        { tag: 'path', attrs: { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' } },
      ]),
    ]);
    const spinner = createDomEl('span', { className: 'st-spinner', id: 'spinner' });
    const controlBar = createDomEl('div', { className: 'st-bar', id: 'control-bar' }, [
      btnClose,
      btnBilingual,
      btnCh,
      btnSettings,
      spinner,
    ]);
    const widget = createDomEl('div', { className: 'st-widget', id: 'widget' }, [translateBtn, controlBar]);
    shadow.appendChild(widget);

    function ensurePageStylesInRoot(rootNode) {
      if (rootNode === document) {
        if (!document.getElementById('st-page-trans-style')) {
          const pageStyle = document.createElement('style');
          pageStyle.id = 'st-page-trans-style';
          pageStyle.textContent = PAGE_TRANS_CSS;
          (document.head || document.documentElement).appendChild(pageStyle);
        }
      } else if (rootNode instanceof ShadowRoot) {
        if (!rootNode.querySelector('style[data-st-shadow-style="1"]')) {
          const st = document.createElement('style');
          st.setAttribute('data-st-shadow-style', '1');
          st.textContent = PAGE_TRANS_CSS;
          rootNode.appendChild(st);
        }
      }
    }

    ensurePageStylesInRoot(document);
    document.documentElement.appendChild(host);

    // 全屏播放视频或演示文稿时自动隐藏悬浮球，退出全屏立即恢复
    document.addEventListener('fullscreenchange', () => {
      const inFs = Boolean(document.fullscreenElement);
      host.style.setProperty('display', inFs ? 'none' : 'block', 'important');
    });

    function applyEdgePosition(pos) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = widget.getBoundingClientRect();
      const w = rect.width || 36;
      const h = rect.height || 36;
      const margin = 8;

      let left = margin;
      let top = margin;

      if (pos.edge === 'left') {
        left = margin;
        top = Math.max(margin, Math.min(vh - h - margin, pos.ratio * (vh - h)));
      } else if (pos.edge === 'right') {
        left = Math.max(margin, vw - w - margin);
        top = Math.max(margin, Math.min(vh - h - margin, pos.ratio * (vh - h)));
      } else if (pos.edge === 'top') {
        top = margin;
        left = Math.max(margin, Math.min(vw - w - margin, pos.ratio * (vw - w)));
      } else {
        top = Math.max(margin, vh - h - margin);
        left = Math.max(margin, Math.min(vw - w - margin, pos.ratio * (vw - w)));
      }

      widget.style.left = `${Math.round(left)}px`;
      widget.style.top = `${Math.round(top)}px`;
    }

    requestAnimationFrame(() => applyEdgePosition(savedPos));
    let resizeRaf = 0;
    window.addEventListener('resize', () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        applyEdgePosition(savedPos);
      });
    }, { passive: true });

    let isDragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;
    let dragW = 36;
    let dragH = 36;

    widget.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = widget.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      dragW = rect.width || 36;
      dragH = rect.height || 36;
      widget.classList.add('dragging');
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (!moved) return;

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      widget.style.left = `${Math.max(0, Math.min(vw - dragW, origLeft + dx))}px`;
      widget.style.top = `${Math.max(0, Math.min(vh - dragH, origTop + dy))}px`;
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      widget.classList.remove('dragging');
      if (!moved) return;

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = widget.getBoundingClientRect();
      const minDist = Math.min(rect.left, vw - rect.right, rect.top, vh - rect.bottom);

      if (minDist === rect.left) {
        savedPos = { edge: 'left', ratio: rect.top / Math.max(1, vh - rect.height) };
      } else if (minDist === vw - rect.right) {
        savedPos = { edge: 'right', ratio: rect.top / Math.max(1, vh - rect.height) };
      } else if (minDist === rect.top) {
        savedPos = { edge: 'top', ratio: rect.left / Math.max(1, vw - rect.width) };
      } else {
        savedPos = { edge: 'bottom', ratio: rect.left / Math.max(1, vw - rect.width) };
      }

      GM_setValue(STORAGE_KEYS.POS, savedPos);
      applyEdgePosition(savedPos);
    });

    // --- 状态管理（WeakMap 存状态 + Set 跟踪活跃元素 + 自动清理失效引用）---
    let currentMode = 'off';
    let sessionId = 0;
    let sessionAbortController = null;
    let activeBatches = 0;

    const elementStateMap = new WeakMap();
    const activeElements = new Set();
    const inFlightElements = new WeakSet();

    // 针对 native <option>、<img> alt/title、<input/textarea> placeholder 与页面标签页标题的无损状态记录
    const optionOriginMap = new WeakMap();
    const activeOptions = new Set();
    const placeholderOriginMap = new WeakMap();
    const activePlaceholders = new Set();
    let origDocumentTitle = null;
    let translatedDocumentTitle = null;

    // Shadow DOM 观察器集合
    const observedShadowRoots = new WeakSet();
    const shadowObservers = new Map(); // ShadowRoot -> MutationObserver

    // 增量扫描脏节点队列（带 maxWait 防饿死上限）
    const dirtyRoots = new Set();
    let scanTimer = null;
    let firstDirtyTimestamp = 0;
    const MAX_DEBOUNCE_WAIT_MS = 450;
    const popupFollowUpTimers = new WeakMap();
    let dynamicObserver = null;
    let interactionListenersBound = false;
    let isInternalDomMutating = false;
    const domWriter = new DomWriteScheduler();

    // 触发元素、滚动显影与主题切换状态记录
    let lastInteractionTime = 0;
    let lastScrollTime = 0;
    let lastTriggerEl = null;
    let themeObserver = null;
    let lazyViewportObserver = null;
    let scrollListenerBound = false;

    function refreshForcedColorsForThemeChange() {
      if (currentMode === 'off' || activeElements.size === 0) return;
      domWriter.enqueue(() => {
        runInternalDomMutation(() => {
          for (const el of activeElements) {
            if (!el.isConnected) continue;
            const state = elementStateMap.get(el);
            if (!state || !state.colorForced || !state.transEl || !state.transEl.isConnected) continue;
            const srcEl = state.colorSourceEl && state.colorSourceEl.isConnected ? state.colorSourceEl : el;
            const liveSt = window.getComputedStyle(srcEl);
            if (liveSt.color && liveSt.color !== 'transparent' && liveSt.color !== 'rgba(0, 0, 0, 0)') {
              state.transEl.style.setProperty('color', liveSt.color, 'important');
            }
          }
        });
      });
    }

    const onWindowScroll = () => {
      lastScrollTime = Date.now();
    };

    const onDynamicShadowAttached = (e) => {
      if (currentMode === 'off') return;
      const sr = e.detail;
      if (sr instanceof ShadowRoot) {
        attachShadowRootObserver(sr);
        enqueueDirtyRoot(sr, 70);
      }
    };

    function updateSpinner() {
      spinner.classList.toggle('loading', currentMode !== 'off' && activeBatches > 0);
    }

    function runInternalDomMutation(fn) {
      isInternalDomMutating = true;
      try {
        fn();
      } finally {
        isInternalDomMutating = false;
      }
    }

    function restoreSingleElement(el) {
      const state = elementStateMap.get(el);
      if (!state) return;

      runInternalDomMutation(() => {
        // 恢复原位修改的 TextNode
        if (state.inPlaceNode && state.inPlaceNode.isConnected && state.inPlaceOriginal !== undefined) {
          state.inPlaceNode.nodeValue = state.inPlaceOriginal;
        }
        // 恢复隐藏的直接 TextNode 与富文本原始行内子节点
        if (state.hiddenTextBackups) {
          for (const [textNode, origVal] of state.hiddenTextBackups) {
            if (textNode.isConnected) {
              textNode.nodeValue = origVal;
            }
          }
          state.hiddenTextBackups.clear();
        }
        if (state.hiddenChildBackups) {
          for (const [childEl, origDisplay] of state.hiddenChildBackups) {
            if (childEl.isConnected) {
              childEl.style.display = origDisplay;
              delete childEl.dataset.stChHidden;
            }
          }
          state.hiddenChildBackups.clear();
        }
        if (state.transEl && state.transEl.isConnected) {
          state.transEl.remove();
        }
        if (el.isConnected && state.styleRestores) {
          for (const [prop, val] of Object.entries(state.styleRestores)) {
            if (val === '' || val == null) {
              el.style.removeProperty(prop);
            } else {
              el.style[prop] = val;
            }
          }
        }
      });

      if (el.isConnected && el.dataset) {
        delete el.dataset.stTranslated;
        delete el.dataset.stInflight;
      }
      elementStateMap.delete(el);
      activeElements.delete(el);
    }

    function applyModeToElement(el, state, mode) {
      if (!el.isConnected) {
        elementStateMap.delete(el);
        activeElements.delete(el);
        return;
      }

      runInternalDomMutation(() => {
        const displayVal = state.isInline ? 'inline' : 'block';
        if (mode === 'bilingual') {
          if (state.useInPlaceBilingual && state.inPlaceNode && state.inPlaceNode.isConnected) {
            if (state.inPlaceOriginal === undefined) {
              state.inPlaceOriginal = state.inPlaceNode.nodeValue;
            }
            const leadWs = (state.inPlaceOriginal.match(/^\s*/) || [''])[0];
            const trailWs = (state.inPlaceOriginal.match(/\s*$/) || [''])[0];
            const trimmedOrig = state.inPlaceOriginal.trim();
            state.inPlaceNode.nodeValue = `${leadWs}${trimmedOrig} ${state.translatedPlain}${trailWs}`;
            state.transEl.style.display = 'none';
            return;
          }
          if (state.inPlaceNode && state.inPlaceNode.isConnected && state.inPlaceOriginal !== undefined) {
            state.inPlaceNode.nodeValue = state.inPlaceOriginal;
          }
          if (state.hiddenTextBackups) {
            for (const [textNode, origVal] of state.hiddenTextBackups) {
              if (textNode.isConnected) textNode.nodeValue = origVal;
            }
            state.hiddenTextBackups.clear();
          }
          if (state.hiddenChildBackups) {
            for (const [childEl, origDisplay] of state.hiddenChildBackups) {
              if (childEl.isConnected) {
                childEl.style.display = origDisplay;
                delete childEl.dataset.stChHidden;
              }
            }
            state.hiddenChildBackups.clear();
          }
          state.transEl.classList.remove('st-ch-only');
          state.transEl.style.display = displayVal;
        } else if (mode === 'ch') {
          if (state.useInPlaceCh && state.inPlaceNode && state.inPlaceNode.isConnected) {
            if (state.inPlaceOriginal === undefined) {
              state.inPlaceOriginal = state.inPlaceNode.nodeValue;
            }
            state.inPlaceNode.nodeValue = state.translatedPlain;
            state.transEl.style.display = 'none';
            return;
          }
          // 隐藏原文文本节点（不动 img / svg / popup），并在富文本模式下临时隐藏已克隆到译文中的原行内子节点（如 <code>/徽章 <span>），杜绝 CH 模式下重复 <code> 与幽灵空徽章
          if (!state.hiddenTextBackups) state.hiddenTextBackups = new Map();
          const nodes = getVisibleTextNodes(el, state.directOnly);
          for (const textNode of nodes) {
            if (!state.hiddenTextBackups.has(textNode)) {
              state.hiddenTextBackups.set(textNode, textNode.nodeValue);
            }
            textNode.nodeValue = '';
          }
          if (state.hasRich) {
            if (!state.hiddenChildBackups) state.hiddenChildBackups = new Map();
            for (const ch of el.children) {
              if (
                isOwnNode(ch) ||
                MEDIA_TAGS.has(ch.tagName) ||
                ch.matches?.(POPUP_ROLE_SELECTOR) ||
                ch.tagName === 'DETAILS' ||
                ch.tagName === 'UL' ||
                ch.tagName === 'OL' ||
                ch.querySelector?.('img, picture, svg, video, canvas')
              ) {
                continue;
              }
              if (!state.hiddenChildBackups.has(ch)) {
                state.hiddenChildBackups.set(ch, ch.style.display);
                ch.dataset.stChHidden = '1';
                ch.style.display = 'none';
              }
            }
          }
          state.transEl.classList.add('st-ch-only');
          state.transEl.style.display = displayVal;
        }
      });
    }

    function applyModeToOptions(mode) {
      runInternalDomMutation(() => {
        for (const opt of activeOptions) {
          if (!opt.isConnected) {
            activeOptions.delete(opt);
            continue;
          }
          const rec = optionOriginMap.get(opt);
          if (!rec) continue;
          if (mode === 'ch') {
            opt.textContent = rec.translated;
          } else if (mode === 'bilingual') {
            opt.textContent = `${rec.original} (${rec.translated})`;
          }
        }
      });
    }

    function applyModeToTranslatedNodes(mode) {
      domWriter.enqueue(() => {
        for (const el of activeElements) {
          if (!el.isConnected) {
            elementStateMap.delete(el);
            activeElements.delete(el);
            continue;
          }
          const state = elementStateMap.get(el);
          if (state) applyModeToElement(el, state, mode);
        }
        applyModeToOptions(mode);
      });
    }

    function restoreAllElements() {
      stopDynamicObserver();
      domWriter.clear();

      runInternalDomMutation(() => {
        for (const el of Array.from(activeElements)) {
          restoreSingleElement(el);
        }
        activeElements.clear();

        for (const opt of activeOptions) {
          const rec = optionOriginMap.get(opt);
          if (opt.isConnected && rec) {
            opt.textContent = rec.original;
          }
          optionOriginMap.delete(opt);
        }
        activeOptions.clear();


        for (const field of activePlaceholders) {
          const origPh = placeholderOriginMap.get(field);
          if (field.isConnected && origPh !== undefined) {
            field.setAttribute('placeholder', origPh);
          }
          placeholderOriginMap.delete(field);
        }
        activePlaceholders.clear();
        if (origDocumentTitle !== null && document.title === translatedDocumentTitle) {
          document.title = origDocumentTitle;
        }
        origDocumentTitle = null;
        translatedDocumentTitle = null;
        document.querySelectorAll('[data-st-inflight], [data-st-translated]').forEach((n) => {
          delete n.dataset.stInflight;
          delete n.dataset.stTranslated;
        });
        firstDirtyTimestamp = 0;
        lastTriggerEl = null;
      });
    }

    // 轻量监听动态创建的开放 Shadow DOM（Web Components 延迟 attachShadow 时自动接入，零轮询开销）
    if (!Element.prototype.__stAttachShadowHooked && typeof Element.prototype.attachShadow === 'function') {
      Element.prototype.__stAttachShadowHooked = true;
      const origAttachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        const sr = origAttachShadow.call(this, init);
        if (init && init.mode === 'open' && !OWN_HOST_IDS.has(this.id)) {
          window.dispatchEvent(new CustomEvent('st:shadow-attached', { detail: sr }));
        }
        return sr;
      };
    }

    /**
     * 发现并监听开放 Shadow DOM
     */
    function attachShadowRootObserver(shadowRoot) {
      if (!shadowRoot || observedShadowRoots.has(shadowRoot)) return;
      if (shadowRoot.host && OWN_HOST_IDS.has(shadowRoot.host.id)) return;
      observedShadowRoots.add(shadowRoot);
      ensurePageStylesInRoot(shadowRoot);

      const obs = new MutationObserver((mutations) => {
        if (currentMode === 'off' || isInternalDomMutating || domWriter.isFlushing) return;
        handleMutations(mutations, shadowRoot);
      });
      obs.observe(shadowRoot, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          'hidden', 'inert', 'open', 'aria-hidden', 'aria-expanded', 'aria-selected',
          'data-state', 'data-open', 'data-visible', 'data-expanded',
          'style', 'class',
        ],
      });
      shadowObservers.set(shadowRoot, obs);
    }

    /**
     * 增量收集指定 root 子树中待翻译的可见元素（单帧 LayoutCache + 自动发现 Shadow DOM + 图片/Select 处理）
     */
    function collectIncrementalElements(roots, cache) {
      const textTargets = [];
      const optionTargets = [];
      const imgTargets = [];
      const placeholderTargets = [];
      const collectedSet = new Set();

      const hasTranslatedNonPopupAncestor = (node) => {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
        if (node.matches?.(POPUP_ROLE_SELECTOR) || node.tagName === 'DETAILS' || node.tagName === 'DIALOG') {
          return false;
        }
        let p = node.parentElement;
        while (p && p !== document.body && p !== document.documentElement) {
          if (elementStateMap.has(p) || inFlightElements.has(p) || p.dataset?.stTranslated === '1' || p.dataset?.stInflight === '1') {
            return true;
          }
          if (p.matches?.(POPUP_ROLE_SELECTOR) || p.tagName === 'DETAILS' || p.tagName === 'DIALOG') {
            return false;
          }
          p = p.parentElement;
        }
        return false;
      };

      const hasTranslatedNonPopupDescendant = (node) => {
        if (!node || node.nodeType !== Node.ELEMENT_NODE || node.childElementCount === 0) return false;
        const matches = node.querySelectorAll('[data-st-translated="1"], [data-st-inflight="1"], .st-trans-block, .st-trans-inline');
        for (const m of matches) {
          let inNestedPopup = false;
          let cur = m;
          while (cur && cur !== node) {
            if (cur.matches?.(POPUP_ROLE_SELECTOR) || cur.tagName === 'DETAILS' || cur.tagName === 'DIALOG') {
              inNestedPopup = true;
              break;
            }
            cur = cur.parentElement;
          }
          if (!inNestedPopup) return true;
        }
        return false;
      };

      const walkRoot = (rootNode) => {
        if (!rootNode) return;
        if (rootNode !== document.body && !(rootNode instanceof ShadowRoot) && !rootNode.isConnected) return;
        if (rootNode.nodeType === Node.ELEMENT_NODE && isOwnNode(rootNode)) return;

        // 防止对已翻译组件内部子节点交互（hover/click 触发 class/style 变化）时重复翻译子节点！
        if (rootNode.nodeType === Node.ELEMENT_NODE && rootNode !== document.body && hasTranslatedNonPopupAncestor(rootNode)) {
          return;
        }

        // 如果 rootNode 本身是元素且自身隐藏，直接剪枝
        if (rootNode.nodeType === Node.ELEMENT_NODE && rootNode !== document.body && cache.isNodeSelfHidden(rootNode)) {
          return;
        }

        const acceptElement = (node) => {
          if (isOwnNode(node)) return NodeFilter.FILTER_REJECT;
          if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
            if (!placeholderOriginMap.has(node) && cache.isElementVisible(node)) {
              const ph = (node.getAttribute('placeholder') || '').trim();
              if (ph.length >= 2 && ph.length <= 120 && isForeignTextValid(ph)) {
                placeholderTargets.push({ field: node, text: ph });
              }
            }
            return NodeFilter.FILTER_REJECT;
          }
          if (node.tagName === 'IFRAME') {
            try {
              const iDoc = node.contentDocument;
              if (iDoc && iDoc.body && !isOwnNode(node) && cache.isElementVisible(node)) {
                if (!iDoc.getElementById('st-page-trans-style')) {
                  const st = iDoc.createElement('style');
                  st.id = 'st-page-trans-style';
                  st.textContent = PAGE_TRANS_CSS;
                  (iDoc.head || iDoc.documentElement).appendChild(st);
                }
                walkRoot(iDoc.body);
              }
            } catch (_) {
              // 跨域 iframe 静默跳过
            }
            return NodeFilter.FILTER_REJECT;
          }
          if (SKIP_TAGS.has(node.tagName) || isEditableOrIconOrMath(node)) return NodeFilter.FILTER_REJECT;
          if (node.classList?.contains('notranslate') || node.getAttribute('translate') === 'no') {
            return NodeFilter.FILTER_REJECT;
          }
          // 若该节点已由第三方翻译插件或页面原生提供了中文译文，直接跳过不再重复翻译
          if (hasExternalTranslation(node)) {
            return NodeFilter.FILTER_REJECT;
          }

          // 若节点已翻译，使用挂载时记录的精确 visibleTextFingerprint 比对，彻底消除含 <code>/<strong> 富文本元素交互时的误重译
          if (elementStateMap.has(node)) {
            const state = elementStateMap.get(node);
            if (!cache.isElementVisible(node)) return NodeFilter.FILTER_REJECT;
            // 若框架重渲染清除了我们挂载的 transEl（且非原位文本模式），清理陈旧状态以便重新翻译
            const usesInPlaceNow = (currentMode === 'bilingual' && state.useInPlaceBilingual) || (currentMode === 'ch' && state.useInPlaceCh);
            if (!usesInPlaceNow && (!state.transEl || !state.transEl.isConnected)) {
              elementStateMap.delete(node);
              activeElements.delete(node);
              delete node.dataset.stTranslated;
            } else {
            const liveText = (state.directOnly ? getDirectTextContent(node) : getElementVisibleText(node, cache)).replace(/\s+/g, ' ').trim();
            const normOrig = state.visibleTextFingerprint || state.originalPlain;
            const normTrans = (state.translatedPlain || '').replace(/\s+/g, ' ').trim();

            if (currentMode === 'bilingual') {
              const expectedInPlaceBi = state.useInPlaceBilingual
                ? `${normOrig} ${normTrans}`.replace(/\s+/g, ' ').trim()
                : '';
              if (!liveText || liveText === normOrig || liveText === state.originalPlain || (expectedInPlaceBi && liveText === expectedInPlaceBi)) {
                return NodeFilter.FILTER_REJECT;
              }
              if (isForeignTextValid(liveText)) {
                restoreSingleElement(node);
              } else {
                return NodeFilter.FILTER_REJECT;
              }
            } else if (currentMode === 'ch') {
              if (!liveText || liveText === normTrans || liveText === normOrig) {
                return NodeFilter.FILTER_REJECT;
              }
              if (isForeignTextValid(liveText)) {
                runInternalDomMutation(() => {
                  if (state.transEl && state.transEl.isConnected) state.transEl.remove();
                  if (state.hiddenTextBackups) state.hiddenTextBackups.clear();
                });
                delete node.dataset.stTranslated;
                elementStateMap.delete(node);
                activeElements.delete(node);
              } else {
                return NodeFilter.FILTER_REJECT;
              }
            } else {
              return NodeFilter.FILTER_REJECT;
            }
            }
          }

          if (cache.isNodeSelfHidden(node)) return NodeFilter.FILTER_REJECT;
          if (node.tagName === 'DETAILS' && !node.open) return NodeFilter.FILTER_SKIP;

          // 发现开放 Shadow DOM
          if (node.shadowRoot && !OWN_HOST_IDS.has(node.id)) {
            attachShadowRootObserver(node.shadowRoot);
            walkRoot(node.shadowRoot);
          }

          // 原生 <select> 的 <option> 专项收集（不破坏原生 select 结构）
          if (node.tagName === 'SELECT') {
            if (cache.isElementVisible(node)) {
              for (const opt of node.options) {
                if (optionOriginMap.has(opt)) continue;
                const txt = (opt.textContent || '').trim();
                if (isForeignTextValid(txt)) {
                  optionTargets.push({ opt, text: txt });
                }
              }
            }
            return NodeFilter.FILTER_REJECT;
          }
          if (node.tagName === 'OPTION') return NodeFilter.FILTER_REJECT;

          // 无论文字翻译状态如何，绝不自动翻译图片（仅由用户右键「翻译图片」手动触发）
          if (node.tagName === 'IMG') {
            return NodeFilter.FILTER_REJECT;
          }

          if (inFlightElements.has(node)) return NodeFilter.FILTER_REJECT;

          const tag = node.tagName;
          const isContainer = COLLECTIBLE_CONTAINER_TAGS.has(tag);

          // 若容器内部已有已翻译或翻译中的非弹出层子元素，绝不对该外层容器重复翻译（防止交互悬停外层 div 产生双份译文）
          if (hasTranslatedNonPopupDescendant(node)) {
            return NodeFilter.FILTER_SKIP;
          }

          if (hasDedicatedInnerTextChild(node, cache)) {
            return NodeFilter.FILTER_SKIP;
          }

          if (TRANSLATABLE_TAGS.has(tag)) {
            const text = getElementVisibleText(node, cache);
            if (isForeignTextValid(text) && cache.isElementVisible(node)) {
              return NodeFilter.FILTER_ACCEPT;
            }
          } else if (isContainer) {
            const hasBlock = hasVisibleTranslatableChild(node, cache);
            const candidateText = hasBlock ? getDirectTextContent(node) : getElementVisibleText(node, cache);
            if (isForeignTextValid(candidateText) && cache.isElementVisible(node)) {
              return NodeFilter.FILTER_ACCEPT;
            }
          }
          return NodeFilter.FILTER_SKIP;
        };

        // 如果 rootNode 本身是可翻译元素（例如属性变化使单个 tooltip 变为可见）
        if (rootNode.nodeType === Node.ELEMENT_NODE && rootNode !== document.body) {
          const selfStatus = acceptElement(rootNode);
          if (selfStatus === NodeFilter.FILTER_ACCEPT) {
            if (!collectedSet.has(rootNode)) {
              collectedSet.add(rootNode);
              textTargets.push(rootNode);
            }
            return;
          } else if (selfStatus === NodeFilter.FILTER_REJECT) {
            return;
          }
        }

        const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT, {
          acceptNode: acceptElement,
        });

        let current;
        while ((current = walker.nextNode())) {
          let parent = current.parentElement;
          let ancestorCollected = false;
          while (parent && parent !== rootNode && parent !== document.body) {
            if (parent.matches?.(POPUP_ROLE_SELECTOR) || parent.tagName === 'DETAILS' || parent.tagName === 'DIALOG') {
              break;
            }
            if (collectedSet.has(parent) || elementStateMap.has(parent)) {
              ancestorCollected = true;
              break;
            }
            parent = parent.parentElement;
          }
          if (!ancestorCollected && !collectedSet.has(current)) {
            collectedSet.add(current);
            textTargets.push(current);
          }
        }
      };

      for (const root of roots) {
        walkRoot(root);
      }

      return { textTargets, optionTargets, imgTargets, placeholderTargets };
    }

    function mountTranslationIntoElement(el, translated, seg, precomputed) {
      if (!el.isConnected || elementStateMap.has(el)) return;
      // 铁律防重：若自身、非弹出层祖先或非弹出层后代已存在译文，绝不重复挂载
      if (el.dataset?.stTranslated === '1') return;
      const existingDesc = el.querySelectorAll('[data-st-translated="1"], .st-trans-block, .st-trans-inline');
      for (const m of existingDesc) {
        let inPopup = false;
        let cur = m;
        while (cur && cur !== el) {
          if (cur.matches?.(POPUP_ROLE_SELECTOR) || cur.tagName === 'DETAILS' || cur.tagName === 'DIALOG') {
            inPopup = true;
            break;
          }
          cur = cur.parentElement;
        }
        if (!inPopup) return;
      }
      if (!el.matches?.(POPUP_ROLE_SELECTOR) && el.tagName !== 'DETAILS' && el.tagName !== 'DIALOG') {
        let p = el.parentElement;
        while (p && p !== document.body && p !== document.documentElement) {
          if (elementStateMap.has(p) || p.dataset?.stTranslated === '1') return;
          if (p.matches?.(POPUP_ROLE_SELECTOR) || p.tagName === 'DETAILS' || p.tagName === 'DIALOG') break;
          p = p.parentElement;
        }
      }
      const visibleTextFingerprint = (seg.directOnly ? getDirectTextContent(el) : getElementVisibleText(el, null))
        .replace(/\s+/g, ' ')
        .trim();

      const isInline = precomputed.layoutStrategy === 'inline';
      const transEl = document.createElement('span');
      transEl.className = isInline ? 'st-trans-inline' : 'st-trans-block';

      if (seg.hasRich) {
        transEl.appendChild(buildRichTranslationFragment(translated, seg.tokens));
      } else {
        transEl.textContent = translated;
      }

      const colorSourceEl = (seg.styleSource && seg.styleSource.isConnected) ? seg.styleSource : el;
      const sameColorSource = colorSourceEl === el;
      const liveSourceStyle = window.getComputedStyle(colorSourceEl);
      copyVisualStyleFromElement(colorSourceEl, transEl, {
        sourceStyle: liveSourceStyle,
        isInline,
        isInteractive: isInline,
        preserveExactColor: isInline,
        deferColorUntilMounted: sameColorSource,
      });

      const styleRestores = {};
      const elStyle = precomputed.elStyle;

      // 判断是否可无损原位替换 TextNode（零多余 DOM）；若 el 是 flex/grid 容器且文本直接位于其下，双语与 CH 模式均直接原位更新，不向容器插入多余 DOM 节点
      const visibleNodes = getVisibleTextNodes(el, seg.directOnly);
      const canInPlace = !seg.hasRich && visibleNodes.length === 1;
      const inPlaceNode = canInPlace ? visibleNodes[0] : null;
      const isFlexOrGridDirectText = Boolean(
        inPlaceNode &&
        inPlaceNode.parentElement === el &&
        elStyle.display &&
        (elStyle.display.includes('flex') || elStyle.display.includes('grid'))
      );

      if (!isFlexOrGridDirectText) {
        runInternalDomMutation(() => {
          if (!isInline) {
            if (elStyle.webkitLineClamp && elStyle.webkitLineClamp !== 'none') {
              styleRestores.webkitLineClamp = el.style.webkitLineClamp;
              el.style.webkitLineClamp = 'unset';
            }
            el.appendChild(transEl);
          } else {
            const lastText = visibleNodes.length > 0 ? visibleNodes[visibleNodes.length - 1] : null;
            if (lastText && lastText.parentNode) {
              lastText.parentNode.insertBefore(transEl, lastText.nextSibling);
            } else {
              el.appendChild(transEl);
            }
          }
        });
      }

      const state = {
        transEl,
        isInline,
        hasRich: Boolean(seg.hasRich),
        directOnly: Boolean(seg.directOnly),
        styleRestores,
        useInPlaceCh: Boolean(canInPlace && inPlaceNode),
        useInPlaceBilingual: isFlexOrGridDirectText,
        inPlaceNode,
        inPlaceOriginal: undefined,
        hiddenTextBackups: null,
        visibleTextFingerprint,
        originalPlain: seg.text.replace(/(?:\[|【)\s*(?:\[|【)\s*(?:C|L|\/[\s]*L)\s*\d+\s*(?:\]|】)\s*(?:\]|】)/gi, '').replace(/\s+/g, ' ').trim(),
        translatedPlain: translated.replace(/(?:\[|【)\s*(?:\[|【)\s*(?:C|L|\/[\s]*L)\s*\d+\s*(?:\]|】)\s*(?:\]|】)/gi, ''),
      };

      state.colorSourceEl = seg.styleSource || el;
      state.colorForced = !sameColorSource;
      el.dataset.stTranslated = '1';
      delete el.dataset.stInflight;
      elementStateMap.set(el, state);
      activeElements.add(el);
      applyModeToElement(el, state, currentMode);

      // 将继承色校验延后到本帧全部写入结束后的集中读取阶段（1 次样式重算替代 N 次强制回流）
      if (
        sameColorSource &&
        transEl.isConnected &&
        !transEl.style.getPropertyValue('background-image') &&
        liveSourceStyle.color &&
        liveSourceStyle.color !== 'transparent' &&
        liveSourceStyle.color !== 'rgba(0, 0, 0, 0)'
      ) {
        const expectedCol = liveSourceStyle.color;
        domWriter.enqueuePostRead(() => {
          if (!transEl.isConnected) return null;
          const actualColor = window.getComputedStyle(transEl).color;
          if (actualColor !== expectedCol) {
            return () => {
              transEl.style.setProperty('color', expectedCol, 'important');
              state.colorForced = true;
            };
          }
          return null;
        });
      }
    }

    /**
     * 合并有父子包含关系的脏根节点，避免对同一子树重复遍历
     */
    function coalesceDirtyRoots(rawSet) {
      const validSet = new Set();
      for (const n of rawSet) {
        if (!n) continue;
        if (n === document.body) return [document.body];
        if (n instanceof ShadowRoot || n.isConnected) validSet.add(n);
      }
      if (validSet.size <= 1) return Array.from(validSet);

      // O(K * D) 线性祖先去重，避免无限滚动突发上百脏节点时的 O(K^2) 开销
      const kept = [];
      for (const candidate of validSet) {
        let covered = false;
        let p = candidate.parentElement;
        while (p && p !== document.body && p !== document.documentElement) {
          if (validSet.has(p)) {
            covered = true;
            break;
          }
          p = p.parentElement;
        }
        if (!covered) kept.push(candidate);
      }
      return kept;
    }

    function pruneDisconnectedRecords() {
      for (const el of activeElements) {
        if (!el.isConnected) {
          elementStateMap.delete(el);
          activeElements.delete(el);
        }
      }
      for (const opt of activeOptions) {
        if (!opt.isConnected) {
          optionOriginMap.delete(opt);
          activeOptions.delete(opt);
        }
      }

      for (const field of activePlaceholders) {
        if (!field.isConnected) {
          placeholderOriginMap.delete(field);
          activePlaceholders.delete(field);
        }
      }
      for (const [sr, obs] of shadowObservers) {
        if (!sr.host || !sr.host.isConnected) {
          obs.disconnect();
          shadowObservers.delete(sr);
        }
      }
    }

    function flushDirtyRoots() {
      scanTimer = null;
      firstDirtyTimestamp = 0;
      if (currentMode === 'off' || dirtyRoots.size === 0) return;
      if (activeElements.size > 180) pruneDisconnectedRecords();
      const roots = coalesceDirtyRoots(dirtyRoots);
      dirtyRoots.clear();
      if (roots.length > 0) {
        scanAndTranslateRoots(roots, sessionId);
      }
    }

    function scheduleDirtyFlush(delayMs) {
      const now = Date.now();
      if (!firstDirtyTimestamp) firstDirtyTimestamp = now;
      const elapsed = now - firstDirtyTimestamp;
      const effectiveDelay = elapsed >= MAX_DEBOUNCE_WAIT_MS ? 16 : Math.min(delayMs, MAX_DEBOUNCE_WAIT_MS - elapsed);
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(flushDirtyRoots, effectiveDelay);
    }

    function schedulePopupAnimationFollowUp(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE || isOwnNode(el)) return;
      if (popupFollowUpTimers.has(el)) return;
      const t = setTimeout(() => {
        popupFollowUpTimers.delete(el);
        if (currentMode !== 'off' && el.isConnected && !computeNodeSelfHidden(el, null)) {
          enqueueDirtyRoot(el, 40);
        }
      }, 280);
      popupFollowUpTimers.set(el, t);
    }

    function enqueueDirtyRoot(node, delayMs = 110) {
      if (currentMode === 'off' || !node) return;
      if (node.nodeType === Node.ELEMENT_NODE && isOwnNode(node)) return;
      dirtyRoots.add(node);
      scheduleDirtyFlush(delayMs);
    }

    async function scanAndTranslateRoots(roots, mySession) {
      if (currentMode === 'off' || sessionId !== mySession) return;
      const signal = sessionAbortController ? sessionAbortController.signal : null;

      // 单帧 LayoutCache 统一完成读取阶段，杜绝读写交替回流
      const cache = new ScanLayoutCache();
      const { textTargets, optionTargets, imgTargets, placeholderTargets } = collectIncrementalElements(roots, cache);

      if (textTargets.length === 0 && optionTargets.length === 0 && imgTargets.length === 0 && placeholderTargets.length === 0) {
        return;
      }

      const vh = window.innerHeight;
      const scored = textTargets.map((el) => {
        const r = cache.getRect(el);
        const inView = r.bottom >= -200 && r.top <= vh + 400 ? 0 : 1;
        return { el, inView, top: r.top };
      });
      scored.sort((a, b) => a.inView - b.inView || a.top - b.top);

      const buildElItem = (el) => {
        const isContainer = COLLECTIBLE_CONTAINER_TAGS.has(el.tagName);
        const directOnly = isContainer && hasVisibleTranslatableChild(el, cache);
        const seg = extractRichSegment(el, directOnly, cache);
        if (!isForeignTextValid(seg.text)) return null;

        const elStyle = cache.getStyle(el);
        const sourceStyle = seg.styleSource && seg.styleSource !== el ? cache.getStyle(seg.styleSource) : elStyle;
        const layoutStrategy = determineLayoutStrategy(el, elStyle, seg.hasMedia, cache);

        inFlightElements.add(el);
        if (el.dataset) el.dataset.stInflight = '1';
        return {
          kind: 'el',
          el,
          seg,
          text: seg.text,
          precomputed: {
            layoutStrategy,
            elStyle: {
              display: elStyle.display,
              webkitLineClamp: elStyle.webkitLineClamp,
            },
            sourceStyle: {
              backgroundImage: sourceStyle.backgroundImage,
              backgroundSize: sourceStyle.backgroundSize,
              backgroundPosition: sourceStyle.backgroundPosition,
              backgroundRepeat: sourceStyle.backgroundRepeat,
              backgroundClip: sourceStyle.backgroundClip,
              webkitBackgroundClip: sourceStyle.webkitBackgroundClip,
              webkitTextFillColor: sourceStyle.webkitTextFillColor,
              color: sourceStyle.color,
              fontWeight: sourceStyle.fontWeight,
              fontStyle: sourceStyle.fontStyle,
              letterSpacing: sourceStyle.letterSpacing,
              textShadow: sourceStyle.textShadow,
              textAlign: sourceStyle.textAlign,
            },
          },
        };
      };

      const applyResolvedItem = (item, translated) => {
        if (item.kind === 'el') {
          inFlightElements.delete(item.el);
          if (item.el?.dataset) delete item.el.dataset.stInflight;
        }
        if (currentMode === 'off' || sessionId !== mySession) return;
        if (!translated || !translated.trim()) return;

        domWriter.enqueue(() => {
          if (currentMode === 'off' || sessionId !== mySession) return;

          if (item.kind === 'el') {
            const { el, seg, precomputed } = item;
            if (!el || !el.isConnected || elementStateMap.has(el)) return;
            if (!computeElementVisible(el, null)) return;
            const clean = translated.trim();
            if (clean === seg.text || normalizeForEquality(clean) === normalizeForEquality(seg.text)) return;
            mountTranslationIntoElement(el, clean, seg, precomputed);
          } else if (item.kind === 'option') {
            const { opt, text } = item;
            if (!opt.isConnected || optionOriginMap.has(opt)) return;
            const clean = translated.trim();
            if (clean === text) return;
            optionOriginMap.set(opt, { original: text, translated: clean });
            activeOptions.add(opt);
            runInternalDomMutation(() => {
              opt.textContent = currentMode === 'ch' ? clean : `${text} (${clean})`;
            });
          } else if (item.kind === 'img') {
            const { img, hasTitle, origTitle, hasAlt, origAlt } = item;
            if (!img.isConnected || imgAttrOriginMap.has(img)) return;
            const clean = translated.trim();
            imgAttrOriginMap.set(img, { hadTitle: hasTitle, origTitle, hadAlt: hasAlt, origAlt });
            activeImgs.add(img);
            runInternalDomMutation(() => {
              img.setAttribute('title', clean);
              if (hasAlt) img.setAttribute('alt', clean);
            });
          } else if (item.kind === 'placeholder') {
            const { field, text } = item;
            if (!field.isConnected || placeholderOriginMap.has(field)) return;
            const clean = translated.trim();
            if (clean === text) return;
            placeholderOriginMap.set(field, text);
            activePlaceholders.add(field);
            runInternalDomMutation(() => {
              field.setAttribute('placeholder', clean);
            });
          } else if (item.kind === 'docTitle') {
            const clean = translated.trim();
            if (clean && clean !== item.text && origDocumentTitle === null) {
              origDocumentTitle = document.title;
              translatedDocumentTitle = clean;
              document.title = clean;
            }
          }
        });
      };

      const dispatchItems = async (batchItems) => {
        if (batchItems.length === 0) return;
        // 同步直出：命中 UI 词表或 L1/L2/L3 缓存的条目立刻入帧渲染，仅未命中条目进入网络队列
        const networkItems = [];
        for (const item of batchItems) {
          const cleanText = typeof item.text === 'string' ? item.text.replace(/\u0000/g, '') : '';
          const uiHit = lookupExactUiTerm(cleanText);
          if (uiHit) {
            applyResolvedItem(item, uiHit);
            continue;
          }
          const cacheKey = makeCacheKey(cleanText);
          if (translationCache.has(cacheKey)) {
            applyResolvedItem(item, translationCache.get(cacheKey));
            continue;
          }
          networkItems.push(item);
        }
        if (networkItems.length === 0) return;

        await translateMany(
          networkItems.map((it) => it.text),
          (idx, translated) => applyResolvedItem(networkItems[idx], translated),
          () => currentMode === 'off' || sessionId !== mySession,
          signal
        );
      };

      const viewportScored = scored.filter((s) => s.inView === 0);
      const offscreenScored = scored.filter((s) => s.inView !== 0);

      const viewportItems = [];
      for (const { el } of viewportScored) {
        const it = buildElItem(el);
        if (it) viewportItems.push(it);
      }

      activeBatches++;
      updateSpinner();

      const allItems = [...viewportItems];
      try {
        // 先行发出首屏请求，网络往返期间并行提取屏外节点，最大化重叠 CPU 与网络耗时
        const vpPromise = dispatchItems(viewportItems);

        // 超长页面（屏外节点 > 180）时，先预译紧邻视口的前 120 个节点，更深处的节点交给 IntersectionObserver 提前 600px 按需触发，省 70%+ 无效首屏流量
        const EAGER_OFFSCREEN_LIMIT = 120;
        const useLazyObserver = offscreenScored.length > 180 && typeof IntersectionObserver === 'function';
        const eagerOffscreen = useLazyObserver ? offscreenScored.slice(0, EAGER_OFFSCREEN_LIMIT) : offscreenScored;
        const deferredOffscreen = useLazyObserver ? offscreenScored.slice(EAGER_OFFSCREEN_LIMIT) : [];

        const offscreenItems = [];
        for (const { el } of eagerOffscreen) {
          if (currentMode === 'off' || sessionId !== mySession) break;
          const it = buildElItem(el);
          if (it) offscreenItems.push(it);
        }
        for (const o of optionTargets) offscreenItems.push({ kind: 'option', opt: o.opt, text: o.text });
        for (const im of imgTargets) offscreenItems.push({ kind: 'img', ...im });
        for (const ph of placeholderTargets) offscreenItems.push({ kind: 'placeholder', field: ph.field, text: ph.text });
        if (origDocumentTitle === null && document.title && isForeignTextValid(document.title)) {
          offscreenItems.push({ kind: 'docTitle', text: document.title.trim() });
        }
        allItems.push(...offscreenItems);

        if (deferredOffscreen.length > 0 && currentMode !== 'off' && sessionId === mySession) {
          if (!lazyViewportObserver) {
            lazyViewportObserver = new IntersectionObserver(
              (entries) => {
                if (currentMode === 'off') return;
                for (const entry of entries) {
                  if (entry.isIntersecting) {
                    lazyViewportObserver?.unobserve(entry.target);
                    if (!elementStateMap.has(entry.target) && !inFlightElements.has(entry.target)) {
                      enqueueDirtyRoot(entry.target, 50);
                    }
                  }
                }
              },
              { rootMargin: '600px 0px 600px 0px' }
            );
          }
          for (const { el } of deferredOffscreen) {
            if (el && el.isConnected) lazyViewportObserver.observe(el);
          }
        }

        await Promise.all([vpPromise, dispatchItems(offscreenItems)]);
      } finally {
        for (const it of allItems) {
          if (it.kind === 'el') { inFlightElements.delete(it.el); if (it.el?.dataset) delete it.el.dataset.stInflight; }
        }
        activeBatches = Math.max(0, activeBatches - 1);
        updateSpinner();
      }
    }

    /**
     * 解析触发元素关联的 Portal / 弹出层目标（aria-controls / aria-describedby / aria-owns / popovertarget）
     */
    function enqueueLinkedPopupTargets(triggerEl) {
      if (!triggerEl || triggerEl.nodeType !== Node.ELEMENT_NODE) return;
      const rootNode = triggerEl.getRootNode?.() || document;
      const getById = (id) => (rootNode.getElementById ? rootNode.getElementById(id) : document.getElementById(id));

      const idAttrs = ['aria-controls', 'aria-describedby', 'aria-owns', 'popovertarget'];
      for (const attr of idAttrs) {
        const val = triggerEl.getAttribute(attr);
        if (!val) continue;
        for (const id of val.split(/\s+/)) {
          if (!id) continue;
          const linked = getById(id);
          if (linked && linked.isConnected && !isOwnNode(linked)) {
            enqueueDirtyRoot(linked, 70);
          }
        }
      }

      // 若触发器在 <details> / accordion / 纯 CSS :hover 下拉菜单容器内，仅扫描新显影的局部子弹出层而非全页
      const localComponent = triggerEl.closest('details, li, [role="menu"], [role="menubar"], [role="tablist"], [data-accordion-item], [class*="dropdown"], [class*="tooltip"], [class*="popover"], [class*="menu-item"]');
      if (localComponent && !isOwnNode(localComponent) && localComponent !== document.body) {
        const cssPopups = localComponent.querySelectorAll(
          'ul, [role="menu"], [role="tooltip"], [role="listbox"], [role="dialog"], [class*="dropdown"], [class*="submenu"], [class*="tooltip"], [class*="popover"]'
        );
        for (const pop of cssPopups) {
          if (pop !== triggerEl && !isOwnNode(pop) && !elementStateMap.has(pop) && !computeNodeSelfHidden(pop, null)) {
            enqueueDirtyRoot(pop, 60);
          }
        }
        if (localComponent.tagName === 'DETAILS' || localComponent.hasAttribute('data-accordion-item')) {
          enqueueDirtyRoot(localComponent, 60);
        }
      }
    }

    function handleMutations(mutations, observerRoot) {
      if (currentMode === 'off' || isInternalDomMutating || domWriter.isFlushing) return;

      let fastDelay = 120;
      let hasRelevant = false;

      for (const m of mutations) {
        const target = m.target;
        if (target && isOwnNode(target)) continue;

        if (m.type === 'childList') {
          // 虚拟列表/React 重渲染移除了我们挂载的译文节点时，立刻清理陈旧状态并重新入队
          if (m.removedNodes.length > 0 && target && target.nodeType === Node.ELEMENT_NODE && elementStateMap.has(target)) {
            for (const rem of m.removedNodes) {
              if (rem.nodeType === Node.ELEMENT_NODE && (rem.classList?.contains('st-trans-block') || rem.classList?.contains('st-trans-inline'))) {
                elementStateMap.delete(target);
                activeElements.delete(target);
                delete target.dataset.stTranslated;
                dirtyRoots.add(target);
                hasRelevant = true;
                fastDelay = 60;
                break;
              }
            }
          }
          for (const added of m.addedNodes) {
            if (added.nodeType === Node.ELEMENT_NODE) {
              if (isOwnNode(added)) continue;
              if (added.tagName === 'OPTION' && target && target.tagName === 'SELECT') {
                dirtyRoots.add(target);
              } else {
                dirtyRoots.add(added);
              }
              hasRelevant = true;
              if (added.matches?.(POPUP_ROLE_SELECTOR) || (Date.now() - lastInteractionTime < 600)) {
                fastDelay = 60;
              }
            } else if (added.nodeType === Node.TEXT_NODE && target && target.nodeType === Node.ELEMENT_NODE) {
              if (added.nodeValue && added.nodeValue.trim()) {
                dirtyRoots.add(target);
                hasRelevant = true;
              }
            }
          }
        } else if (m.type === 'characterData') {
          const parentEl = target?.parentElement;
          if (!parentEl || isOwnNode(parentEl) || SKIP_TAGS.has(parentEl.tagName) || isEditableOrIconOrMath(parentEl)) {
            continue;
          }
          const newVal = (target.nodeValue || '').trim();
          // 过滤纯数字/倒计时/进度条等高频非外语文本更新
          if (newVal.length < 2 || !/[A-Za-z\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\uAC00-\uD7AF]/.test(newVal)) {
            continue;
          }
          // 若文本节点位于已翻译元素内部，将已翻译容器本身入队以触发精确指纹重译（支持 React/Vue/Svelte 直接改写 nodeValue）
          let rootTarget = parentEl;
          let cur = parentEl;
          while (cur && cur !== document.body && cur !== document.documentElement) {
            if (elementStateMap.has(cur)) {
              rootTarget = cur;
              break;
            }
            if (cur.matches?.(POPUP_ROLE_SELECTOR) || cur.tagName === 'DETAILS' || cur.tagName === 'DIALOG') break;
            cur = cur.parentElement;
          }
          dirtyRoots.add(rootTarget);
          hasRelevant = true;
          fastDelay = 80;
        } else if (m.type === 'attributes' && target && target.nodeType === Node.ELEMENT_NODE) {
          const attr = m.attributeName;
          // 跳过已翻译元素自身及内部非弹出层子节点的高频 style/class 交互变动（悬停高亮/点击态等）
          if (elementStateMap.has(target) && (attr === 'style' || attr === 'class')) continue;

          // 对高频 class/style 变动做精准过滤：仅在交互窗口期、弹出层/折叠组件或显式可见性属性变更时入队
          const isStateAttr =
            attr === 'hidden' ||
            attr === 'inert' ||
            attr === 'open' ||
            attr === 'aria-hidden' ||
            attr === 'aria-expanded' ||
            attr === 'aria-selected' ||
            attr === 'data-state' ||
            attr === 'data-open' ||
            attr === 'data-visible' ||
            attr === 'data-expanded';

          if (isStateAttr) {
            // 若是触发器自身 aria-expanded="true"，顺带追踪其 aria-controls 指向的弹出层
            if (
              (attr === 'aria-expanded' && target.getAttribute('aria-expanded') === 'true') ||
              (attr === 'aria-selected' && target.getAttribute('aria-selected') === 'true')
            ) {
              enqueueLinkedPopupTargets(target);
            }
            dirtyRoots.add(target);
            hasRelevant = true;
            fastDelay = 60;
          } else if (attr === 'style' || attr === 'class') {
            if (target.shadowRoot) attachShadowRootObserver(target.shadowRoot);
            const nowTs = Date.now();
            const recentlyInteracted = nowTs - lastInteractionTime < 800;
            const recentlyScrolled = nowTs - lastScrollTime < 700;
            const isPopupLike =
              target.matches?.(POPUP_ROLE_SELECTOR) ||
              target.closest?.(POPUP_ROLE_SELECTOR) ||
              target.hasAttribute('data-state') ||
              target.hasAttribute('data-open');
            if (recentlyInteracted || isPopupLike) {
              dirtyRoots.add(target);
              hasRelevant = true;
              fastDelay = 60;
            } else if (!elementStateMap.has(target) && !computeNodeSelfHidden(target, null)) {
              // 异步延迟显影组件（如 >800ms 接口返回后移除 hidden class 或滚动显影），仅当含未译外语文本时入队
              const quickTxt = (target.textContent || '').trim();
              if (quickTxt.length >= 2 && /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u3040-\u30FF\uAC00-\uD7AF]/.test(quickTxt)) {
                dirtyRoots.add(target);
                hasRelevant = true;
                fastDelay = recentlyScrolled ? 100 : 140;
              }
            }
          }
        }
      }

      if (hasRelevant) {
        // 对处于动画过渡起点（opacity~0 / scale(0)）的弹出层安排单节点延迟复检，绝不触发全页扫描
        for (const r of dirtyRoots) {
          if (
            r.nodeType === Node.ELEMENT_NODE &&
            (r.matches?.(POPUP_ROLE_SELECTOR) || r.hasAttribute?.('data-state') || r.hasAttribute?.('data-open')) &&
            computeNodeSelfHidden(r, null)
          ) {
            schedulePopupAnimationFollowUp(r);
          }
        }
        scheduleDirtyFlush(fastDelay);
      }
    }

    const onUserInteraction = (e) => {
      if (currentMode === 'off') return;
      const target = e.target;
      if (!target || target.nodeType !== Node.ELEMENT_NODE) return;
      // 仅忽略插件自身的悬浮球与词库弹窗，绝不忽略点击/悬停在已译按钮内部的 .st-trans-inline/.st-trans-block！
      if (target.closest?.('#st-floating-host, #st-glossary-modal-host, .st-gh-standalone-bar')) return;

      const interactive = target.closest?.(
        'button, a, summary, [aria-haspopup], [aria-expanded], [aria-controls], [aria-describedby], [popovertarget], [data-state], [role="button"], [role="menuitem"], [role="tab"], [data-tooltip], details'
      );

      if (e.type === 'pointerenter' || e.type === 'mouseover') {
        if (!interactive || interactive === lastTriggerEl) return;
        lastTriggerEl = interactive;
        lastInteractionTime = Date.now();
        enqueueLinkedPopupTargets(interactive);
      } else if (e.type === 'click' || e.type === 'focusin' || e.type === 'keydown') {
        if (e.type === 'keydown' && !['Enter', ' ', 'ArrowDown', 'ArrowUp', 'ArrowRight'].includes(e.key)) {
          return;
        }
        lastTriggerEl = interactive || target;
        lastInteractionTime = Date.now();
        if (interactive) {
          enqueueLinkedPopupTargets(interactive);
        }
      } else if (e.type === 'toggle' || e.type === 'transitionend' || e.type === 'animationend') {
        // 动画展开完成或 <details> / [popover] 切换展开后，仅增量扫描目标组件
        if (!computeNodeSelfHidden(target, null)) {
          enqueueDirtyRoot(target, 50);
        }
      }
    };

    function ensureDynamicObserver() {
      if (!dynamicObserver && document.body) {
        dynamicObserver = new MutationObserver((mutations) => handleMutations(mutations, document.body));
        dynamicObserver.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: [
            'hidden', 'inert', 'open', 'aria-hidden', 'aria-expanded', 'aria-selected',
            'data-state', 'data-open', 'data-visible', 'data-expanded',
            'style', 'class',
          ],
        });
      }

      if (!interactionListenersBound) {
        interactionListenersBound = true;
        document.addEventListener('mouseover', onUserInteraction, true);
        document.addEventListener('click', onUserInteraction, true);
        document.addEventListener('focusin', onUserInteraction, true);
        document.addEventListener('keydown', onUserInteraction, true);
        document.addEventListener('toggle', onUserInteraction, true);
        document.addEventListener('transitionend', onUserInteraction, true);
        document.addEventListener('animationend', onUserInteraction, true);
      }

      if (!scrollListenerBound) {
        scrollListenerBound = true;
        window.addEventListener('scroll', onWindowScroll, { passive: true, capture: true });
        window.addEventListener('st:shadow-attached', onDynamicShadowAttached);
      }

      if (!themeObserver && document.documentElement) {
        themeObserver = new MutationObserver(() => refreshForcedColorsForThemeChange());
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'data-theme', 'data-color-mode', 'data-mode'],
        });
      }
    }

    function stopDynamicObserver() {
      if (dynamicObserver) {
        dynamicObserver.disconnect();
        dynamicObserver = null;
      }
      for (const [, obs] of shadowObservers) {
        obs.disconnect();
      }
      shadowObservers.clear();

      if (scanTimer) {
        clearTimeout(scanTimer);
        scanTimer = null;
      }
      dirtyRoots.clear();

      if (interactionListenersBound) {
        interactionListenersBound = false;
        document.removeEventListener('mouseover', onUserInteraction, true);
        document.removeEventListener('click', onUserInteraction, true);
        document.removeEventListener('focusin', onUserInteraction, true);
        document.removeEventListener('keydown', onUserInteraction, true);
        document.removeEventListener('toggle', onUserInteraction, true);
        document.removeEventListener('transitionend', onUserInteraction, true);
        document.removeEventListener('animationend', onUserInteraction, true);
      }
      if (scrollListenerBound) {
        scrollListenerBound = false;
        window.removeEventListener('scroll', onWindowScroll, true);
        window.removeEventListener('st:shadow-attached', onDynamicShadowAttached);
      }
      if (themeObserver) {
        themeObserver.disconnect();
        themeObserver = null;
      }
      if (lazyViewportObserver) {
        lazyViewportObserver.disconnect();
        lazyViewportObserver = null;
      }
    }

    function cancelActiveSession() {
      sessionId++;
      if (sessionAbortController) {
        sessionAbortController.abort();
        sessionAbortController = null;
      }
    }

    async function startPageTranslation(targetMode) {
      if (currentMode === 'off') {
        cancelActiveSession();
        sessionAbortController = typeof AbortController === 'function' ? new AbortController() : null;
      }
      currentMode = targetMode;
      setCurrentPageLineageMode(targetMode);
      const mySession = sessionId;

      translateBtn.style.display = 'none';
      controlBar.classList.add('active');
      btnBilingual.classList.toggle('selected', targetMode === 'bilingual');
      btnCh.classList.toggle('selected', targetMode === 'ch');
      requestAnimationFrame(() => applyEdgePosition(savedPos));

      applyModeToTranslatedNodes(targetMode);
      ensureDynamicObserver();

      await scanAndTranslateRoots([document.body], mySession);
    }

    // SPA 路由变化监听：页面切换时取消过期任务并按当前模式重新增量扫描
    let lastPageHref = location.href;
    function onSpaRouteChange() {
      if (location.href === lastPageHref) return;
      lastPageHref = location.href;
      setCurrentPageLineageMode(currentMode);
      if (currentMode === 'off') return;
      cancelActiveSession();
      sessionAbortController = typeof AbortController === 'function' ? new AbortController() : null;
      // 清理已脱离 DOM 的旧记录
      for (const el of Array.from(activeElements)) {
        if (!el.isConnected) {
          elementStateMap.delete(el);
          activeElements.delete(el);
        }
      }
      enqueueDirtyRoot(document.body, 220);
    }

    window.addEventListener('popstate', onSpaRouteChange);
    window.addEventListener('hashchange', onSpaRouteChange);
    if (!history.__stPatched) {
      history.__stPatched = true;
      const origPushState = history.pushState;
      if (typeof origPushState === 'function') {
        history.pushState = function (...args) {
          const ret = origPushState.apply(this, args);
          setTimeout(onSpaRouteChange, 50);
          return ret;
        };
      }
      const origReplaceState = history.replaceState;
      if (typeof origReplaceState === 'function') {
        history.replaceState = function (...args) {
          const ret = origReplaceState.apply(this, args);
          setTimeout(onSpaRouteChange, 50);
          return ret;
        };
      }
    }

    translateBtn.addEventListener('click', () => {
      if (moved) return;
      startPageTranslation('bilingual');
    });

    translateBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openGlossaryModal();
    });

    btnBilingual.addEventListener('click', () => {
      if (moved) return;
      startPageTranslation('bilingual');
    });

    btnCh.addEventListener('click', () => {
      if (moved) return;
      startPageTranslation('ch');
    });

    btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      if (moved) return;
      openGlossaryModal();
    });

    onGlossaryUpdated(() => {
      if (currentMode === 'off') return;
      const activeMode = currentMode;
      cancelActiveSession();
      restoreAllElements();
      currentMode = 'off';
      startPageTranslation(activeMode);
    });

    btnClose.addEventListener('click', () => {
      if (moved) return;
      currentMode = 'off';
      setCurrentPageLineageMode('off');
      cancelActiveSession();
      activeBatches = 0;
      updateSpinner();
      restoreAllElements();
      controlBar.classList.remove('active');
      translateBtn.style.display = 'inline-flex';
      requestAnimationFrame(() => applyEdgePosition(savedPos));
    });

    // CH 模式下按住 Alt 悬停任意已译元素可无损查看英文原文（松开即恢复，零排版干扰）
    let altPeekEl = null;
    const clearAltPeek = () => {
      if (!altPeekEl) return;
      const st = elementStateMap.get(altPeekEl);
      if (st && altPeekEl.isConnected && currentMode === 'ch') {
        applyModeToElement(altPeekEl, st, 'ch');
      }
      altPeekEl = null;
    };
    document.addEventListener('mouseover', (e) => {
      if (currentMode !== 'ch' || !e.altKey) return;
      const el = e.target?.closest?.('[data-st-translated="1"]');
      if (!el || el === altPeekEl) return;
      clearAltPeek();
      const st = elementStateMap.get(el);
      if (st) {
        altPeekEl = el;
        applyModeToElement(el, st, 'bilingual');
      }
    }, true);
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Alt') clearAltPeek();
    }, true);

    // 快捷键支持：Alt+T 开关翻译，Alt+B 在双语与纯中文间快速切换（输入框内自动忽略）
    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
      const k = (e.key || '').toLowerCase();
      if (k === 't') {
        e.preventDefault();
        if (currentMode === 'off') startPageTranslation('bilingual');
        else btnClose.click();
      } else if (k === 'b') {
        e.preventDefault();
        if (currentMode === 'bilingual') startPageTranslation('ch');
        else startPageTranslation('bilingual');
      }
    });

    // 按来源页面继承翻译模式（必须先读取继承状态，再写入当前页状态，避免覆盖 sessionStorage / PAGE_MODES）
    const inherited = resolveInheritedModeForCurrentPage();
    if (!pageIsChinese && (inherited === 'bilingual' || inherited === 'ch')) {
      setCurrentPageLineageMode(inherited);
      setTimeout(() => {
        if (currentMode === 'off' && !isHostBlocked()) {
          startPageTranslation(inherited);
        }
      }, 100);
    } else {
      setCurrentPageLineageMode('off');
    }
  }

  // ============================================================================
  // 7.5 手动右键图片 OCR 翻译模块（默认不自动翻译图片；右键图片 -> 翻译图片 / 还原原图）
  // ============================================================================
  const imageOcrOriginMap = new WeakMap(); // img -> { origSrc, origSrcset, sources: [{el, srcset}], translated: true }
  const imageOcrBusySet = new WeakSet();

  function fetchImageBlobViaGm(imgUrl) {
    return new Promise((resolve, reject) => {
      if (imgUrl.startsWith('data:') || imgUrl.startsWith('blob:')) {
        fetch(imgUrl).then((r) => r.blob()).then(resolve, reject);
        return;
      }
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: imgUrl,
          headers: {
            'Referer': location.href,
            'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          },
          responseType: 'blob',
          timeout: 15000,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300 && res.response) {
              resolve(res.response);
            } else {
              reject(new Error(`图片下载失败 (HTTP ${res.status})`));
            }
          },
          onerror: () => reject(new Error('图片下载网络错误')),
          ontimeout: () => reject(new Error('图片下载超时')),
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function tryDrawLiveImageUntainted(imgEl) {
    if (!imgEl || !imgEl.complete || !imgEl.naturalWidth || !imgEl.naturalHeight) return null;
    try {
      const natW = imgEl.naturalWidth;
      const natH = imgEl.naturalHeight;
      const scale = Math.min(1, 1800 / Math.max(natW, natH));
      const w = Math.max(1, Math.round(natW * scale));
      const h = Math.max(1, Math.round(natH * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(imgEl, 0, 0, w, h);
      // 检测画布是否被跨域污染
      ctx.getImageData(0, 0, 1, 1);
      return { canvas, ctx, width: w, height: h };
    } catch (_) {
      return null;
    }
  }

  function loadImageToCanvas(imgEl) {
    // 1. 优先直接从已解码的同源/CORS 图片绘制（0 网络请求、极速且不受防盗链影响）
    const direct = tryDrawLiveImageUntainted(imgEl);
    if (direct) return Promise.resolve(direct);

    // 2. 跨域图片通过 GM_xmlhttpRequest 携带 Referer 绕过 CORS 拉取 Blob 解码
    return new Promise(async (resolve, reject) => {
      try {
        const srcUrl = imgEl.currentSrc || imgEl.src;
        if (!srcUrl) return reject(new Error('图片地址为空'));
        const blob = await fetchImageBlobViaGm(srcUrl);
        const objUrl = URL.createObjectURL(blob);
        const tempImg = new Image();
        tempImg.onload = () => {
          URL.revokeObjectURL(objUrl);
          const natW = tempImg.naturalWidth || imgEl.naturalWidth || imgEl.width;
          const natH = tempImg.naturalHeight || imgEl.naturalHeight || imgEl.height;
          if (!natW || !natH) return reject(new Error('图片尺寸无效'));

          const scale = Math.min(1, 1800 / Math.max(natW, natH));
          const w = Math.max(1, Math.round(natW * scale));
          const h = Math.max(1, Math.round(natH * scale));

          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(tempImg, 0, 0, w, h);
          resolve({ canvas, ctx, width: w, height: h });
        };
        tempImg.onerror = () => {
          URL.revokeObjectURL(objUrl);
          reject(new Error('图片解码失败'));
        };
        tempImg.src = objUrl;
      } catch (err) {
        reject(err);
      }
    });
  }

  function canvasToJpegBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas 编码失败'))), 'image/jpeg', quality);
      } else {
        try {
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          const bstr = atob(dataUrl.split(',')[1]);
          const u8 = new Uint8Array(bstr.length);
          for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
          resolve(new Blob([u8], { type: 'image/jpeg' }));
        } catch (err) {
          reject(err);
        }
      }
    });
  }

  /**
   * 生成轻量二进制 JPEG Blob 供 OCR 上传（限制 <= 1280px 且 < 750KB），避免 base64 + URLSearchParams 膨胀超 1MB 报错
   */
  async function prepareOcrUploadBlob(fullCanvas) {
    const scale = Math.min(1, 1280 / Math.max(fullCanvas.width, fullCanvas.height));
    const ocrW = Math.max(1, Math.round(fullCanvas.width * scale));
    const ocrH = Math.max(1, Math.round(fullCanvas.height * scale));

    let uploadCanvas = fullCanvas;
    if (scale < 1) {
      uploadCanvas = document.createElement('canvas');
      uploadCanvas.width = ocrW;
      uploadCanvas.height = ocrH;
      const uctx = uploadCanvas.getContext('2d');
      uctx.fillStyle = '#ffffff';
      uctx.fillRect(0, 0, ocrW, ocrH);
      uctx.drawImage(fullCanvas, 0, 0, ocrW, ocrH);
    }

    let blob = await canvasToJpegBlob(uploadCanvas, 0.82);
    if (blob.size > 750 * 1024) {
      blob = await canvasToJpegBlob(uploadCanvas, 0.6);
    }
    return {
      blob,
      scaleX: fullCanvas.width / ocrW,
      scaleY: fullCanvas.height / ocrH,
    };
  }

  /**
   * 严格过滤图片 OCR 行：跳过中文、品牌 Logo/商标水印、词库 Keep 专有名词与笔画误识乱码
   */
  function isOcrLineTranslatable(text, box, imgW, imgH) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 2) return false;

    const cnCount = countChineseChars(clean);
    if (cnCount >= 2 || (cnCount >= 1 && cnCount / clean.replace(/\s+/g, '').length >= 0.15)) {
      return false;
    }
    if (!isForeignTextValid(clean)) return false;

    const words = clean.split(/\s+/).filter(Boolean);
    if (/[™®©]/.test(clean) && words.length <= 3) return false;

    const strippedBrand = clean.replace(/[™®©.,:;!?]+$/g, '').trim();
    const glossary = loadGlossary();
    if ((glossary.keep || []).some((k) => k.toLowerCase() === strippedBrand.toLowerCase())) {
      return false;
    }
    if (words.length === 1 && (SMART_AUTO_KEEP_CI_RE.test(strippedBrand) || SMART_AUTO_KEEP_CS_RE.test(strippedBrand))) {
      SMART_AUTO_KEEP_CI_RE.lastIndex = 0;
      SMART_AUTO_KEEP_CS_RE.lastIndex = 0;
      return false;
    }
    SMART_AUTO_KEEP_CI_RE.lastIndex = 0;
    SMART_AUTO_KEEP_CS_RE.lastIndex = 0;

    const isKnownUiWord = Boolean(lookupExactUiTerm(strippedBrand));
    if (words.length === 1 && !isKnownUiWord) {
      if (/^[A-Z0-9&.-]{2,8}$/.test(strippedBrand)) return false;
      if (imgH > 0 && box.h >= imgH * 0.14 && strippedBrand.length <= 12) return false;
      if (/^[A-Za-z0-9]+$/.test(strippedBrand) && !/[aeiouyAEIOUY]/.test(strippedBrand)) return false;
    }

    const singleLetterTokens = words.filter((w) => w.length === 1 && /[A-Za-z]/.test(w)).length;
    if (words.length >= 3 && singleLetterTokens / words.length >= 0.6) return false;

    return true;
  }

  async function requestOcrSpaceMultipart(blob, engine, language, scaleX, scaleY, imgW, imgH) {
    const fd = new FormData();
    fd.append('file', blob, 'image.jpg');
    fd.append('apikey', 'helloworld');
    fd.append('filetype', 'JPG');
    fd.append('language', language);
    fd.append('isOverlayRequired', 'true');
    fd.append('OCREngine', engine);
    fd.append('scale', 'true');
    fd.append('detectOrientation', 'false');

    const raw = await rawGmXhr(
      {
        method: 'POST',
        url: 'https://api.ocr.space/parse/image',
        headers: {
          'apikey': 'helloworld',
          'Accept': 'application/json',
        },
        data: fd,
      },
      22000,
      null
    );

    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      throw new Error('OCR 接口返回格式异常');
    }
    if (!data || data.IsErroredOnProcessing || !Array.isArray(data.ParsedResults) || !data.ParsedResults[0]) {
      const msg = Array.isArray(data?.ErrorMessage) ? data.ErrorMessage.join('; ') : (data?.ErrorMessage || 'OCR 识别失败');
      throw new Error(msg);
    }

    const lines = data.ParsedResults[0]?.TextOverlay?.Lines || [];
    const boxes = [];
    for (const line of lines) {
      const text = String(line?.LineText || '').replace(/\s+/g, ' ').trim();
      const words = Array.isArray(line?.Words) ? line.Words : [];
      if (!text || words.length === 0) continue;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = 0;
      let maxY = 0;
      for (const w of words) {
        const lx = (Number(w.Left) || 0) * scaleX;
        const ty = (Number(w.Top) || 0) * scaleY;
        const ww = (Number(w.Width) || 0) * scaleX;
        const hh = (Number(w.Height) || 0) * scaleY;
        if (ww <= 0 || hh <= 0) continue;
        if (lx < minX) minX = lx;
        if (ty < minY) minY = ty;
        if (lx + ww > maxX) maxX = lx + ww;
        if (ty + hh > maxY) maxY = ty + hh;
      }
      if (minX < maxX && minY < maxY) {
        const box = { text, x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        if (isOcrLineTranslatable(text, box, imgW, imgH)) {
          boxes.push(box);
        }
      }
    }
    return boxes;
  }

  let lanOcrCooldownUntil = 0;

  async function requestLanOcr(blob, scaleX, scaleY, imgW, imgH) {
    const raw = await rawGmXhr(
      {
        method: 'POST',
        url: LAN_OCR_ENDPOINT,
        headers: {
          'Content-Type': 'image/jpeg',
          'Accept': 'application/json',
        },
        data: blob,
      },
      4500,
      null
    );
    const data = JSON.parse(raw);
    if (!data || !data.ok || !Array.isArray(data.boxes)) {
      throw new Error(data?.error || 'LAN OCR invalid response');
    }
    const boxes = [];
    for (const b of data.boxes) {
      const text = String(b?.text || '').replace(/\s+/g, ' ').trim();
      const box = {
        text,
        x: (Number(b.x) || 0) * scaleX,
        y: (Number(b.y) || 0) * scaleY,
        w: (Number(b.w) || 0) * scaleX,
        h: (Number(b.h) || 0) * scaleY,
      };
      if (box.w > 0 && box.h > 0 && isOcrLineTranslatable(text, box, imgW, imgH)) {
        boxes.push(box);
      }
    }
    return boxes;
  }

  async function recognizeImageTextBoxes(canvas) {
    const { blob, scaleX, scaleY } = await prepareOcrUploadBlob(canvas);

    // 1. 优先使用 本机 RapidOCR（极速、无限流、中英混排精度高）
    if (Date.now() >= lanOcrCooldownUntil) {
      try {
        const rawBoxes = await requestLanOcr(blob, scaleX, scaleY, canvas.width, canvas.height);
        return { boxes: mergeAdjacentOcrParagraphs(rawBoxes), source: '本地 OCR' };
      } catch (_) {
        // 本机服务不可达或未安装 RapidOCR 时进入 60 秒冷却并无缝回退公网方案
        lanOcrCooldownUntil = Date.now() + 60 * 1000;
      }
    }

    // 2. 本机服务不可用时自动回退公网 OCR.space 三级降级
    const attempts = [
      ['2', 'auto'],
      ['2', 'eng'],
      ['1', 'eng'],
    ];
    let lastErr = null;
    for (const [engine, lang] of attempts) {
      try {
        const rawBoxes = await requestOcrSpaceMultipart(blob, engine, lang, scaleX, scaleY, canvas.width, canvas.height);
        return { boxes: mergeAdjacentOcrParagraphs(rawBoxes), source: '公网 OCR' };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('OCR 服务暂不可用');
  }

  function medianValue(arr) {
    if (!arr || arr.length === 0) return 0;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  // 架构图 / 技术示意图高频孤立节点词表（结合图内外技术上下文时 100% 精准翻译，避免 "Cache -> 藏匿处" / "Server -> 服务员" / "Library -> 图书馆"）
  const IMAGE_TECH_DIAGRAM_DICT = new Map(Object.entries({
    'client': '客户端', 'server': '服务器', 'database': '数据库', 'db': '数据库',
    'cache': '缓存', 'queue': '消息队列', 'worker': '工作节点', 'gateway': '网关',
    'proxy': '代理', 'router': '路由器', 'storage': '存储', 'memory': '内存',
    'network': '网络', 'firewall': '防火墙', 'load balancer': '负载均衡', 'cdn': 'CDN 加速',
    'user': '用户', 'users': '用户', 'request': '请求', 'response': '响应',
    'input': '输入', 'output': '输出', 'model': '模型', 'agent': '智能体',
    'tools': '工具', 'prompt': '提示词', 'library': '代码库', 'package': '软件包',
    'container': '容器', 'cluster': '集群', 'node': '节点', 'service': '服务',
    'services': '服务', 'backend': '后端', 'frontend': '前端', 'browser': '浏览器',
    'pipeline': '流水线', 'endpoint': '接口端点', 'webhook': '网络钩子', 'auth': '身份认证',
    'authentication': '身份认证', 'authorization': '权限授权', 'monitoring': '监控',
    'logging': '日志', 'metrics': '指标', 'scheduler': '调度器', 'broker': '消息代理',
    'publisher': '发布者', 'subscriber': '订阅者', 'producer': '生产者', 'consumer': '消费者',
    'branch': '分支', 'commit': '提交', 'build': '构建', 'deploy': '部署', 'test': '测试',
  }));

  function extractImageExternalContext(imgEl) {
    const parts = [];
    if (document.title) parts.push(document.title);
    if (imgEl) {
      const alt = imgEl.getAttribute('alt');
      const title = imgEl.getAttribute('title');
      if (alt) parts.push(alt);
      if (title) parts.push(title);
      const fig = imgEl.closest?.('figure');
      const cap = fig ? fig.querySelector('figcaption') : null;
      if (cap && cap.textContent) parts.push(cap.textContent.trim().slice(0, 160));
      // 向上查找最近的章节标题（h1-h4）作为图片外部主题上下文
      let cur = imgEl.parentElement;
      for (let depth = 0; depth < 5 && cur && cur !== document.body; depth++) {
        let sib = cur.previousElementSibling;
        let steps = 0;
        while (sib && steps < 4) {
          if (/^H[1-4]$/.test(sib.tagName) && sib.textContent) {
            parts.push(sib.textContent.trim().slice(0, 120));
            break;
          }
          sib = sib.previousElementSibling;
          steps++;
        }
        cur = cur.parentElement;
      }
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function isTechnicalImageContext(externalContext, boxes) {
    const internalText = (boxes || []).map((b) => b.text).join(' ');
    const combined = `${externalContext || ''} ${internalText}`.toLowerCase();
    return /(?:architecture|system|diagram|workflow|pipeline|api|sdk|cloud|server|client|database|cache|docker|kubernetes|react|node|python|git|github|llm|agent|model|microservice|deploy|network|http|tcp|memory|cpu|gpu|framework|library|cluster|gateway)/i.test(combined);
  }

  function colorDistSq(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
  }

  /**
   * 精细化采样：分别采样四边颜色（识别纯色 / 纵向渐变 / 横向渐变 / 复杂照片背景）、
   * 高对比前景色，并估算原始文字笔画密度用于自适应字重。
   */
  function sampleBoxVisuals(ctx, width, height, box) {
    const pad = 2;
    const x0 = Math.max(0, Math.floor(box.x - pad));
    const y0 = Math.max(0, Math.floor(box.y - pad));
    const x1 = Math.min(width - 1, Math.ceil(box.x + box.w + pad));
    const y1 = Math.min(height - 1, Math.ceil(box.y + box.h + pad));
    const sw = Math.max(1, x1 - x0 + 1);
    const sh = Math.max(1, y1 - y0 + 1);
    const imgData = ctx.getImageData(x0, y0, sw, sh).data;

    const collectEdge = (coords) => {
      const rs = [], gs = [], bs = [];
      for (const [lx, ly] of coords) {
        const idx = (ly * sw + lx) * 4;
        if (imgData[idx + 3] < 20) continue;
        rs.push(imgData[idx]);
        gs.push(imgData[idx + 1]);
        bs.push(imgData[idx + 2]);
      }
      if (rs.length === 0) return [255, 255, 255];
      return [medianValue(rs), medianValue(gs), medianValue(bs)];
    };

    const stepX = Math.max(1, Math.floor(sw / 28));
    const stepY = Math.max(1, Math.floor(sh / 14));
    const topPts = [], botPts = [], leftPts = [], rightPts = [];
    for (let lx = 0; lx < sw; lx += stepX) {
      topPts.push([lx, 0]);
      botPts.push([lx, sh - 1]);
    }
    for (let ly = 1; ly < sh - 1; ly += stepY) {
      leftPts.push([0, ly]);
      rightPts.push([sw - 1, ly]);
    }

    const topRgb = collectEdge(topPts);
    const botRgb = collectEdge(botPts);
    const leftRgb = collectEdge(leftPts);
    const rightRgb = collectEdge(rightPts);

    const allR = [topRgb[0], botRgb[0], leftRgb[0], rightRgb[0]];
    const allG = [topRgb[1], botRgb[1], leftRgb[1], rightRgb[1]];
    const allB = [topRgb[2], botRgb[2], leftRgb[2], rightRgb[2]];
    const avgBg = [medianValue(allR), medianValue(allG), medianValue(allB)];

    const vGradDist = Math.sqrt(colorDistSq(topRgb, botRgb));
    const hGradDist = Math.sqrt(colorDistSq(leftRgb, rightRgb));
    let bgKind = 'solid';
    if (vGradDist >= 22 && vGradDist >= hGradDist) bgKind = 'vgrad';
    else if (hGradDist >= 22) bgKind = 'hgrad';

    // 评估边缘复杂纹理方差（判断是否为复杂照片背景）
    let edgeVarSum = 0;
    let edgeCount = 0;
    for (const [lx, ly] of topPts.concat(botPts)) {
      const idx = (ly * sw + lx) * 4;
      if (imgData[idx + 3] < 20) continue;
      edgeVarSum += Math.sqrt(colorDistSq([imgData[idx], imgData[idx + 1], imgData[idx + 2]], avgBg));
      edgeCount++;
    }
    const isComplexPhotoBg = edgeCount > 0 && (edgeVarSum / edgeCount) >= 26;

    const bgLum = 0.299 * avgBg[0] + 0.587 * avgBg[1] + 0.114 * avgBg[2];

    // 采样前景色并统计笔画像素占比（采用高对比笔画像素中位数，彻底过滤 JPEG 噪点与高光离群像素）
    let fg = bgLum > 140 ? [17, 24, 39] : [248, 250, 252];
    let fgPixels = 0;
    let totalSampled = 0;
    const strokeSamples = [];
    const inStepX = Math.max(1, Math.floor(sw / 26));
    const inStepY = Math.max(1, Math.floor(sh / 14));
    for (let ly = 2; ly < sh - 2; ly += inStepY) {
      for (let lx = 2; lx < sw - 2; lx += inStepX) {
        const idx = (ly * sw + lx) * 4;
        if (imgData[idx + 3] < 80) continue;
        totalSampled++;
        const px = [imgData[idx], imgData[idx + 1], imgData[idx + 2]];
        const dSq = colorDistSq(px, avgBg);
        if (dSq > 3000) {
          fgPixels++;
          strokeSamples.push({ dSq, r: px[0], g: px[1], b: px[2] });
        }
      }
    }
    if (strokeSamples.length > 0) {
      strokeSamples.sort((a, b) => b.dSq - a.dSq);
      const topN = strokeSamples.slice(0, Math.max(3, Math.ceil(strokeSamples.length * 0.4)));
      fg = [
        medianValue(topN.map((p) => p.r)),
        medianValue(topN.map((p) => p.g)),
        medianValue(topN.map((p) => p.b)),
      ];
    }

    const fgLum = 0.299 * fg[0] + 0.587 * fg[1] + 0.114 * fg[2];
    if (Math.abs(fgLum - bgLum) < 75) {
      fg = bgLum > 140 ? [17, 24, 39] : [248, 250, 252];
    }
    const strokeDensity = totalSampled > 0 ? fgPixels / totalSampled : 0.25;

    return {
      bgKind,
      bgColor: `rgb(${avgBg[0]}, ${avgBg[1]}, ${avgBg[2]})`,
      topColor: `rgb(${topRgb[0]}, ${topRgb[1]}, ${topRgb[2]})`,
      botColor: `rgb(${botRgb[0]}, ${botRgb[1]}, ${botRgb[2]})`,
      leftColor: `rgb(${leftRgb[0]}, ${leftRgb[1]}, ${leftRgb[2]})`,
      rightColor: `rgb(${rightRgb[0]}, ${rightRgb[1]}, ${rightRgb[2]})`,
      fgColor: `rgb(${fg[0]}, ${fg[1]}, ${fg[2]})`,
      bgLum,
      isComplexPhotoBg,
      strokeDensity,
    };
  }

  function paintRefinedMaskRect(ctx, rx, ry, rw, rh, visual) {
    ctx.save();
    let fillStyle = visual.bgColor;
    if (visual.bgKind === 'vgrad') {
      const grad = ctx.createLinearGradient(rx, ry, rx, ry + rh);
      grad.addColorStop(0, visual.topColor);
      grad.addColorStop(1, visual.botColor);
      fillStyle = grad;
    } else if (visual.bgKind === 'hgrad') {
      const grad = ctx.createLinearGradient(rx, ry, rx + rw, ry);
      grad.addColorStop(0, visual.leftColor);
      grad.addColorStop(1, visual.rightColor);
      fillStyle = grad;
    }

    const radius = Math.min(4, Math.floor(Math.min(rw, rh) * 0.18));
    const traceRoundRect = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };

    // 外圈 1.5px 柔边羽化过渡，消除硬矩形贴片感
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = fillStyle;
    traceRoundRect(Math.max(0, rx - 1.5), Math.max(0, ry - 1.5), rw + 3, rh + 3, radius + 1);
    ctx.fill();

    // 内部实心圆角遮罩完全覆盖原文笔画
    ctx.globalAlpha = 1.0;
    traceRoundRect(rx, ry, rw, rh, radius);
    ctx.fill();
    ctx.restore();
  }

  /**
   * 合并同一段落纵向相邻多行，同时保留每个子行的精细坐标 subBoxes 与对齐特征（center / left）
   */
  function mergeAdjacentOcrParagraphs(boxes) {
    if (!Array.isArray(boxes) || boxes.length <= 1) {
      return (boxes || []).map((b) => ({ ...b, lineCount: 1, lineH: b.h, subBoxes: [{ x: b.x, y: b.y, w: b.w, h: b.h }] }));
    }
    const sorted = boxes.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const merged = [];

    for (const cur of sorted) {
      const prev = merged[merged.length - 1];
      if (prev) {
        const prevLineH = prev.lineH || prev.h;
        const heightSimilar = Math.abs(cur.h - prevLineH) / Math.max(cur.h, prevLineH) <= 0.25;
        const vGap = cur.y - (prev.y + prev.h);
        const closeVertically = vGap >= -prevLineH * 0.35 && vGap <= prevLineH * 0.85;
        const leftDiff = Math.abs(cur.x - prev.x);
        const centerDiff = Math.abs((cur.x + cur.w / 2) - (prev.x + prev.w / 2));
        const leftAligned = leftDiff <= Math.max(22, prevLineH * 1.4);
        const centerAligned = centerDiff <= Math.max(24, prevLineH * 1.5);
        const horizOverlap = Math.min(prev.x + prev.w, cur.x + cur.w) > Math.max(prev.x, cur.x);
        const prevEndsSentence = /[.!?。！？:]$/.test(prev.text.trim());

        if (heightSimilar && closeVertically && horizOverlap && (leftAligned || centerAligned) && !prevEndsSentence) {
          const minX = Math.min(prev.x, cur.x);
          const minY = Math.min(prev.y, cur.y);
          const maxX = Math.max(prev.x + prev.w, cur.x + cur.w);
          const maxY = Math.max(prev.y + prev.h, cur.y + cur.h);
          prev.text = `${prev.text} ${cur.text}`.replace(/\s+/g, ' ').trim();
          prev.x = minX;
          prev.y = minY;
          prev.w = maxX - minX;
          prev.h = maxY - minY;
          prev.lineCount = (prev.lineCount || 1) + 1;
          prev.lineH = Math.round((prevLineH + cur.h) / 2);
          prev.subBoxes.push({ x: cur.x, y: cur.y, w: cur.w, h: cur.h });
          if (centerAligned && centerDiff < leftDiff) {
            prev.inferredAlign = 'center';
          }
          continue;
        }
      }
      merged.push({
        ...cur,
        lineCount: 1,
        lineH: cur.h,
        subBoxes: [{ x: cur.x, y: cur.y, w: cur.w, h: cur.h }],
        inferredAlign: '',
      });
    }
    return merged;
  }

  /**
   * 智能推断译文对齐方式（居中 / 右对齐 / 左对齐），避免较短中文在居中标题/按钮/流程图节点中偏左留白
   */
  function inferOcrBoxAlignment(box, imgW, allBoxes) {
    if (box.inferredAlign === 'center') return 'center';

    const boxCenterX = box.x + box.w / 2;
    // 1. 相对图片水平居中（标题、海报主文案、居中卡片按钮）
    if (Math.abs(boxCenterX - imgW / 2) <= Math.max(18, imgW * 0.08)) {
      return 'center';
    }

    // 2. 与其他文本框共享明显左对齐轴线（左对齐段落/列表）
    const sharesLeftAxis = allBoxes.some(
      (other) => other !== box && Math.abs(other.x - box.x) <= Math.max(12, (box.lineH || box.h) * 0.7)
    );
    if (sharesLeftAxis) return 'left';

    // 3. 靠右且共享右对齐轴线（右对齐标注/数值说明）
    const sharesRightAxis = allBoxes.some(
      (other) => other !== box && Math.abs((other.x + other.w) - (box.x + box.w)) <= Math.max(12, (box.lineH || box.h) * 0.7)
    );
    if (sharesRightAxis && (imgW - (box.x + box.w)) <= imgW * 0.14) {
      return 'right';
    }

    // 4. 孤立单行短标签/流程图节点/按钮文字（非长段落，宽 <= 45% 图宽）采用居中对齐最自然
    if ((box.lineCount || 1) === 1 && box.w <= imgW * 0.45) {
      return 'center';
    }

    return 'left';
  }

  const CJK_NO_LINE_START_RE = /^[，。！？；：、）】》”’%,.!?;:\)\]]$/;

  function wrapCjkCanvasLines(ctx, text, maxWidth) {
    // 英文单词/数字/版本号整体切词防截断 + 中文避头点（标点不落行首）
    const tokens = String(text || '').match(/[A-Za-z0-9._%+-]+|\s+|./gu) || [];
    const lines = [];
    let cur = '';
    for (const tok of tokens) {
      const next = cur + tok;
      if (cur && ctx.measureText(next).width > maxWidth) {
        if (CJK_NO_LINE_START_RE.test(tok)) {
          cur = next;
          continue;
        }
        lines.push(cur.trimEnd());
        cur = /^\s+$/.test(tok) ? '' : tok;
      } else {
        cur = next;
      }
    }
    if (cur.trim()) lines.push(cur.trimEnd());
    return lines.length > 0 ? lines : [text];
  }

  function computeUnifiedBoxFontSizes(ctx, boxes, translations, colorPlans, fontFamily) {
    const validIndices = [];
    for (let i = 0; i < boxes.length; i++) {
      const zh = (translations[i] || '').trim();
      if (zh && zh !== boxes[i].text && countChineseChars(zh) > 0) {
        validIndices.push(i);
      }
    }

    const groups = [];
    for (const idx of validIndices) {
      const h = boxes[idx].lineH || boxes[idx].h;
      let targetGroup = null;
      for (const g of groups) {
        if (Math.abs(h - g.refH) / Math.max(h, g.refH) <= 0.25) {
          targetGroup = g;
          break;
        }
      }
      if (!targetGroup) groups.push({ refH: h, indices: [idx] });
      else targetGroup.indices.push(idx);
    }

    const fontPlans = new Array(boxes.length).fill(null);
    for (const g of groups) {
      const medianH = medianValue(g.indices.map((i) => boxes[i].lineH || boxes[i].h));
      const avgDensity =
        g.indices.reduce((sum, i) => sum + (colorPlans[i]?.strokeDensity || 0.25), 0) / Math.max(1, g.indices.length);
      // 结合原始字高与笔画密度自适应字重
      const weight = (medianH >= 28 || avgDensity >= 0.34) ? 700 : (medianH >= 20 || avgDensity >= 0.24 ? 600 : 400);
      const baseSize = Math.max(11, Math.min(Math.round(medianH * 0.82), 56));

      let unifiedScale = 1.0;
      ctx.font = `${weight} ${baseSize}px ${fontFamily}`;
      for (const idx of g.indices) {
        const zh = translations[idx].trim();
        const box = boxes[idx];
        const padX = Math.max(2, Math.round((box.lineH || box.h) * 0.12));
        const lineSlots = Math.max(1, box.lineCount || 1);
        const availW = Math.max(24, (box.w + padX * 2) * lineSlots);
        const tw = ctx.measureText(zh).width;
        if (tw > availW) {
          unifiedScale = Math.min(unifiedScale, availW / tw);
        }
      }
      const groupFontSize = Math.max(10, Math.round(baseSize * Math.max(0.78, unifiedScale)));

      for (const idx of g.indices) {
        fontPlans[idx] = { fontSize: groupFontSize, weight };
      }
    }
    return fontPlans;
  }

  function renderTranslatedBoxesOnCanvas(canvas, ctx, boxes, translations, imgEl) {
    const w = canvas.width;
    const h = canvas.height;
    // 根据宿主页面字体风格自适应衬线 / 无衬线中文字体栈
    const hostFont = imgEl ? (window.getComputedStyle(imgEl.parentElement || document.body).fontFamily || '') : '';
    const isSerifContext = /\b(?:serif|georgia|times|garamond|palatino)\b/i.test(hostFont) && !/sans-serif/i.test(hostFont);
    const fontFamily = isSerifContext
      ? '"Songti SC", "Noto Serif CJK SC", "SimSun", Georgia, serif'
      : '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, sans-serif';

    // 1. 先集中采样全部外框与多行子行的精细视觉信息（在任何遮罩写入前一次性采样完毕）
    const colorPlans = boxes.map((box) => sampleBoxVisuals(ctx, w, h, box));
    const subVisualPlans = boxes.map((box, i) => {
      const subs = box.subBoxes && box.subBoxes.length > 1 ? box.subBoxes : null;
      return subs ? subs.map((sb) => sampleBoxVisuals(ctx, w, h, sb)) : [colorPlans[i]];
    });
    const fontPlans = computeUnifiedBoxFontSizes(ctx, boxes, translations, colorPlans, fontFamily);
    const alignPlans = boxes.map((box) => inferOcrBoxAlignment(box, w, boxes));

    // 2. 精细化逐行遮罩：合并段落的每一行各自使用自身独立采样的背景/渐变，支持跨越照片或双色背景
    for (let i = 0; i < boxes.length; i++) {
      if (!fontPlans[i]) continue;
      const box = boxes[i];
      const subs = box.subBoxes && box.subBoxes.length > 0 ? box.subBoxes : [box];
      const visuals = subVisualPlans[i];
      for (let si = 0; si < subs.length; si++) {
        const sb = subs[si];
        const sbVisual = visuals[si] || colorPlans[i];
        const padX = Math.max(2, Math.round(sb.h * 0.14));
        const padY = Math.max(2, Math.round(sb.h * 0.14));
        const rx = Math.max(0, Math.floor(sb.x - padX));
        const ry = Math.max(0, Math.floor(sb.y - padY));
        const rw = Math.min(w - rx, Math.ceil(sb.w + padX * 2));
        const rh = Math.min(h - ry, Math.ceil(sb.h + padY * 2));
        paintRefinedMaskRect(ctx, rx, ry, rw, rh, sbVisual);
      }
    }

    // 3. 按智能对齐方式（center / right / left）与整体统一字号绘制高清中文
    for (let i = 0; i < boxes.length; i++) {
      const plan = fontPlans[i];
      if (!plan) continue;
      const box = boxes[i];
      const zh = translations[i].trim();
      const visual = colorPlans[i];
      const align = alignPlans[i];

      const padX = Math.max(2, Math.round((box.lineH || box.h) * 0.12));
      const rx = Math.max(0, Math.floor(box.x - padX));
      const ry = Math.max(0, Math.floor(box.y));
      const rw = Math.min(w - rx, Math.ceil(box.w + padX * 2));
      const rh = Math.min(h - ry, Math.ceil(box.h));

      ctx.save();
      ctx.font = `${plan.weight} ${plan.fontSize}px ${fontFamily}`;
      ctx.fillStyle = visual.fgColor;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';

      // 复杂照片背景上添加极轻描边投影保证中文边缘锐利清晰
      if (visual.isComplexPhotoBg) {
        ctx.shadowColor = visual.bgLum > 140 ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.65)';
        ctx.shadowBlur = 2.5;
      }

      const maxWidth = Math.max(24, rw - 2);
      const anchorX =
        align === 'center'
          ? rx + rw / 2
          : (align === 'right' ? rx + rw - Math.max(1, padX * 0.5) : rx + Math.max(1, padX * 0.5));

      const measuredW = ctx.measureText(zh).width;
      const maxLines = Math.max(1, Math.floor(rh / (plan.fontSize * 1.12)));
      if (measuredW > maxWidth * 1.04 && maxLines >= 2) {
        const wrapped = wrapCjkCanvasLines(ctx, zh, maxWidth).slice(0, maxLines);
        const lineStep = Math.min(plan.fontSize * 1.3, rh / wrapped.length);
        const startY = ry + (rh - lineStep * (wrapped.length - 1)) / 2;
        wrapped.forEach((ln, li) => {
          ctx.fillText(ln, anchorX, startY + li * lineStep, maxWidth);
        });
      } else {
        ctx.fillText(zh, anchorX, ry + rh / 2, maxWidth);
      }
      ctx.restore();
    }
    return { fontPlans, alignPlans, colorPlans };
  }

  function showImageToast(msg, durationMs = 2400) {
    let host = document.getElementById('st-img-toast-host');
    if (host) host.remove();
    host = document.createElement('div');
    host.id = 'st-img-toast-host';
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('top', '18px', 'important');
    host.style.setProperty('left', '50%', 'important');
    host.style.setProperty('transform', 'translateX(-50%)', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('pointer-events', 'none', 'important');
    const sh = host.attachShadow({ mode: 'open' });
    applyShadowStyles(
      sh,
      `:host { all: initial; }
      .toast {
        background: rgba(17, 19, 24, 0.94);
        color: #f4f4f5;
        border: 1px solid #2b303c;
        border-radius: 8px;
        padding: 8px 14px;
        font-size: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
      }`
    );
    sh.appendChild(createDomEl('div', { className: 'toast', textContent: msg }));
    (document.body || document.documentElement).appendChild(host);
    if (durationMs > 0) {
      setTimeout(() => {
        if (host.isConnected) host.remove();
      }, durationMs);
    }
    return host;
  }

  function restoreTranslatedImage(imgEl) {
    const rec = imageOcrOriginMap.get(imgEl);
    if (!rec) return;
    if (imgEl.isConnected) {
      imgEl.src = rec.origSrc;
      if (rec.hadSrcset) imgEl.setAttribute('srcset', rec.origSrcset);
      else imgEl.removeAttribute('srcset');
      for (const s of rec.sources || []) {
        if (s.el.isConnected) s.el.setAttribute('srcset', s.srcset);
      }
      delete imgEl.dataset.stImgTranslated;
    }
    imageOcrOriginMap.delete(imgEl);
  }

  const imageOcrRenderCache = new LRUCache(16);

  function applyRenderedImageToEl(imgEl, renderedUrl) {
    const origSrc = imgEl.getAttribute('src') || imgEl.currentSrc || '';
    const hadSrcset = imgEl.hasAttribute('srcset');
    const origSrcset = imgEl.getAttribute('srcset') || '';
    const sources = [];
    if (imgEl.parentElement && imgEl.parentElement.tagName === 'PICTURE') {
      for (const s of imgEl.parentElement.querySelectorAll('source[srcset]')) {
        sources.push({ el: s, srcset: s.getAttribute('srcset') });
        s.removeAttribute('srcset');
      }
    }
    imageOcrOriginMap.set(imgEl, { origSrc, hadSrcset, origSrcset, sources });
    imgEl.removeAttribute('srcset');
    imgEl.src = renderedUrl;
    imgEl.dataset.stImgTranslated = '1';
  }

  async function translateImageOnDemand(imgEl) {
    if (!imgEl || !imgEl.isConnected || imageOcrBusySet.has(imgEl)) return;
    const cacheKeyUrl = imgEl.currentSrc || imgEl.getAttribute('src') || '';
    if (!imageOcrOriginMap.has(imgEl) && cacheKeyUrl && imageOcrRenderCache.has(cacheKeyUrl)) {
      applyRenderedImageToEl(imgEl, imageOcrRenderCache.get(cacheKeyUrl));
      showImageToast('已从缓存恢复翻译图（再次点击左下角圆点可还原）', 1800);
      return;
    }
    imageOcrBusySet.add(imgEl);
    const loadingToast = showImageToast('正在识别图片中的文字...', 0);

    try {
      // 若之前已翻译，先恢复原图再重新识别，防止二次覆盖失真
      if (imageOcrOriginMap.has(imgEl)) {
        restoreTranslatedImage(imgEl);
      }

      const { canvas, ctx } = await loadImageToCanvas(imgEl);
      const { boxes, source: ocrSource } = await recognizeImageTextBoxes(canvas);
      if (!boxes || boxes.length === 0) {
        loadingToast.remove();
        showImageToast('未在图片中识别到需要翻译的外语文字');
        return;
      }

      loadingToast.remove();
      const transToast = showImageToast(`已识别 ${boxes.length} 处文字，正在翻译...`, 0);
      try {
        const extCtx = extractImageExternalContext(imgEl);
        const techCtx = isTechnicalImageContext(extCtx, boxes);
        const translatedList = new Array(boxes.length).fill('');
        const pendingIdx = [];
        const pendingTexts = [];

        for (let i = 0; i < boxes.length; i++) {
          const t = boxes[i].text;
          const low = t.toLowerCase();
          // 结合图内外上下文：技术架构图中的孤立词优先查精准专业词表，0 误差
          if (techCtx && IMAGE_TECH_DIAGRAM_DICT.has(low)) {
            translatedList[i] = IMAGE_TECH_DIAGRAM_DICT.get(low);
            continue;
          }
          const uiHit = lookupExactUiTerm(t);
          if (uiHit) {
            translatedList[i] = uiHit;
            continue;
          }
          pendingIdx.push(i);
          pendingTexts.push(t);
        }

        if (pendingTexts.length > 0) {
          const mtRes = await translateBatchWithFallback(pendingTexts, null);
          for (let k = 0; k < pendingIdx.length; k++) {
            const idx = pendingIdx[k];
            const rawZh = (mtRes[k] || '').trim();
            const ctxHint = techCtx ? `api server ${boxes[idx].text}` : boxes[idx].text;
            translatedList[idx] = polishChineseTypography(rawZh, ctxHint);
          }
        }

        renderTranslatedBoxesOnCanvas(canvas, ctx, boxes, translatedList, imgEl);
        const renderedUrl = canvas.toDataURL('image/png');

        // 无损备份原图 src / srcset 以及 <picture><source> 后原地替换，并写入 0ms 切换缓存
        const cacheKeyFinal = imgEl.currentSrc || imgEl.getAttribute('src') || '';
        if (cacheKeyFinal) imageOcrRenderCache.set(cacheKeyFinal, renderedUrl);
        applyRenderedImageToEl(imgEl, renderedUrl);

        transToast.remove();
        showImageToast(`图片翻译完成 [${ocrSource}]（再次点击左下角圆点可还原）`, 2200);
      } catch (err) {
        transToast.remove();
        throw err;
      }
    } catch (err) {
      if (loadingToast.isConnected) loadingToast.remove();
      console.warn('[SmartTranslator] Image OCR translate failed:', err);
      const reason = String(err?.message || '').slice(0, 48);
      showImageToast(reason ? `图片翻译失败：${reason}` : '图片翻译失败，请稍后重试', 3200);
    } finally {
      imageOcrBusySet.delete(imgEl);
    }
  }

  function initImageDotTrigger() {
    if (window.__stImgDotBound) return;
    window.__stImgDotBound = true;

    const host = document.createElement('div');
    host.id = 'st-img-dot-host';
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('z-index', '2147483645', 'important');
    host.style.setProperty('display', 'none', 'important');
    host.style.setProperty('pointer-events', 'auto', 'important');

    const sh = host.attachShadow({ mode: 'open' });
    applyShadowStyles(
      sh,
      `:host { all: initial; }
      .dot-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 12px;
        height: 12px;
        padding: 0;
        border-radius: 999px;
        border: 1.5px solid rgba(255, 255, 255, 0.92);
        background: rgba(15, 23, 42, 0.62);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
        cursor: pointer;
        transition: transform 0.14s ease, background 0.14s ease, width 0.14s ease, height 0.14s ease;
        outline: none;
      }
      .dot-btn:hover {
        transform: scale(1.25);
        background: #2563eb;
      }
      .dot-btn.is-translated {
        background: #2563eb;
      }
      .dot-btn.is-busy {
        background: #f59e0b;
        animation: st-dot-pulse 0.9s ease-in-out infinite;
      }
      @keyframes st-dot-pulse {
        0%, 100% { transform: scale(1); opacity: 0.85; }
        50% { transform: scale(1.3); opacity: 1; }
      }`
    );

    const dotBtn = createDomEl('button', {
      className: 'dot-btn',
      id: 'st-img-dot-btn',
      type: 'button',
      title: '点击翻译图片',
      'aria-label': '翻译图片',
    });
    sh.appendChild(dotBtn);

    let currentImg = null;
    let hideTimer = null;

    const ensureMounted = () => {
      if (!host.isConnected && (document.body || document.documentElement)) {
        (document.body || document.documentElement).appendChild(host);
      }
    };

    const syncDotVisual = () => {
      if (!currentImg || !currentImg.isConnected) return;
      const busy = imageOcrBusySet.has(currentImg);
      const translated = imageOcrOriginMap.has(currentImg);
      dotBtn.classList.toggle('is-busy', busy);
      dotBtn.classList.toggle('is-translated', translated && !busy);
      dotBtn.title = busy ? '正在翻译图片...' : (translated ? '点击还原原图' : '点击翻译图片');
    };

    const positionDotForImg = (imgEl) => {
      if (!imgEl || !imgEl.isConnected || isHostBlocked() || document.fullscreenElement) {
        host.style.setProperty('display', 'none', 'important');
        return;
      }
      const r = imgEl.getBoundingClientRect();
      if (r.width < 64 || r.height < 64 || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
        host.style.setProperty('display', 'none', 'important');
        return;
      }
      ensureMounted();
      const left = Math.max(4, Math.min(window.innerWidth - 20, Math.round(r.left + 8)));
      const top = Math.max(4, Math.min(window.innerHeight - 20, Math.round(r.bottom - 20)));
      host.style.setProperty('left', `${left}px`, 'important');
      host.style.setProperty('top', `${top}px`, 'important');
      host.style.setProperty('display', 'block', 'important');
      syncDotVisual();
    };

    const scheduleHide = () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        hideTimer = null;
        if (currentImg && imageOcrBusySet.has(currentImg)) return;
        host.style.setProperty('display', 'none', 'important');
        currentImg = null;
      }, 220);
    };

    const cancelHide = () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    host.addEventListener('mouseenter', cancelHide);
    host.addEventListener('mouseleave', scheduleHide);

    dotBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!currentImg || !currentImg.isConnected || imageOcrBusySet.has(currentImg)) return;
      const targetImg = currentImg;
      if (imageOcrOriginMap.has(targetImg)) {
        restoreTranslatedImage(targetImg);
        syncDotVisual();
      } else {
        dotBtn.classList.add('is-busy');
        await translateImageOnDemand(targetImg);
        if (currentImg === targetImg) {
          positionDotForImg(targetImg);
        }
      }
    });

    document.addEventListener('mouseover', (e) => {
      if (isHostBlocked() || document.fullscreenElement) return;
      const target = e.target;
      if (!target || target.nodeType !== Node.ELEMENT_NODE) return;
      if (target.id === 'st-img-dot-host') {
        cancelHide();
        return;
      }
      const imgEl = target.tagName === 'IMG' ? target : null;
      if (imgEl && imgEl.isConnected) {
        const r = imgEl.getBoundingClientRect();
        if (r.width >= 64 && r.height >= 64) {
          cancelHide();
          currentImg = imgEl;
          positionDotForImg(imgEl);
          return;
        }
      }
      if (currentImg && target !== currentImg) {
        scheduleHide();
      }
    }, true);

    window.addEventListener('scroll', () => {
      if (currentImg && host.style.display !== 'none') {
        positionDotForImg(currentImg);
      }
    }, { passive: true, capture: true });
  }

  // ============================================================================
  // 8. GitHub 专项模块（智能中文 README 发现与校验 + 完整 GFM 解析器 + 双引擎容灾）
  // ============================================================================
  const cnReadmeRepoCache = new LRUCache(MAX_CN_README_CACHE_SIZE);

  function parseGitHubRepoInfo() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const reserved = new Set([
      'settings', 'notifications', 'explore', 'marketplace', 'issues',
      'pulls', 'sponsors', 'orgs', 'users', 'login', 'signup', 'search', 'topics', 'new', 'codespaces',
    ]);
    if (reserved.has(parts[0])) return null;

    const owner = parts[0];
    const repo = parts[1];
    let branch = '';
    let subDir = '';
    if ((parts[2] === 'tree' || parts[2] === 'blob') && parts[3]) {
      branch = decodeURIComponent(parts[3]);
      if (parts.length > 4) {
        const rest = parts.slice(4).map((p) => {
          try {
            return decodeURIComponent(p);
          } catch (_) {
            return p;
          }
        });
        subDir = parts[2] === 'blob' ? rest.slice(0, -1).join('/') : rest.join('/');
      }
    }
    return { owner, repo, branch, subDir };
  }

  function getLiveMarkdownBody() {
    return document.querySelector('#readme article.markdown-body, [data-testid="readme"] article.markdown-body, article.markdown-body');
  }

  function encodeGitHubPath(filePath) {
    return String(filePath || '')
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join('/');
  }

  function resolveRelativePath(baseDir, relPath) {
    const cleanRel = String(relPath || '').split(/[?#]/)[0];
    const parts = (baseDir ? baseDir.split('/') : []).concat(cleanRel.split('/'));
    const stack = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return stack.join('/');
  }

  function detectBranchFromPageDom(repoInfo) {
    if (repoInfo.branch) return repoInfo.branch;

    // 1. 尝试从嵌入式 React 数据读取 defaultBranch / current ref
    const scripts = document.querySelectorAll('script[data-target="react-app.embeddedData"], script[type="application/json"]');
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (!txt.includes('defaultBranch') && !txt.includes('refInfo')) continue;
      try {
        const data = JSON.parse(txt);
        const payload = data?.payload || data;
        const refName =
          payload?.codeViewRepoRoute?.refInfo?.name ||
          payload?.repo?.defaultBranch ||
          payload?.overview?.overviewFiles?.[0]?.refName;
        if (refName && typeof refName === 'string') return refName;
      } catch (_) {
        // 忽略
      }
    }

    // 2. 尝试从分支切换按钮读取
    const branchBtn = document.querySelector(
      'button[data-hotkey="w"] span, [data-testid="anchor-button"] span, summary[title="Switch branches or tags"] span[data-menu-button]'
    );
    if (branchBtn && branchBtn.textContent) {
      const candidate = branchBtn.textContent.trim();
      if (candidate && candidate.length <= 80 && !/\s/.test(candidate)) {
        return candidate;
      }
    }

    // 3. 尝试从仓库根目录 blob 链接推断
    const prefix = `/${repoInfo.owner}/${repoInfo.repo}/blob/`;
    const blobLink = document.querySelector(`a[href^="${prefix}"]`);
    if (blobLink) {
      const rest = (blobLink.getAttribute('href') || '').slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash > 0) return decodeURIComponent(rest.slice(0, slash));
    }

    return '';
  }

  function detectCnReadmeLinksInBody(repoInfo, markdownBody, defaultBranch) {
    if (!markdownBody) return [];
    const results = [];
    const seen = new Set();
    const links = markdownBody.querySelectorAll('a[href]');
    const blobPrefix = `/${repoInfo.owner}/${repoInfo.repo}/blob/`;
    const rawPrefix = `/${repoInfo.owner}/${repoInfo.repo}/raw/`;

    for (const a of links) {
      const rawHref = (a.getAttribute('href') || '').trim();
      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('mailto:')) continue;
      const text = (a.textContent || '').trim();
      const isCnLabel = /中文|简体|繁體|chinese|zh[-_]?cn|zh[-_]?hans/i.test(text);
      const isCnFile =
        /readme[^/]*[-._](zh|cn|chinese|hans|hant|chs)[^/]*\.md/i.test(rawHref) ||
        /\/(zh[-_]?cn|cn|zh)\/readme\.md/i.test(rawHref);
      if (!isCnLabel && !isCnFile) continue;

      let ref = repoInfo.branch || defaultBranch || '';
      let filePath = '';

      if (/^https?:\/\//i.test(rawHref) || rawHref.startsWith('/')) {
        try {
          const url = new URL(rawHref, window.location.origin);
          if (url.hostname === 'raw.githubusercontent.com') {
            const segs = url.pathname.split('/').filter(Boolean);
            if (segs.length >= 4 && segs[0].toLowerCase() === repoInfo.owner.toLowerCase() && segs[1].toLowerCase() === repoInfo.repo.toLowerCase()) {
              ref = decodeURIComponent(segs[2]);
              filePath = segs.slice(3).map((s) => decodeURIComponent(s)).join('/');
            }
          } else if (url.hostname === 'github.com') {
            let rest = '';
            if (url.pathname.startsWith(blobPrefix)) rest = url.pathname.slice(blobPrefix.length);
            else if (url.pathname.startsWith(rawPrefix)) rest = url.pathname.slice(rawPrefix.length);
            if (rest) {
              const slashIdx = rest.indexOf('/');
              if (slashIdx > 0) {
                ref = decodeURIComponent(rest.slice(0, slashIdx));
                filePath = rest.slice(slashIdx + 1).split('/').map((s) => decodeURIComponent(s)).join('/');
              }
            }
          }
        } catch (_) {
          continue;
        }
      } else {
        // 相对链接（如 README_cn.md、./docs/README.zh-CN.md）
        filePath = resolveRelativePath(repoInfo.subDir, rawHref);
      }

      if (filePath && filePath.toLowerCase().endsWith('.md')) {
        const key = `${ref}::${filePath.toLowerCase()}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ ref, filePath });
        }
      }
    }
    return results;
  }

  function detectRootCnReadmeFromPageDom(repoInfo) {
    const candidateLowerMap = new Map(CN_README_ROOT_CANDIDATES.map((c) => [c.toLowerCase(), c]));
    let defaultBranch = detectBranchFromPageDom(repoInfo);
    const matchedFiles = [];
    const seen = new Set();
    let hasEmbeddedTree = false;

    const checkName = (name) => {
      const clean = String(name || '').trim();
      if (!clean || clean.includes('/')) return;
      const lower = clean.toLowerCase();
      if (candidateLowerMap.has(lower) || CN_README_FILENAME_REGEX.test(clean)) {
        if (!seen.has(lower)) {
          seen.add(lower);
          matchedFiles.push(clean);
        }
      }
    };

    const scripts = document.querySelectorAll('script[data-target="react-app.embeddedData"], script[type="application/json"]');
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (!txt.includes('"items"') && !txt.includes('"overviewFiles"')) continue;
      try {
        const data = JSON.parse(txt);
        const payload = data?.payload || data;
        const items =
          payload?.codeViewRepoRoute?.tree?.items ||
          payload?.tree?.items ||
          payload?.overview?.tree?.items;
        if (Array.isArray(items) && items.length > 0) {
          hasEmbeddedTree = true;
          for (const item of items) {
            checkName(item?.name || item?.path || '');
          }
        }
      } catch (_) {
        // 忽略
      }
    }

    const prefix = `/${repoInfo.owner}/${repoInfo.repo}/blob/`;
    const links = document.querySelectorAll(`a[href^="${prefix}"]`);
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const rest = href.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx > 0) {
        const branchPart = decodeURIComponent(rest.slice(0, slashIdx));
        const filePath = rest.slice(slashIdx + 1);
        if (!defaultBranch) defaultBranch = branchPart;
        const decodedPath = filePath.split('/').map((p) => { try { return decodeURIComponent(p); } catch (_) { return p; } }).join('/');
        const subPrefix = repoInfo.subDir ? `${repoInfo.subDir}/` : '';
        if (subPrefix && decodedPath.startsWith(subPrefix)) {
          const relName = decodedPath.slice(subPrefix.length);
          if (!relName.includes('/')) checkName(relName);
        } else if (!subPrefix && !decodedPath.includes('/')) {
          checkName(decodedPath);
        }
      }
    }

    return { matchedFiles, defaultBranch, hasEmbeddedTree };
  }

  /**
   * 严格验证拉取到的中文 README 是否有效 Markdown 且包含真实中文内容（排除 HTML 404/登录页与空壳文件）
   */
  function isValidChineseMarkdown(md) {
    if (typeof md !== 'string') return false;
    const trimmed = md.trim();
    if (trimmed.length < 30) return false;
    if (/^<!DOCTYPE\s+html|^<html[\s>]|<title>Page not found/i.test(trimmed)) return false;

    // 去除代码块与 URL 后检测真实中文内容
    const proseOnly = trimmed
      .replace(/```[\s\S]*?```/g, '')
      .replace(/~~~[\s\S]*?~~~/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/<[^>]+>/g, ' ');
    const cnCount = countChineseChars(proseOnly);
    return cnCount >= 15;
  }

  async function fetchRepoRawFile(owner, repo, ref, filePath, signal) {
    const branchRef = encodeURIComponent(ref || 'HEAD');
    const encodedPath = encodeGitHubPath(filePath);
    const primaryUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${branchRef}/${encodedPath}`;
    const fallbackUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/${branchRef}/${encodedPath}`;

    try {
      const md = await gmRequest({ url: primaryUrl, timeout: 3200, signal, pool: 'discovery' });
      if (isValidChineseMarkdown(md)) return md;
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      // 404 直接失败，不重复请求 github.com/raw
      if (err?.status === 404) throw err;
    }

    const mdFallback = await gmRequest({ url: fallbackUrl, timeout: 3200, signal, pool: 'discovery' });
    if (isValidChineseMarkdown(mdFallback)) return mdFallback;
    throw new Error('Invalid CN markdown');
  }

  async function findRootChineseReadmeMarkdown(repoInfo, markdownBody, signal) {
    const { owner, repo, branch, subDir } = repoInfo;
    const domInfo = detectRootCnReadmeFromPageDom(repoInfo);
    const effectiveBranch = branch || domInfo.defaultBranch || '';

    // 1. 收集 README 内部链接与页面文件树匹配到的候选文件，并发竞速（最多前 4 个），避免串行阻塞
    const orderedCandidates = [];
    const seenKeys = new Set();
    const pushCandidate = (ref, filePath) => {
      const key = `${(ref || '').toLowerCase()}::${filePath.toLowerCase()}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        orderedCandidates.push({ ref: ref || effectiveBranch || 'HEAD', filePath });
      }
    };

    for (const linked of detectCnReadmeLinksInBody(repoInfo, markdownBody, effectiveBranch)) {
      pushCandidate(linked.ref, linked.filePath);
    }
    for (const f of domInfo.matchedFiles) {
      pushCandidate(effectiveBranch, subDir ? `${subDir}/${f}` : f);
    }

    if (orderedCandidates.length > 0) {
      if (signal?.aborted) return null;
      try {
        const hit = await Promise.any(
          orderedCandidates.slice(0, 4).map(async (cand) => {
            const md = await fetchRepoRawFile(owner, repo, cand.ref, cand.filePath, signal);
            return { markdown: md, fileName: cand.filePath, ref: cand.ref };
          })
        );
        return hit;
      } catch (_) {
        // 候选全部无效，继续后续检测
      }
    }

    if (signal?.aborted) return null;
    // 若页面已完整内嵌根目录文件树且无匹配文件，直接结束避免无效 404 请求
    if (domInfo.hasEmbeddedTree && domInfo.matchedFiles.length === 0) {
      return null;
    }

    // 2. 轻量并发：1 次 GitHub Contents API（列出全部文件）+ 仅 2 个最高频中文文件名，总计最多 3 请求
    const refForApi = effectiveBranch;
    const refForRaw = effectiveBranch || 'HEAD';
    const pathPrefix = subDir ? `${subDir}/` : '';

    try {
      const hit = await Promise.any([
        ...['README_cn.md', 'README.zh-CN.md'].map(async (fileName) => {
          const fullPath = `${pathPrefix}${fileName}`;
          const md = await fetchRepoRawFile(owner, repo, refForRaw, fullPath, signal);
          return { markdown: md, fileName: fullPath, ref: refForRaw };
        }),
        (async () => {
          const encodedSub = subDir ? encodeGitHubPath(subDir) : '';
          const refQuery = refForApi ? `?ref=${encodeURIComponent(refForApi)}` : '';
          const rawList = await gmRequest({
            url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedSub}${refQuery}`,
            headers: { 'Accept': 'application/vnd.github.v3+json' },
            timeout: 3200,
            signal,
            pool: 'discovery',
          });
          const files = JSON.parse(rawList);
          if (!Array.isArray(files)) throw new Error('Invalid contents API response');

          const matched = [];
          const lowerSet = new Set(CN_README_ROOT_CANDIDATES.map((c) => c.toLowerCase()));
          for (const f of files) {
            if (f?.type !== 'file' || !f?.name) continue;
            if (lowerSet.has(f.name.toLowerCase()) || CN_README_FILENAME_REGEX.test(f.name)) {
              matched.push(f.path || `${pathPrefix}${f.name}`);
            }
          }
          if (matched.length === 0) throw new Error('No CN README in API listing');
          return Promise.any(
            matched.slice(0, 3).map(async (filePath) => {
              const md = await fetchRepoRawFile(owner, repo, refForRaw, filePath, signal);
              return { markdown: md, fileName: filePath, ref: refForRaw };
            })
          );
        })(),
      ]);
      return hit;
    } catch (_) {
      return null;
    }
  }

  // --- 完整且安全的 GitHub-Flavored Markdown (GFM) 解析器（零 XSS，纯 DOM 构建）---
  const SAFE_HTML_TAGS = new Set([
    'DIV', 'P', 'SPAN', 'A', 'IMG', 'PICTURE', 'SOURCE', 'FIGURE', 'FIGCAPTION',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
    'DETAILS', 'SUMMARY', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'INS', 'MARK',
    'CODE', 'PRE', 'KBD', 'SUB', 'SUP', 'BLOCKQUOTE', 'CENTER', 'SMALL', 'ABBR',
  ]);

  const SAFE_HTML_ATTRS = new Set([
    'href', 'src', 'srcset', 'alt', 'title', 'width', 'height', 'align',
    'colspan', 'rowspan', 'open', 'target', 'rel', 'media', 'type', 'loading',
  ]);

  function resolveGitHubUrl(rawUrl, repoCtx, isImage) {
    const url = String(rawUrl || '').trim();
    if (!url) return '';
    if (/^(?:https?:|data:image\/|#|mailto:)/i.test(url)) return url;
    if (/^javascript:/i.test(url)) return '';
    if (!repoCtx || !repoCtx.owner || !repoCtx.repo) return url;

    const ref = encodeURIComponent(repoCtx.ref || repoCtx.branch || 'HEAD');
    const resolvedPath = url.startsWith('/')
      ? url.replace(/^\/+/, '')
      : resolveRelativePath(repoCtx.baseDir || '', url);
    const encodedPath = encodeGitHubPath(resolvedPath);
    if (isImage) {
      return `https://raw.githubusercontent.com/${encodeURIComponent(repoCtx.owner)}/${encodeURIComponent(repoCtx.repo)}/${ref}/${encodedPath}`;
    }
    return `https://github.com/${encodeURIComponent(repoCtx.owner)}/${encodeURIComponent(repoCtx.repo)}/blob/${ref}/${encodedPath}`;
  }

  function sanitizeHtmlToFragment(htmlStr, repoCtx) {
    const frag = document.createDocumentFragment();
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(`<div>${htmlStr}</div>`, 'text/html');
      const container = doc.body.firstElementChild;
      if (!container) return frag;

      const cloneSafe = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return document.createTextNode(node.nodeValue || '');
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return null;
        if (!SAFE_HTML_TAGS.has(node.tagName)) {
          // 跳过危险标签（script/iframe/style/object）但保留未知普通标签的纯文本
          if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|FORM)$/i.test(node.tagName)) return null;
          const span = document.createElement('span');
          for (const ch of node.childNodes) {
            const safeCh = cloneSafe(ch);
            if (safeCh) span.appendChild(safeCh);
          }
          return span;
        }
        const el = document.createElement(node.tagName.toLowerCase());
        for (const attr of node.attributes) {
          const name = attr.name.toLowerCase();
          if (!SAFE_HTML_ATTRS.has(name) || name.startsWith('on')) continue;
          let val = attr.value;
          if (name === 'href') {
            val = resolveGitHubUrl(val, repoCtx, false);
            if (!val) continue;
          } else if (name === 'src') {
            val = resolveGitHubUrl(val, repoCtx, true);
            if (!val) continue;
          } else if (name === 'srcset') {
            val = val
              .split(',')
              .map((part) => {
                const segs = part.trim().split(/\s+/);
                if (!segs[0]) return '';
                segs[0] = resolveGitHubUrl(segs[0], repoCtx, true);
                return segs.join(' ');
              })
              .filter(Boolean)
              .join(', ');
            if (!val) continue;
          }
          el.setAttribute(name, val);
        }
        if (el.tagName === 'A' && /^https?:\/\//i.test(el.getAttribute('href') || '')) {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
        for (const ch of node.childNodes) {
          const safeCh = cloneSafe(ch);
          if (safeCh) el.appendChild(safeCh);
        }
        return el;
      };

      for (const ch of container.childNodes) {
        const safeCh = cloneSafe(ch);
        if (safeCh) frag.appendChild(safeCh);
      }
    } catch (_) {
      frag.appendChild(document.createTextNode(htmlStr));
    }
    return frag;
  }

  function appendInlineMarkdown(container, text, refMap, repoCtx) {
    if (!text) return;
    // 支持：图片链接 [![alt](img)](href)、图片 ![alt](src)、链接 [text](href)、引用链接 [text][id]、
    // 行内代码 `code`、HTML 内联标签、粗体 **text**/__text__、斜体 *text*、删除线 ~~text~~、自动链接 <https://...>
    const pattern =
      /(\[!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"([^"]*)")?\)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"([^"]*)")?\)|!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"([^"]*)")?\)|!\[([^\]]*)\]\[([^\]]+)\]|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"([^"]*)")?\)|\[([^\]]+)\]\[([^\]]+)\]|``([^`]+(?:`[^`]+)*)``|`([^`]+)`|<((?:https?:\/\/)[^>]+)>|<(?:br\s*\/?|img\s+[^>]+|a\s+[^>]+>[\s\S]*?<\/a>|kbd>[\s\S]*?<\/kbd>|sub>[\s\S]*?<\/sub>|sup>[\s\S]*?<\/sup>|strong>[\s\S]*?<\/strong>|em>[\s\S]*?<\/em>|code>[\s\S]*?<\/code>|del>[\s\S]*?<\/del>|b>[\s\S]*?<\/b>|i>[\s\S]*?<\/i>)>|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*)/gi;

    let last = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > last) {
        container.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      const token = m[0];

      if (m[3] !== undefined && m[5] !== undefined) {
        // 图片链接 [![alt](img)](href)
        const a = createDomEl('a', { href: resolveGitHubUrl(m[5], repoCtx, false) });
        if (m[6]) a.setAttribute('title', m[6]);
        if (/^https?:\/\//i.test(a.getAttribute('href') || '')) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }
        const img = createDomEl('img', {
          src: resolveGitHubUrl(m[3], repoCtx, true),
          alt: m[2] || '',
        });
        if (m[4]) img.setAttribute('title', m[4]);
        a.appendChild(img);
        container.appendChild(a);
      } else if (m[8] !== undefined) {
        // 图片 ![alt](src)
        const img = createDomEl('img', {
          src: resolveGitHubUrl(m[8], repoCtx, true),
          alt: m[7] || '',
        });
        if (m[9]) img.setAttribute('title', m[9]);
        container.appendChild(img);
      } else if (m[11] !== undefined) {
        // 引用图片 ![alt][id]
        const def = refMap.get(m[11].toLowerCase());
        if (def) {
          const img = createDomEl('img', {
            src: resolveGitHubUrl(def.url, repoCtx, true),
            alt: m[10] || '',
          });
          if (def.title) img.setAttribute('title', def.title);
          container.appendChild(img);
        } else {
          container.appendChild(document.createTextNode(token));
        }
      } else if (m[13] !== undefined) {
        // 普通链接 [text](href)
        const href = resolveGitHubUrl(m[13], repoCtx, false);
        const a = createDomEl('a', { href });
        if (m[14]) a.setAttribute('title', m[14]);
        if (/^https?:\/\//i.test(href)) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }
        appendInlineMarkdown(a, m[12], refMap, repoCtx);
        container.appendChild(a);
      } else if (m[16] !== undefined) {
        // 引用链接 [text][id]
        const def = refMap.get(m[16].toLowerCase());
        if (def) {
          const href = resolveGitHubUrl(def.url, repoCtx, false);
          const a = createDomEl('a', { href });
          if (def.title) a.setAttribute('title', def.title);
          if (/^https?:\/\//i.test(href)) {
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
          }
          appendInlineMarkdown(a, m[15], refMap, repoCtx);
          container.appendChild(a);
        } else {
          container.appendChild(document.createTextNode(token));
        }
      } else if (m[17] !== undefined || m[18] !== undefined) {
        container.appendChild(createDomEl('code', { textContent: (m[17] || m[18]).trim() }));
      } else if (m[19] !== undefined) {
        const a = createDomEl('a', { href: m[19], target: '_blank', rel: 'noopener noreferrer', textContent: m[19] });
        container.appendChild(a);
      } else if (token.startsWith('<')) {
        container.appendChild(sanitizeHtmlToFragment(token, repoCtx));
      } else if (m[20] !== undefined || m[21] !== undefined) {
        const strong = createDomEl('strong');
        appendInlineMarkdown(strong, m[20] || m[21], refMap, repoCtx);
        container.appendChild(strong);
      } else if (m[22] !== undefined) {
        const del = createDomEl('del');
        appendInlineMarkdown(del, m[22], refMap, repoCtx);
        container.appendChild(del);
      } else if (m[23] !== undefined) {
        const em = createDomEl('em');
        appendInlineMarkdown(em, m[23], refMap, repoCtx);
        container.appendChild(em);
      } else {
        container.appendChild(document.createTextNode(token));
      }

      last = pattern.lastIndex;
    }

    if (last < text.length) {
      container.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function splitTableRow(line) {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = [];
    let cur = '';
    let escaped = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escaped) {
        cur += ch;
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '|') {
        cells.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  }

  function isTableSeparatorLine(line) {
    const trimmed = line.trim();
    if (!trimmed.includes('-')) return false;
    const cells = splitTableRow(trimmed);
    return cells.length >= 1 && cells.every((c) => /^:?-{3,}:?$/.test(c));
  }

  function parseMarkdownToDomNodes(markdown, repoCtx = null) {
    const cleanedMarkdown = (markdown || '').replace(/<!--[\s\S]*?-->/g, '');
    const rawLines = cleanedMarkdown.split(/\r?\n/);

    // 预扫描引用链接定义 [id]: url "title"
    const refMap = new Map();
    const lines = [];
    let inFencePre = false;
    for (const line of rawLines) {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFencePre = !inFencePre;
        lines.push(line);
        continue;
      }
      if (!inFencePre) {
        const refMatch = line.match(/^\s*\[([^\]]+)\]:\s*(\S+)(?:\s+"([^"]*)")?\s*$/);
        if (refMatch) {
          refMap.set(refMatch[1].trim().toLowerCase(), {
            url: refMatch[2].trim(),
            title: refMatch[3] || '',
          });
          continue;
        }
      }
      lines.push(line);
    }

    const nodes = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      // 1. Fenced Code Block (``` 或 ~~~)
      const fenceMatch = trimmed.match(/^(```+|~~~+)(.*)$/);
      if (fenceMatch) {
        const fenceChar = fenceMatch[1][0];
        const fenceLen = fenceMatch[1].length;
        const lang = fenceMatch[2].trim().split(/\s+/)[0] || '';
        const codeLines = [];
        i++;
        while (i < lines.length) {
          const closeMatch = lines[i].trim().match(new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`));
          if (closeMatch) {
            i++;
            break;
          }
          codeLines.push(lines[i]);
          i++;
        }
        const codeEl = createDomEl('code', { textContent: codeLines.join('\n') });
        if (lang) codeEl.className = `language-${lang}`;
        nodes.push(createDomEl('pre', {}, [codeEl]));
        continue;
      }

      // 2. HTML 块级标签（支持 <div align="center">/<details>/<center> 内部嵌套 Markdown 递归解析）
      const htmlBlockStart = trimmed.match(/^<(div|p|table|details|figure|picture|center|h[1-6]|ul|ol|blockquote|img|hr|a)(?:\s|>|$)/i);
      if (htmlBlockStart) {
        const tag = htmlBlockStart[1].toLowerCase();
        // 对纯容器标签（div/details/center），若起始行仅有开标签且末尾行仅有闭标签，递归解析内部 Markdown
        const openTagOnly = trimmed.match(/^<(div|details|center)(\s[^>]*)?>\s*$/i);
        if (openTagOnly) {
          const wrapTag = openTagOnly[1].toLowerCase();
          const openAttrStr = openTagOnly[2] || '';
          const innerLines = [];
          i++;
          let depth = 1;
          const openRe = new RegExp(`<${wrapTag}(?:\\s|>)`, 'gi');
          const closeRe = new RegExp(`</${wrapTag}\\s*>`, 'gi');
          while (i < lines.length && depth > 0) {
            const curLine = lines[i];
            const opens = (curLine.match(openRe) || []).length;
            const closes = (curLine.match(closeRe) || []).length;
            depth += opens - closes;
            if (depth > 0) innerLines.push(curLine);
            i++;
          }
          const shellFrag = sanitizeHtmlToFragment(`<${wrapTag}${openAttrStr}></${wrapTag}>`, repoCtx);
          const wrapperEl = shellFrag.firstElementChild || createDomEl(wrapTag);
          // 单独处理 <details> 中的 <summary>
          let bodyStartIdx = 0;
          if (wrapTag === 'details') {
            for (let k = 0; k < innerLines.length; k++) {
              const sm = innerLines[k].trim().match(/^<summary[^>]*>([\s\S]*?)<\/summary>$/i);
              if (sm) {
                const sumEl = createDomEl('summary');
                appendInlineMarkdown(sumEl, sm[1].trim(), refMap, repoCtx);
                wrapperEl.appendChild(sumEl);
                bodyStartIdx = k + 1;
                break;
              }
            }
          }
          const nestedNodes = parseMarkdownToDomNodes(innerLines.slice(bodyStartIdx).join('\n'), repoCtx);
          nestedNodes.forEach((n) => wrapperEl.appendChild(n));
          nodes.push(wrapperEl);
          continue;
        }

        const htmlLines = [line];
        i++;
        if (tag !== 'img' && tag !== 'hr' && !new RegExp(`</${tag}\\s*>`, 'i').test(trimmed) && !/\/>\s*$/.test(trimmed)) {
          let depth = 1;
          const openRe = new RegExp(`<${tag}(?:\\s|>)`, 'gi');
          const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
          while (i < lines.length && depth > 0) {
            const curLine = lines[i];
            htmlLines.push(curLine);
            const opens = (curLine.match(openRe) || []).length;
            const closes = (curLine.match(closeRe) || []).length;
            depth += opens - closes;
            i++;
          }
        }
        const frag = sanitizeHtmlToFragment(htmlLines.join('\n'), repoCtx);
        for (const child of Array.from(frag.childNodes)) {
          if (child.nodeType === Node.ELEMENT_NODE) nodes.push(child);
        }
        continue;
      }

      // 3. 分隔线
      if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
        nodes.push(createDomEl('hr'));
        i++;
        continue;
      }

      // 4. ATX 标题 (# ~ ######)
      const hMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (hMatch) {
        const level = hMatch[1].length;
        const hEl = createDomEl(`h${level}`);
        appendInlineMarkdown(hEl, hMatch[2].replace(/\s+#+\s*$/, ''), refMap, repoCtx);
        nodes.push(hEl);
        i++;
        continue;
      }

      // 5. Setext 标题 (=== / ---)
      if (i + 1 < lines.length && /^(?:={3,}|-{3,})\s*$/.test(lines[i + 1].trim()) && !/^[-*+]\s/.test(trimmed)) {
        const level = lines[i + 1].trim().startsWith('=') ? 1 : 2;
        const hEl = createDomEl(`h${level}`);
        appendInlineMarkdown(hEl, trimmed, refMap, repoCtx);
        nodes.push(hEl);
        i += 2;
        continue;
      }

      // 6. GFM 表格
      if (line.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])) {
        const headerCells = splitTableRow(line);
        const aligns = splitTableRow(lines[i + 1]).map((c) => {
          if (c.startsWith(':') && c.endsWith(':')) return 'center';
          if (c.endsWith(':')) return 'right';
          if (c.startsWith(':')) return 'left';
          return '';
        });
        i += 2;
        const thead = createDomEl('thead');
        const headTr = createDomEl('tr');
        headerCells.forEach((cell, idx) => {
          const th = createDomEl('th');
          if (aligns[idx]) th.style.textAlign = aligns[idx];
          appendInlineMarkdown(th, cell, refMap, repoCtx);
          headTr.appendChild(th);
        });
        thead.appendChild(headTr);

        const tbody = createDomEl('tbody');
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const rowCells = splitTableRow(lines[i]);
          const tr = createDomEl('tr');
          const colCount = Math.max(headerCells.length, rowCells.length);
          for (let c = 0; c < colCount; c++) {
            const td = createDomEl('td');
            if (aligns[c]) td.style.textAlign = aligns[c];
            appendInlineMarkdown(td, rowCells[c] || '', refMap, repoCtx);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
          i++;
        }
        nodes.push(createDomEl('table', {}, [thead, tbody]));
        continue;
      }

      // 7. 嵌套引用块与 GitHub Alerts (> [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION])
      if (/^>\s?/.test(trimmed)) {
        const bqLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          bqLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        const alertMatch = bqLines[0] && bqLines[0].trim().match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i);
        if (alertMatch) {
          const kind = alertMatch[1].toLowerCase();
          const labelMap = { note: '提示', tip: '技巧', important: '重要', warning: '警告', caution: '注意' };
          const alertDiv = createDomEl('div', { className: `markdown-alert markdown-alert-${kind}` });
          const titleP = createDomEl('p', { className: 'markdown-alert-title', textContent: labelMap[kind] || alertMatch[1] });
          alertDiv.appendChild(titleP);
          const innerNodes = parseMarkdownToDomNodes(bqLines.slice(1).join('\n'), repoCtx);
          innerNodes.forEach((n) => alertDiv.appendChild(n));
          nodes.push(alertDiv);
        } else {
          const bq = createDomEl('blockquote');
          const innerNodes = parseMarkdownToDomNodes(bqLines.join('\n'), repoCtx);
          innerNodes.forEach((n) => bq.appendChild(n));
          nodes.push(bq);
        }
        continue;
      }

      // 8. 嵌套有序/无序列表及任务列表
      const listStart = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
      if (listStart) {
        const rootStack = [];
        while (i < lines.length) {
          const cur = lines[i];
          const lm = cur.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
          if (!lm) {
            if (!cur.trim()) {
              // 检查下一行是否继续列表
              if (i + 1 < lines.length && /^(\s*)([-*+]|\d+\.)\s+/.test(lines[i + 1])) {
                i++;
                continue;
              }
            }
            break;
          }
          const indent = lm[1].replace(/\t/g, '  ').length;
          const tag = /^\d+\.$/.test(lm[2]) ? 'ol' : 'ul';
          let content = lm[3];

          while (rootStack.length > 0 && indent < rootStack[rootStack.length - 1].indent) {
            rootStack.pop();
          }

          if (
            rootStack.length === 0 ||
            indent > rootStack[rootStack.length - 1].indent ||
            (indent === rootStack[rootStack.length - 1].indent && rootStack[rootStack.length - 1].tag !== tag)
          ) {
            const listEl = createDomEl(tag);
            if (rootStack.length > 0) {
              const parentList = rootStack[rootStack.length - 1].el;
              const parentLi = parentList.lastElementChild;
              if (parentLi) parentLi.appendChild(listEl);
              else parentList.appendChild(listEl);
            } else {
              nodes.push(listEl);
            }
            rootStack.push({ indent, tag, el: listEl });
          }

          const li = createDomEl('li');
          const taskMatch = content.match(/^\[([ xX])\]\s+(.*)$/);
          if (taskMatch) {
            const cb = createDomEl('input', { type: 'checkbox', disabled: 'disabled' });
            if (taskMatch[1].toLowerCase() === 'x') cb.setAttribute('checked', 'checked');
            li.appendChild(cb);
            li.appendChild(document.createTextNode(' '));
            content = taskMatch[2];
          }
          appendInlineMarkdown(li, content, refMap, repoCtx);
          rootStack[rootStack.length - 1].el.appendChild(li);
          i++;
        }
        continue;
      }

      // 9. 普通段落（合并连续非特殊行）
      const paraLines = [trimmed];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(?:```|~~~|#{1,6}\s|>\s?|[-*+]\s|\d+\.\s|[-*_]{3,}$|<\/?(?:div|p|table|details|figure|picture|center|h[1-6]|ul|ol|blockquote))/i.test(lines[i]) &&
        !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1]))
      ) {
        paraLines.push(lines[i].trim());
        i++;
      }
      const p = createDomEl('p');
      appendInlineMarkdown(p, paraLines.join(' '), refMap, repoCtx);
      nodes.push(p);
    }

    return nodes;
  }

  function ensureGitHubStyles() {
    if (document.getElementById('st-github-style')) return;
    const style = document.createElement('style');
    style.id = 'st-github-style';
    style.textContent = `
      .st-gh-standalone-bar {
        display: inline-flex !important;
        align-items: center !important;
        gap: 6px !important;
        flex-shrink: 0 !important;
        margin-left: auto !important;
        margin-right: 6px !important;
        vertical-align: middle !important;
        border: 0 none transparent !important;
        box-shadow: none !important;
        background: transparent !important;
        outline: none !important;
      }
      .st-gh-standalone-bar.is-fallback {
        display: flex !important;
        justify-content: flex-end !important;
        width: 100% !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        padding: 8px 16px 0 !important;
        box-sizing: border-box !important;
      }
      .st-gh-spinner {
        width: 14px !important;
        height: 14px !important;
        border: 2px solid var(--borderColor-default, #d0d7de) !important;
        border-top-color: var(--fgColor-accent, #2563eb) !important;
        border-radius: 50% !important;
        animation: st-gh-spin 0.7s linear infinite !important;
        display: none !important;
        flex-shrink: 0 !important;
        box-sizing: border-box !important;
      }
      .st-gh-spinner.loading {
        display: inline-block !important;
      }
      @keyframes st-gh-spin {
        to { transform: rotate(360deg); }
      }
      .st-gh-switcher {
        display: inline-flex !important;
        align-items: center !important;
        border: 0 none transparent !important;
        border-radius: 0 !important;
        outline: none !important;
        box-shadow: none !important;
        background: transparent !important;
        background-color: transparent !important;
        height: 28px !important;
        padding: 0 !important;
        gap: 4px !important;
        box-sizing: border-box !important;
      }
      .st-gh-switcher button,
      .st-gh-switcher button:hover,
      .st-gh-switcher button:focus,
      .st-gh-switcher button:focus-visible,
      .st-gh-switcher button:active,
      .st-gh-switcher button.active {
        appearance: none !important;
        -webkit-appearance: none !important;
        border: 0 none transparent !important;
        border-radius: 0 !important;
        outline: none !important;
        box-shadow: none !important;
        background: transparent !important;
        background-color: transparent !important;
        font-size: 12px !important;
        padding: 0 5px !important;
        margin: 0 !important;
        height: 100% !important;
        cursor: pointer !important;
        line-height: 28px !important;
        white-space: nowrap !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        transition: color 0.12s ease !important;
      }
      .st-gh-switcher button {
        color: var(--fgColor-muted, #656d76) !important;
        font-weight: 500 !important;
      }
      .st-gh-switcher button:hover {
        color: var(--fgColor-default, #1f2328) !important;
      }
      .st-gh-switcher button.active,
      .st-gh-switcher button.active:hover {
        color: var(--fgColor-accent, #2563eb) !important;
        font-weight: 600 !important;
      }
      .st-gh-settings-btn,
      .st-gh-settings-btn:focus,
      .st-gh-settings-btn:focus-visible,
      .st-gh-settings-btn:active {
        appearance: none !important;
        -webkit-appearance: none !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 26px !important;
        height: 26px !important;
        padding: 0 !important;
        border: 0 none transparent !important;
        outline: none !important;
        box-shadow: none !important;
        border-radius: 6px !important;
        background: transparent !important;
        color: var(--fgColor-muted, #656d76) !important;
        cursor: pointer !important;
        flex-shrink: 0 !important;
        box-sizing: border-box !important;
      }
      .st-gh-settings-btn:hover {
        background: transparent !important;
        color: var(--fgColor-accent, #2563eb) !important;
      }
      .st-gh-divider {
        display: inline-block !important;
        width: 1px !important;
        height: 16px !important;
        background: var(--borderColor-default, #d0d7de) !important;
        margin: 0 2px 0 4px !important;
        flex-shrink: 0 !important;
      }
      .st-gh-trans-block {
        display: block !important;
        margin-top: 4px !important;
        margin-bottom: 10px !important;
        font-family: inherit !important;
        font-size: 0.96em !important;
        line-height: 1.6 !important;
        color: inherit;
        opacity: 1 !important;
      }
      .st-gh-trans-inline {
        display: inline !important;
        margin-left: 6px !important;
        font-family: inherit !important;
        font-size: 0.95em !important;
        color: inherit;
        opacity: 1 !important;
      }
      .st-gh-trans-block.st-gh-ch-only,
      .st-gh-trans-inline.st-gh-ch-only {
        margin-top: 0 !important;
        margin-left: 0 !important;
        margin-bottom: 0 !important;
        opacity: 1 !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function mountBarToGitHubTopRight(standaloneBar, markdownBody) {
    const readmeRoot =
      markdownBody.closest('#readme') ||
      markdownBody.closest('[data-testid="readme"]') ||
      markdownBody.parentElement?.parentElement ||
      document;

    const attachWithDivider = (targetNode) => {
      const safeTarget = targetNode.closest?.('[class*="ButtonGroup"], .BtnGroup') || targetNode;
      if (!safeTarget.parentElement) return false;
      const divider = createDomEl('span', { className: 'st-gh-divider', 'aria-hidden': 'true' });
      standaloneBar.appendChild(divider);
      safeTarget.parentElement.insertBefore(standaloneBar, safeTarget);
      return true;
    };

    const editBtn = readmeRoot.querySelector(
      'a[aria-label*="Edit"], button[aria-label*="Edit"], [data-testid="edit-button"], a[href*="/edit/"]'
    );
    if (editBtn && !editBtn.closest('nav') && !markdownBody.contains(editBtn)) {
      if (attachWithDivider(editBtn)) return;
    }

    const headerSlot = readmeRoot.querySelector('[class*="readmeHeaderSlot"]');
    if (headerSlot && headerSlot.parentElement) {
      if (attachWithDivider(headerSlot.nextElementSibling || headerSlot)) return;
    }

    const outlineBtn = readmeRoot.querySelector('button[aria-label="Outline"], [aria-label="Outline"]');
    if (outlineBtn && !outlineBtn.closest('nav')) {
      if (attachWithDivider(outlineBtn)) return;
    }

    const rawBtn = document.querySelector('[data-testid="raw-button"]');
    if (rawBtn) {
      standaloneBar.style.marginLeft = '0';
      standaloneBar.style.marginRight = '6px';
      if (attachWithDivider(rawBtn)) return;
    }

    const contentWrapper =
      markdownBody.closest('[class*="SharedMarkdownContent"]') ||
      markdownBody.parentElement;
    let headerBar =
      readmeRoot.querySelector('.Box-header, .react-code-view-header, [class*="StickyHeader"]') ||
      contentWrapper?.previousElementSibling;

    if (headerBar && headerBar.tagName === 'NAV' && headerBar.parentElement) {
      headerBar = headerBar.parentElement;
    }

    if (headerBar && !markdownBody.contains(headerBar)) {
      const hStyle = window.getComputedStyle(headerBar);
      if (hStyle.display.includes('flex') && hStyle.flexDirection !== 'column') {
        standaloneBar.style.marginLeft = 'auto';
        headerBar.appendChild(standaloneBar);
        return;
      }
      if (hStyle.position === 'static') {
        headerBar.style.position = 'relative';
      }
      standaloneBar.style.position = 'absolute';
      standaloneBar.style.right = '12px';
      standaloneBar.style.top = '50%';
      standaloneBar.style.transform = 'translateY(-50%)';
      standaloneBar.style.zIndex = '20';
      headerBar.appendChild(standaloneBar);
      return;
    }

    standaloneBar.classList.add('is-fallback');
    markdownBody.parentElement.insertBefore(standaloneBar, markdownBody);
  }

  function extractDirectTextBeforeSubList(el, subList) {
    let text = '';
    for (const node of el.childNodes) {
      if (node === subList) break;
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue || '';
      } else if (node.nodeType === Node.ELEMENT_NODE && !node.matches('ul, ol, pre, code, .st-gh-trans-block')) {
        text += node.textContent || '';
      }
    }
    return text;
  }

  function extractGitHubRichSegment(el, subList, cache) {
    if (!subList && el.childElementCount === 0) {
      return { text: (el.textContent || '').replace(/\s+/g, ' ').trim(), tokens: [], hasRich: false, styleSource: el, hasMedia: false };
    }
    // 若块内直接包含 <img>/<picture>/<svg>（如带 Logo 标题、徽章行、GitHub Alert 标题），绝不克隆媒体节点
    const directHasMedia = Array.from(el.querySelectorAll('img, picture, svg')).some(
      (m) => !subList || !subList.contains(m)
    );
    if (directHasMedia) {
      const rawText = subList ? extractDirectTextBeforeSubList(el, subList) : getElementVisibleText(el, cache);
      return { text: rawText.replace(/\s+/g, ' ').trim(), tokens: [], hasRich: false, styleSource: findDominantTextStyleSource(el, cache), hasMedia: true };
    }
    if (!subList) {
      return extractRichSegment(el, false, cache);
    }
    // 含子列表的 <li>：仅提取子列表之前节点的富文本占位符，保留 <a>/<code>/<strong>/颜色
    const tempNodes = [];
    for (const child of el.childNodes) {
      if (child === subList) break;
      tempNodes.push(child);
    }
    const tokens = [];
    let hasRich = false;
    const rootColor = (cache ? cache.getStyle(el) : window.getComputedStyle(el)).color || '';

    function walkListPrefix(nodes, parentColor) {
      let out = '';
      for (const child of nodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue || '';
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.matches?.('ul, ol, pre, .st-gh-trans-block, .st-gh-trans-inline, .anchor')) continue;
        if (ATOMIC_INLINE_TAGS.has(child.tagName)) {
          const idx = tokens.length;
          tokens.push({ type: 'atomic', node: child });
          hasRich = true;
          out += `[[C${idx}]]`;
          continue;
        }
        if (RICH_INLINE_TAGS.has(child.tagName)) {
          const st = cache ? cache.getStyle(child) : window.getComputedStyle(child);
          const col = st.color || parentColor;
          const inner = walkListPrefix(child.childNodes, col);
          if (!inner.trim()) continue;
          const isStyled =
            child.tagName !== 'SPAN' ||
            (col && parentColor && col !== parentColor) ||
            hasGradientTextStyle(st) ||
            parseInt(st.fontWeight, 10) >= 600;
          if (isStyled && tokens.length < 16) {
            const idx = tokens.length;
            tokens.push({ type: 'wrap', node: child });
            hasRich = true;
            out += `[[L${idx}]]${inner}[[/L${idx}]]`;
          } else {
            out += inner;
          }
          continue;
        }
        out += walkListPrefix(child.childNodes, parentColor);
      }
      return out;
    }

    const text = walkListPrefix(tempNodes, rootColor).replace(/\s+/g, ' ').trim();
    return { text, tokens, hasRich, styleSource: el, hasMedia: false };
  }

  function collectGitHubTranslatableBlocks(markdownBody) {
    if (!markdownBody) return [];
    const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, td, th, summary, dd, dt, figcaption';
    const CHILD_CONTAINER_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, blockquote, td, th, summary';
    const blocks = [];
    const cache = new ScanLayoutCache();

    const all = Array.from(markdownBody.querySelectorAll(BLOCK_SELECTOR));
    for (const el of all) {
      if (el.closest('pre, code, .st-gh-trans-block, .st-gh-trans-inline')) continue;
      if (hasExternalTranslation(el)) continue;
      const subList = el.tagName === 'LI' ? el.querySelector(':scope > ul, :scope > ol') : null;
      const hasInnerBlock = Array.from(el.querySelectorAll(CHILD_CONTAINER_SELECTOR)).some(
        (child) => child !== el && (!subList || !subList.contains(child))
      );
      if (hasInnerBlock) continue;

      const seg = extractGitHubRichSegment(el, subList, cache);
      if (!isForeignTextValid(seg.text)) continue;

      blocks.push({ el, text: seg.text, seg, subList });
    }
    return blocks;
  }

  const savedBodyChildrenMap = new WeakMap();
  let activeGitHubCleanup = null;

  function initGitHubReadmeTranslator() {
    if (isHostBlocked()) return;
    const repoInfo = parseGitHubRepoInfo();
    if (!repoInfo) return;

    const initialBody = getLiveMarkdownBody();
    if (!initialBody || !initialBody.parentElement) return;

    const repoKey = `${repoInfo.owner}/${repoInfo.repo}@${repoInfo.branch || 'default'}:${repoInfo.subDir || ''}`;
    const existingBar = document.querySelector('.st-gh-standalone-bar');
    if (existingBar) {
      if (existingBar.dataset.stRepoKey === repoKey) return;
      if (activeGitHubCleanup) activeGitHubCleanup();
      existingBar.remove();
    }

    const readmeIsChinese = isGitHubReadmeChinese(initialBody);

    ensureGitHubStyles();

    const spinner = createDomEl('span', { className: 'st-gh-spinner', 'aria-hidden': 'true' });
    const btnBilingual = createDomEl('button', { type: 'button', dataset: { mode: 'bilingual' }, textContent: '双语' });
    const btnCh = createDomEl('button', { type: 'button', dataset: { mode: 'ch' }, textContent: 'CH' });
    const btnEn = createDomEl('button', { type: 'button', className: 'active', dataset: { mode: 'en' }, textContent: 'EN' });
    const switcher = createDomEl('div', { className: 'st-gh-switcher' }, [btnBilingual, btnCh, btnEn]);
    const settingsBtn = createDomEl('button', { type: 'button', className: 'st-gh-settings-btn', title: '词库设置', 'aria-label': '词库设置' }, [
      createSvgIcon(14, [
        { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
        { tag: 'path', attrs: { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' } },
      ]),
    ]);
    const standaloneBar = createDomEl('div', { className: 'st-gh-standalone-bar', dataset: { stRepoKey: repoKey } }, [
      spinner,
      switcher,
      settingsBtn,
    ]);

    mountBarToGitHubTopRight(standaloneBar, initialBody);

    const hiddenTextOriginMap = new Map();
    const textTransCache = new LRUCache(1000);
    let cnReadmePromise = null;
    let currentMode = 'en';
    let ghSession = 0;
    let ghAbortController = null;
    let disposed = false;

    const offGlossary = onGlossaryUpdated(() => {
      if (disposed) return;
      textTransCache.clear();
      const liveBody = getLiveMarkdownBody();
      if (currentMode !== 'en' && liveBody && liveBody.dataset.stCnReplaced !== '1') {
        switchMode(currentMode);
      }
    });

    activeGitHubCleanup = () => {
      disposed = true;
      offGlossary();
      ghSession++;
      if (ghAbortController) {
        ghAbortController.abort();
        ghAbortController = null;
      }
      restoreOriginalDom();
    };

    function setLoading(loading) {
      spinner.classList.toggle('loading', Boolean(loading));
    }

    function setActiveButton(mode) {
      currentMode = mode;
      switcher.querySelectorAll('button').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
      });
    }

    function hideDirectTextInGhBlock(el, subList) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (subList && subList.contains(node)) return NodeFilter.FILTER_REJECT;
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (p.closest('.st-gh-trans-block, .st-gh-trans-inline, pre, code, script, style')) {
            return NodeFilter.FILTER_REJECT;
          }
          // 仅排除 el 内部的嵌套子列表（绝不能用 closest('ul, ol') 误伤 <li> 自身所在的外部列表！）
          let anc = p;
          while (anc && anc !== el) {
            if (anc.tagName === 'UL' || anc.tagName === 'OL') return NodeFilter.FILTER_REJECT;
            anc = anc.parentElement;
          }
          return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
      const nodes = [];
      let cur;
      while ((cur = walker.nextNode())) nodes.push(cur);
      for (const textNode of nodes) {
        if (!hiddenTextOriginMap.has(textNode)) {
          hiddenTextOriginMap.set(textNode, textNode.nodeValue);
        }
        textNode.nodeValue = '';
      }
    }

    function restoreOriginalDom() {
      const liveBody = getLiveMarkdownBody();
      for (const [textNode, originalValue] of hiddenTextOriginMap.entries()) {
        if (textNode.isConnected) {
          textNode.nodeValue = originalValue;
        }
      }
      hiddenTextOriginMap.clear();

      if (!liveBody) return;
      liveBody.querySelectorAll('.st-gh-trans-block, .st-gh-trans-inline').forEach((el) => el.remove());
      liveBody.querySelectorAll('[data-st-gh-hidden-child="1"]').forEach((el) => {
        el.style.display = el.dataset.stGhOrigDisplay || '';
        delete el.dataset.stGhHiddenChild;
        delete el.dataset.stGhOrigDisplay;
      });

      const savedChildren = savedBodyChildrenMap.get(liveBody);
      if (savedChildren && liveBody.dataset.stCnReplaced === '1') {
        liveBody.replaceChildren(...savedChildren);
        delete liveBody.dataset.stCnReplaced;
      }
    }

    function renderTranslatedBlock(item, translatedText, mode) {
      let { el, subList, text, seg } = item;
      if (!el || !el.isConnected) {
        const liveBody = getLiveMarkdownBody();
        if (!liveBody) return;
        const freshMatch = collectGitHubTranslatableBlocks(liveBody).find((b) => b.text === text);
        if (!freshMatch) return;
        el = freshMatch.el;
        subList = freshMatch.subList;
        seg = freshMatch.seg;
      }
      if (!translatedText) return;

      const preferInline =
        el.tagName === 'SUMMARY' ||
        el.classList?.contains('markdown-alert-title') ||
        Boolean(seg?.hasMedia);

      const transNode = document.createElement(preferInline || mode === 'ch' ? 'span' : 'div');
      transNode.className = preferInline
        ? (mode === 'ch' ? 'st-gh-trans-inline st-gh-ch-only' : 'st-gh-trans-inline')
        : (mode === 'ch' ? 'st-gh-trans-block st-gh-ch-only' : 'st-gh-trans-block');

      if (seg && seg.hasRich && seg.tokens && seg.tokens.length > 0) {
        transNode.appendChild(buildRichTranslationFragment(translatedText, seg.tokens));
      } else {
        transNode.textContent = translatedText.replace(/(?:\[|【)\s*(?:\[|【)\s*(?:C|L|\/[\s]*L)\s*\d+\s*(?:\]|】)\s*(?:\]|】)/gi, '');
      }

      const ghColorSrc = seg?.styleSource || el;
      const ghSameSrc = ghColorSrc === el;
      const ghLiveSt = window.getComputedStyle(ghColorSrc);
      copyVisualStyleFromElement(ghColorSrc, transNode, {
        sourceStyle: ghLiveSt,
        isInline: preferInline,
        preserveExactColor: true,
        deferColorUntilMounted: ghSameSrc && mode === 'ch',
      });

      if (mode === 'ch') {
        hideDirectTextInGhBlock(el, subList);
        // CH 模式下若富文本已完整还原 <code>/<a>/<strong>，临时隐藏原始行内节点以避免重复显示，恢复时 100% 还原
        if (seg && seg.hasRich) {
          for (const ch of el.children) {
            if (ch === subList || ch.classList?.contains('anchor') || ch.matches?.('ul, ol, img, picture, svg, .st-gh-trans-block, .st-gh-trans-inline')) {
              continue;
            }
            if (!ch.dataset.stGhHiddenChild) {
              ch.dataset.stGhOrigDisplay = ch.style.display;
              ch.dataset.stGhHiddenChild = '1';
              ch.style.display = 'none';
            }
          }
        }
        if (subList) {
          el.insertBefore(transNode, subList);
        } else {
          el.appendChild(transNode);
        }
      } else if (mode === 'bilingual') {
        if (preferInline) {
          if (subList) el.insertBefore(transNode, subList);
          else el.appendChild(transNode);
        } else if (subList) {
          el.insertBefore(transNode, subList);
        } else if (el.tagName === 'LI' || el.tagName === 'TD' || el.tagName === 'TH') {
          el.appendChild(transNode);
        } else if (el.parentElement?.classList?.contains('markdown-heading')) {
          el.parentElement.insertAdjacentElement('afterend', transNode);
        } else {
          el.insertAdjacentElement('afterend', transNode);
        }
      }
    }

    function ensureCnReadme(signal) {
      if (cnReadmeRepoCache.has(repoKey)) {
        return Promise.resolve(cnReadmeRepoCache.get(repoKey));
      }
      if (cnReadmePromise) return cnReadmePromise;

      cnReadmePromise = (async () => {
        try {
          const found = await findRootChineseReadmeMarkdown(repoInfo, getLiveMarkdownBody(), signal);
          if (disposed || signal?.aborted) return null;
          if (!found) {
            cnReadmeRepoCache.set(repoKey, null);
            return null;
          }
          const baseDir = found.fileName.includes('/')
            ? found.fileName.slice(0, found.fileName.lastIndexOf('/'))
            : '';
          const repoCtx = {
            owner: repoInfo.owner,
            repo: repoInfo.repo,
            branch: repoInfo.branch,
            ref: found.ref,
            baseDir,
          };
          const domNodes = parseMarkdownToDomNodes(found.markdown, repoCtx);
          const blocks = [];
          const tempWrap = document.createElement('div');
          domNodes.forEach((n) => tempWrap.appendChild(n.cloneNode(true)));
          tempWrap.querySelectorAll('h1, h2, h3, h4, h5, h6, p, blockquote').forEach((el) => {
            if (!el.closest('pre, code, li, td, th') && (el.textContent || '').trim().length > 1) {
              blocks.push(el);
            }
          });
          const listAndCellBlocks = [];
          tempWrap.querySelectorAll('li, td, th').forEach((el) => {
            if (el.closest('pre, code')) return;
            const subList = el.tagName === 'LI' ? el.querySelector(':scope > ul, :scope > ol') : null;
            const txt = (subList ? extractDirectTextBeforeSubList(el, subList) : (el.textContent || '')).replace(/\s+/g, ' ').trim();
            if (txt.length > 0) listAndCellBlocks.push(txt);
          });
          const result = { ...found, domNodes, blocks, listAndCellBlocks };
          cnReadmeRepoCache.set(repoKey, result);
          return result;
        } catch (_) {
          return null;
        } finally {
          cnReadmePromise = null;
        }
      })();
      return cnReadmePromise;
    }

    const ghWriter = new DomWriteScheduler();

    async function streamMachineTranslation(mode, mySession, isSuperseded, signal) {
      const liveBody = getLiveMarkdownBody();
      if (!liveBody) return;
      const blocks = collectGitHubTranslatableBlocks(liveBody);

      // 视口优先排序：首屏可见的 README 内容放入第一批，大幅缩短首屏出字耗时
      const vh = window.innerHeight;
      const scored = blocks.map((item, origIdx) => {
        const r = item.el.getBoundingClientRect();
        const inView = r.bottom >= -120 && r.top <= vh + 350 ? 0 : 1;
        return { item, inView, origIdx };
      });
      scored.sort((a, b) => a.inView - b.inView || a.origIdx - b.origIdx);

      const pendingBlocks = [];
      const pendingTexts = [];

      for (const { item } of scored) {
        if (isSuperseded() || signal?.aborted) return;
        const cached = textTransCache.get(item.text);
        if (cached && cached !== item.text) {
          ghWriter.enqueue(() => {
            if (disposed || ghSession !== mySession || currentMode !== mode || isSuperseded()) return;
            renderTranslatedBlock(item, cached, mode);
          });
        } else {
          pendingBlocks.push(item);
          pendingTexts.push(item.text);
        }
      }

      if (pendingTexts.length === 0) return;

      await translateMany(
        pendingTexts,
        (idx, res) => {
          if (disposed || ghSession !== mySession || currentMode !== mode || isSuperseded()) return;
          const item = pendingBlocks[idx];
          const clean = (res || '').trim();
          if (!item || !clean || clean === item.text) return;
          textTransCache.set(item.text, clean);
          ghWriter.enqueue(() => {
            if (disposed || ghSession !== mySession || currentMode !== mode || isSuperseded()) return;
            renderTranslatedBlock(item, clean, mode);
          });
        },
        () => disposed || ghSession !== mySession || currentMode !== mode || isSuperseded(),
        signal
      );
    }

    function applyCnReadmeToPage(cnData, mode) {
      const liveBody = getLiveMarkdownBody();
      if (!liveBody || !cnData) return false;

      if (mode === 'ch' && cnData.domNodes.length > 0) {
        restoreOriginalDom();
        if (!savedBodyChildrenMap.has(liveBody)) {
          savedBodyChildrenMap.set(liveBody, Array.from(liveBody.childNodes));
        }
        liveBody.dataset.stCnReplaced = '1';
        liveBody.replaceChildren(...cnData.domNodes.map((n) => n.cloneNode(true)));
        return true;
      }

      if (mode === 'bilingual' && cnData.blocks.length > 0) {
        const paraBlocks = Array.from(liveBody.querySelectorAll('h1, h2, h3, h4, h5, h6, p, blockquote')).filter(
          (el) =>
            !el.closest('pre, code, li, td, th, .st-gh-trans-block') &&
            isForeignTextValid(el.textContent || '')
        );
        // 过滤中文 README 顶部的纯语言切换条（如 "English | 简体中文"），防止整篇双语错位
        const cnParagraphs = cnData.blocks.filter((el) => {
          const t = (el.textContent || '').trim();
          if (t.length <= 40 && /^(?:English|中文|简体中文|繁體中文|日本語|한국어|README)(?:\s*[|·/]\s*(?:English|中文|简体中文|繁體中文|日本語|한국어|README))+$/i.test(t)) {
            return false;
          }
          return true;
        });

        const mountCnPair = (el, cnEl) => {
          if (!cnEl || !(cnEl.textContent || '').trim()) return;
          const div = document.createElement('div');
          div.className = 'st-gh-trans-block';
          for (const ch of cnEl.childNodes) {
            div.appendChild(ch.cloneNode(true));
          }
          copyVisualStyleFromElement(el, div, { preserveExactColor: true });
          if (el.parentElement?.classList?.contains('markdown-heading')) {
            el.parentElement.insertAdjacentElement('afterend', div);
          } else {
            el.insertAdjacentElement('afterend', div);
          }
        };

        // 按标题锚点分段对齐：即使某一章节中英文段落数略有差异，也不会把后续所有章节错位
        const splitIntoSections = (arr) => {
          const secs = [{ heading: null, items: [] }];
          for (const el of arr) {
            if (/^H[1-6]$/.test(el.tagName)) {
              secs.push({ heading: el, items: [] });
            } else {
              secs[secs.length - 1].items.push(el);
            }
          }
          return secs;
        };

        const enSecs = splitIntoSections(paraBlocks);
        const cnSecs = splitIntoSections(cnParagraphs);
        const canSectionAlign =
          enSecs.length > 1 &&
          enSecs.length === cnSecs.length &&
          enSecs.slice(1).every((s, idx) => s.heading?.tagName === cnSecs[idx + 1].heading?.tagName);

        if (canSectionAlign) {
          restoreOriginalDom();
          for (let s = 0; s < enSecs.length; s++) {
            if (enSecs[s].heading && cnSecs[s].heading) {
              mountCnPair(enSecs[s].heading, cnSecs[s].heading);
            }
            const minLen = Math.min(enSecs[s].items.length, cnSecs[s].items.length);
            for (let k = 0; k < minLen; k++) {
              mountCnPair(enSecs[s].items[k], cnSecs[s].items[k]);
            }
          }
        } else if (
          paraBlocks.length > 0 &&
          Math.abs(cnParagraphs.length - paraBlocks.length) <= Math.max(3, Math.floor(paraBlocks.length * 0.35))
        ) {
          restoreOriginalDom();
          paraBlocks.forEach((el, idx) => mountCnPair(el, cnParagraphs[idx]));
        } else {
          return false;
        }
        if (true) {
          // 同步对齐列表项与表格单元格，避免双语模式下列表/表格留白
          if (cnData.listAndCellBlocks && cnData.listAndCellBlocks.length > 0) {
            const enCells = Array.from(liveBody.querySelectorAll('li, td, th')).filter(
              (el) => !el.closest('pre, code, .st-gh-trans-block') && isForeignTextValid(el.textContent || '')
            );
            if (Math.abs(cnData.listAndCellBlocks.length - enCells.length) <= Math.max(2, Math.floor(enCells.length * 0.3))) {
              enCells.forEach((el, idx) => {
                const cnItem = cnData.listAndCellBlocks[idx];
                if (cnItem && cnItem.trim()) {
                  const div = document.createElement('div');
                  div.className = 'st-gh-trans-block';
                  div.textContent = cnItem.trim();
                  const subList = el.tagName === 'LI' ? el.querySelector(':scope > ul, :scope > ol') : null;
                  if (subList) el.insertBefore(div, subList);
                  else el.appendChild(div);
                }
              });
            }
          }
          return true;
        }
      }
      return false;
    }

    async function switchMode(mode) {
      const mySession = ++ghSession;
      if (ghAbortController) {
        ghAbortController.abort();
      }
      ghAbortController = typeof AbortController === 'function' ? new AbortController() : null;
      const mySignal = ghAbortController ? ghAbortController.signal : null;

      setActiveButton(mode);
      setCurrentPageLineageMode(mode === 'en' ? 'off' : mode);

      if (mode === 'en') {
        setLoading(false);
        restoreOriginalDom();
        return;
      }

      setLoading(true);
      try {
        restoreOriginalDom();

        // 若已有缓存的有效中文 README，立即应用
        if (cnReadmeRepoCache.has(repoKey)) {
          const cachedCn = cnReadmeRepoCache.get(repoKey);
          if (cachedCn && applyCnReadmeToPage(cachedCn, mode)) {
            return;
          }
        }

        // 立即启动 Google + Microsoft 机翻，同时后台静默检测中文 README（不阻塞机翻）
        let appliedCn = false;
        const mtAbortController = typeof AbortController === 'function' ? new AbortController() : null;
        if (mySignal && mtAbortController) {
          mySignal.addEventListener('abort', () => mtAbortController.abort(), { once: true });
        }

        const fillRemainingUnmatchedInBilingual = () => {
          const liveBody = getLiveMarkdownBody();
          if (!liveBody || disposed || ghSession !== mySession || currentMode !== 'bilingual') return;
          const unmatched = collectGitHubTranslatableBlocks(liveBody).filter((b) => {
            const el = b.el;
            if (el.querySelector('.st-gh-trans-block, .st-gh-trans-inline')) return false;
            const anchor = el.parentElement?.classList?.contains('markdown-heading') ? el.parentElement : el;
            if (anchor.nextElementSibling?.classList?.contains('st-gh-trans-block')) return false;
            return true;
          });
          if (unmatched.length === 0) return;
          translateMany(
            unmatched.map((u) => u.text),
            (idx, res) => {
              if (disposed || ghSession !== mySession || currentMode !== 'bilingual') return;
              const clean = (res || '').trim();
              if (!clean || clean === unmatched[idx].text) return;
              textTransCache.set(unmatched[idx].text, clean);
              ghWriter.enqueue(() => {
                if (disposed || ghSession !== mySession || currentMode !== 'bilingual') return;
                renderTranslatedBlock(unmatched[idx], clean, 'bilingual');
              });
            },
            () => disposed || ghSession !== mySession || currentMode !== 'bilingual',
            mySignal
          );
        };

        const bgCnPromise = !cnReadmeRepoCache.has(repoKey)
          ? ensureCnReadme(mySignal).then((cnData) => {
              if (!disposed && ghSession === mySession && currentMode === mode && cnData) {
                if (applyCnReadmeToPage(cnData, mode)) {
                  appliedCn = true;
                  mtAbortController?.abort();
                  if (mode === 'bilingual') fillRemainingUnmatchedInBilingual();
                }
              }
            })
          : Promise.resolve();

        await Promise.all([
          streamMachineTranslation(mode, mySession, () => appliedCn, mtAbortController ? mtAbortController.signal : mySignal).catch((err) => {
            if (err?.name !== 'AbortError') {
              console.warn('[SmartTranslator] GitHub translation error:', err);
            }
          }),
          bgCnPromise,
        ]);
      } finally {
        if (!disposed && ghSession === mySession) {
          setLoading(false);
        }
      }
    }

    switcher.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      switchMode(btn.dataset.mode);
    });

    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openGlossaryModal();
    });

    // 空闲预取：仅当页面 DOM 已明确出现中文 README 链接或根目录文件时静默预热缓存（对无中文 README 的仓库 0 额外请求），点击切换时可 0ms 秒开
    const idlePrefetch = () => {
      if (disposed || cnReadmeRepoCache.has(repoKey)) return;
      const domInfo = detectRootCnReadmeFromPageDom(repoInfo);
      const bodyEl = getLiveMarkdownBody();
      const linked = detectCnReadmeLinksInBody(repoInfo, bodyEl, domInfo.defaultBranch);
      if (domInfo.matchedFiles.length > 0 || linked.length > 0) {
        ensureCnReadme(null);
      }
    };
    // 按来源页面继承翻译模式（先读后写，防止覆盖同标签 sessionStorage）
    const inherited = resolveInheritedModeForCurrentPage();
    let autoStarted = false;
    if (!readmeIsChinese && (inherited === 'bilingual' || inherited === 'ch')) {
      autoStarted = true;
      setCurrentPageLineageMode(inherited);
      setTimeout(() => {
        if (!disposed && currentMode === 'en') {
          switchMode(inherited);
        }
      }, 80);
    } else {
      setCurrentPageLineageMode('off');
    }

    if (!autoStarted) {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(idlePrefetch, { timeout: 1200 });
      } else {
        setTimeout(idlePrefetch, 700);
      }
    }
  }

  // ============================================================================
  // 9. 入口路由与 SPA / GitHub Turbo / PJAX 生命周期管理
  // ============================================================================
  function bootstrap() {
    bindNavigationLineageTracker();
    initImageDotTrigger();
    setTimeout(maybeSyncLanGlossary, 1500);
    const isGitHub = location.hostname === 'github.com' || location.hostname.endsWith('.github.com');

    if (isGitHub) {
      let ghInitTimer = null;
      const syncGitHubPageMode = () => {
        const hasReadme = Boolean(parseGitHubRepoInfo() && getLiveMarkdownBody());
        if (hasReadme) {
          const floating = document.getElementById('st-floating-host');
          if (floating) floating.remove();
          initGitHubReadmeTranslator();
        } else {
          // GitHub Issues / PRs / Discussions / Releases / Commits 页面自动启用边缘悬浮球翻译
          if (activeGitHubCleanup) {
            activeGitHubCleanup();
            activeGitHubCleanup = null;
          }
          const bar = document.querySelector('.st-gh-standalone-bar');
          if (bar) bar.remove();
          initGeneralPageTranslator();
        }
      };

      const scheduleGhInit = (delay = 180) => {
        if (ghInitTimer) clearTimeout(ghInitTimer);
        ghInitTimer = setTimeout(() => {
          ghInitTimer = null;
          syncGitHubPageMode();
        }, delay);
      };

      syncGitHubPageMode();
      document.addEventListener('turbo:load', () => scheduleGhInit(180));
      document.addEventListener('turbo:render', () => scheduleGhInit(180));
      document.addEventListener('turbo:frame-load', () => scheduleGhInit(180));
      document.addEventListener('pjax:end', () => scheduleGhInit(180));
      window.addEventListener('popstate', () => scheduleGhInit(220));

      if (!history.__stGhPatched) {
        history.__stGhPatched = true;
        const origGhPush = history.pushState;
        if (typeof origGhPush === 'function') {
          history.pushState = function (...args) {
            const ret = origGhPush.apply(this, args);
            scheduleGhInit(220);
            return ret;
          };
        }
        const origGhReplace = history.replaceState;
        if (typeof origGhReplace === 'function') {
          history.replaceState = function (...args) {
            const ret = origGhReplace.apply(this, args);
            scheduleGhInit(220);
            return ret;
          };
        }
      }

      // 仅在尚未挂载切换栏或路由仓库/分支变化时响应，避免在 GitHub 页面常驻高频空转
      const observer = new MutationObserver((mutations) => {
        const bar = document.querySelector('.st-gh-standalone-bar');
        const info = parseGitHubRepoInfo();
        const curKey = info ? `${info.owner}/${info.repo}@${info.branch || 'default'}:${info.subDir || ''}` : '';
        if (bar && bar.dataset.stRepoKey === curKey) return;
        for (const m of mutations) {
          if (m.addedNodes.length > 0) {
            if (getLiveMarkdownBody()) {
              scheduleGhInit(150);
              return;
            }
          }
        }
      });
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    } else {
      initGeneralPageTranslator();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();