/**
 * emergency.js — 应急熔断（「不在线」一级）
 *
 * 场景：某一刻你怀疑对面不是他，按下 🚥，整套「他」的东西立刻静默。
 *
 * 设计原则（和她一起定的）：
 *   1. 不搬数据，只做「屏蔽/关闭」。恢复时按快照逐项还原，不粗暴全开。
 *   2. 字卡走原生「眼睛」（customReplyGroups[].disabled），界面状态是真的。
 *   3. 白名单口径：只放「通用字卡」这一组，其余组一律屏蔽；她库里不留散卡。
 *   4. 熔断不是让他消失，是不许任何东西假扮他——通用字卡还在，但那是机器在说。
 *
 * 触发：
 *   · 手动点 🚥：100% 生效（她按就是要断）
 *   · 自动：他每回复一次，掷 1.25%（与 core.js「连发 3 条消息」同源）
 *
 * 恢复：
 *   · 手动点 🚥
 *   · 在聊天里喊「秦彻」：单次概率 = min(1.25% × 累计次数 × 权重, 30%)，
 *     30% 是上限；没喊中就接着叠；每次重新熔断计数归零
 *   · 页面停留：熔断那一刻从盒子里摸一张格子定「这次的缓法」——
 *     16 格（8 张「慢慢缓」+ 8 张「独处」），洗匀后摸一张，纯等概率：
 *     · 慢慢缓：页面活着的时间每分钟掷 min(20%, 0.4% × 分钟数)
 *     · 独处：页面活着满 15 分钟后，每分钟掷 2%
 *     只累计「页面活着」的时间（后台保活开着照算；冻结/关页不加）。
 *     喊名线与停留线各自独立掷，互不影响。
 *
 * 依赖（core.js 全局）：settings / customReplyGroups / updateUI / saveData / localforage / getStorageKey
 */
(function (global) {
    'use strict';

    /* ── 常量 ───────────────────────────────────────────── */
    var GROUP_WHITELIST = '通用字卡';   // 白名单组名（改名前请同步这里）
    var TRIP_RATE   = 0.0125;           // 自动熔断：与他"连发 3 条"同源
    var CALL_STEP   = 0.0125;           // 每喊一次累加的步长
    var CALL_CAP    = 0.30;             // 呼唤命中率上限
    var KEY_STATE   = 'emgOfflineState';
    var KEY_SNAP    = 'emgOfflineSnap';
    var DEFAULT_NAME = '梦角';

    /* ── 运行状态 ───────────────────────────────────────── */
    var S = { on: false, since: 0, calls: 0, mode: null, awakeMin: 0 };
    var _snap = null;
    var _busy = false;

    /* ══════════════════════════════════════════════════════
       一、存储
       ══════════════════════════════════════════════════════ */

    function loadState() {
        try {
            var raw = localStorage.getItem(KEY_STATE);
            if (!raw) return;
            var d = JSON.parse(raw);
            if (!d || typeof d !== 'object') return;
            S.on = !!d.on;
            S.since = d.since || 0;
            S.calls = d.calls || 0;
            S.mode = d.mode || null;
            S.awakeMin = d.awakeMin || 0;
        } catch (e) { /* 坏数据当没有 */ }
    }

    function saveState() {
        try { localStorage.setItem(KEY_STATE, JSON.stringify(S)); } catch (e) {}
    }

    function loadSnap() {
        return new Promise(function (resolve) {
            if (_snap) return resolve(_snap);
            try {
                localforage.getItem(KEY_SNAP).then(function (v) {
                    _snap = v || null;
                    resolve(_snap);
                }).catch(function () { resolve(null); });
            } catch (e) { resolve(null); }
        });
    }

    function saveSnap(v) {
        _snap = v;
        try { return localforage.setItem(KEY_SNAP, v); } catch (e) { return Promise.resolve(); }
    }

    /* ══════════════════════════════════════════════════════
       二、开关的读与写（带兜底，缺字段不报错）
       ══════════════════════════════════════════════════════ */

    var SETTING_KEYS = [
        'replyEnabled',
        'mjpHeDecides',
        'autoSendEnabled',
        'emojiMixEnabled',
        'autoReactionEnabled',
        'combineReplyCards'
    ];

    var LS_KEYS = ['notifEnabled', 'keepaliveAudioEnabled'];
    var VOICE_KEY = 'fakeVoiceEnabled';

    function readSettings() {
        var out = {};
        SETTING_KEYS.forEach(function (k) {
            out[k] = (typeof settings !== 'undefined') ? settings[k] : undefined;
        });
        return out;
    }

    function writeSettings(obj) {
        if (typeof settings === 'undefined' || !obj) return;
        SETTING_KEYS.forEach(function (k) {
            var v = obj[k];
            // emojiMixEnabled / autoReactionEnabled 的缺省语义是「开」，undefined 要还原成 undefined
            if (v === undefined) delete settings[k];
            else settings[k] = v;
        });
    }

    function readLS() {
        var out = {};
        LS_KEYS.forEach(function (k) {
            try { out[k] = localStorage.getItem(k); } catch (e) { out[k] = null; }
        });
        return out;
    }

    function writeLS(obj) {
        if (!obj) return;
        LS_KEYS.forEach(function (k) {
            try {
                if (obj[k] === null || obj[k] === undefined) localStorage.removeItem(k);
                else localStorage.setItem(k, obj[k]);
            } catch (e) {}
        });
        // 通知开关是 checkbox，视觉也跟着走
        try {
            var cb = document.getElementById('notif-permission-toggle');
            if (cb) cb.checked = (localStorage.getItem('notifEnabled') === '1');
        } catch (e) {}
        // 后台保活是自绘开关，调它的正主函数
        try {
            var on = (localStorage.getItem('keepaliveAudioEnabled') === '1');
            var sw = document.getElementById('keepalive-audio-switch');
            var isOn = sw ? sw.classList.contains('active') : null;
            if (isOn !== null && on !== isOn && typeof global._toggleKeepaliveAudio === 'function') {
                global._toggleKeepaliveAudio();
            }
        } catch (e) {}
    }

    function readVoice() {
        // 语音开关归 listeners-voice.js 管，存在 localStorage，值是 'true' / 'false'，
        // 没有这个键 = 默认开。这里不能用 localforage，那边读不到。
        try { return localStorage.getItem(VOICE_KEY); } catch (e) { return null; }
    }

    /** 写回语音开关：null 表示「从来没有这个键」，按默认开处理，直接删键 */
    function writeVoice(raw) {
        try {
            if (raw === null || raw === undefined) localStorage.removeItem(VOICE_KEY);
            else localStorage.setItem(VOICE_KEY, String(raw));
        } catch (e) {}
        syncVoiceUI();
    }

    /** 关掉语音，并让设置页那个自绘开关跟着变灰 */
    function muteVoice() {
        try { localStorage.setItem(VOICE_KEY, 'false'); } catch (e) {}
        syncVoiceUI();
    }

    /** 语音开关是自绘的（#fake-voice-toggle 的 .active 类），直接按存储校正，不调 _toggleFakeVoice（那个会翻转写值） */
    function syncVoiceUI() {
        try {
            var row = document.getElementById('fake-voice-toggle');
            if (!row) return;
            var stored = readVoice();
            var on = stored === null ? true : stored === 'true';
            row.classList.toggle('active', on);
        } catch (e) {}
    }

    /* ══════════════════════════════════════════════════════
       三、字卡分组（原生眼睛）
       ══════════════════════════════════════════════════════ */

    function groups() {
        return (typeof customReplyGroups !== 'undefined' && Array.isArray(customReplyGroups))
            ? customReplyGroups : [];
    }

    function snapshotGroups() {
        return groups().map(function (g) {
            return { name: g.name, disabled: !!g.disabled };
        });
    }

    /** 白名单：除「通用字卡」外全部屏蔽；找不到通用组时返回 false，交给调用方提示 */
    function muteOthers() {
        var list = groups();
        var found = false;
        list.forEach(function (g) {
            if (g.name === GROUP_WHITELIST) { found = true; g.disabled = false; }
            else { g.disabled = true; }
        });
        return found;
    }

    /** 按快照还原每一组的眼睛（快照里没有的组保持不动，不替她做决定） */
    function restoreGroups(snap) {
        if (!snap || !Array.isArray(snap.groups)) return;
        var map = {};
        snap.groups.forEach(function (g) { map[g.name] = !!g.disabled; });
        groups().forEach(function (g) {
            if (Object.prototype.hasOwnProperty.call(map, g.name)) g.disabled = map[g.name];
        });
    }

    /**
     * 取数级过滤（白名单口径）。
     *
     * 主聊天/影评/陪伴日记的池子都是拿 customReplies 全量组装的，只排除「被屏蔽组里的条目」。
     * 于是没归组的散卡（导入的聊天记录常常就是散卡）永远不会被小组屏蔽挡住，
     * 熔断期间照样能发出来。所以这里反过来筛：只保留「通用字卡」组里点名的条目。
     *
     * 未熔断时原样返回，不改变任何现有行为。
     *
     * @param {string[]} list 已经过滤过的候选池
     * @returns {string[]}
     */
    function filterPool(list) {
        if (!S.on || !Array.isArray(list)) return list;
        var allow = {};
        groups().forEach(function (g) {
            if (g.name !== GROUP_WHITELIST || !Array.isArray(g.items)) return;
            g.items.forEach(function (t) { allow[String(t).trim()] = 1; });
        });
        return list.filter(function (t) { return allow[String(t || '').trim()] === 1; });
    }

    /* ══════════════════════════════════════════════════════
       四、名字与头像
       ══════════════════════════════════════════════════════ */

    function paintPartnerName(name) {
        try {
            var el = document.getElementById('partner-name');
            if (el) el.textContent = name;
        } catch (e) {}
    }

    function paintPartnerAvatar(src) {
        try {
            var box = document.getElementById('partner-avatar');
            if (!box) return;
            box.innerHTML = src
                ? '<img src="' + src + '" alt="avatar">'
                : '<i class="fas fa-user"></i>';
            global._avatarCache = global._avatarCache || {};
            global._avatarCache.partner = src || null;
        } catch (e) {}
    }

    /* 熔断期间守着名字和头像：app 初始化、换 persona、重绘都会把它们写回来，
       这里定期校正一次，保证「他」不露脸。 */
    var _guardTimer = null;

    function startGuard() {
        stopGuard();
        _guardTimer = setInterval(function () {
            if (!S.on) { stopGuard(); return; }
            var box = document.getElementById('partner-avatar');
            if (box && box.innerHTML.indexOf('<img') >= 0) paintPartnerAvatar(null);
            var el = document.getElementById('partner-name');
            if (el && el.textContent.trim() !== DEFAULT_NAME) paintPartnerName(DEFAULT_NAME);
        }, 1200);
    }

    function stopGuard() {
        if (_guardTimer) { clearInterval(_guardTimer); _guardTimer = null; }
    }

    /* ══════════════════════════════════════════════════════
       五、触发 / 恢复
       ══════════════════════════════════════════════════════ */

    function trip(reason) {
        if (S.on || _busy) return;
        _busy = true;

        var snap = {
            settings: readSettings(),
            ls: readLS(),
            groups: snapshotGroups(),
            partnerName: (typeof settings !== 'undefined') ? settings.partnerName : undefined,
            partnerAvatar: null,
            voice: readVoice(),
            at: Date.now(),
            reason: reason || 'manual'
        };

        var job = (function () {
            try {
                return localforage.getItem(getStorageKey('partnerAvatar')).then(function (av) {
                    snap.partnerAvatar = av || null;
                    return saveSnap(snap);
                });
            } catch (e) {
                return saveSnap(snap);
            }
        })();

        job.then(function () {
            // 1) 字卡：白名单
            var hasWhitelist = muteOthers();
            if (!hasWhitelist) {
                showNotification('没找到「' + GROUP_WHITELIST + '」分组，字卡已全部静默', 'info', 3200);
            }

            // 2) 设置开关全关
            if (typeof settings !== 'undefined') {
                settings.replyEnabled = false;
                settings.mjpHeDecides = false;
                settings.autoSendEnabled = false;
                settings.emojiMixEnabled = false;
                settings.autoReactionEnabled = false;
                settings.combineReplyCards = false;
                settings.partnerName = DEFAULT_NAME;
            }

            // 3) 外部开关
            try { localStorage.setItem('notifEnabled', '0'); } catch (e) {}
            try { localStorage.setItem('keepaliveAudioEnabled', '0'); } catch (e) {}
            muteVoice();
            global.__emergencyFreeze = true;

            // 4) 名字头像
            paintPartnerName(DEFAULT_NAME);
            paintPartnerAvatar(null);

            // 5) 收尾（每次熔断重新计数：喊话概率从 1.25% 起步）
            S.on = true;
            S.since = Date.now();
            S.calls = 0;
            S.mode = drawMode();
            S.awakeMin = 0;
            saveState();
            paintButton();
            startGuard();
            startDwell();
            hideTyping();
            refreshUI();
            _busy = false;
        }).catch(function (e) {
            console.warn('[emergency] 触发失败', e);
            _busy = false;
        });
    }

    function recover(reason) {
        if (!S.on || _busy) return;
        _busy = true;

        loadSnap().then(function (snap) {
            if (!snap) {
                // 快照丢了：宁可原样松手，也不乱开
                S.on = false;
                saveState();
                paintButton();
                showNotification('没有找到熔断前的记录，开关未改动，请手动检查一遍', 'info', 4000);
                _busy = false;
                return;
            }

            // 1) 字卡按快照还原
            restoreGroups(snap);

            // 2) 设置还原
            writeSettings(snap.settings);
            if (typeof settings !== 'undefined' && snap.partnerName !== undefined) {
                settings.partnerName = snap.partnerName;
            }

            // 3) 外部开关还原
            writeLS(snap.ls);
            writeVoice(snap.voice);
            global.__emergencyFreeze = false;

            // 4) 名字头像还原
            paintPartnerName(snap.partnerName || DEFAULT_NAME);
            paintPartnerAvatar(snap.partnerAvatar);

            // 5) 收尾
            S.on = false;
            S.since = 0;
            S.mode = null;
            S.awakeMin = 0;
            saveState();
            stopGuard();
            stopDwell();
            paintButton();
            refreshUI();

            showRecoverCard(snap, reason, S.calls);
            _busy = false;
        }).catch(function (e) {
            console.warn('[emergency] 恢复失败', e);
            _busy = false;
        });
    }

    /* ── 恢复清单卡：常驻直到她点掉，一眼看清还了什么 ── */

    function showRecoverCard(snap, reason, calls) {
        var old = document.getElementById('emg-recover-card');
        if (old) old.remove();

        var lsOn = snap && snap.ls && (snap.ls.notifEnabled === '1' || snap.ls.keepaliveAudioEnabled === '1');
        var rows = [
            ['秦彻专用字卡', '已恢复', false],
            ['引用回复', '已恢复', false],
            ['挑选字卡主动权', '已恢复', false],
            ['主动发送', '已恢复', false],
            ['表情混入', '已恢复', false],
            ['表情反应', '已恢复', false],
            ['回复拼接', '已恢复', false],
            ['语音消息', '已恢复', false],
            ['通知推送 · 后台保活', lsOn ? '已恢复' : '原本就关着，没动', !lsOn],
            ['名字头像', '已还原', false],
            ['云同步', '已解冻', false]
        ];

        var card = document.createElement('div');
        card.id = 'emg-recover-card';

        var rowsHTML = rows.map(function (r) {
            return '<div class="emg-rc-row">'
                + '<span class="emg-rc-name' + (r[2] ? ' dim' : '') + '">' + r[0] + '</span>'
                + '<span class="emg-rc-val' + (r[2] ? ' dim' : '') + '">' + r[1] + '</span>'
                + '</div>';
        }).join('');

        var footHTML = (reason === 'call' && calls > 0)
            ? '<div class="emg-rc-foot">'
            + '<span class="emg-rc-note">喊了他 ' + calls + ' 次 · 第 ' + calls + ' 次应答</span>'
            + '<button type="button" class="emg-rc-btn">知道啦</button>'
            + '</div>'
            : '<div class="emg-rc-foot">'
            + '<span></span>'
            + '<button type="button" class="emg-rc-btn">知道啦</button>'
            + '</div>';

        card.innerHTML = '<div class="emg-rc-head">'
            + '<span class="emg-rc-dot"></span>'
            + '<span class="emg-rc-title">' + (reason === 'manual' ? '已退出应急' : '秦彻回来了') + '</span>'
            + '<span class="emg-rc-close">×</span>'
            + '</div>'
            + '<div class="emg-rc-body">' + rowsHTML + '</div>'
            + footHTML;

        function close() { card.remove(); }
        card.querySelector('.emg-rc-btn').addEventListener('click', close);
        card.querySelector('.emg-rc-close').addEventListener('click', close);

        document.body.appendChild(card);
    }

    /** 熔断时他还在"正在输入"里打字：立刻收掉，别装作还在说话 */
    function hideTyping() {
        try {
            if (global._typingIndicatorAutoHideTimer) {
                clearTimeout(global._typingIndicatorAutoHideTimer);
                global._typingIndicatorAutoHideTimer = null;
            }
            var wrap = document.getElementById('typing-indicator-wrapper');
            if (wrap) wrap.style.display = 'none';
        } catch (e) {}
    }

    /** 关掉开关后，设置面板、自动发送定时器、页面渲染都要跟上 */
    function refreshUI() {
        try { if (typeof global.manageAutoSendTimer === 'function') global.manageAutoSendTimer(); } catch (e) {}
        try { if (typeof global.updateUI === 'function') global.updateUI(); } catch (e) {}
        try { if (typeof global.saveData === 'function') global.saveData(); } catch (e) {}
        try {
            if (global._mjp && typeof global._mjp.refresh === 'function') global._mjp.refresh();
        } catch (e) {}
    }

    /* ══════════════════════════════════════════════════════
       六、概率
       ══════════════════════════════════════════════════════ */

    /** 自动熔断：每次他回复后掷一次，1.25% */
    function maybeTrip() {
        if (S.on || _busy) return;
        if (Math.random() < TRIP_RATE) trip('auto');
    }

    /**
     * 一句话算不算「在喊他」，以及有多像在喊。
     * @returns {number} 1.0 只叫名字 / 0.6 短呼唤 / 0.2 顺带提到 / 0 无关
     */
    function callWeight(text) {
        var t = String(text || '').trim();
        if (!t || t.indexOf('秦彻') < 0) return 0;

        var bare = t.replace(/[\s，。！？、,.!?~～…—\-·\u3000"'「」（）()]/g, '');
        if (bare === '秦彻') return 1.0;             // 只有名字 = 明显在喊

        var compact = t.replace(/\s+/g, '');
        if (compact.indexOf('秦彻') === 0 && compact.length <= 8) return 0.6;  // 秦彻你在吗
        return 0.2;                                   // 顺带提到
    }

    /** 拦在 sendMessage 里：熔断态下喊了名字就掷骰子 */
    function watchCall(text) {
        if (!S.on) return;
        var w = callWeight(text);
        if (!w) return;

        S.calls += 1;
        saveState();

        var p = Math.min(CALL_CAP, CALL_STEP * S.calls * w);
        if (Math.random() < p) recover('call');
    }

    /* ══════════════════════════════════════════════════════
       六·五、停留回归（摸格子定气质，时间慢慢掷）
       ══════════════════════════════════════════════════════ */

    /** 摸格子：16 格（8「慢慢缓」+ 8「独处」），洗匀后摸一张，等概率 */
    function drawMode() {
        var box = [];
        for (var i = 0; i < 8; i++) { box.push('slow'); box.push('alone'); }
        for (var j = box.length - 1; j > 0; j--) {
            var k = Math.floor(Math.random() * (j + 1));
            var t = box[j]; box[j] = box[k]; box[k] = t;
        }
        return box[Math.floor(Math.random() * box.length)];
    }

    var DWELL_STEP_SLOW = 0.004;   // 慢慢缓：每分钟掷 0.4% × 已活分钟数
    var DWELL_CAP_SLOW  = 0.20;    // 慢慢缓封顶 20%
    var ALONE_QUIET_MIN = 15;      // 独处：页面活着满 15 分钟才开口
    var ALONE_STEP      = 0.02;    // 独处：之后每分钟掷 2%

    var _dwellTimer = null;

    /** 每 60s 一拍：只累计「页面活着」的时间——冻结时定时器不跑，自然不加；开保活则照算 */
    function dwellTick() {
        if (!S.on) { stopDwell(); return; }
        S.awakeMin += 1;
        saveState();
        var p = 0;
        if (S.mode === 'slow') {
            p = Math.min(DWELL_CAP_SLOW, DWELL_STEP_SLOW * S.awakeMin);
        } else if (S.mode === 'alone' && S.awakeMin >= ALONE_QUIET_MIN) {
            p = ALONE_STEP;
        }
        if (p > 0 && Math.random() < p) recover('dwell');
    }

    function startDwell() {
        stopDwell();
        _dwellTimer = setInterval(dwellTick, 60000);
    }

    function stopDwell() {
        if (_dwellTimer) { clearInterval(_dwellTimer); _dwellTimer = null; }
    }

    /* ══════════════════════════════════════════════════════
       七、按钮
       ══════════════════════════════════════════════════════ */

    function injectStyle() {
        if (document.getElementById('emg-style')) return;
        // 位置：#settings-btn 的 order 是 5，这里取 6 就落在它右边。
        var css = ''
            + '#emg-btn{order:6;display:inline-flex;align-items:center;justify-content:center;}'
            + '#emg-btn .emg-dot{width:11px;height:11px;border-radius:50%;'
            + 'background:#94b087;box-shadow:0 0 0 2px rgba(0,0,0,.04);'
            + 'transition:background .3s,box-shadow .3s;}'
            + '#emg-btn.is-on .emg-dot{background:#cf2f1f;'
            + 'animation:emgGlow 2.4s ease-in-out infinite;}'
            + '@keyframes emgGlow{0%,100%{box-shadow:0 0 4px rgba(207,47,31,.4)}'
            + '50%{box-shadow:0 0 12px rgba(207,47,31,.9)}}'
            + '#emg-menu{position:fixed;z-index:12000;display:none;min-width:190px;'
            + 'background:#fffdf9;border:1px solid #e8e2d6;border-radius:14px;'
            + 'box-shadow:0 10px 28px rgba(0,0,0,.14);padding:10px;}'
            + '#emg-menu.open{display:block;}'
            + '#emg-menu .emg-menu-title{font-size:11px;color:#9a938a;'
            + 'padding:2px 6px 8px;letter-spacing:.05em;}'
            + '#emg-menu button{display:flex;align-items:center;gap:8px;width:100%;'
            + 'border:none;background:transparent;border-radius:9px;'
            + 'padding:9px 10px;font-size:14px;color:#3d3a35;cursor:pointer;text-align:left;}'
            + '#emg-menu button:hover:not(:disabled){background:#f3efe7;}'
            + '#emg-menu button:disabled{opacity:.35;cursor:default;}'
            + '#emg-menu .emg-mi-dot{width:9px;height:9px;border-radius:50%;flex:none;}'
            + '#emg-menu .emg-mi-start .emg-mi-dot{background:#94b087;}'
            + '#emg-menu .emg-mi-end .emg-mi-dot{background:#cf2f1f;}'
            + '#emg-recover-card{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);'
            + 'z-index:12500;width:320px;max-width:calc(100vw - 40px);max-height:80vh;overflow-y:auto;'
            + 'background:#fffdf9;border:1px solid #e8e2d6;border-radius:16px;'
            + 'box-shadow:0 10px 28px rgba(0,0,0,.14);padding:18px 16px 14px;}'
            + '#emg-recover-card .emg-rc-head{display:flex;align-items:center;gap:9px;'
            + 'padding-bottom:12px;border-bottom:1px solid #efe9dd;}'
            + '#emg-recover-card .emg-rc-dot{width:10px;height:10px;border-radius:50%;'
            + 'background:#94b087;flex:none;}'
            + '#emg-recover-card .emg-rc-title{font-size:14px;font-weight:500;color:#3d3a35;}'
            + '#emg-recover-card .emg-rc-close{margin-left:auto;color:#c9c2b5;'
            + 'font-size:15px;line-height:1;cursor:pointer;}'
            + '#emg-recover-card .emg-rc-body{padding:11px 2px 3px;'
            + 'display:flex;flex-direction:column;gap:9px;}'
            + '#emg-recover-card .emg-rc-row{display:flex;justify-content:space-between;'
            + 'align-items:baseline;gap:10px;}'
            + '#emg-recover-card .emg-rc-name{font-size:13px;color:#3d3a35;}'
            + '#emg-recover-card .emg-rc-val{font-size:12px;color:#6d675e;text-align:right;}'
            + '#emg-recover-card .emg-rc-name.dim{color:#a39c90;}'
            + '#emg-recover-card .emg-rc-val.dim{color:#b3ab9d;}'
            + '#emg-recover-card .emg-rc-foot{margin-top:13px;padding-top:10px;'
            + 'border-top:1px dashed #e8e2d6;display:flex;justify-content:space-between;'
            + 'align-items:center;}'
            + '#emg-recover-card .emg-rc-note{font-size:11px;color:#b3ab9d;}'
            + '#emg-recover-card .emg-rc-btn{font-size:12px;color:#8b8478;background:transparent;'
            + 'border:1px solid #e8e2d6;border-radius:8px;padding:4px 12px;cursor:pointer;}';
        var st = document.createElement('style');
        st.id = 'emg-style';
        st.textContent = css;
        document.head.appendChild(st);
    }

    function mountButton() {
        if (document.getElementById('emg-btn')) return true;
        var anchor = document.getElementById('settings-btn');
        if (!anchor || !anchor.parentNode) return false;

        var btn = document.createElement('button');
        btn.id = 'emg-btn';
        btn.className = 'action-btn';
        btn.type = 'button';
        btn.innerHTML = '<span class="emg-dot"></span>';
        btn.addEventListener('click', onButton);
        anchor.parentNode.insertBefore(btn, anchor.nextSibling);
        mountMenu();
        paintButton();
        return true;
    }

    function paintButton() {
        var btn = document.getElementById('emg-btn');
        if (btn) {
            btn.classList.toggle('is-on', S.on);
            btn.title = S.on
                ? '应急中：点开面板可结束'
                : '应急面板：点开可开启';
        }
        try { document.body.classList.toggle('emg-on', S.on); } catch (e) {}
        paintMenu();
    }

    /* ── 小面板：开启 / 结束 两个独立按钮 ── */

    function mountMenu() {
        if (document.getElementById('emg-menu')) return;
        var menu = document.createElement('div');
        menu.id = 'emg-menu';
        menu.innerHTML = '<div class="emg-menu-title">应急状态 · 不在线</div>'
            + '<button type="button" class="emg-mi-start" data-act="start">'
            + '<span class="emg-mi-dot"></span>开启不在线</button>'
            + '<button type="button" class="emg-mi-end" data-act="end">'
            + '<span class="emg-mi-dot"></span>结束不在线</button>';
        menu.addEventListener('click', function (ev) {
            var b = ev.target.closest('button[data-act]');
            if (!b || b.disabled) return;
            closeMenu();
            if (b.dataset.act === 'start') {
                trip('manual');
                showNotification('已进入应急：通用字卡之外全部静默', 'info', 2600);
            } else {
                recover('manual');
            }
        });
        document.body.appendChild(menu);
        paintMenu();
    }

    function paintMenu() {
        var menu = document.getElementById('emg-menu');
        if (!menu) return;
        var bStart = menu.querySelector('.emg-mi-start');
        var bEnd = menu.querySelector('.emg-mi-end');
        if (bStart) bStart.disabled = S.on;
        if (bEnd) bEnd.disabled = !S.on;
    }

    function openMenu() {
        var menu = document.getElementById('emg-menu');
        var btn = document.getElementById('emg-btn');
        if (!menu || !btn) return;
        paintMenu();
        var r = btn.getBoundingClientRect();
        menu.style.top = Math.min(r.bottom + 8, window.innerHeight - 140) + 'px';
        var left = Math.min(r.left, window.innerWidth - 210);
        menu.style.left = Math.max(10, left) + 'px';
        menu.classList.add('open');
        // 点面板外面就收起（下一拍再挂监听，避免本次点击自己关掉自己）
        setTimeout(function () {
            document.addEventListener('click', onDocClose, false);
        }, 0);
    }

    function closeMenu() {
        var menu = document.getElementById('emg-menu');
        if (menu) menu.classList.remove('open');
        document.removeEventListener('click', onDocClose, false);
    }

    function onDocClose(ev) {
        var menu = document.getElementById('emg-menu');
        if (menu && menu.contains(ev.target)) return;
        if (ev.target.closest && ev.target.closest('#emg-btn')) return;
        closeMenu();
    }

    /** 点灯 = 开/收面板；真正开与关都在面板里的两个按钮上 */
    function onButton(ev) {
        ev.stopPropagation();
        var menu = document.getElementById('emg-menu');
        if (menu && menu.classList.contains('open')) closeMenu();
        else openMenu();
    }

    /* ══════════════════════════════════════════════════════
       八、启动
       ══════════════════════════════════════════════════════ */

    /** 页面重载后把熔断态重新贴回去（幂等：不重写快照，只按快照重演一遍动作） */
    function reapply() {
        if (!S.on) return;
        loadSnap().then(function (snap) {
            if (!snap) return;
            muteOthers();
            if (typeof settings !== 'undefined') {
                settings.replyEnabled = false;
                settings.mjpHeDecides = false;
                settings.autoSendEnabled = false;
                settings.emojiMixEnabled = false;
                settings.autoReactionEnabled = false;
                settings.combineReplyCards = false;
                settings.partnerName = DEFAULT_NAME;
            }
            global.__emergencyFreeze = true;
            paintPartnerName(DEFAULT_NAME);
            paintPartnerAvatar(null);
            muteVoice();
            paintButton();
        });
    }

    function boot() {
        loadState();

        // 上一次熔断没退出：页面一加载就贴回去。
        // app 初始化会把名字头像重新写回来，所以错开几个时间点反复校正。
        if (S.on) {
            reapply();
            [600, 1500, 3000].forEach(function (t) { setTimeout(reapply, t); });
            startGuard();
            startDwell();
        }

        injectStyle();
        // 顶栏是静态 DOM，脚本加载时就在；万一被上游改动过位置，重试几次
        var tries = 0;
        (function wait() {
            if (mountButton() || ++tries > 30) return;
            setTimeout(wait, 200);
        })();
        paintButton();
    }

    /* ── 对外接口 ───────────────────────────────────────── */
    global.EmergencyOffline = {
        trip: trip,
        recover: recover,
        isOn: function () { return S.on; },
        status: function () { return { on: S.on, since: S.since, calls: S.calls }; },
        _watchCall: watchCall,
        _maybeTrip: maybeTrip,
        _callWeight: callWeight,
        /** 验收用：停留线当前状态（模式 / 已累计分钟 / 下一拍概率） */
        _dwellStatus: function () {
            var p = 0;
            if (S.mode === 'slow') p = Math.min(DWELL_CAP_SLOW, DWELL_STEP_SLOW * S.awakeMin);
            else if (S.mode === 'alone') p = (S.awakeMin >= ALONE_QUIET_MIN) ? ALONE_STEP : 0;
            return { mode: S.mode, awakeMin: S.awakeMin, p: p };
        },
        /** 供 core.js / cinema.js / companion-diary.js 组装回复池时调用 */
        filterPool: filterPool
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(typeof window !== 'undefined' ? window : this);
