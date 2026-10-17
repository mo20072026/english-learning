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
  var PAGE = 40;
  var REVIEW_N = 10;

  var state = {
    view: 'words',
    q: { words: '', talks: '' },
    cat: { words: '', talks: '' },
    sub: { words: '', talks: '' },
    lv: { words: '' },
    page: { words: PAGE, talks: PAGE },
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
    pushTimer: null,
    pollTimer: null
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
    if (!state.prog[id]) state.prog[id] = {};
    state.prog[id].lv = lv;
    state.prog[id].t = Date.now();
    saveProg();
    if (opts.silent !== true) toast('已标记为「' + levelName(lv) + '」');
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
        '<button class="btn ghost sm' + (lv === '已掌握' ? ' on' : '') + '" data-lvl="' + esc(it.i) + '|已掌握">已掌握</button>' +
        '<button class="btn ghost sm' + (lv === '学习中' ? ' on' : '') + '" data-lvl="' + esc(it.i) + '|学习中">加强学习</button>';
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
    var show = Math.min(state.page[kind], total);
    var cnt = $('cnt-' + kind);
    if (cnt) { cnt.textContent = total + ' 条'; cnt.className = 'chip gray cnt'; }

    if (!total) {
      box.innerHTML = '<div class="empty">没有符合条件的条目，换个关键词或筛选试试。</div>';
    } else {
      var h = '';
      for (var i = 0; i < show; i++) h += itemHtml(rows[i], kind);
      box.innerHTML = h;
    }
    var more = $('more-' + kind);
    if (more) {
      more.hidden = show >= total;
      var btn = more.querySelector('button');
      if (btn) btn.textContent = '加载更多（还有 ' + (total - show) + ' 条）';
    }
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
        '<button class="btn ghost sm" data-rlvl="' + esc(it.i) + '|已掌握">还是已掌握</button>' +
        '<button class="btn ghost sm" data-rlvl="' + esc(it.i) + '|学习中">要加强学习</button>' +
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

  function ghSave() { lsSet(LS_GH, state.gh); }
  function ghHeaders() {
    return {
      'Authorization': 'Bearer ' + state.gh.token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };
  }
  function ghStatus(text, cls) {
    var el = $('ghStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'dot' + (cls ? ' ' + cls : '');
  }
  function ghPayload() {
    return JSON.stringify({
      v: 2,
      updatedAt: new Date().toISOString(),
      resetAt: state.resetAt || 0,
      prog: state.prog
    });
  }
  function ghFetch(url, opt) {
    return fetch(url, opt).then(function (r) {
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
  /* 没有 Gist ID 时先去账号里找一次（5 分钟内不重复查找）；找到就写入配置 */
  function ghEnsureGist() {
    if (state.gh.gistId) return Promise.resolve(state.gh.gistId);
    if (!state.gh.token) return Promise.resolve('');
    if (state.ghFindAt && Date.now() - state.ghFindAt < 300000) return Promise.resolve('');
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

  function ghPush(silent) {
    if (!ghSupported()) { if (!silent) toast('当前浏览器不支持同步'); return Promise.resolve(); }
    if (!state.gh.token) { if (!silent) toast('请先填写 GitHub Token'); return Promise.resolve(); }
    if (state.ghBusy) return Promise.resolve();
    state.ghBusy = true;
    ghStatus('同步中', 'busy');
    var merged = 0;
    /* 先拉一次再推：把云端比本地新的标记合并进来，避免覆盖另一台设备 */
    var p = ghEnsureGist().then(function () {
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
      lsSet(LS_LASTSYNC, state.ghLastSync);
      ghStatus('已同步', '');
      if (!silent) toast('进度已同步' + (merged ? '，并从云端合并 ' + merged + ' 条' : ''));
      renderGhBox();
    }).catch(function (e) {
      ghStatus('同步失败', 'off');
      if (!silent) toast('同步失败：' + e.message);
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
      ghStatus('读取失败', 'off');
      if (!silent) toast('读取失败：' + e.message);
      return null;
    }).then(function (r) { state.ghBusy = false; return r; });
  }

  /* 打开页面 / 回到前台 / 定时触发的自动同步：先拉取合并，必要时把本地较新的标记回传 */
  function ghSync(force) {
    if (!state.gh.auto || !state.gh.token) return Promise.resolve();
    if (state.ghBusy) return Promise.resolve();
    if (!force && state.ghLastSync && Date.now() - state.ghLastSync < POLL_MIN_GAP) return Promise.resolve();
    ghStatus('同步中', 'busy');
    return ghEnsureGist().then(function () {
      if (!state.gh.gistId) {          /* 账号下还没有备份 Gist：等第一次标记单词时自动创建 */
        ghStatus('待创建', '');
        renderGhBox();
        return;
      }
      return ghPull(true).then(function (res) {
        if (!res) return;
        if (ghNeedsPush(res.prog, res.resetAt)) return ghPush(true);
      });
    }).catch(function () { /* 自动同步静默失败，不打扰学习 */ });
  }
  function schedulePush() {
    clearTimeout(state.pushTimer);
    state.pushTimer = setTimeout(function () { ghPush(true); }, 2500);
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
    var head = state.gh.gistId
      ? '<div class="muted">已连接备份 Gist：' + esc(state.gh.gistId.slice(0, 8)) + '… ' + link + '</div>'
      : '<div class="muted">账号下还没找到备份文件，标记任意单词后会自动创建，不用手动填 ID。</div>';
    box.innerHTML = head
      + '<div class="muted" style="margin-top:6px">' + (state.gh.auto !== false
        ? '自动同步已开启：打开页面、切回本页、恢复网络都会自动对齐，后台每 60 秒检查一次，标记单词后约 2.5 秒自动回传。'
        : '自动同步已关闭：只能手动「上传」或「拉取」。') + '</div>'
      + (state.ghLastSync ? '<div class="muted" style="margin-top:6px">上次同步：' + esc(syncAgoText()) + '</div>' : '');
    ghStatus(state.gh.gistId ? '已连接' : '待创建', '');
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

      var more = t.getAttribute('data-more');
      if (more) {
        state.page[more] += PAGE;
        renderList(more);
        return;
      }

      var lv = t.getAttribute('data-lvl') || t.getAttribute('data-rlvl');
      if (lv) {
        var k = lv.lastIndexOf('|');
        if (k > 0) {
          var id = lv.slice(0, k), val = lv.slice(k + 1);
          setLevel(id, val);
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
            state.page[kind] = PAGE;
            renderList(kind);
          }, 180);
        });
      }
      var c = $('c-' + kind);
      if (c) c.addEventListener('change', function () {
        state.cat[kind] = c.value;
        state.sub[kind] = '';
        state.page[kind] = PAGE;
        fillSubs(kind);
        renderList(kind);
      });
      var s = $('s-' + kind);
      if (s) s.addEventListener('change', function () {
        state.sub[kind] = s.value;
        state.page[kind] = PAGE;
        renderList(kind);
      });
    });

    var lvSel = $('l-words');
    if (lvSel) lvSel.addEventListener('change', function () {
      state.lv.words = lvSel.value;
      state.page.words = PAGE;
      renderList('words');
    });

    var tok = $('ghToken');
    if (tok) {
      tok.value = state.gh.token || '';
      tok.addEventListener('change', function () {
        state.gh.token = tok.value.trim();
        ghSave();
        renderGhBox();
        if (state.gh.token) ghSync(true);
      });
    }
    var gid = $('ghGist');
    if (gid) {
      gid.value = state.gh.gistId || '';
      gid.addEventListener('change', function () {
        var v = gid.value.trim();
        /* 允许直接粘贴 https://gist.github.com/用户名/<id> */
        var m = v.match(/([0-9a-f]{20,})/i);
        state.gh.gistId = m ? m[1] : '';
        gid.value = state.gh.gistId;
        ghSave();
        renderGhBox();
        if (state.gh.token) ghSync(true);
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
    var gh = lsGet(LS_GH, null);
    if (gh && gh.token) state.gh = { token: gh.token, gistId: gh.gistId || '', auto: gh.auto !== false };
    state.ghLastSync = lsGet(LS_LASTSYNC, 0) || 0;

    buildIndex();
    fillCats('words'); fillSubs('words');
    fillCats('talks'); fillSubs('talks');
    refreshAll();
    switchView('words');
    bind();

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
    if (!consumeUrlSyncCode()) ghSync();
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
    ghSync: ghSync, ghPush: ghPush, ghPull: ghPull, flushPush: flushPush,
    makeSyncCode: makeSyncCode, parseSyncCode: parseSyncCode, applySyncCode: applySyncCode, syncLink: syncLink
  };
})();
