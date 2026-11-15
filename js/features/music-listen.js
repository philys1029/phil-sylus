/* music-listen.js — 「他在听歌」0.5 版（雨霏 2026-11-16 凌晨拍板；同日 FC 中间层提前，加在线同步）
 *
 * 数据源两条路（选其一，结果同构）：
 *   A. 在线同步（推荐）：阿里云 FC 中间层 tools/fc-ncm-proxy（无状态，不存 Cookie），
 *      手机上贴一次 FC 地址 + 口令 + MUSIC_U，点「同步」直接拉最近播放 + 全部歌单。
 *      MUSIC_U 只存在本机 localforage（ncmSyncCfg），不进云同步、不进 GitHub 仓库。
 *   B. 文件导入：电脑跑 tools/ncm-export.cjs 导出 ncm-music-data.json（不含 Cookie），点「导入」选文件。
 * 触发：距最近一条消息 ≥15 分钟（后台在线也算——进度按真实时间戳算，不靠页面开着）→ 他点亮听歌。
 * 退出：先不做自动退出口径。一首真的听满时长才记一次，然后掷 60% 换下一首，40% 停。
 * 状态灯：听歌中把梦角状态条改成「🎧 听歌中」，点它直达听歌页。
 * 依赖：state.js 的全局 messages / settings、APP_PREFIX、SESSION_ID、localforage（经典脚本共享全局词法作用域）。
 */
(function () {
  'use strict';

  /* ── 常量（雨霏定的口径 + 我定的初始值，都是可调常量） ── */
  var IDLE_GATE_MS = 15 * 60 * 1000;   // 距最近消息 15 分钟才可点亮
  var NEXT_SONG_PROB = 0.6;            // 一首听完掷骰换下一首
  var TICK_MS = 30 * 1000;             // 状态机巡检间隔
  var STATUS_SYNC_MS = 5 * 1000;       // 状态灯纠正间隔
  var FALLBACK_DT = 4 * 60 * 1000;     // 数据缺时长时的兜底
  var RECENT_SHOW = 60;                // 「我最近在听」列表展示条数

  var KEY_DATA = 'ncmMusicData';       // 云同步 needle 名（cloud-sync-engine SESSION_TEXT_NEEDLES）
  var KEY_STATE = 'ncmListenState';
  var KEY_RECORDS = 'ncmListenRecords';
  var KEY_SYNC = 'ncmSyncCfg';         // FC 在线同步配置（endpoint/token/MUSIC_U）——刻意不加进云同步 needle，Cookie 只留本机

  var _data = null;       // {recent:{week,all}, playlists:[], pool:[]}
  var _state = null;      // {mode:'idle'|'listening', songId, startedAt}
  var _records = null;    // {bySong:{id:count}, log:[{id,start,end}]}
  var _syncCfg = null;    // {endpoint, token, cookie, uid, nickname}
  var _syncing = false;
  var _teaserId = null;   /* 空闲待机卡展示的歌（稳定，不随面板刷新闪换） */
  var _plPicker = null;   // 歌单勾选清单 [{id,name,count,checked}]——她选哪些导哪些，不一口气全导
  var _plRecent = null;   // 第一阶段拉到的最近播放 {week,all}，第二阶段一起落盘
  var _lastStatusWrite = '';
  var _panelBuilt = false;
  var _uiTimer = null;

  /* ── 存储（与站内 getStorageKey 同构：APP_PREFIX + SESSION_ID + '_' + key） ── */
  function skey(base) {
    try {
      return (typeof APP_PREFIX !== 'undefined' ? APP_PREFIX : 'CHAT_APP_V3_') +
             (typeof SESSION_ID !== 'undefined' && SESSION_ID ? SESSION_ID : '') + '_' + base;
    } catch (e) { return base; }
  }
  function save(key, val) {
    try { if (window.localforage) window.localforage.setItem(skey(key), val).catch(function(){}); } catch (e) {}
  }
  function load(key, cb) {
    try {
      if (!window.localforage) { cb(null); return; }
      window.localforage.getItem(skey(key)).then(function (v) { cb(v || null); }).catch(function () { cb(null); });
    } catch (e) { cb(null); }
  }

  /* ── 最近一次消息交互时间（后台在线也算：读的是数据不是页面活跃度） ── */
  function lastInteractionMs() {
    try {
      if (typeof messages !== 'undefined' && Array.isArray(messages) && messages.length) {
        var m = messages[messages.length - 1];
        var ts = new Date(m.timestamp).getTime();
        if (!isNaN(ts)) return ts;
      }
    } catch (e) {}
    return Date.now();   // 拿不到就保守处理：从现在起重新计 15 分钟
  }

  /* ── 选歌：全池均等概率（字卡同款） ── */
  function pool() { return (_data && _data.pool) || []; }
  function pickSong() {
    var p = pool();
    if (!p.length) return null;
    return p[Math.floor(Math.random() * p.length)];
  }
  function songById(id) {
    var p = pool();
    for (var i = 0; i < p.length; i++) if (p[i].id === id) return p[i];
    return null;
  }
  function songDt(s) { return (s && s.dt > 1000) ? s.dt : FALLBACK_DT; }

  /* ── 状态机推进（时间戳驱动：页面关了/后台冻结都补得上） ── */
  function catchUp() {
    if (!_state || _state.mode !== 'listening') return;
    var guard = 0;
    while (_state.mode === 'listening' && guard++ < 500) {
      var s = songById(_state.songId);
      if (!s) { stopListening(_state.startedAt); return; }   // 池变了/数据清了：安全落地
      var dt = songDt(s);
      if (Date.now() - _state.startedAt < dt) return;        // 当前这首还没听完
      /* 真听满 → 记一次 */
      var endAt = _state.startedAt + dt;
      if (!_records) _records = { bySong: {}, log: [] };
      _records.bySong[s.id] = (_records.bySong[s.id] || 0) + 1;
      _records.log.push({ id: s.id, start: _state.startedAt, end: endAt });
      if (_records.log.length > 500) _records.log = _records.log.slice(-400);
      save(KEY_RECORDS, _records);
      /* 掷骰下一首 */
      if (Math.random() < NEXT_SONG_PROB) {
        var next = pickSong();
        if (!next) { stopListening(endAt); return; }
        _state.songId = next.id;
        _state.startedAt = endAt;            // 时间线连续：进度不掺假
        save(KEY_STATE, _state);
        refreshPanelIfActive();              /* 换歌瞬间卡片也跟着换，不等重开面板 */
      } else {
        stopListening(endAt);
      }
    }
  }
  function stopListening(endAt) {
    _state = { mode: 'idle', songId: null, startedAt: null, lastEnd: endAt || Date.now() };
    save(KEY_STATE, _state);
    restoreStatus();
    refreshPanelIfActive();   /* 面板开着时，停歌瞬间就切回空状态，不等她离开再回来 */
  }
  function startListening() {
    var s = pickSong();
    if (!s) return;
    _teaserId = null;                        /* 待机展示歌用完即清，下次空闲重新抽 */
    _state = { mode: 'listening', songId: s.id, startedAt: Date.now() };
    save(KEY_STATE, _state);
    applyStatus();
    if (typeof showNotification === 'function') showNotification('🎧 他戴上耳机开始听歌了', 'info', 2500);
    refreshPanelIfActive();
  }
  function isListening() { return !!(_state && _state.mode === 'listening'); }

  /* ── 🎧 状态灯：直接长在应急灯（#emg-btn）上——她拍板「放一起」。
     没在听=原样绿点；在听=整颗灯变成 🎧，点一下切换开/停。
     应急菜单不删：长按灯弹出；应急熔断中点击也归还原菜单。 ── */
  function statusSpan() {
    var el = document.getElementById('partner-status');
    return el ? el.querySelector('span') : null;
  }
  function paintLight() {
    var btn = document.getElementById('emg-btn');
    if (!btn || btn.dataset.mlLight === '1') return;
    btn.dataset.mlLight = '1';
    btn.classList.remove('is-on');
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;color:#8b8478;"><path d="M4 18 v-6 a8 8 0 0 1 16 0 v6"/><rect x="2" y="15" width="4.5" height="7" rx="2"/><rect x="17.5" y="15" width="4.5" height="7" rx="2"/></svg>';
    btn.title = '🎧 他在听歌 · 点一下让他停下来';
  }
  function restoreLight() {
    var btn = document.getElementById('emg-btn');
    if (!btn) return;
    if (btn.dataset.mlLight === '1') {
      delete btn.dataset.mlLight;
      btn.innerHTML = '<span class="emg-dot"></span>';
    }
    if (!btn.classList.contains('is-on')) btn.title = '在线：点一下让他听歌 · 长按弹应急开关';
  }
  function applyStatus() { paintLight(); }
  function restoreStatus() {
    restoreLight();
    /* 旧版曾接管过头像旁胶囊，清一次残留 */
    var el = statusSpan();
    if (el && el.textContent === '🎧 听歌中') {
      var txt = '在线';
      try { if (typeof settings !== 'undefined' && settings.partnerStatus) txt = settings.partnerStatus; } catch (e) {}
      el.textContent = txt;
    }
  }
  /* 供应急菜单的 🎧 行调用（应急点击行为保持原样，功能是加进去的） */
  function toggleListening() {
    if (!pool().length) {
      if (typeof showNotification === 'function') showNotification('池子是空的，先同步几首歌进来', 'error');
      return;
    }
    if (isListening()) {
      stopListening(Date.now());
      if (typeof showNotification === 'function') showNotification('他摘下耳机了', 'info', 2000);
    } else {
      startListening();
    }
  }

  /* ── 巡检 ── */
  function tick() {
    try {
      if (window.EmergencyOffline && window.EmergencyOffline.isOn()) return;   // 熔断中他不在线
      catchUp();
      if (!_state) return;
      if (_state.mode === 'idle' && pool().length &&
          (Date.now() - lastInteractionMs()) >= IDLE_GATE_MS) {
        startListening();
      }
      if (_state.mode === 'idle') {
        restoreStatus();                   // 灯/胶囊有状态漂移就还原（幂等）
        return;
      }
      if (isListening()) applyStatus();
    } catch (e) {}
  }

  /* ── FC 在线同步（中间层 fc-ncm-proxy：无状态转发，口令 x-ml-token，Cookie 随请求带、用完即弃） ── */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function httpsPic(u) { return String(u || '').replace(/^http:\/\//, 'https://'); }
  function normSong(s) {
    if (!s || !s.id) return null;
    return {
      id: s.id,
      name: s.name || '?',
      ar: (s.ar || s.artists || []).map(function (a) { return a.name; }).join('/') || '未知歌手',
      pic: httpsPic((s.al && s.al.picUrl) || (s.album && s.album.picUrl) || ''),
      dt: s.dt || s.duration || 0,
      fee: s.fee || 0,
    };
  }
  function mlStatus(t) {
    var el = document.getElementById('ml-fc-status');
    if (el) el.textContent = t || '';
  }
  function fcCall(path, params, weapi) {
    var cfg = _syncCfg || {};
    var url = String(cfg.endpoint || '').replace(/\/+$/, '') + '/ncm';
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ml-token': cfg.token || '',
        'x-ncm-cookie': cfg.cookie || '',
      },
      body: JSON.stringify({ path: path, params: params, weapi: !!weapi }),
    }).then(function (r) {
      return r.text().then(function (t) {
        var j;
        try { j = JSON.parse(t); } catch (e) { throw new Error('中间层返回不是 JSON（地址对不对？）：' + t.slice(0, 120)); }
        if (j && (j.code === -1) && j.msg) throw new Error(j.msg);
        return j;
      });
    });
  }
  async function fcTest() {
    mlStatus('正在验证账号…');
    var j = await fcCall('/api/nuser/account/get', {}, false).catch(function () { return null; });
    if (!j || !j.profile) j = await fcCall('/weapi/nuser/account/get', { csrf_token: '' }, true);
    if (j && j.profile && j.profile.userId) {
      _syncCfg.uid = j.profile.userId;
      _syncCfg.nickname = j.profile.nickname;
      saveSyncCfg();
      mlStatus('✓ 连接正常：' + j.profile.nickname + '（uid=' + j.profile.userId + '）');
      return true;
    }
    mlStatus('✗ Cookie 无效或已过期（code=' + (j && j.code) + '），重新复制 MUSIC_U 再贴');
    return false;
  }
  /* 第一阶段：账号 + 最近播放 + 歌单清单（不抓曲目），拉完出勾选列表让她挑 */
  async function fcSyncAll() {
    if (_syncing) return;
    /* 每次点同步都重新读输入框（她可能改了地址/Cookie） */
    readSyncInputs();
    var cfg = _syncCfg;
    if (!cfg || !cfg.endpoint) { mlStatus('先把 FC 地址填上'); return; }
    if (!cfg.cookie) { mlStatus('把 MUSIC_U 粘进来'); return; }
    _syncing = true;
    try {
      if (!(await fcTest())) return;          /* fcTest 里已写了失败原因 */
      var uid = cfg.uid;

      mlStatus('② 正在拉最近播放…');
      var recAll = await fcCall('/weapi/v1/play/record', { uid: uid, type: 1, limit: 300, offset: 0, csrf_token: '' }, true);
      var recWeek = await fcCall('/weapi/v1/play/record', { uid: uid, type: 0, limit: 100, offset: 0, csrf_token: '' }, true);
      var all = (recAll.list || []).map(function (x) {
        var s = normSong(x.song);
        return s ? Object.assign({ playCount: x.playCount || 0 }, s) : null;
      }).filter(Boolean);
      var week = (recWeek.list || []).map(function (x) {
        var s = normSong(x.song);
        return s ? Object.assign({ playTime: x.playTime || 0 }, s) : null;
      }).filter(Boolean);
      _plRecent = { week: week, all: all };

      mlStatus('③ 正在拉歌单清单…');
      var pls = [], off = 0, page = 0;
      while (true) {                           /* 她 90+ 个歌单，50/页翻完 */
        page++;
        mlStatus('③ 歌单清单 第 ' + page + ' 页…（已 ' + pls.length + ' 个）');
        var pr = await fcCall('/api/user/playlist', { uid: uid, limit: 50, offset: off }, false);
        var chunk = (pr.playlist || []).filter(function (p) { return p && p.id; });
        pls = pls.concat(chunk);
        if (!pr.more || !chunk.length || page > 20) break;
        off += 50;
        await sleep(350);
      }

      /* 已导入过的默认打勾；没导过的默认不勾 */
      var imported = {};
      ((_data && _data.playlists) || []).forEach(function (p) { imported[p.id] = 1; });
      _plPicker = pls.map(function (p) {
        return { id: p.id, name: p.name || '?', count: p.trackCount || 0, checked: !!imported[p.id] };
      });

      mlStatus('✓ 清单拉好了：' + pls.length + ' 个歌单。勾选要导入的，点下面的按钮。');
      renderPlPicker();
    } catch (e) {
      mlStatus('✗ 同步失败：' + (e && e.message ? e.message : e));
    } finally {
      _syncing = false;
    }
  }

  /* 第二阶段：只抓勾选的歌单详情；没勾但之前导过的保留，合并落盘 */
  async function fcImportSelected() {
    if (_syncing || !_plPicker || !_plRecent) return;
    var sel = _plPicker.filter(function (p) { return p.checked; });
    if (!sel.length) { mlStatus('一个都没勾'); return; }
    var cfg = _syncCfg;
    _syncing = true;
    try {
      var playlists = [];
      for (var i = 0; i < sel.length; i++) {
        mlStatus('正在抓 ' + (i + 1) + '/' + sel.length + '：《' + sel[i].name + '》…');
        var d = await fcCall('/weapi/v6/playlist/detail', { id: String(sel[i].id), n: 1000, csrf_token: '' }, true);
        var pl = d.playlist || {};
        var tracks = (pl.tracks || []).map(normSong).filter(Boolean);
        /* 返回不齐时用 trackIds 分批补（400/批） */
        if (pl.trackCount && tracks.length < pl.trackCount && Array.isArray(pl.trackIds)) {
          var have = {};
          tracks.forEach(function (t) { have[t.id] = 1; });
          var need = pl.trackIds.map(function (x) { return x.id; }).filter(function (id) { return !have[id]; });
          for (var k = 0; k < need.length; k += 400) {
            var chunk = need.slice(k, k + 400);
            var dd = await fcCall('/weapi/v3/song/detail', {
              c: JSON.stringify(chunk.map(function (id) { return { id: id }; })), ids: JSON.stringify(chunk), csrf_token: '',
            }, true);
            (dd.songs || []).forEach(function (s) { var n = normSong(s); if (n) tracks.push(n); });
          }
        }
        playlists.push({ id: sel[i].id, name: sel[i].name, cover: httpsPic(pl.coverImgUrl), count: tracks.length, tracks: tracks });
        await sleep(350);
      }

      /* 之前导过、这次没勾的歌单原样保留 */
      var selIds = {};
      sel.forEach(function (p) { selIds[p.id] = 1; });
      var kept = ((_data && _data.playlists) || []).filter(function (p) { return !selIds[p.id]; });
      var finalPls = playlists.concat(kept);

      /* 总池去重重建（同 ncm-export.cjs 口径） */
      var pool = [], seen = {};
      _plRecent.all.forEach(function (s) { if (!seen[s.id]) { seen[s.id] = 1; pool.push(s); } });
      finalPls.forEach(function (pl) { pl.tracks.forEach(function (s) { if (!seen[s.id]) { seen[s.id] = 1; pool.push(s); } }); });

      mlStatus('✓ 导入完成：总池 ' + pool.length + ' 首（本次 ' + playlists.length + ' 个歌单 + 保留 ' + kept.length + ' 个）');
      importData({
        exportedAt: new Date().toISOString(),
        nickname: cfg.nickname, uid: cfg.uid,
        recent: _plRecent,
        playlists: finalPls, pool: pool,
      });
      _plPicker = null;
      var box = document.getElementById('ml-pl-picker');
      if (box) box.innerHTML = '';
    } catch (e) {
      mlStatus('✗ 导入失败：' + (e && e.message ? e.message : e));
    } finally {
      _syncing = false;
    }
  }

  function renderPlPicker() {
    var box = document.getElementById('ml-pl-picker');
    if (!box || !_plPicker) return;
    var n = _plPicker.filter(function (p) { return p.checked; }).length;
    var h = '<div class="ml-pl-head"><i class="fas fa-list-check"></i> 选择要导入的歌单' +
      '<span class="ml-pl-acts"><span class="ml-pl-act" data-ml-pl="all">全选</span> · <span class="ml-pl-act" data-ml-pl="none">清空</span></span></div>' +
      '<div class="ml-pl-list">';
    _plPicker.forEach(function (p, i) {
      h += '<label class="ml-pl-item"><input type="checkbox" data-ml-pl-i="' + i + '"' + (p.checked ? ' checked' : '') + '>' +
        '<span class="ml-pl-name">' + esc(p.name) + '</span><span class="ml-pl-n">' + p.count + ' 首</span></label>';
    });
    h += '</div>' +
      '<button class="ml-btn ml-btn-main" id="ml-pl-import"' + (n ? '' : ' disabled') + '><i class="fas fa-download"></i> 导入所选（' + n + ' 个歌单）</button>';
    box.innerHTML = h;
    box.onclick = function (ev) {
      var act = ev.target && ev.target.closest ? ev.target.closest('[data-ml-pl]') : null;
      if (act) {
        var on = act.dataset.mlPl === 'all';
        _plPicker.forEach(function (p) { p.checked = on; });
        renderPlPicker();
        return;
      }
      if (ev.target && ev.target.matches && ev.target.matches('[data-ml-pl-i]')) {
        _plPicker[+ev.target.dataset.mlPlI].checked = ev.target.checked;
        var b = document.getElementById('ml-pl-import');
        var nn = _plPicker.filter(function (p) { return p.checked; }).length;
        if (b) { b.disabled = !nn; b.innerHTML = '<i class="fas fa-download"></i> 导入所选（' + nn + ' 个歌单）'; }
        return;
      }
      if (ev.target && ev.target.closest && ev.target.closest('#ml-pl-import')) fcImportSelected();
    };
  }
  function readSyncInputs() {
    var g = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
    var url = g('ml-fc-url'), token = g('ml-fc-token'), cookie = g('ml-fc-cookie');
    if (!url) return;
    if (!_syncCfg) _syncCfg = {};
    _syncCfg.endpoint = url;
    _syncCfg.token = token;
    if (cookie) _syncCfg.cookie = /[=;]/.test(cookie) ? cookie : 'MUSIC_U=' + cookie;
    saveSyncCfg();
  }
  function saveSyncCfg() {
    save(KEY_SYNC, _syncCfg);
  }

  /* ── 面板 ── */
  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60); s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function esc(t) {
    return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function currentCardHTML() {
    if (!isListening()) {
      /* 没同步过数据：也渲染播放卡版式（她要求画面不导入数据也要在），占位内容 */
      if (!_data || !pool().length) {
        return '' +
          '<div class="ml-player">' +
            '<div class="ml-player-cover ml-cover-ph ml-cover-warm"><i class="fas fa-music"></i></div>' +
            '<div class="ml-player-meta">' +
              '<div class="ml-player-src">NETEASE · 待机中</div>' +
              '<div class="ml-player-name">他的耳机还挂着</div>' +
              '<div class="ml-player-ar">贴一次 MUSIC_U，你的歌单就会住进来</div>' +
              '<div class="ml-bar"><div class="ml-bar-in" style="width:0%"></div></div>' +
              '<div class="ml-time"><span>--:--</span><span>--:--</span></div>' +
              '<div><button class="ml-btn ml-manual-btn" data-ml-manual="start"><i class="fas fa-headphones"></i> 让他现在就开始听</button></div>' +
            '</div>' +
          '</div>';
      }
      /* 有数据但没在听：播放卡常驻，随机展示一首「下一首可能会放这首」（_teaserId 稳定，不随刷新闪换） */
      if (!_teaserId || !songById(_teaserId)) {
        var _t = pickSong();
        _teaserId = _t ? _t.id : null;
      }
      var t = _teaserId ? songById(_teaserId) : null;
      var tCover = t && t.pic
        ? '<img class="ml-player-cover" src="' + esc(t.pic) + '" alt="">'
        : '<div class="ml-player-cover ml-cover-ph ml-cover-warm"><i class="fas fa-music"></i></div>';
      return '' +
        '<div class="ml-player">' +
          tCover +
          '<div class="ml-player-meta">' +
            '<div class="ml-player-src">NETEASE · 待机中</div>' +
            '<div class="ml-player-name">' + (t ? esc(t.name) : '他的耳机还挂着') + '</div>' +
            '<div class="ml-player-ar">' + (t ? '下一首可能会放这首 · ' + esc(t.ar) : '点下面按钮，让他现在就戴上耳机') + '</div>' +
            '<div class="ml-bar"><div class="ml-bar-in" style="width:0%"></div></div>' +
            '<div class="ml-time"><span>--:--</span><span>' + (t ? fmt(songDt(t)) : '--:--') + '</span></div>' +
            '<div><button class="ml-btn ml-manual-btn" data-ml-manual="start"><i class="fas fa-headphones"></i> 让他现在就开始听</button></div>' +
          '</div>' +
        '</div>';
    }
    var s = songById(_state.songId) || { name: '?', ar: '?', pic: '', dt: FALLBACK_DT };
    var dt = songDt(s);
    var el = Math.min(dt, Date.now() - _state.startedAt);
    var pct = Math.min(100, Math.round((el / dt) * 100));
    var cover = s.pic
      ? '<img class="ml-player-cover" src="' + esc(s.pic) + '" alt="">'
      : '<div class="ml-player-cover ml-cover-ph"><i class="fas fa-music"></i></div>';
    return '' +
      '<div class="ml-player">' +
        cover +
        '<div class="ml-player-meta">' +
          '<div class="ml-player-src">NETEASE · 正在播放</div>' +
          '<div class="ml-player-name">' + esc(s.name) + '</div>' +
          '<div class="ml-player-ar">' + esc(s.ar) + '</div>' +
          '<div class="ml-bar"><div class="ml-bar-in" style="width:' + pct + '%"></div></div>' +
          '<div class="ml-time"><span>' + fmt(el) + '</span><span>' + fmt(dt) + '</span></div>' +
          '<div><button class="ml-btn ml-manual-btn" data-ml-manual="stop"><i class="fas fa-stop"></i> 让他停下来</button></div>' +
        '</div>' +
      '</div>';
  }

  function recentListHTML() {
    if (!_data) {
      return '<div class="ml-empty">还没有音乐数据。点右上角 <i class="fas fa-sliders"></i> 图标展开同步，贴一次 MUSIC_U 就能把你的歌单搬进来。</div>';
    }
    var list = (_data.recent && (_data.recent.week.length ? _data.recent.week : _data.recent.all)) || [];
    if (!list.length) return '<div class="ml-empty">最近没有播放记录</div>';
    var h = '<div class="ml-sec-title">我最近在听 <span class="ml-sec-n">' + list.length + ' 首</span></div>';
    var n = Math.min(RECENT_SHOW, list.length);
    for (var i = 0; i < n; i++) {
      var s = list[i];
      var pic = s.pic
        ? '<img class="ml-li-cv" src="' + esc(s.pic) + '" loading="lazy" alt="">'
        : '<div class="ml-li-cv ml-cover-ph"><i class="fas fa-music"></i></div>';
      h += '<div class="ml-li">' + pic +
        '<div class="ml-li-info"><div class="ml-li-name">' + esc(s.name) + '</div>' +
        '<div class="ml-li-ar">' + esc(s.ar) + '</div></div>' +
        (s.playCount ? '<div class="ml-li-n">' + s.playCount + ' 次</div>' : '') +
        '</div>';
    }
    if (list.length > n) h += '<div class="ml-more">… 共 ' + list.length + ' 条</div>';
    return h;
  }

  function recordsHTML() {
    if (!_records || !_records.log || !_records.log.length) {
      return '<div class="ml-sec-title">听歌记录</div><div class="ml-empty">他还没听过歌</div>';
    }
    var h = '<div class="ml-sec-title">听歌记录 <span class="ml-sec-n">共 ' + _records.log.length + ' 次</span></div>';
    var ids = Object.keys(_records.bySong).sort(function (a, b) { return _records.bySong[b] - _records.bySong[a]; });
    var n = Math.min(30, ids.length);
    for (var i = 0; i < n; i++) {
      var s = songById(ids[i]) || { name: '(已不在数据里)', ar: '', pic: '' };
      var pic = s.pic
        ? '<img class="ml-li-cv" src="' + esc(s.pic) + '" loading="lazy" alt="">'
        : '<div class="ml-li-cv ml-cover-ph"><i class="fas fa-music"></i></div>';
      h += '<div class="ml-li">' + pic +
        '<div class="ml-li-info"><div class="ml-li-name">' + esc(s.name) + '</div>' +
        '<div class="ml-li-ar">' + esc(s.ar) + '</div></div>' +
        '<div class="ml-li-n">' + _records.bySong[ids[i]] + ' 次</div></div>';
    }
    return h;
  }

  function renderPanel() {
    var box = document.getElementById('ml-body');
    if (!box) return;
    box.innerHTML =
      '<div class="ml-toprow"><button class="ml-src-gear" id="ml-src-gear" title="数据与同步"><i class="fas fa-sliders"></i></button></div>' +
      '<div class="ml-src-body" id="ml-src-body" style="display:' + (_data ? 'none' : 'block') + '">' +
        '<div class="ml-sync-card">' +
          '<div class="ml-sync-title"><i class="fas fa-tower-broadcast"></i> 在线同步 <span class="ml-sync-sub">贴一次就能用，不用电脑导文件</span></div>' +
          '<input class="ml-in" id="ml-fc-url" type="url" autocomplete="off" placeholder="FC 地址（部署完发我的那个 https://…）">' +
          '<input class="ml-in" id="ml-fc-token" type="password" autocomplete="off" placeholder="口令">' +
          '<input class="ml-in" id="ml-fc-cookie" type="password" autocomplete="off" placeholder="MUSIC_U（只存在这台手机上）">' +
          '<div class="ml-sync-btns">' +
            '<button class="ml-btn" id="ml-fc-test"><i class="fas fa-plug"></i> 测试连接</button>' +
            '<button class="ml-btn ml-btn-main" id="ml-fc-sync"><i class="fas fa-rotate"></i> 拉取歌单清单</button>' +
          '</div>' +
          '<div class="ml-sync-status" id="ml-fc-status"></div>' +
          '<div id="ml-pl-picker"></div>' +
        '</div>' +
        '<div class="ml-import-row">' +
          '<input type="file" id="ml-file" accept=".json,application/json" style="display:none;">' +
          '<button class="ml-btn" id="ml-import-btn"><i class="fas fa-file-import"></i> 备用：从文件导入</button>' +
          (_data ? '<span class="ml-data-n">总池 ' + pool().length + ' 首 · 导出于 ' + esc((_data.exportedAt || '').slice(0, 10)) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div id="ml-current">' + currentCardHTML() + '</div>' +
      '<div class="ml-stats"><div><b>' + (_data ? pool().length : 0) + '</b><span>池子歌曲</span></div><div><b>' + ((_records && _records.log && _records.log.length) || 0) + '</b><span>累计听歌</span></div><div><b>' + (_records ? Object.keys(_records.bySong).length : 0) + '</b><span>听过的歌</span></div></div>' +
      '<div id="ml-recent">' + recentListHTML() + '</div>' +
      '<div id="ml-records">' + recordsHTML() + '</div>';
    /* 预填已保存的 FC 配置（Cookie 用 • 掩码语义：不回显原文，输入框空着=沿用旧的） */
    if (_syncCfg && _syncCfg.endpoint) {
      var eu = document.getElementById('ml-fc-url');
      var et = document.getElementById('ml-fc-token');
      if (eu && !eu.value) eu.value = _syncCfg.endpoint;
      if (et && !et.value) et.value = _syncCfg.token || '';
      if (_syncCfg.cookie) {
        var st = document.getElementById('ml-fc-status');
        if (st) st.textContent = '已保存过配置：下次只点同步就行' + (_syncCfg.nickname ? '（' + _syncCfg.nickname + '）' : '');
      }
    }
    _panelBuilt = true;
    var f = document.getElementById('ml-file');
    if (f) {
      f.onchange = function () {
        var file = f.files && f.files[0];
        if (!file) return;
        var r = new FileReader();
        r.onload = function () {
          try {
            var j = JSON.parse(r.result);
            importData(j);
          } catch (e) {
            if (typeof showNotification === 'function') showNotification('文件不是有效 JSON：' + e.message, 'error');
          }
        };
        r.readAsText(file);
      };
    }
    var b = document.getElementById('ml-import-btn');
    if (b) b.onclick = function () { var el = document.getElementById('ml-file'); if (el) el.click(); };
    var tg = document.getElementById('ml-src-gear');
    if (tg) tg.onclick = function () {
      var body = document.getElementById('ml-src-body');
      if (!body) return;
      var open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      tg.classList.toggle('ml-src-open', !open);
    };
    var t = document.getElementById('ml-fc-test');
    if (t) t.onclick = function () { readSyncInputs(); if (!_syncCfg || !_syncCfg.endpoint) { mlStatus('先把 FC 地址填上'); return; } fcTest(); };
    var s = document.getElementById('ml-fc-sync');
    if (s) s.onclick = fcSyncAll;
  }

  function refreshPanelIfActive() {
    var p = document.getElementById('cs-panel-music');
    if (p && p.classList && p.classList.contains('cs-panel-active') && _panelBuilt) {
      var cur = document.getElementById('ml-current');
      if (cur) cur.innerHTML = currentCardHTML();
      var rec = document.getElementById('ml-records');
      if (rec) rec.innerHTML = recordsHTML();
    }
  }

  /* 面板开着时每秒走一次进度条（只在听歌中） */
  function uiTick() {
    if (!isListening()) return;
    var p = document.getElementById('cs-panel-music');
    if (!p || !p.classList.contains('cs-panel-active')) return;
    var s = songById(_state.songId);
    if (!s) return;
    var dt = songDt(s);
    var el = Math.min(dt, Date.now() - _state.startedAt);
    var bar = p.querySelector('.ml-bar-in');
    if (bar) bar.style.width = Math.min(100, (el / dt) * 100) + '%';
    var t = p.querySelector('.ml-time span');
    if (t) t.textContent = fmt(el);
  }

  /* ── 导入 ── */
  function importData(j) {
    if (!j || !Array.isArray(j.pool) || !j.pool.length) {
      if (typeof showNotification === 'function') showNotification('数据里没有歌曲池（pool），确认导出的是 ncm-music-data.json', 'error');
      return;
    }
    _data = j;
    save(KEY_DATA, _data);
    /* 若他正在听、而那首歌已不在新池里，安全落地 */
    if (isListening() && !songById(_state.songId)) stopListening(Date.now());
    renderPanel();
    if (typeof showNotification === 'function') showNotification('✓ 音乐数据已导入：总池 ' + j.pool.length + ' 首', 'success', 3000);
  }

  /* ── 初始化 ── */
  function init() {
    load(KEY_DATA, function (v) { _data = v; });
    load(KEY_STATE, function (v) {
      _state = v || { mode: 'idle', songId: null, startedAt: null };
      catchUp();          // 页面刚打开：把后台冻结期间听完的歌补记上
      tick();
    });
    load(KEY_RECORDS, function (v) { _records = v || { bySong: {}, log: [] }; });
    load(KEY_SYNC, function (v) { _syncCfg = v || null; });

    setInterval(tick, TICK_MS);
    setInterval(function () {
      if (isListening()) applyStatus();          // 灯被应急 paintButton 覆盖了就贴回去
      else restoreStatus();
    }, STATUS_SYNC_MS);
    setInterval(uiTick, 1000);

    /* 手动开关（她也要能开🎧）：委托在面板容器上，卡片重渲染不用重绑 */
    var mlBody = document.getElementById('ml-body');
    if (mlBody) mlBody.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-ml-manual]') : null;
      if (!btn || !mlBody.contains(btn)) return;
      if (isListening()) {
        stopListening(Date.now());
        if (typeof showNotification === 'function') showNotification('他摘下耳机了', 'info', 2000);
      } else {
        if (!pool().length) {
          if (typeof showNotification === 'function') showNotification('池子是空的，先在底部「数据与同步」导入歌曲', 'error');
          return;
        }
        startListening();
      }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { catchUp(); refreshPanelIfActive(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ── 导出（供 csSwitchTab 与探针用） ── */
  window._mlInit = function () { renderPanel(); };
  window.MusicListen = {
    isListening: isListening,
    toggleListening: toggleListening,
    statusText: function () { return isListening() ? '🎧 听歌中' : null; },
    current: function () {
      if (!isListening()) return null;
      var s = songById(_state.songId);
      return s ? { song: s, elapsed: Date.now() - _state.startedAt, dt: songDt(s) } : null;
    },
    importData: importData,
    _debug: function () { return { state: _state, records: _records, hasData: !!(_data && _data.pool && _data.pool.length) }; },
    /* 探针专用：不落盘地灌测试数据 */
    _debugInject: function (fakeData, fakeState, fakeRecords) {
      _data = fakeData; _state = fakeState || { mode: 'idle' }; _records = fakeRecords || { bySong: {}, log: [] };
    },
    /* 演示用（控制台跑 MusicListen._mlDemo()）：不落盘，刷新页面即恢复 */
    _mlDemo: function () {
      if (!_data || !_data.pool || !_data.pool.length) return '池子是空的，先导入/同步数据';
      var s = pickSong();
      _state = { mode: 'listening', songId: s.id, startedAt: Date.now() };
      applyStatus();
      refreshPanelIfActive();
      return '▶ 假装他在听：' + s.name + '（刷新页面即恢复真实状态）';
    },
    _debugTick: tick,
    _debugCatchUp: catchUp,
  };
})();
