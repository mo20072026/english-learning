/* 英语学习工作台 · 纯静态版
 * 数据：data.js（构建时烘焙，无后端、无账号）
 * 进度：localStorage；可选手动同步到自己的 GitHub Gist
 */
(function () {
  'use strict';

  var DATA = (window.EN_DATA && window.EN_DATA.items) ? window.EN_DATA : { cats: {}, items: [] };
  var ITEMS = DATA.items || [];
  var LS_PROG = 'en_prog_v2';   /* v2：2026-10-17 全量重置为「未掌握」，旧进度作废 */
  var LS_PROG_OLD = 'en_prog_v1';
  var LS_GH = 'en_gh_v1';
  var LS_RESET = 'en_prog_reset_v1';   /* 最近一次「清空进度」的时间戳，同步时用来压过云端旧标记 */
  var LS_LASTSYNC = 'en_sync_at_v1';   /* 最近一次成功同步的时间，仅用于展示 */
  var PAGE = 10;          /* 每页条数 */
  var PAGER_SPAN = 2;     /* 当前页左右各显示几个页码 */
  var REVIEW_N = 10;

  var state = {
    view: 'words',
    q: { words: '', talks: '' },
    cat: { words: '', talks: '' },
    sub: { words: '', talks: '' },
    lv: { words: '' },
    page: { words: 1, talks: 1 },    /* 页码，从 1 开始 */
    prog: {},
    resetAt: 0,
    ttsDisabled: false,
    ttsFail: 0,
    gh: { token: '', gistId: '', auto: true },
    review: [],
    reviewSeen: [],
    ghBusy: false,
    ghSynced: false,
    ghLastSync: 0,
    ghFindAt: 0,
    ghError: '',
    ghPushOk: null,
    __build: '20261017-3',
    pushTimer: null,
    pollTimer: null,
    agoTimer: null
  };
  var SYNC_PREFIX = 'ENSYNC1.';
  var POLL_MS = 60000;        /* 后台轮询间隔：页面可见时每 60 秒对齐一次 */
  var POLL_MIN_GAP = 25000;   /* 两次同步之间的最小间隔，避免切标签页时频繁打接口 */

  /* ---------------- 工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function lsGet(k, d) {
    try { var r = localStorage.getItem(k); return r ? JSON.parse(r) : d; } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
  }
  function todayStr() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast on';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast'; }, 2000);
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  /* ---------------- 掌握程度 ---------------- */
  function levelOf(it) {
    var p = state.prog[it.i];
    return (p && p.lv) || it.lv || '未学';
  }
  function levelName(lv) {
    return lv === '已掌握' ? '已掌握' : lv === '学习中' ? '加强学习' : '未掌握';
  }
  function levelChipCls(lv) {
    return lv === '已掌握' ? 'green' : lv === '学习中' ? 'orange' : 'gray';
  }
  function setLevel(id, lv, opts) {
    opts = opts || {};
    /* 再点当前状态＝取消标记，回到「未掌握」（写成一条 lv=未学 的记录，这样取消动作也会同步到其他设备） */
    var cur = (state.prog[id] && state.prog[id].lv) || '未学';
    var canceled = false;
    if (opts.toggle && lv !== '未学' && cur === lv) { lv = '未学'; canceled = true; }
    if (!state.prog[id]) state.prog[id] = {};
    state.prog[id].lv = lv;
    state.prog[id].t = Date.now();
    saveProg();
    if (opts.silent !== true) {
      toast(canceled ? '已取消标记，恢复「未掌握」' : '已标记为「' + levelName(lv) + '」');
    }
    if (state.gh.auto && state.gh.token) schedulePush();
  }
  function saveProg() {
    if (!lsSet(LS_PROG, state.prog)) toast('本地存储空间不足，进度未能保存');
  }

  /* ---------------- 索引与筛选 ---------------- */
  var INDEX = { words: [], talks: [] };
  var CATS = { words: [], talks: [] };
  var SUBS = { words: {}, talks: {} };

  function buildIndex() {
    var byKind = { '单词': 'words', '对话': 'talks' };
    for (var i = 0; i < ITEMS.length; i++) {
      var it = ITEMS[i];
      var k = byKind[it.k];
      if (!k) continue;
      INDEX[k].push(it);
      var c = it.c || '未分类';
      if (!SUBS[k][c]) { SUBS[k][c] = []; CATS[k].push(c); }
      var s = it.s || '';
      if (s && SUBS[k][c].indexOf(s) < 0) SUBS[k][c].push(s);
    }
  }

  function match(it, kind) {
    var q = state.q[kind];
    if (q) {
      var qq = q.toLowerCase();
      if ((it.t || '').toLowerCase().indexOf(qq) < 0 &&
          (it.en || '').toLowerCase().indexOf(qq) < 0 &&
          (it.cn || '').toLowerCase().indexOf(qq) < 0) return false;
    }
    if (state.cat[kind] && (it.c || '未分类') !== state.cat[kind]) return false;
    if (state.sub[kind] && (it.s || '') !== state.sub[kind]) return false;
    if (kind === 'words' && state.lv.words && levelOf(it) !== state.lv.words) return false;
    return true;
  }

  function filtered(kind) {
    var out = [], arr = INDEX[kind];
    for (var i = 0; i < arr.length; i++) if (match(arr[i], kind)) out.push(arr[i]);
    return out;
  }

  function findItem(id) {
    for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].i === id) return ITEMS[i];
    return null;
  }

  /* ---------------- 渲染：列表 ---------------- */
  function sayBtn(id, text) {
    if (!text) return '';
    return '<button class="btn ghost sm say" data-say="' + esc(text) + '" title="朗读"><svg class="i-say" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 9H3a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2l4 4V5L5 9zm7 0a3.5 3.5 0 0 1 0 6.5v-2a1.5 1.5 0 0 0 0-3v-1.5zm3.5-3A7 7 0 0 1 15.5 19v-1.8a5.2 5.2 0 0 0 0-9.8V6z" fill="currentColor"/></svg></button>';
  }

  function itemHtml(it, kind) {
    var lv = levelOf(it);
    var chips =
      '<span class="chip cat">' + esc(it.c || '未分类') + '</span>' +
      (it.s ? '<span class="chip gray">' + esc(it.s) + '</span>' : '') +
      '<span class="chip ' + levelChipCls(lv) + '" data-lvl-tag="' + esc(it.i) + '">' + levelName(lv) + '</span>';
    var head, body;
    if (kind === 'words') {
      head = sayBtn(it.i + '_a', it.en || it.t) +
        '<span class="ttl">' + esc(it.t || it.en) + '</span>' + chips +
        '<div style="flex:1 1 auto"></div>' +
        '<button class="btn ghost sm' + (lv === '已掌握' ? ' on' : '') + '" data-lvl="' + esc(it.i) + '|已掌握" title="' + (lv === '已掌握' ? '再点一次取消标记' : '标记为已掌握') + '">已掌握</button>' +
        '<button class="btn ghost sm' + (lv === '学习中' ? ' on' : '') + '" data-lvl="' + esc(it.i) + '|学习中" title="' + (lv === '学习中' ? '再点一次取消标记' : '标记为要加强学习') + '">加强学习</button>';
      body = (it.en && it.en !== it.t ? '<div class="en">' + esc(it.en) + '</div>' : '') +
        (it.cn ? '<div class="cn">' + esc(it.cn) + '</div>' : '');
      if (it.en && it.en === it.t && it.cn) body = '<div class="cn">' + esc(it.cn) + '</div>';
    } else {
      head = sayBtn(it.i + '_a', it.en || it.t) +
        '<span class="ttl">' + esc(it.t || it.en) + '</span>' + chips;
      body = (it.en ? '<div class="en">' + esc(it.en) + '</div>' : '') +
        (it.cn ? '<div class="cn">' + esc(it.cn) + '</div>' : '');
    }
    return '<div class="item" data-id="' + esc(it.i) + '">' +
      '<div class="item-h">' + head + '</div>' + body + '</div>';
  }

  function renderList(kind) {
    var box = $('list-' + kind);
    if (!box) return;
    var rows = filtered(kind);
    var total = rows.length;
    var pages = Math.max(1, Math.ceil(total / PAGE));
    var page = Math.min(Math.max(1, state.page[kind] | 0), pages);
    state.page[kind] = page;
    var start = (page - 1) * PAGE;
    var cnt = $('cnt-' + kind);
    if (cnt) { cnt.textContent = total + ' 条'; cnt.className = 'chip gray cnt'; }

    if (!total) {
      box.innerHTML = '<div class="empty">没有符合条件的条目，换个关键词或筛选试试。</div>';
    } else {
      var h = '';
      for (var i = start; i < Math.min(start + PAGE, total); i++) h += itemHtml(rows[i], kind);
      box.innerHTML = h;
    }
    var pager = $('pager-' + kind);
    if (pager) {
      pager.innerHTML = total ? pagerHtml(kind, total, pages, page) : '';
      pager.hidden = !total || pages <= 1;
    }
  }

  /* 分页控件：上一页 / 页码（带省略号）/ 下一页 / 输入页码跳转 */
  function pagerHtml(kind, total, pages, page) {
    var nums = [];
    var add = function (n) { if (n >= 1 && n <= pages && nums.indexOf(n) < 0) nums.push(n); };
    add(1); add(2); add(pages); add(pages - 1);
    for (var i = page - PAGER_SPAN; i <= page + PAGER_SPAN; i++) add(i);
    nums.sort(function (a, b) { return a - b; });
    var mid = '', prev = 0;
    nums.forEach(function (n) {
      if (prev && n - prev > 1) mid += '<span class="pg-gap">…</span>';
      mid += '<button class="btn ghost sm' + (n === page ? ' on' : '') + '" data-pg="' + kind + '|' + n + '">' + n + '</button>';
      prev = n;
    });
    return '<div class="pager">' +
        '<button class="btn ghost sm" data-pg="' + kind + '|' + Math.max(1, page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
        mid +
        '<button class="btn ghost sm" data-pg="' + kind + '|' + Math.min(pages, page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>下一页</button>' +
        '<span class="muted pg-info">第 ' + page + '/' + pages + ' 页 · 共 ' + total + ' 条</span>' +
        '<span class="pg-jump">跳到 <input class="pg-input" id="pg-' + kind + '" type="number" min="1" max="' + pages + '" value="' + page + '" /> 页' +
        '<button class="btn ghost sm" data-pg-go="' + kind + '">跳转</button></span>' +
      '</div>';
  }
  function gotoPage(kind, n) {
    var rows = filtered(kind);
    var pages = Math.max(1, Math.ceil(rows.length / PAGE));
    n = parseInt(n, 10);
    if (!n || n < 1) n = 1;
    if (n > pages) n = pages;
    state.page[kind] = n;
    renderList(kind);
    var box = $('list-' + kind);
    if (box && box.scrollIntoView) box.scrollIntoView({ block: 'start' });
  }

  /* ---------------- 渲染：复习 ---------------- */
  function reviewPool() {
    var out = [], arr = INDEX.words;
    for (var i = 0; i < arr.length; i++) {
      var lv = levelOf(arr[i]);
      if (lv === '已掌握' || lv === '学习中') out.push(arr[i]);
    }
    return out;
  }

  function pickReview(force) {
    var pool = reviewPool();
    /* 全部都是「未掌握」时（如刚重置），先从单词库里随机抽，避免复习区空着 */
    state.reviewFallback = false;
    if (!pool.length) {
      pool = INDEX.words.slice();
      state.reviewFallback = true;
    }
    var seen = (force && state.reviewSeen) || [];
    var pick = [];
    var seenSet = {};
    for (var i = 0; i < seen.length; i++) seenSet[seen[i]] = 1;
    var fresh = pool.filter(function (it) { return !seenSet[it.i]; });
    if (fresh.length < REVIEW_N) fresh = pool.slice();
    shuffle(fresh);
    pick = fresh.slice(0, Math.min(REVIEW_N, fresh.length));
    state.review = pick;
    if (force) state.reviewSeen = pick.map(function (x) { return x.i; });
    renderReview();
  }

  function renderReview() {
    var box = $('reviewList');
    var cnt = $('reviewCount');
    if (!box) return;
    var items = state.review.filter(function (it) { return !!findItem(it.i); });
    if (cnt) {
      cnt.textContent = items.length
        ? ('本轮 ' + items.length + ' 个' + (state.reviewFallback ? ' · 未掌握随机' : ''))
        : '暂无可复习';
      cnt.className = 'chip ' + (items.length ? 'orange' : 'gray');
    }
    if (!items.length) {
      box.innerHTML = '<div class="empty">还没有标记为「已掌握」或「加强学习」的单词。' +
        '在下方单词库里点右侧按钮标记后，这里会随机抽 10 个出来复习。</div>';
      return;
    }
    var h = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i], lv = levelOf(it);
      h += '<div class="todo" data-rid="' + esc(it.i) + '">' +
        sayBtn(it.i + '_r', it.en || it.t) +
        '<div class="grow"><div class="t">' + esc(it.t || it.en) + '</div>' +
        '<div class="s">' + esc([it.en !== it.t ? it.en : '', it.cn].filter(Boolean).join(' · ') || (it.c || '')) + '</div></div>' +
        '<span class="chip ' + levelChipCls(lv) + '">' + levelName(lv) + '</span>' +
        '<button class="btn ghost sm' + (lv === '已掌握' ? ' on' : '') + '" data-rlvl="' + esc(it.i) + '|已掌握" title="' + (lv === '已掌握' ? '再点一次取消标记' : '标记为已掌握') + '">还是已掌握</button>' +
        '<button class="btn ghost sm' + (lv === '学习中' ? ' on' : '') + '" data-rlvl="' + esc(it.i) + '|学习中" title="' + (lv === '学习中' ? '再点一次取消标记' : '标记为要加强学习') + '">要加强学习</button>' +
        '</div>';
    }
    box.innerHTML = h;
  }

  /* ---------------- 统计 ---------------- */
  function renderStats() {
    var w = INDEX.words.length, t = INDEX.talks.length;
    var n = { full: 0, learn: 0, none: 0 };
    for (var i = 0; i < INDEX.words.length; i++) {
      var lv = levelOf(INDEX.words[i]);
      if (lv === '已掌握') n.full++;
      else if (lv === '学习中') n.learn++;
      else n.none++;
    }
    var set = function (id, v) { var el = $(id); if (el) el.textContent = v; };
    set('st-total', (w + t).toLocaleString());
    set('st-words', w.toLocaleString());
    set('st-talks', t);
    set('st-full', n.full.toLocaleString());
    set('st-learn', n.learn.toLocaleString());
    set('st-none', n.none.toLocaleString());
    set('st-rate', w ? (Math.round(n.full / w * 1000) / 10 + '%') : '0%');
    set('wordTotal', w.toLocaleString());
    set('talkTotal', t.toLocaleString());
    set('st-total2', (w + t).toLocaleString());
    var nw = $('nav-words'), nt = $('nav-talks');
    if (nw) nw.textContent = w.toLocaleString();
    if (nt) nt.textContent = t;
  }

  /* ---------------- 朗读（多源音频 TTS） ----------------
   * 有道对长句会返回 500，故按「有道 → 百度」依次尝试；
   * 单条失败只提示，连续失败 3 次才隐藏全部按钮。 */
  var TTS_MAXLEN = 160;
  var TTS_PROVIDERS = [
    { name: '有道', url: function (t) { return 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(t) + '&type=1'; } },
    { name: '百度', url: function (t) { return 'https://fanyi.baidu.com/gettts?lan=en&text=' + encodeURIComponent(t) + '&spd=3&source=web'; } }
  ];
  function ttsText(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length > TTS_MAXLEN) {
      var sents = t.match(/[^.!?]+[.!?]?/g) || [t];
      var buf = '';
      for (var i = 0; i < sents.length; i++) {
        if (buf && buf.length + sents[i].length > TTS_MAXLEN) break;
        buf += sents[i];
      }
      t = buf.trim() || t.slice(0, TTS_MAXLEN);
    }
    return t;
  }
  function sayDisabled() { return state.ttsDisabled || lsGet('en_tts_disabled', false); }
  function hideSayBtns() {
    state.ttsDisabled = true;
    lsSet('en_tts_disabled', true);
    document.body.classList.add('say-hidden');
    toast('连续多次朗读失败，已隐藏朗读按钮');
  }
  function showSayBtns() {
    state.ttsDisabled = false;
    lsSet('en_tts_disabled', false);
    document.body.classList.remove('say-hidden');
  }
  function canPlayAudio() { return typeof Audio === 'function'; }
  function speak(text) {
    if (!text) return;
    if (sayDisabled() || !canPlayAudio()) return;
    playTts(ttsText(text), 0);
  }
  function playTts(text, idx) {
    if (idx >= TTS_PROVIDERS.length) {
      state.ttsFail = (state.ttsFail || 0) + 1;
      toast('这条暂时没有发音，换一条试试');
      if (state.ttsFail >= 3) hideSayBtns();
      return;
    }
    var a = new Audio(TTS_PROVIDERS[idx].url(text));
    var settled = false;
    function stop() { try { a.pause(); } catch (e) { /* 忽略 */ } }
    function next() {
      if (settled) return;
      settled = true;
      stop();
      playTts(text, idx + 1);
    }
    a.addEventListener('error', next);
    a.addEventListener('stalled', next);
    var p;
    try { p = a.play(); } catch (e) { next(); return; }
    if (p && typeof p.then === 'function') {
      p.then(function () { state.ttsFail = 0; }).catch(function (e) {
        if (e && e.name === 'NotAllowedError') { toast('浏览器阻止了自动播放，请再点一次'); return; }
        next();
      });
    }
  }

  /* ---------------- GitHub Gist 同步 ---------------- */
  var GH_FILE = 'english-progress.json';
  var GH_API = 'https://api.github.com';

  /* 凭据双写：localStorage 为主，cookie 兜底一年。
     手机浏览器（iOS Safari / 微信）清理缓存时会丢掉 localStorage，cookie 通常活得更久，
     这样"填一次 Token"能真正记住，不用反复输入。 */
  var GH_COOKIE = 'en_gh_cfg';
  function cookieSet(name, val, days) {
    try {
      var attrs = '; path=/; max-age=' + (days * 86400) + '; SameSite=Lax';
      if (location.protocol === 'https:') attrs += '; Secure';
      document.cookie = name + '=' + encodeURIComponent(val) + attrs;
    } catch (e) { /* 无痕模式等场景忽略 */ }
  }
  function cookieGet(name) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }
  function ghSave() {
    var cfg = { token: state.gh.token || '', gistId: state.gh.gistId || '', auto: state.gh.auto !== false };
    lsSet(LS_GH, cfg);
    if (cfg.token) cookieSet(GH_COOKIE, JSON.stringify(cfg), 365);
    else cookieSet(GH_COOKIE, '', 0);
  }
  /* 读取本机保存的同步配置：localStorage 没有时回退到 cookie */
  function ghLoadCfg() {
    var gh = lsGet(LS_GH, null);
    if (gh && gh.token) {
      /* 老用户只有 localStorage、没有 cookie：顺手补写 cookie，缓存被清时能恢复 */
      if (!cookieGet(GH_COOKIE)) cookieSet(GH_COOKIE, JSON.stringify(gh), 365);
      return gh;
    }
    var raw = cookieGet(GH_COOKIE);
    if (!raw) return null;
    try {
      gh = JSON.parse(raw);
      if (gh && gh.token) { lsSet(LS_GH, gh); return gh; }   /* 顺手补回 localStorage */
    } catch (e) { /* 忽略坏数据 */ }
    return null;
  }
  function ghHeaders() {
    return {
      'Authorization': 'Bearer ' + state.gh.token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };
  }
  function ghStatus(text, cls) {
    var el = $('ghStatus');
    if (el) {
      el.textContent = text;
      el.className = 'dot' + (cls ? ' ' + cls : '');
    }
    /* 顶栏指示器在所有页面都可见：同步失败时用户能立刻看到，并可直接重试 */
    var dot = $('syncDot'), txt = $('syncText'), retry = $('syncRetry');
    if (dot) dot.className = 'dot' + (cls ? ' ' + cls : '');
    if (txt) txt.textContent = state.gh.token ? text : '本地进度';
    if (retry) retry.hidden = !(state.gh.token && cls === 'off');
    renderSyncAgo();
  }
  /* 右上角「上次同步」：只显示相对时间，每 30 秒自己刷新一次，不发请求 */
  function renderSyncAgo() {
    var el = $('syncAgo');
    if (!el) return;
    if (!state.gh.token) { el.textContent = ''; el.title = '填写 Token 后可跨设备同步'; return; }
    el.textContent = state.ghLastSync
      ? syncAgoText()
      : (state.ghBusy ? '正在同步…' : '等待同步');
    el.title = state.ghLastSync ? new Date(state.ghLastSync).toLocaleString() : '尚未同步过';
  }
  function ghPayload() {
    return JSON.stringify({
      v: 2,
      updatedAt: new Date().toISOString(),
      resetAt: state.resetAt || 0,
      prog: state.prog
    });
  }
  var ghLastHeaders = null;                       /* 记录最近一次响应的头，用于自检 Token 权限 */
  function ghHeader(name) {
    try { return ghLastHeaders ? (ghLastHeaders.get(name) || '') : ''; } catch (e) { return ''; }
  }
  function ghFetch(url, opt) {
    return fetch(url, opt).then(function (r) {
      try { ghLastHeaders = r.headers; } catch (e) { /* 某些环境取不到 */ }
      if (!r.ok) {
        return r.text().then(function (t) {
          var msg = t;
          try { msg = JSON.parse(t).message || t; } catch (e) { /* 原文 */ }
          throw new Error('HTTP ' + r.status + ' ' + msg);
        });
      }
      return r.json();
    });
  }
  /* 只用 Token 也能同步：按用途在账号下自动找出备份用的那个 Gist（各设备同一个 Token → 同一个 Gist） */
  function ghFindGist() {
    return ghFetch(GH_API + '/gists?per_page=100', { headers: ghHeaders() })
      .then(function (list) {
        var best = null, bestScore = 0;
        (Array.isArray(list) ? list : []).forEach(function (g) {
          if (!g || !g.files || !g.files[GH_FILE]) return;
          var score = ((g.description || '').indexOf('英语学习') >= 0) ? 2 : 1;
          if (!best || score > bestScore ||
              (score === bestScore && String(g.updated_at || '') > String(best.updated_at || ''))) {
            best = g; bestScore = score;
          }
        });
        return best ? best.id : '';
      })
      .catch(function () { return ''; });
  }
  /* 没有 Gist ID 时先去账号里找一次；force=true 时不使用缓存，用于用户手动触发 */
  function ghEnsureGist(force) {
    if (state.gh.gistId) return Promise.resolve(state.gh.gistId);
    if (!state.gh.token) return Promise.resolve('');
    if (!force && state.ghFindAt && Date.now() - state.ghFindAt < 300000) return Promise.resolve('');
    return ghFindGist().then(function (id) {
      state.ghFindAt = Date.now();
      if (id) {
        state.gh.gistId = id;
        ghSave();
        var gid = $('ghGist');
        if (gid) gid.value = id;
        renderGhBox();
      }
      return state.gh.gistId || '';
    });
  }
  /* 读取任意一个 Gist 里的进度（用于统一多个备份文件） */
  function readGistProg(id) {
    return ghFetch(GH_API + '/gists/' + id, { headers: ghHeaders() }).then(function (g) {
      var f = g.files && g.files[GH_FILE];
      if (!f) return null;
      var o = JSON.parse(f.content || '{}');
      return { prog: (o && o.prog) || {}, resetAt: (o && o.resetAt) || 0 };
    }).catch(function () { return null; });
  }
  /* 账号下出现多个备份文件时（不同设备各自创建过），合并到最近更新的那个并删除多余的。
     不统一的话，各设备会一直各写各的文件，看起来就是"单向同步"。 */
  function ghUnify() {
    if (!state.gh.token) { toast('请先填写 Token'); return Promise.resolve(0); }
    return ghFetch(GH_API + '/gists?per_page=100', { headers: ghHeaders() })
      .then(function (list) {
        var arr = Array.isArray(list) ? list : [];
        var hit = arr.filter(function (g) { return g && g.files && g.files[GH_FILE]; })
          .sort(function (a, b) { return String(a.updated_at || '') < String(b.updated_at || '') ? 1 : -1; });
        if (hit.length < 2) {
          toast(hit.length ? '只找到 1 个备份文件，无需统一' : '账号下没有备份文件');
          return 0;
        }
        return Promise.all(hit.map(function (g) { return readGistProg(g.id); })).then(function (rows) {
          var merged = {}, reset = state.resetAt || 0;
          rows.forEach(function (r) {
            if (!r) return;
            if ((r.resetAt || 0) > reset) reset = r.resetAt || 0;
            Object.keys(r.prog || {}).forEach(function (id) {
              var b = r.prog[id], a = merged[id];
              if (b && (!a || (b.t || 0) > (a.t || 0))) merged[id] = b;
            });
          });
          Object.keys(state.prog).forEach(function (id) {          /* 本机也参与合并 */
            var a = state.prog[id], b = merged[id];
            if (a && (!b || (a.t || 0) > (b.t || 0))) merged[id] = a;
          });
          state.prog = merged;
          state.resetAt = reset;
          saveProg();
          lsSet(LS_RESET, reset);
          state.gh.gistId = hit[0].id;
          ghSave();
          var gid = $('ghGist');
          if (gid) gid.value = state.gh.gistId;
          var body = { files: (function () { var o = {}; o[GH_FILE] = { content: ghPayload() }; return o; })() };
          return ghFetch(GH_API + '/gists/' + hit[0].id, { method: 'PATCH', headers: ghHeaders(), body: JSON.stringify(body) })
            .then(function () {
              /* 删掉多余的；删不掉也不影响，因为已经统一指向同一个文件 */
              return Promise.all(hit.slice(1).map(function (g) {
                return ghFetch(GH_API + '/gists/' + g.id, { method: 'DELETE', headers: ghHeaders() })
                  .catch(function () { return null; });
              }));
            })
            .then(function () {
              refreshAll();
              renderGhBox();
              toast('已把 ' + hit.length + ' 个备份文件合并为 1 个，共 ' + Object.keys(merged).length + ' 条标记');
              return hit.length;
            });
        });
      })
      .catch(function (e) { toast('统一失败：' + (e.message || e)); return 0; });
  }
  function ghCreateGist() {
    return ghFetch(GH_API + '/gists', {
      method: 'POST',
      headers: ghHeaders(),
      body: JSON.stringify({
        description: '英语学习 · 学习进度备份',
        public: false,
        files: (function () { var o = {}; o[GH_FILE] = { content: ghPayload() }; return o; })()
      })
    }).then(function (g) {
      state.gh.gistId = g.id;
      ghSave();
      return g;
    });
  }
  /* 读取云端进度；Gist 还没建或已被删时返回 null */
  function ghSupported() {
    return typeof fetch === 'function' && typeof Promise === 'function';
  }
  function ghRead() {
    if (!ghSupported()) return Promise.resolve(null);
    if (!state.gh.token || !state.gh.gistId) return Promise.resolve(null);
    return ghFetch(GH_API + '/gists/' + state.gh.gistId, { headers: ghHeaders() })
      .then(function (g) {
        var f = g.files && g.files[GH_FILE];
        if (!f) return null;
        if (f.truncated && f.raw_url) {
          return fetch(f.raw_url).then(function (r) { return r.text(); });
        }
        return f.content || '';
      })
      .then(function (text) {
        if (!text) return null;
        var obj = JSON.parse(text);
        return { prog: (obj && obj.prog) || {}, resetAt: (obj && obj.resetAt) || 0 };
      })
      .catch(function (e) {
        if (/HTTP 404/.test(e.message)) return null;   /* Gist 被删了，当作空云端 */
        throw e;
      });
  }

  /* 双向合并：按单条时间戳，新者胜；「清空进度」之前产生的标记不再复活 */
  function ghMerge(remote, remoteResetAt) {
    var cut = Math.max(state.resetAt || 0, remoteResetAt || 0);
    if (cut > (state.resetAt || 0)) { state.resetAt = cut; lsSet(LS_RESET, cut); }
    var changed = 0;
    Object.keys(remote || {}).forEach(function (id) {
      var b = remote[id];
      if (!b || (b.t || 0) <= cut) return;
      var a = state.prog[id];
      if (!a || (b.t || 0) > (a.t || 0)) { state.prog[id] = b; changed++; }
    });
    Object.keys(state.prog).forEach(function (id) {
      var a = state.prog[id];
      if (a && (a.t || 0) <= cut) { delete state.prog[id]; changed++; }
    });
    return changed;
  }

  /* 合并之后，本地是否还有更新的标记需要回传（避免每次开页面都白写一次 Gist） */
  function ghNeedsPush(remote, remoteResetAt) {
    if ((state.resetAt || 0) > (remoteResetAt || 0)) return true;
    var ids = Object.keys(state.prog);
    for (var i = 0; i < ids.length; i++) {
      var a = state.prog[ids[i]], b = (remote || {})[ids[i]];
      if (!a) continue;
      if (!b || (a.t || 0) > (b.t || 0)) return true;
    }
    return false;
  }

  function ghPush(silent, retry, notifyError) {
    if (!ghSupported()) { if (!silent) toast('当前浏览器不支持同步'); return Promise.resolve(); }
    if (!state.gh.token) { if (!silent) toast('请先填写 GitHub Token'); return Promise.resolve(); }
    if (state.ghBusy) return Promise.resolve();
    state.ghBusy = true;
    ghStatus('同步中', 'busy');
    var merged = 0;
    /* 先拉一次再推：把云端比本地新的标记合并进来，避免覆盖另一台设备 */
    var p = ghEnsureGist(true).then(function () {
      return state.gh.gistId
        ? ghRead().then(function (res) {
            if (res) merged = ghMerge(res.prog, res.resetAt);
            return { id: state.gh.gistId };
          })
        : ghCreateGist();
    });
    return p.then(function (g) {
      var body = { files: (function () { var o = {}; o[GH_FILE] = { content: ghPayload() }; return o; })() };
      return ghFetch(GH_API + '/gists/' + g.id, { method: 'PATCH', headers: ghHeaders(), body: JSON.stringify(body) });
    }).then(function (g) {
      state.gh.gistId = g.id || state.gh.gistId;
      ghSave();
      if (merged) { saveProg(); refreshAll(); }
      state.ghSynced = true;
      state.ghLastSync = Date.now();
      state.ghPushOk = true;
      lsSet(LS_LASTSYNC, state.ghLastSync);
      ghStatus('已同步', '');
      if (!silent) toast('进度已同步' + (merged ? '，并从云端合并 ' + merged + ' 条' : ''));
      renderGhBox();
    }).catch(function (e) {
      state.ghBusy = false;                       /* 先释放锁，便于重试 */
      var msg = e && (e.message || '未知错误');
      var clientErr = /HTTP 4\d\d/.test(msg);     /* 401/403 属权限问题，重试无用 */
      if (!retry && !clientErr) {
        /* 网络抖动、5xx、请求被系统挂起（手机锁屏常见）：3 秒后自动重试一次 */
        return new Promise(function (r) { setTimeout(r, 3000); })
          .then(function () { return ghPush(silent, true, notifyError); });
      }
      state.ghError = msg;
      state.ghPushOk = false;
      ghStatus('同步失败', 'off');
      if (!silent || notifyError) toast('同步失败：' + msg + '（进度已存本机，稍后会自动重试）');
      renderGhBox();
    }).then(function () { state.ghBusy = false; });
  }

  function ghPull(silent) {
    if (!ghSupported()) { if (!silent) toast('当前浏览器不支持同步'); return Promise.resolve(null); }
    if (!state.gh.token || !state.gh.gistId) {
      if (!silent) toast('请先连接 Gist');
      return Promise.resolve(null);
    }
    state.ghBusy = true;
    ghStatus('读取中', 'busy');
    return ghRead().then(function (res) {
      if (!res) throw new Error('云端还没有进度文件');
      var changed = ghMerge(res.prog, res.resetAt);
      saveProg();
      if (changed) refreshAll();          /* 没有变化时不做重渲染，避免打断正在看的列表 */
      state.ghSynced = true;
      state.ghLastSync = Date.now();
      lsSet(LS_LASTSYNC, state.ghLastSync);
      ghStatus('已同步', '');
      if (!silent) toast(changed ? '已合并云端进度（' + changed + ' 条更新）' : '云端与本地一致');
      return { changed: changed, prog: res.prog, resetAt: res.resetAt };
    }).catch(function (e) {
      state.ghError = e && (e.message || '未知错误');
      ghStatus('读取失败', 'off');
      if (!silent) toast('读取失败：' + e.message);
      return null;
    }).then(function (r) { state.ghBusy = false; return r; });
  }

  /* 打开页面 / 回到前台 / 定时触发的自动同步：先拉取合并，必要时把本地较新的标记回传 */
  function ghSync(force, notify) {
    if (!state.gh.auto || !state.gh.token) return Promise.resolve();
    if (state.ghBusy) return Promise.resolve();
    if (!force && state.ghLastSync && Date.now() - state.ghLastSync < POLL_MIN_GAP) return Promise.resolve();
    ghStatus('同步中', 'busy');
    state.ghError = '';
    return ghEnsureGist(force).then(function () {
      if (!state.gh.gistId) {
        /* 账号下还没有备份：立刻用当前进度创建一个空备份，让用户看到"已连接" */
        return ghPush(true);
      }
      return ghPull(true).then(function (res) {
        if (!res) return;
        if (ghNeedsPush(res.prog, res.resetAt)) return ghPush(true);
      });
    }).catch(function (e) {
      state.ghError = e && (e.message || '未知错误');
      ghStatus('同步失败', 'off');
      if (notify) toast('自动同步失败：' + state.ghError);
      renderGhBox();
    });
  }
  function ghDiag() {
    var box = $('ghBox');
    if (!box) return Promise.resolve('');
    var L = [];
    var push = function (s) { L.push(s); };
    push('== 同步自检报告 ==');
    push('时间：' + new Date().toLocaleString());
    push('页面版本：' + (state.__build || 'unknown'));
    push('UA：' + (navigator.userAgent || '').slice(0, 40));
    push('自动同步：' + (state.gh.auto ? '开' : '关'));
    push('本地标记：' + Object.keys(state.prog).length + ' 条');
    push('本地 resetAt：' + (state.resetAt || 0));
    push('上次同步：' + (state.ghLastSync ? syncAgoText() : '无'));
    push('Token：' + (state.gh.token ? '已填（' + state.gh.token.slice(0, 4) + '…）' : '未填'));
    push('最近一次上传：' + (state.ghPushOk === true ? '成功' : state.ghPushOk === false ? '失败' : '未发生过'));
    if (state.ghError) push('最近错误：' + state.ghError);
    if (!state.gh.token) {
      push('结论：Token 为空，请先生成并粘贴 Token');
      renderDiag(L.join('\n'));
      return Promise.resolve(L.join('\n'));
    }
    var remoteProg = null, remoteReset = 0;
    ghStatus('诊断中', 'busy');
    return ghFetch(GH_API + '/user', { headers: ghHeaders() })
      .then(function (u) {
        push('账号验证：成功，' + u.login);
        var scopes = ghHeader('x-oauth-scopes');
        push('Token 权限：' + (scopes || '（浏览器未暴露该响应头，以下一步实测为准）'));
        push('API 剩余额度：' + (ghHeader('x-ratelimit-remaining') || '-'));
        if (scopes && scopes.indexOf('gist') < 0) push('⚠ Token 没有 gist 权限，只能读不能写！');
        return ghFetch(GH_API + '/gists?per_page=100', { headers: ghHeaders() });
      })
      .then(function (list) {
        var arr = Array.isArray(list) ? list : [];
        var hit = arr.filter(function (g) { return g && g.files && g.files[GH_FILE]; });
        push('账号 Gist：' + arr.length + ' 个，含备份文件：' + hit.length + ' 个');
        if (hit.length > 1) {
          push('⚠ 账号下有 ' + hit.length + ' 个备份文件：设备可能各写一个，这正是「单向同步」的典型原因。请点「统一备份文件」合并成一个。');
        }
        if (hit.length) hit.forEach(function (g) { push('  - ' + g.id + '（' + (g.description || '无描述') + '）'); });
        return ghEnsureGist(true);
      })
      .then(function (id) {
        push('选用 Gist：' + (id || '无'));
        if (!id) { push('结论：账号下没有备份文件，标记任意单词后会自动创建'); return null; }
        return ghRead();
      })
      .then(function (res) {
        if (res) {
          remoteProg = res.prog; remoteReset = res.resetAt || 0;
          push('云端标记：' + Object.keys(res.prog).length + ' 条');
          push('云端 resetAt：' + (res.resetAt || 0));
          push('结论：' + (ghNeedsPush(res.prog, res.resetAt) ? '本地有更新，需要回传' : '两端一致或云端更新'));
          var maxT = 0;
          Object.keys(res.prog).forEach(function (id) {
            var t = (res.prog[id] || {}).t || 0;
            if (t > maxT) maxT = t;
          });
          if (maxT) {
            push('云端最新标记时间：' + new Date(maxT).toLocaleString());
            if (maxT > Date.now() + 300000) {
              push('⚠ 云端存在「未来」时间戳（比本机早 ' + Math.round((maxT - Date.now()) / 60000) +
                   ' 分钟）：某台设备的系统时间超前，它的标记会一直被判为更新，导致本机新标记被忽略。请把那台设备的时间校对为自动同步。');
            }
          }
        } else {
          push('云端标记：读取失败');
        }
      })
      .catch(function (e) {
        state.ghError = e && (e.message || '未知错误');
        push('诊断中断：' + state.ghError);
      })
      .then(function () {
        /* 实测写入权限：有待回传的条数就真的推一次，把结果写进报告 */
        var pending = 0;
        Object.keys(state.prog).forEach(function (id) {
          var a = state.prog[id], b = (remoteProg || {})[id];
          if (a && (!b || (a.t || 0) > (b.t || 0)) && (a.t || 0) > remoteReset) pending++;
        });
        push('待回传：' + pending + ' 条');
        if (!pending || !state.gh.gistId) return null;
        return ghPush(true, true, false).then(function () {
          push('实测上传：' + (state.ghPushOk ? '成功' : '失败 —— ' + (state.ghError || '')));
          if (!state.ghPushOk && /HTTP 40[13]/.test(state.ghError || '')) {
            push('⚠ 写入被拒绝：Token 权限不足或已失效，请重新生成一个勾选了 gist 的 Token');
          }
        });
      })
      .then(function () {
        ghStatus(state.gh.gistId ? '已连接' : '待创建', '');
        var txt = L.join('\n');
        renderDiag(txt);
        copyText(txt);
        toast('诊断报告已生成');
        return txt;
      });
  }
  function renderDiag(text) {
    var box = $('ghBox');
    if (!box) return;
    box.innerHTML = '<pre style="white-space:pre-wrap;word-break:break-all;margin:0;font-family:var(--font-mono);font-size:12px;line-height:1.6;color:var(--color-text-primary);background:var(--color-background-tertiary);padding:10px;border-radius:8px;border:0.5px solid var(--color-border-tertiary)">' + esc(text) + '</pre>';
  }

  function schedulePush() {
    clearTimeout(state.pushTimer);
    /* 用户刚动过标记：这次失败要 toast 提示，否则手机上会以为同步成功了 */
    state.pushTimer = setTimeout(function () { ghPush(true, false, true); }, 1800);
  }
  /* 离开页面时把还没回传的标记立刻推上去（不等 2.5 秒） */
  function flushPush() {
    if (!state.gh.auto || !state.gh.token) return;
    clearTimeout(state.pushTimer);
    ghPush(true);
  }

  /* ---------------- 同步码：换设备时一次粘贴即可接入 ---------------- */
  function makeSyncCode() {
    var json = JSON.stringify({ t: state.gh.token || '', g: state.gh.gistId || '' });
    var b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return SYNC_PREFIX + b64;
  }
  function parseSyncCode(code) {
    var v = String(code || '').trim();
    if (!v) throw new Error('同步码为空');
    if (v.indexOf(SYNC_PREFIX) === 0) v = v.slice(SYNC_PREFIX.length);
    v = v.replace(/-/g, '+').replace(/_/g, '/');
    while (v.length % 4) v += '=';
    var obj = JSON.parse(decodeURIComponent(escape(atob(v))));
    if (!obj || !obj.t) throw new Error('同步码不完整');
    return { token: obj.t, gistId: obj.g || '' };
  }
  function applySyncCode(code, quiet) {
    var cfg;
    try { cfg = parseSyncCode(code); } catch (e) { toast('同步码无法识别：' + e.message); return false; }
    state.gh.token = cfg.token;
    state.gh.gistId = cfg.gistId;
    state.gh.auto = true;
    ghSave();
    var tok = $('ghToken'), gid = $('ghGist'), auto = $('ghAuto');
    if (tok) tok.value = cfg.token;
    if (gid) gid.value = cfg.gistId;
    if (auto) auto.checked = true;
    renderGhBox();
    if (!quiet) toast('已接入同步，正在拉取进度…');
    ghSync(true);
    return true;
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }
  /* 带同步码的网址：另一台设备打开即自动接入（导入后立刻把码从地址栏抹掉） */
  function syncLink() {
    var base = location.origin + location.pathname;
    return base + '?sync=' + encodeURIComponent(makeSyncCode());
  }
  function consumeUrlSyncCode() {
    try {
      var m = location.search.match(/[?&]sync=([^&]+)/);
      if (!m) return false;
      var code = decodeURIComponent(m[1]);
      history.replaceState(null, '', location.pathname + (location.hash || ''));
      return applySyncCode(code, true);
    } catch (e) { return false; }
  }

  /* ---------------- 后台自动同步：回到前台 / 恢复网络 / 定时 / 离开页面 ---------------- */
  function startAutoSync() {
    renderSyncAgo();                                  /* 先把已有的「上次同步」显示出来 */
    clearInterval(state.agoTimer);
    state.agoTimer = setInterval(renderSyncAgo, 30000); /* 相对时间自己走，不额外发请求 */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') ghSync();
      else flushPush();                 /* 切走或锁屏时立刻回传未上传的标记 */
    });
    window.addEventListener('pagehide', flushPush);
    window.addEventListener('online', function () { ghSync(true); });
    window.addEventListener('offline', function () { ghStatus('离线', 'off'); });
    window.addEventListener('beforeunload', flushPush);
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(function () {
      if (document.visibilityState === 'visible') ghSync();
    }, POLL_MS);
  }

  function syncAgoText() {
    if (!state.ghLastSync) return '';
    var s = Math.floor((Date.now() - state.ghLastSync) / 1000);
    if (s < 5) return '刚刚同步';
    if (s < 60) return s + ' 秒前同步';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分钟前同步';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前同步';
    return new Date(state.ghLastSync).toLocaleString() + ' 同步';
  }
  function renderGhBox() {
    var box = $('ghBox');
    if (!box) return;
    if (!state.gh.token) {
      box.innerHTML = '<div class="muted">未连接。填一次 Token（每台设备填<b>同一个</b>），各设备的学习进度就会自动互相同步。</div>';
      ghStatus('未连接', 'off');
      return;
    }
    var link = state.gh.gistId
      ? '<a href="https://gist.github.com/' + esc(state.gh.gistId) + '" target="_blank" rel="noopener" style="color:var(--accent)">打开 Gist</a>'
      : '<span class="muted">尚未创建 Gist</span>';
    var head;
    if (state.gh.gistId) {
      head = '<div class="muted">已连接备份 Gist：' + esc(state.gh.gistId.slice(0, 8)) + '… ' + link + '</div>';
    } else if (state.ghError) {
      head = '<div style="color:var(--color-danger)">同步失败：' + esc(state.ghError) + '</div>';
    } else {
      head = '<div class="muted">正在查找/创建云端备份，请稍候…</div>';
    }
    box.innerHTML = head
      + '<div class="muted" style="margin-top:6px">' + (state.gh.auto !== false
        ? '自动同步已开启：打开页面、切回本页、恢复网络都会自动对齐，后台每 60 秒检查一次，标记单词后约 2.5 秒自动回传。'
        : '自动同步已关闭：只能手动「上传」或「拉取」。') + '</div>'
      + (state.ghLastSync ? '<div class="muted" style="margin-top:6px">上次同步：' + esc(syncAgoText()) + '</div>' : '')
      + (state.ghError ? '<div style="color:var(--color-danger);margin-top:6px">最近错误：' + esc(state.ghError) + '</div>' : '');
    /* 有错误就保持失败态，否则会把刚显示出来的「重试」入口又隐藏掉 */
    if (state.ghError) { ghStatus('同步失败', 'off'); return; }
    ghStatus(state.gh.gistId ? '已连接' : '待创建', state.gh.gistId ? '' : '');
  }

  /* ---------------- 视图切换 ---------------- */
  var TITLES = {
    words: ['单词库', '按分类、子类、掌握情况筛选，点 🔊 听发音'],
    talks: ['情景对话', '按场景分组的实用口语句子，点 🔊 跟读'],
    setup: ['备份与设置', '学习统计、进度备份与 GitHub 同步']
  };
  function switchView(v) {
    state.view = v;
    ['words', 'talks', 'setup'].forEach(function (k) {
      var el = $('view-' + k);
      if (el) el.hidden = (k !== v);
    });
    document.querySelectorAll('.navitem, .tabbar button').forEach(function (b) {
      if (b.getAttribute('data-nav') === v) b.classList.add('on');
      else b.classList.remove('on');
    });
    var t = TITLES[v] || ['', ''];
    if ($('pageTitle')) $('pageTitle').textContent = t[0];
    if ($('pageSub')) $('pageSub').textContent = t[1];
    if (v === 'setup') { renderStats(); renderGhBox(); }
    if (v === 'words') { renderReview(); }
  }

  /* ---------------- 筛选控件 ---------------- */
  function fillCats(kind) {
    var sel = $('c-' + kind);
    if (!sel) return;
    var cur = state.cat[kind];
    var h = '<option value="">全部分类</option>';
    for (var i = 0; i < CATS[kind].length; i++) {
      var c = CATS[kind][i];
      h += '<option value="' + esc(c) + '"' + (c === cur ? ' selected' : '') + '>' + esc(c) + '</option>';
    }
    sel.innerHTML = h;
  }
  function fillSubs(kind) {
    var sel = $('s-' + kind);
    if (!sel) return;
    var cat = state.cat[kind];
    var list = cat ? (SUBS[kind][cat] || []) : [];
    var h = '<option value="">' + (cat ? '全部子类' : '子类') + '</option>';
    for (var i = 0; i < list.length; i++) {
      h += '<option value="' + esc(list[i]) + '"' + (list[i] === state.sub[kind] ? ' selected' : '') + '>' + esc(list[i]) + '</option>';
    }
    sel.innerHTML = h;
    sel.disabled = !cat;
  }

  /* 页码输入框回车跳转（用事件委托，分页重绘后无需重新绑定） */
  function bindPagerKeys() {
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var el = e.target;
      var m = el && el.id ? el.id.match(/^pg-(words|talks)$/) : null;
      if (!m) return;
      e.preventDefault();
      gotoPage(m[1], el.value);
    });
  }

  function refreshAll() {
    renderStats();
    renderList('words');
    renderList('talks');
    renderReview();
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button, [data-nav]') : null;
      if (!t) return;

      var nav = t.getAttribute('data-nav');
      if (nav) { switchView(nav); return; }

      var say = t.getAttribute('data-say');
      if (say) { speak(say); return; }

      var pg = t.getAttribute('data-pg');
      if (pg) {
        var pk = pg.indexOf('|');
        if (pk > 0) { gotoPage(pg.slice(0, pk), pg.slice(pk + 1)); return; }
      }
      var pgGo = t.getAttribute('data-pg-go');
      if (pgGo) {
        var pin = $('pg-' + pgGo);
        gotoPage(pgGo, pin ? pin.value : 1);
        return;
      }


      var lv = t.getAttribute('data-lvl') || t.getAttribute('data-rlvl');
      if (lv) {
        var k = lv.lastIndexOf('|');
        if (k > 0) {
          var id = lv.slice(0, k), val = lv.slice(k + 1);
          setLevel(id, val, { toggle: true });     /* 再点同一个状态＝取消标记 */
          state.review = state.review.filter(function (x) { return x.i !== id; });
          renderReview();
          renderList('words');
          renderStats();
        }
        return;
      }

      var act = t.getAttribute('data-act');
      if (act) { doAction(act); return; }
    });

    var refresh = $('refreshReview');
    if (refresh) refresh.addEventListener('click', function () {
      pickReview(true);
      toast('已换一批');
    });

    ['words', 'talks'].forEach(function (kind) {
      var q = $('q-' + kind);
      if (q) {
        var timer = null;
        q.addEventListener('input', function () {
          clearTimeout(timer);
          timer = setTimeout(function () {
            state.q[kind] = q.value.trim();
            state.page[kind] = 1;
            renderList(kind);
          }, 180);
        });
      }
      var c = $('c-' + kind);
      if (c) c.addEventListener('change', function () {
        state.cat[kind] = c.value;
        state.sub[kind] = '';
        state.page[kind] = 1;
        fillSubs(kind);
        renderList(kind);
      });
      var s = $('s-' + kind);
      if (s) s.addEventListener('change', function () {
        state.sub[kind] = s.value;
        state.page[kind] = 1;
        renderList(kind);
      });
    });

    var lvSel = $('l-words');
    if (lvSel) lvSel.addEventListener('change', function () {
      state.lv.words = lvSel.value;
      state.page.words = 1;
      renderList('words');
    });

    var tok = $('ghToken');
    if (tok) {
      tok.value = state.gh.token || '';
      var tokTimer = null;
      function tokUpdated() {
        state.gh.token = tok.value.trim();
        ghSave();
        renderGhBox();
        if (state.gh.token) ghSync(true);
      }
      tok.addEventListener('change', tokUpdated);
      tok.addEventListener('input', function () {
        clearTimeout(tokTimer);
        tokTimer = setTimeout(tokUpdated, 800);
      });
    }
    var gid = $('ghGist');
    if (gid) {
      gid.value = state.gh.gistId || '';
      var gidTimer = null;
      function gidUpdated() {
        var v = gid.value.trim();
        /* 允许直接粘贴 https://gist.github.com/用户名/<id> */
        var m = v.match(/([0-9a-f]{20,})/i);
        state.gh.gistId = m ? m[1] : (v ? state.gh.gistId : '');
        gid.value = state.gh.gistId;
        ghSave();
        renderGhBox();
        if (state.gh.token) ghSync(true);
      }
      gid.addEventListener('change', gidUpdated);
      gid.addEventListener('input', function () {
        clearTimeout(gidTimer);
        gidTimer = setTimeout(gidUpdated, 800);
      });
    }
    var auto = $('ghAuto');
    if (auto) {
      auto.checked = state.gh.auto !== false;
      auto.addEventListener('change', function () {
        state.gh.auto = auto.checked;
        ghSave();
        renderGhBox();
        if (state.gh.auto) ghSync(true);   /* 打开开关时立刻对齐一次 */
      });
    }
    var codeBox = $('ghCode');
    if (codeBox) {
      codeBox.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); doAction('ghImportCode'); }
      });
    }

    var file = $('importFile');
    if (file) file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var obj = JSON.parse(String(rd.result));
          var src = (obj && obj.prog) || obj;
          if (!src || typeof src !== 'object') throw new Error('格式不对');
          var n = 0;
          Object.keys(src).forEach(function (id) {
            var v = src[id];
            if (v && v.lv) { state.prog[id] = v; n++; }
          });
          saveProg();
          refreshAll();
          toast('已导入 ' + n + ' 条进度');
        } catch (err) { toast('导入失败：' + err.message); }
        file.value = '';
      };
      rd.readAsText(f);
    });
  }

  function doAction(act) {
    if (act === 'export') {
      var data = JSON.stringify({ v: 1, exportedAt: new Date().toISOString(), prog: state.prog }, null, 0);
      var blob = new Blob([data], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'english-progress-' + todayStr() + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('已导出进度文件');
      return;
    }
    if (act === 'clear') {
      if (!confirm('清空本机的学习进度？单词内容不会删除，只是掌握标记会全部重置。' + (state.gh.gistId ? '\n（云端 Gist 里的旧标记也会一起作废，不会被同步回来）' : ''))) return;
      state.prog = {};
      state.resetAt = Date.now();
      lsSet(LS_RESET, state.resetAt);
      saveProg();
      refreshAll();
      toast('已清空进度');
      if (state.gh.auto && state.gh.token) schedulePush();
      return;
    }
    if (act === 'ghDiag') { ghDiag(); return; }
    if (act === 'ghForget') {
      if (!confirm('清除本机保存的 Token 与同步配置？清除后需要重新填一次 Token（别的设备不受影响）。')) return;
      state.gh = { token: '', gistId: '', auto: true };
      ghSave();
      try { localStorage.removeItem(LS_GH); } catch (e) { /* 忽略 */ }
      var t2 = $('ghToken'), g2 = $('ghGist');
      if (t2) t2.value = '';
      if (g2) g2.value = '';
      renderGhBox();
      toast('已清除本机的 Token');
      return;
    }
    if (act === 'ghUnify') { ghUnify(); return; }
    if (act === 'ghPush') { ghPush(false); return; }
    if (act === 'ghPull') { ghPull(); return; }
    if (act === 'ghCopyCode') {
      if (!state.gh.token) { toast('请先填写 Token 并成功同步一次'); return; }
      var code = makeSyncCode();
      copyText(code).then(function (ok) {
        if (ok) { toast('同步码已复制，粘到新设备即可'); return; }
        var box = $('ghCode');
        if (box) { box.value = code; box.select(); }
        toast('已生成同步码，请手动复制上方文本框内容');
      });
      return;
    }
    if (act === 'ghCopyLink') {
      if (!state.gh.token) { toast('请先填写 Token 并成功同步一次'); return; }
      var url = syncLink();
      copyText(url).then(function (ok) {
        if (ok) { toast('同步链接已复制，另一台设备打开即自动接入'); return; }
        var box = $('ghCode');
        if (box) { box.value = url; box.select(); }
        toast('已生成同步链接，请手动复制上方文本框内容');
      });
      return;
    }
    if (act === 'ghImportCode') {
      var inp = $('ghCode');
      var v = inp ? inp.value : '';
      if (!v.trim()) { toast('请先粘贴同步码或同步链接'); return; }
      var m = v.match(/[?&]sync=([^&\s]+)/);
      var raw = m ? decodeURIComponent(m[1]) : v;
      if (applySyncCode(raw, false) && inp) {
        inp.value = '';
        inp.placeholder = '已接入，可留空';
      }
      return;
    }
    if (act === 'ghTest') {
      if (!state.gh.token) { toast('请先填写 Token'); return; }
      ghStatus('验证中', 'busy');
      ghFetch(GH_API + '/user', { headers: ghHeaders() }).then(function (u) {
        ghStatus('Token 有效：' + u.login, '');
        toast('Token 有效，账号：' + u.login);
      }).catch(function (e) {
        ghStatus('Token 无效', 'off');
        toast('Token 验证失败：' + e.message);
      });
      return;
    }
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    /* 旧版进度（v1）不再使用，直接清除，保证所有词条回到「未掌握」 */
    try { localStorage.removeItem(LS_PROG_OLD); } catch (e) {}
    state.prog = lsGet(LS_PROG, {}) || {};
    state.resetAt = lsGet(LS_RESET, 0) || 0;
    var gh = ghLoadCfg();
    if (gh && gh.token) state.gh = { token: gh.token, gistId: gh.gistId || '', auto: gh.auto !== false };
    state.ghLastSync = lsGet(LS_LASTSYNC, 0) || 0;

    buildIndex();
    fillCats('words'); fillSubs('words');
    fillCats('talks'); fillSubs('talks');
    refreshAll();
    switchView('words');
    bind();
    bindPagerKeys();

    /* 早期版本一次失败就永久隐藏朗读按钮，这里把该标记作废一次，让按钮重新出现 */
    if (!lsGet('en_tts_mig_v2', false)) {
      try { localStorage.removeItem('en_tts_disabled'); } catch (e) { /* 忽略 */ }
      lsSet('en_tts_mig_v2', true);
    }
    if (sayDisabled() || !canPlayAudio()) {
      document.body.classList.add('say-hidden');
    }
    pickReview(false);
    /* 若网址里带了同步码（另一台设备打开同步链接），先接入再同步；否则按本机配置直接同步 */
    if (!consumeUrlSyncCode()) ghSync(false, true);
    /* 后台自动同步：切回前台 / 恢复网络 / 每 60 秒 / 离开页面前 */
    startAutoSync();
    if (!lsGet('en_visited', false)) {
      lsSet('en_visited', true);
      setTimeout(function () { toast('数据已加载：' + (INDEX.words.length + INDEX.talks.length) + ' 条，进度存在本机'); }, 600);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__EN__ = {
    state: state, renderList: renderList, pickReview: pickReview, setLevel: setLevel, speak: speak,
    ghSync: ghSync, ghPush: ghPush, ghPull: ghPull, flushPush: flushPush, ghDiag: ghDiag, ghUnify: ghUnify,
    makeSyncCode: makeSyncCode, parseSyncCode: parseSyncCode, applySyncCode: applySyncCode, syncLink: syncLink
  };
})();
