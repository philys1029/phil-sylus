/* 和他一起选字卡
 * ── 从「彻狸宇宙」导出的对话 HTML 里，让他自己挑字卡；你逐张过目，拒绝时进入 argue。
 *
 * 结构（自上而下，只允许上面依赖下面）：
 *   1 常量        键名、上限、滑轨范围
 *   2 他的意志    全模块唯一的随机来源，概率集中在这一张表里
 *   3 小工具      DOM / 转义 / 通知 / 全局数据拿取
 *   4 存储        localforage，键名走站点统一前缀
 *   5 文本        清洗、切句、解析对话 HTML
 *   6 状态        唯一真源；界面只是它的投影
 *   7 业务        挑卡、argue、反悔、入库、续轮、思考时长
 *   8 视图        modal / 各阶段渲染 / 事件委托（渲染函数不绑事件）
 *   9 历史与长图
 *  10 注入        设置面板、功能入口、回复库小字（都不动上游 HTML）
 *  11 启动        幂等 boot
 *
 * 三条硬约束（改代码前先读）：
 *   · 键名 mjPickHistory / mjPickedCards 已写死在 cloud-sync 与导入导出白名单里，不能改。
 *   · window.__mjpRegistry 必须继续返回 { srcOf(text) }，回复库的 ✍️/📖 筛选靠它。
 *   · settings 的 mjpMinSec / mjpMaxMin / mjpHeDecides 三个字段与滑轨、开关绑定，不能改名。
 */

(function () {
    'use strict';

    /* ══════════════════════ 1 常量 ══════════════════════ */

    var K_HISTORY = 'mjPickHistory';
    var K_PICKED = 'mjPickedCards';
    var INSIST = '他坚持要';

    var MAX_CARDS = 8;      // 一轮最多挑几张
    var MAX_ROUNDS = 3;     // 同一份对话最多挑几轮
    var MAX_SENTENCES = 5;  // 一张卡最多由几句组成

    var MIN_SEC = { lo: 5, hi: 60 };   // 最短等待：5~60 秒
    var MAX_MIN = { lo: 1, hi: 5 };    // 最长等待：1~5 分钟

    // 导出长图的红色（蓝调、压饱和）。可选 a~e，见 mj-pick-image.js 的 REDS
    var MJP_RED = 'd';

    /* ══════════════════════ 2 他的意志：唯一的随机来源 ══════════════════════
     *
     * 以前这些概率散在代码里：池子里 18:1:1、argue 里五五开、反悔里写死 0.05。
     * 现在全部收进这张表，右边是权重，不用是百分比——`roll()` 会按权重摸。
     * 想调任何一个概率，只改这里，别在业务里另写 Math.random()。
     */

    var WILL = {
        kind: { card: 18, poke: 1, both: 1 },   // 90% 纯字卡 / 5% 只拍一拍 / 5% 两者都要
        argue: { ok: 1, insist: 1 },            // 你拒绝他时，他争不争
        undo: { allow: 19, deny: 1 },           // 你反悔时，他允不允许（5% 驳回）
        more: { no: 19, yes: 1 }                // 这一轮完了，他还有没有想选的
    };

    /**
     * 按权重从表里摸一个键。权重不必是整数，也不必加起来等于 100。
     * @param {Object<string, number>} table 键 → 权重
     * @returns {string} 摸中的键
     */
    function roll(table) {
        var total = 0, k;
        for (k in table) if (Object.prototype.hasOwnProperty.call(table, k)) total += table[k];
        var r = Math.random() * total;
        for (k in table) {
            if (!Object.prototype.hasOwnProperty.call(table, k)) continue;
            r -= table[k];
            if (r < 0) return k;
        }
        // 浮点误差兜底：回到第一个键
        for (k in table) if (Object.prototype.hasOwnProperty.call(table, k)) return k;
        return '';
    }

    /**
     * 从数组里等概率拿一个（挑句子用，不是概率决策）。
     * @param {Array} arr
     * @returns {*}
     */
    function pick(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    /**
     * 在 lo..hi 之间取一个整数（含两端）。
     * @param {number} lo
     * @param {number} hi
     * @returns {number}
     */
    function drawInt(lo, hi) {
        if (hi < lo) { var t = lo; lo = hi; hi = t; }
        return lo + Math.floor(Math.random() * (hi - lo + 1));
    }

    /* ══════════════════════ 3 小工具 ══════════════════════ */

    /**
     * HTML 转义。所有要进 innerHTML 的动态文本都必须过这一道。
     * @param {*} s
     * @returns {string}
     */
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * 走站点自己的 toast；拿不到就静默（不能因为提示失败而中断流程）。
     * @param {string} msg
     * @param {string} [type]
     */
    function notify(msg, type) {
        try {
            if (typeof showNotification === 'function') showNotification(msg, type || 'info');
        } catch (e) { }
    }

    /** 让站点把数据落盘（节流版优先）。 */
    function persist() {
        try {
            if (typeof throttledSaveData === 'function') { throttledSaveData(); return; }
        } catch (e) { }
        try {
            if (typeof saveData === 'function') saveData();
        } catch (e) { }
    }

    /** @returns {Object} 站点的 settings，拿不到就给一个空壳 */
    function getSettings() {
        try {
            if (typeof settings !== 'undefined' && settings) return settings;
        } catch (e) { }
        return {};
    }

    /** @returns {string[]|null} 回复库数据，拿不到返回 null */
    function getReplies() {
        try {
            if (typeof customReplies !== 'undefined' && Array.isArray(customReplies)) return customReplies;
        } catch (e) { }
        return null;
    }

    /** @returns {string[]|null} 拍一拍数据 */
    function getPokes() {
        try {
            if (typeof customPokes !== 'undefined' && Array.isArray(customPokes)) return customPokes;
        } catch (e) { }
        try {
            if (window.customPokes && Array.isArray(window.customPokes)) return window.customPokes;
        } catch (e) { }
        return null;
    }

    /** @returns {Array} 回复分组数组（不存在就建一个空的挂到 window 上） */
    function getGroups() {
        if (!window.customReplyGroups) window.customReplyGroups = [];
        return window.customReplyGroups;
    }

    /**
     * 找分组，没有就建。名字是业务键，不靠 id。
     * @param {string} name
     * @returns {Object}
     */
    function ensureGroup(name) {
        var groups = getGroups();
        for (var i = 0; i < groups.length; i++) {
            if (groups[i].name === name) return groups[i];
        }
        var g = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            name: name, color: '#F06595', disabled: false, items: []
        };
        groups.push(g);
        return g;
    }

    /**
     * 把 text 归进某个分组（已在不重复加）。
     * @param {string} name
     * @param {string} text
     */
    function putInGroup(name, text) {
        var g = ensureGroup(name);
        if (!g.items) g.items = [];
        if (g.items.indexOf(text) === -1) g.items.push(text);
    }

    /**
     * 把值夹到区间里，非法值回落默认。
     * @param {*} v
     * @param {number} lo
     * @param {number} hi
     * @param {number} dft
     * @returns {number}
     */
    function clampInt(v, lo, hi, dft) {
        var n = parseInt(v, 10);
        if (!isFinite(n)) return dft;
        if (n < lo) return lo;
        if (n > hi) return hi;
        return n;
    }

    /* ══════════════════════ 4 存储 ══════════════════════
     * 键名必须走站点统一的 getStorageKey（APP_PREFIX + 梦角ID + 键名）。
     * 云同步只认这个前缀，换梦角 / 云端恢复也按它清理重建。
     */

    /**
     * @param {string} base
     * @returns {string|null} 梦角身份还没初始化时返回 null，调用方要重试
     */
    function keyFor(base) {
        try {
            if (typeof SESSION_ID !== 'undefined' && SESSION_ID && typeof window.getStorageKey === 'function') {
                return window.getStorageKey(base);
            }
        } catch (e) { }
        return null;
    }

    /** 当前梦角的存储前缀，用来识别旧版本猜错的键名 */
    function sessionTag() {
        try {
            if (typeof SESSION_ID !== 'undefined' && SESSION_ID) {
                return (window.APP_PREFIX || 'CHAT_APP_V3_') + SESSION_ID + '_';
            }
        } catch (e) { }
        return null;
    }

    /**
     * @param {string} base
     * @param {*} fallback
     * @returns {Promise<*>}
     */
    function dbLoad(base, fallback) {
        var k = keyFor(base);
        if (!k || typeof localforage === 'undefined') return Promise.resolve(fallback);
        return localforage.getItem(k).then(function (v) {
            return v || fallback;
        }, function () { return fallback; });
    }

    /**
     * @param {string} base
     * @param {*} data
     * @returns {Promise<void>}
     */
    function dbSave(base, data) {
        var k = keyFor(base);
        if (!k || typeof localforage === 'undefined') return Promise.resolve();
        return localforage.setItem(k, data).catch(function (e) {
            console.warn('[mj-pick] 保存失败', e);
        });
    }

    /* ══════════════════════ 5 文本 ══════════════════════ */

    // 两个引号中间什么都没有的空引号对，成对删掉（可能删完出现新的空对，所以循环到稳定）
    var EMPTY_PAIRS = [
        /“[^”]{0,0}\s*”/g, /‘\s*’/g, /"\s*"/g, /'\s*'/g,
        /「\s*」/g, /『\s*』/g, /《\s*》/g, /〈\s*〉/g
    ];
    // 悬在句子两头的引号与空白；句子内部真正引用的内容不动
    var EDGE = /^[\s“”‘’"「」『』《》〈〉]+|[\s“”‘’"「」『』《》〈〉]+$/g;

    /**
     * @param {string} t
     * @returns {string}
     */
    function cleanText(t) {
        if (!t) return '';
        var s = String(t), prev;
        do {
            prev = s;
            for (var i = 0; i < EMPTY_PAIRS.length; i++) s = s.replace(EMPTY_PAIRS[i], '');
        } while (s !== prev);
        return s.replace(EDGE, '').trim();
    }

    // 句末标点。不能写成后行断言 (?<=…) —— iOS Safari 16.4 以下会整文件语法报错，
    // 整个功能在手机上直接消失。这里手工逐字扫，标点留在前一句末尾。
    var SENT_END = { '。': 1, '！': 1, '？': 1, '!': 1, '?': 1, '…': 1, '\n': 1 };

    /**
     * 按句末标点切句（不在逗号处切碎）。
     * @param {string} t
     * @returns {string[]}
     */
    function splitSentences(t) {
        var out = [], buf = '';
        for (var i = 0; i < t.length; i++) {
            var ch = t.charAt(i);
            buf += ch;
            if (SENT_END[ch] === 1) { out.push(buf); buf = ''; }
        }
        if (buf) out.push(buf);
        return out;
    }

    /** 只剩标点的碎片（省略号被切开后的「…」）不算一句 */
    function hasContent(s) {
        return /[\u4e00-\u9fa5A-Za-z0-9]/.test(s);
    }

    /**
     * 把一段文字拆成句子池。解析的两条路（导出格式 / 整篇兜底）共用同一套清洗规则。
     * @param {string} text
     * @returns {string[]}
     */
    function collectSentences(text) {
        var out = [];
        var parts = splitSentences(text);
        for (var i = 0; i < parts.length; i++) {
            var c = cleanText(parts[i]);
            if (!c || !hasContent(c)) continue;
            out.push(c);
        }
        return out;
    }

    // 整篇兜底时先摘掉的「页面零件」。留着会把「复制」「导出」这类按钮字当成他说的话。
    var PAGE_CHROME = 'script,style,noscript,template,svg,canvas,iframe,object,embed,' +
        'button,input,select,textarea,option,nav,header,footer,aside,form';

    // 块级标签：进出各垫一个换行，保住原页面的分行，句子才不会糊成一坨
    var BLOCK_TAG = {
        DIV: 1, P: 1, LI: 1, UL: 1, OL: 1, TR: 1, TD: 1, TH: 1,
        SECTION: 1, ARTICLE: 1, MAIN: 1, BLOCKQUOTE: 1, PRE: 1,
        FIGURE: 1, FIGCAPTION: 1, TABLE: 1, HR: 1
    };

    // 标题不算他说的话：《彻给我的信》那种页面顶上挂个「吵架后」，被挑成字卡就很怪
    var TITLE_TAG = { H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };

    /**
     * 递归取文字。文本节点原样收；块级元素两侧补换行；<br> 当换行；标题整段跳过。
     * @param {Node} node
     * @returns {string}
     */
    function textOfNode(node) {
        if (!node) return '';
        if (node.nodeType === 3) return node.nodeValue || '';
        if (node.nodeType !== 1) return '';
        if (node.tagName === 'BR') return '\n';
        if (TITLE_TAG[node.tagName]) return '\n';

        var s = '';
        for (var i = 0; i < node.childNodes.length; i++) {
            s += textOfNode(node.childNodes[i]);
        }
        return BLOCK_TAG[node.tagName] ? ('\n' + s + '\n') : s;
    }

    /**
     * 整篇兜底：认不出「彻狸宇宙」那套 class 时，把页面正文整篇当成他说过的话。
     * 《彻给我的信》这类文件本来整页就是他写的，直接整篇进池正好。
     * @param {string} html
     * @returns {string[]}
     */
    function parseWholePage(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');

        var junk = doc.querySelectorAll(PAGE_CHROME);
        for (var i = 0; i < junk.length; i++) {
            if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
        }

        var raw = doc.body ? textOfNode(doc.body) : '';
        raw = raw.replace(/\r/g, '')
                 .replace(/[ \t\u00a0\u3000]+/g, ' ')
                 .replace(/ *\n */g, '\n')
                 .replace(/\n{2,}/g, '\n')
                 .trim();

        return raw ? collectSentences(raw) : [];
    }

    /**
     * 解析对话 HTML。优先按「彻狸宇宙」导出的格式读；
     * 一个 .exp-say / .exp-action 都没认出来时，退回整篇正文（普通 HTML、单封信都能吃）。
     * 他的台词在 .exp-say，动作旁白在 .exp-action，两者平起平坐、按文档顺序进池。
     * @param {string} html
     * @returns {string[]} 句子数组
     */
    function parseDialogue(html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var out = [];

        function push(txt) {
            var parts = collectSentences(txt);
            for (var i = 0; i < parts.length; i++) out.push(parts[i]);
        }

        var blocks = doc.querySelectorAll('.exp-assist');
        if (blocks.length) {
            Array.prototype.forEach.call(blocks, function (blk) {
                var parts = blk.querySelectorAll('.exp-say, .exp-action');
                Array.prototype.forEach.call(parts, function (p) {
                    var t = (p.textContent || '').trim();
                    if (t) push(t);
                });
            });
        } else {
            // 兜底：没有 .exp-assist 包裹时，直接找两类元素
            var els = doc.querySelectorAll('.exp-say, .exp-action');
            Array.prototype.forEach.call(els, function (el) {
                var t = (el.textContent || '').trim();
                if (t) push(t);
            });
        }

        // 导出格式一句都没读到（比如普通网页存下来的信）→ 整篇正文兜底
        if (!out.length) return parseWholePage(html);
        return out;
    }

    /* ══════════════════════ 6 状态 ══════════════════════
     * 唯一真源。视图只读它，用户输入先写它、再决定要不要重画。
     * 绝不在渲染完之后回头从 DOM 里回收数据——那是上一版丢分组的根因。
     */

    var S = {
        tab: 'pick',         // pick | write | history
        stage: 'choose',     // choose | preview | thinking | list | offer
        fileName: '',
        sentences: [],
        cards: [],           // { id, text, kind, status, forced, group, checked }
        round: 1,
        moreOffer: false,    // 这一轮挑完，他是否表现出「还有想选的」
        badgeOn: false,      // 入口红点：他挑好了但你还没看
        lastApproved: 0,     // 上一轮真正加进去几张（offer 页显示用，不再从历史里反推）
        deadline: 0,
        timer: null,
        showAll: false,
        picked: [],          // 「他挑的」登记表 [{text, src, forced, poke, kind, ts}]
        history: [],         // [{ts, fileName, cards, round}]
        detail: -1,          // 历史里展开的那条
        pendingDel: -1,      // 点了删除、等第二次确认的那条
        committing: false,   // 入库防重入
        window: null         // 本次思考的区间 {lo, hi}，仅内存
    };

    /* ══════════════════════ 7 业务 ══════════════════════
     * 这一层的函数只改状态、写数据，不碰 DOM。
     * 要刷新界面就在末尾调一次 render()，别在中间到处重画。
     */

    /* ── 7.1 挑卡 ── */

    var _seq = 0;

    /**
     * 造一张卡。id 只要在本轮会话里唯一，不写进存储。
     * @param {string} text
     * @param {string} kind card | poke | both
     * @returns {Object}
     */
    function makeCard(text, kind) {
        return {
            id: 'c' + (++_seq) + '_' + drawInt(100, 999),
            text: text,
            kind: kind,
            status: 'pending',
            forced: false,
            group: '',
            checked: false
        };
    }

    /**
     * 从句子池里挑一批卡。
     * 张数 0~min(8, 句数) 等概率；每张卡由 1~5 句「从起点往后连续」的句子组成，
     * 已被用掉的句子不会再用，所以后一张卡可能在半路被截断变短。
     * @param {string[]} sentences
     * @returns {Object[]}
     */
    function pickCards(sentences) {
        if (!sentences.length) return [];

        var avail = sentences.map(function (_, i) { return i; });
        var count = drawInt(0, Math.min(MAX_CARDS, avail.length));   // 可以一张都不挑
        var cards = [];

        for (var n = 0; n < count && avail.length; n++) {
            var start = pick(avail);
            var len = drawInt(1, MAX_SENTENCES);
            var text = '';

            for (var k = 0; k < len; k++) {
                var at = avail.indexOf(start + k);
                if (at === -1) break;          // 后续句子已被别的卡拿走，这张就到这
                text += (k ? '\n' : '') + sentences[start + k];
                avail.splice(at, 1);
            }

            if (text) cards.push(makeCard(text, roll(WILL.kind)));
        }
        return cards;
    }

    /* ── 7.2 思考时长 ──
     *
     * 关掉「他来决定」：就在你滑轨设的区间里随机，一秒不越界。
     * 打开：他自己定这一篇的阈值——下限在 5~60 秒里摸，上限在「下限所在的那一分钟~5 分钟」里摸，
     *       摸完把这两个值写回滑轨（你能看见轴被推走），再在阈值里随机一个等待时长。
     * 每次进入思考阶段都重抽一次：阈值是「他这一篇愿意花多久」，不该跨篇固定。
     * 他一动手就说明他要自己来，你只要拖了任一滑轨，开关自动关掉，此后听你的。
     */

    /**
     * @returns {{lo:number, hi:number, ms:number}} 区间（秒）与这次要等的毫秒
     */
    function thinkWindow() {
        var s = getSettings();
        var lo, hiMin;

        if (s.mjpHeDecides) {
            lo = drawInt(MIN_SEC.lo, MIN_SEC.hi);
            // 上限不能比下限还小，所以最少也得是下限所在的那一分钟
            var atLeast = Math.max(MAX_MIN.lo, Math.ceil(lo / 60));
            hiMin = drawInt(atLeast, MAX_MIN.hi);
            writeWindowToSettings(lo, hiMin);
        } else {
            lo = clampInt(s.mjpMinSec, MIN_SEC.lo, MIN_SEC.hi, 60);
            hiMin = clampInt(s.mjpMaxMin, MAX_MIN.lo, MAX_MIN.hi, 5);
        }

        var hi = Math.max(lo, hiMin * 60);
        return { lo: lo, hi: hi, ms: drawInt(lo, hi) * 1000 };
    }

    /**
     * 把他定的阈值写回设置（滑轨会跟着动）。
     * 值没变就不写，避免每次挑卡都触发一次保存。
     * @param {number} lo 秒
     * @param {number} hiMin 分钟
     */
    function writeWindowToSettings(lo, hiMin) {
        var s = getSettings();
        if (!s || typeof s !== 'object') return;
        if (s.mjpMinSec === lo && s.mjpMaxMin === hiMin) return;
        try {
            s.mjpMinSec = lo;
            s.mjpMaxMin = hiMin;
        } catch (e) { return; }
        persist();
        paintSettings();
    }

    /** 进入等待：抽区间 → 定死线 → 画一次 → 起表 */
    function beginThinking() {
        S.stage = 'thinking';
        S.window = thinkWindow();
        S.deadline = Date.now() + S.window.ms;
        render();
        startTimer();
    }

    /* ── 7.3 计时 ── */

    function stopTimer() {
        if (S.timer) { clearInterval(S.timer); S.timer = null; }
    }

    function startTimer() {
        stopTimer();
        S.timer = setInterval(function () {
            if (S.stage !== 'thinking') { stopTimer(); return; }
            var left = Math.max(0, Math.ceil((S.deadline - Date.now()) / 1000));
            var el = document.getElementById('mjp-count');
            if (el) el.textContent = left;
            if (left <= 0) finishThinking(false);
        }, 500);
    }

    /**
     * 等待结束：这次真的挑卡。
     * @param {boolean} fromOpen 是不是「打开面板时补结算」——补结算时人就在跟前，不发通知
     */
    function finishThinking(fromOpen) {
        stopTimer();
        var fresh = pickCards(S.sentences);
        S.cards = S.cards.concat(fresh);      // 续轮的卡累加进同一次会话
        S.stage = 'list';
        S.deadline = 0;

        // 一张都没挑出来就谈不上还想挑，不摸
        S.moreOffer = (fresh.length > 0 && S.round < MAX_ROUNDS && roll(WILL.more) === 'yes');

        // 你不在面板前：底部卡片通知 + 入口红点
        if (!fromOpen && !isModalVisible()) {
            S.badgeOn = true;
            showPickNotif(fresh.length);
            updateEntryBadge();
        }
        render();
    }

    /* ── 7.4 argue 与反悔 ──
     *
     * argue：你拒绝他时，他争不争。
     * 反悔：你处理完一张又想撤回，他有 5% 不允许（由 WILL.undo 统一抽，不再写死概率）。
     * 批量通过不确认、批量拒绝可能被驳回——这两个不对称是她的设定，别当 bug 顺手「修好」。
     */

    /**
     * @param {Object} card
     * @returns {string} 'ok'（他让步）| 'insist'（他坚持）
     */
    function argue(card) {
        return roll(WILL.argue);
    }

    /** 单张拒绝：带 argue，画界面 */
    function rejectCard(card) {
        if (argue(card) === 'ok') card.status = 'rejected';
        else card.status = 'arguing';
        render();
    }

    /** 批量拒绝用：带 argue，但不画界面（调用方最后统一画一次） */
    function rejectCardQuiet(card) {
        if (argue(card) === 'ok') card.status = 'rejected';
        else card.status = 'arguing';
    }

    /** 最后一次机会：让步就加，坚持就把他挡回去 */
    function lastChance(card) {
        if (argue(card) === 'ok') {
            card.status = 'rejected';
        } else {
            card.status = 'approved';
            card.forced = true;
            card.group = INSIST;
        }
        render();
    }

    /** 你让步：算正常通过，分组自己选 */
    function yieldCard(card) {
        card.status = 'approved';
        card.forced = false;
        card.group = '';
        render();
    }

    /** 反悔：他可能不允许 */
    function undoCard(card) {
        if (roll(WILL.undo) === 'deny') {
            notify('他不允许你反悔', 'info');
            return;
        }
        card.status = 'pending';
        card.forced = false;
        card.group = '';
        card.checked = false;
        render();
    }

    /* ── 7.5 入库 ── */

    /**
     * 把通过的卡写进回复库 / 拍一拍 / 他挑的登记表，并落一条历史。
     * 防重入：双击「加入回复库」不会再写第二条历史。
     */
    function commit() {
        if (S.committing) return;

        var approved = S.cards.filter(function (c) { return c.status === 'approved'; });
        if (!approved.length) {
            notify('这次没有要加入的内容', 'info');
            return;
        }
        S.committing = true;

        var replies = getReplies();
        var pokes = getPokes();
        var libCount = 0, pokeCount = 0, forcedCount = 0;

        approved.forEach(function (c) {
            var kind = c.kind || 'card';           // 老数据没有 kind，一律当纯字卡
            var isPokeOnly = (kind === 'poke');

            if (!isPokeOnly) {
                libCount++;
                if (replies && replies.indexOf(c.text) === -1) replies.push(c.text);

                if (c.forced) {
                    forcedCount++;
                    putInGroup(INSIST, c.text);
                } else if (c.group && c.group !== '未分组') {
                    putInGroup(c.group, c.text);
                }
                // 没选分组的就留在未分组，不凭空建一个空分组
            }

            if (kind === 'poke' || kind === 'both') {
                pokeCount++;
                if (pokes && pokes.indexOf(c.text) === -1) pokes.push(c.text);
            }

            S.picked.push({
                text: c.text,
                forced: !!c.forced,
                poke: kind !== 'card',
                kind: kind,
                src: 'pick',
                ts: Date.now()
            });
        });

        S.lastApproved = libCount;
        invalidateRegistry();          // 登记表变了，回复库的 ✍️ 缓存要重建

        // 历史只留「够用来回看」的字段：文件名、时间、卡片。
        // 不再存整份对话 HTML（界面从来不读，却每条几十 KB）。
        S.history.unshift({
            ts: Date.now(),
            fileName: S.fileName,
            round: S.round,
            cards: S.cards.map(function (c) {
                return {
                    text: c.text,
                    status: c.status,
                    forced: !!c.forced,
                    kind: c.kind || 'card',
                    group: c.group || ''
                };
            })
        });

        Promise.all([
            dbSave(K_PICKED, S.picked),
            dbSave(K_HISTORY, S.history)
        ]).then(function () {
            persist();
            var bits = [];
            if (libCount) bits.push('已加入 ' + libCount + ' 张');
            if (pokeCount) bits.push('拍一拍 ' + pokeCount + ' 张');
            if (forcedCount) bits.push('他坚持要 ' + forcedCount + ' 张');
            notify(bits.join(' · ') || '处理好了', 'success');
        }).then(function () {
            S.committing = false;
            // 入库完是终点还是「还有想选的」：保持线性——所有卡都处理完、都入库了才问他
            if (S.moreOffer && S.round < MAX_ROUNDS) {
                S.moreOffer = false;
                S.cards = [];                  // 这轮已入库，下一轮从空白清单开始
                S.stage = 'offer';
            } else {
                resetSession();
            }
            render();
        }, function () {
            S.committing = false;
            notify('保存没写进去，再点一次试试', 'error');
        });
    }

    /* ── 7.6 续轮与复位 ── */

    /** 「还有想选的」→ 再来一轮：从原池重摸，重复句不管 */
    function nextRound() {
        S.moreOffer = false;
        S.round++;
        beginThinking();
    }

    /** 会话清场。只清这次挑选的临时状态，不碰 picked / history 这些持久数据。 */
    function resetSession() {
        stopTimer();
        S.stage = 'choose';
        S.fileName = '';
        S.sentences = [];
        S.cards = [];
        S.deadline = 0;
        S.showAll = false;
        S.round = 1;
        S.moreOffer = false;
        S.window = null;
        S.detail = -1;
        S.pendingDel = -1;
    }

    /* ══════════════════════ 8 视图 ══════════════════════
     *
     * 渲染函数是纯的：状态进、HTML 出，里面不绑事件、不读 DOM 里的用户输入。
     * 所有交互都靠 modal 上的两个委托（click / change）——重画多少次都不会掉绑定。
     */

    var _modal = null;
    var _lastView = '';     // tab|stage，用来判断「还是同一个视图」以保住滚动位置

    /** 弹窗是不是正开着。关着的时候到点了才需要弹通知。 */
    function isModalVisible() {
        if (!_modal) return false;
        try {
            return getComputedStyle(_modal).display !== 'none';
        } catch (e) {
            return _modal.style.display !== 'none';
        }
    }

    function buildModal() {
        var m = document.createElement('div');
        m.className = 'modal';
        m.id = 'mjp-modal';
        m.innerHTML =
            '<div class="modal-content">' +
                '<div class="modal-title"><i class="fas fa-book-open"></i><span>和他一起选字卡</span></div>' +
                '<div id="mjp-tabs" style="display:flex;gap:8px;margin:10px 0 14px;flex-shrink:0;"></div>' +
                '<div id="mjp-body" style="flex:1;min-height:0;overflow-y:auto;padding-right:2px;padding-bottom:6px;"></div>' +
                // 加入回复库：吸在关闭上方、靠右。放在滚动区外面，滚卡片时它不动
                '<div id="mjp-commit-bar" style="display:none;flex-shrink:0;justify-content:flex-end;' +
                    'align-items:center;gap:10px;padding:10px 0 4px;border-top:1px solid var(--border-color);"></div>' +
                '<div class="modal-buttons">' +
                    '<button class="modal-btn modal-btn-secondary" id="mjp-drop">放弃这次</button>' +
                    '<button class="modal-btn modal-btn-primary" id="mjp-close">关闭</button>' +
                '</div>' +
            '</div>';

        // 只在这个弹窗里改滚动结构：内容区自己滚，底部按钮不跟着滚走
        var content = m.querySelector('.modal-content');
        content.style.cssText += 'overflow:hidden;max-height:86vh;padding-bottom:0;';
        m.querySelector('.modal-buttons').style.cssText +=
            'padding-bottom:max(18px, env(safe-area-inset-bottom, 18px));';

        m.querySelector('#mjp-close').addEventListener('click', hide);
        m.querySelector('#mjp-drop').addEventListener('click', dropSession);

        // 委托只绑这一次，之后 innerHTML 换了多少回都有效
        m.addEventListener('click', onModalClick);
        m.addEventListener('change', onModalChange);

        return m;
    }

    function dropSession() {
        resetSession();
        notify('这次的挑选已作废', 'info');
        render();
    }

    function open() {
        if (!_modal) {
            _modal = buildModal();
            document.body.appendChild(_modal);
        }
        // 关着面板的这段时间计时照常在走：进来先补结算一次（人就在跟前，不发通知）
        if (S.stage === 'thinking' && S.deadline && Date.now() >= S.deadline) finishThinking(true);
        // 人来了，红点和通知都算看过了
        S.badgeOn = false;
        hidePickNotif();
        updateEntryBadge();
        try {
            if (typeof showModal === 'function') showModal(_modal);
            else { _modal.style.display = 'flex'; _modal.classList.add('active'); }
        } catch (e) {
            _modal.style.display = 'flex';
        }
        render();
        if (S.stage === 'thinking') startTimer();
    }

    function hide() {
        // 刻意不停表：面板关着倒计时继续走，到点了才弹得出「他挑好了」
        try {
            if (typeof hideModal === 'function') hideModal(_modal);
            else { _modal.style.display = 'none'; _modal.classList.remove('active'); }
        } catch (e) {
            _modal.style.display = 'none';
        }
    }

    /**
     * 重画。同一视图内保持滚动位置，换视图回到顶部。
     * @param {boolean} [forceTop] 强制回顶部
     */
    function render(forceTop) {
        if (!_modal) return;

        var body = _modal.querySelector('#mjp-body');
        var key = S.tab + '|' + S.stage;
        var top = (!forceTop && key === _lastView) ? body.scrollTop : 0;
        _lastView = key;

        // —— 标签 ——
        var tabs = _modal.querySelector('#mjp-tabs');
        tabs.innerHTML =
            tabBtn('pick', '让他挑选') +
            tabBtn('write', '我写他挑') +
            tabBtn('history', '挑选历史');

        // —— 底部吸底条默认收起，只有过目页且有通过的卡时才亮 ——
        var bar = _modal.querySelector('#mjp-commit-bar');
        bar.style.display = 'none';
        bar.innerHTML = '';

        if (S.tab === 'history') renderHistory(body);
        else if (S.tab === 'write') renderWrite(body);
        else renderPick(body);

        var drop = _modal.querySelector('#mjp-drop');
        if (drop) drop.style.display = (S.tab === 'pick' && S.stage !== 'choose') ? 'inline-block' : 'none';

        body.scrollTop = top;
    }

    /* ── 小构件 ── */

    function tabBtn(id, label) {
        var on = (S.tab === id);
        return '<button data-tab="' + id + '" style="flex:1;padding:9px 0;border-radius:12px;font-size:13px;' +
            'font-weight:700;cursor:pointer;font-family:var(--font-family);border:1.5px solid ' +
            (on ? 'var(--accent-color)' : 'var(--border-color)') + ';background:' +
            (on ? 'var(--accent-color)' : 'transparent') + ';color:' + (on ? '#fff' : 'var(--text-secondary)') + ';">' +
            label + '</button>';
    }

    function smallBtn(label, kind, attr) {
        var c = kind === 'ok' ? 'var(--accent-color)' : (kind === 'no' ? '#e24b4a' : 'var(--border-color)');
        return '<button ' + (attr || '') + ' style="padding:6px 14px;border-radius:10px;border:1.5px solid ' + c +
            ';background:transparent;color:' + (kind === 'muted' ? 'var(--text-secondary)' : c) +
            ';font-size:12px;font-weight:700;cursor:pointer;font-family:var(--font-family);">' + label + '</button>';
    }

    function bigBtn(label, kind, attr) {
        var c = kind === 'ok' ? 'var(--accent-color)' : 'var(--border-color)';
        return '<button ' + (attr || '') + ' style="padding:8px 16px;border-radius:12px;border:1.5px solid ' + c +
            ';background:transparent;color:' + c + ';font-size:13px;font-weight:700;cursor:pointer;' +
            'font-family:var(--font-family);">' + label + '</button>';
    }

    /* ── 交互委托 ── */

    function onModalClick(e) {
        var t = e.target;
        if (!t || typeof t.closest !== 'function') return;

        var el;

        if ((el = t.closest('[data-tab]'))) {
            S.tab = el.getAttribute('data-tab');
            render(true);
            return;
        }

        if ((el = t.closest('[data-act]'))) {
            cardAction(el);
            return;
        }

        if ((el = t.closest('#mjp-all'))) {
            setAllChecked(true);
            return;
        }
        if ((el = t.closest('#mjp-none'))) {
            setAllChecked(false);
            return;
        }
        if ((el = t.closest('#mjp-pass-all'))) {
            passAll();
            return;
        }
        if ((el = t.closest('#mjp-reject-all'))) {
            rejectAll();
            return;
        }

        if ((el = t.closest('#mjp-commit'))) {
            commit();
            return;
        }

        if ((el = t.closest('#mjp-more'))) {
            S.showAll = !S.showAll;
            render();
            return;
        }
        if ((el = t.closest('#mjp-change'))) {
            resetSession();
            render(true);
            return;
        }
        if ((el = t.closest('#mjp-go'))) {
            beginThinking();
            return;
        }
        if ((el = t.closest('#mjp-again'))) {
            resetSession();
            render(true);
            return;
        }
        if ((el = t.closest('#mjp-offer-yes'))) {
            nextRound();
            return;
        }
        if ((el = t.closest('#mjp-offer-no'))) {
            resetSession();
            render(true);
            return;
        }
        if ((el = t.closest('#mjp-write-go'))) {
            notify('这个功能还没做，别忘了他', 'info');
            return;
        }

        if ((el = t.closest('[data-rename]'))) {
            startRename(parseInt(el.getAttribute('data-rename'), 10), el);
            return;
        }
        if ((el = t.closest('[data-hist]'))) {
            var hi = parseInt(el.getAttribute('data-hist'), 10);
            S.detail = (S.detail === hi ? -1 : hi);
            S.pendingDel = -1;
            render();
            return;
        }
        if ((el = t.closest('[data-del]'))) {
            askDelete(parseInt(el.getAttribute('data-del'), 10));
            return;
        }
        if ((el = t.closest('[data-img]'))) {
            exportImage(S.history[parseInt(el.getAttribute('data-img'), 10)]);
            return;
        }
    }

    function onModalChange(e) {
        var el = e.target;
        if (!el || typeof el.getAttribute !== 'function') return;

        // 分组下拉：改的这一刻就写进状态。不重画，所以列表不会跳。
        var gid = el.getAttribute('data-gid');
        if (gid) {
            var card = findCard(gid);
            if (card) card.group = el.value;
            return;
        }

        // 勾选：同理，只记状态
        if (el.getAttribute('data-act') === 'check') {
            var c = findCard(el.getAttribute('data-cid'));
            if (c) c.checked = !!el.checked;
        }
    }

    function cardAction(el) {
        var card = findCard(el.getAttribute('data-cid'));
        if (!card) return;
        var act = el.getAttribute('data-act');

        if (act === 'pass') {
            card.status = 'approved';
            card.forced = false;
            render();
        } else if (act === 'reject') {
            rejectCard(card);
        } else if (act === 'yield') {
            yieldCard(card);
        } else if (act === 'last') {
            lastChance(card);
        } else if (act === 'undo') {
            undoCard(card);
        }
    }

    function findCard(id) {
        for (var i = 0; i < S.cards.length; i++) {
            if (S.cards[i].id === id) return S.cards[i];
        }
        return null;
    }

    /** 有没有勾任何一张 */
    function anyChecked() {
        for (var i = 0; i < S.cards.length; i++) {
            if (S.cards[i].status === 'pending' && S.cards[i].checked) return true;
        }
        return false;
    }

    /** 批量操作的作用对象：勾了的；一句没勾就当全选（她的设定，不是 bug） */
    function batchTargets() {
        var hasChecked = anyChecked();
        return S.cards.filter(function (c) {
            return c.status === 'pending' && (hasChecked ? c.checked : true);
        });
    }

    function setAllChecked(v) {
        S.cards.forEach(function (c) {
            if (c.status === 'pending') c.checked = v;
        });
        render();
    }

    /** 批量通过：不确认，直接全过（她的设定） */
    function passAll() {
        var targets = batchTargets();
        if (!targets.length) { notify('没有待处理的卡', 'info'); return; }
        targets.forEach(function (c) {
            c.status = 'approved';
            c.forced = false;
        });
        render();
        notify('通过了 ' + targets.length + ' 张', 'success');
    }

    /** 批量拒绝：每张单独 argue，所以他可能驳回其中几张（她的设定） */
    function rejectAll() {
        var targets = batchTargets();
        if (!targets.length) { notify('没有待处理的卡', 'info'); return; }
        targets.forEach(rejectCardQuiet);
        render();
    }

    /* ── 各阶段 ── */

    function renderPick(body) {
        if (S.stage === 'preview') return renderPreview(body);
        if (S.stage === 'thinking') return renderThinking(body);
        if (S.stage === 'list') return renderList(body);
        if (S.stage === 'offer') return renderOffer(body);
        return renderChoose(body);
    }

    /** 我写他挑（占位，还没开发） */
    function renderWrite(body) {
        body.innerHTML =
            '<div style="text-align:center;padding:40px 10px;">' +
                '<div style="font-size:13px;color:var(--text-primary);">我写他挑</div>' +
                '<div style="margin-top:18px;">' + smallBtn('开始写', 'ok', 'id="mjp-write-go"') + '</div>' +
            '</div>';
    }

    function renderChoose(body) {
        body.innerHTML =
            '<label id="mjp-dropzone" style="display:block;text-align:center;padding:26px 10px;cursor:pointer;' +
                'border:1.5px dashed var(--accent-color);border-radius:14px;color:var(--accent-color);' +
                'background:var(--accent-color)0d;font-family:var(--font-family);">' +
                '<i class="fas fa-file-import" style="font-size:20px;display:block;margin-bottom:8px;"></i>' +
                '<span style="font-size:13px;font-weight:700;">选择对话 HTML 文件</span>' +
                '<div style="font-size:11px;font-weight:400;color:var(--text-secondary);margin-top:6px;">也可以直接把文件拖进来</div>' +
            '</label>' +
            '<input type="file" id="mjp-file" accept=".html,.htm,text/html" style="display:none;">' +
            '<div id="mjp-msg" style="font-size:12px;color:var(--text-secondary);margin-top:10px;line-height:1.7;text-align:center;min-height:18px;"></div>' +
            '<div style="font-size:12px;color:var(--text-secondary);margin-top:6px;line-height:1.7;">' +
                '他会读一遍这份对话，然后从自己说过的话里挑。挑完先给你一张清单，你逐张过目。' +
            '</div>';

        var input = body.querySelector('#mjp-file');
        var zone = body.querySelector('#mjp-dropzone');
        var msg = body.querySelector('#mjp-msg');

        function say(t, bad) {
            if (!msg) return;
            msg.textContent = t;
            msg.style.color = bad ? '#e24b4a' : 'var(--text-secondary)';
        }

        zone.addEventListener('click', function (e) { e.preventDefault(); input.click(); });
        input.addEventListener('change', function () {
            handleFile(input.files && input.files[0], say);
        });

        ['dragenter', 'dragover'].forEach(function (ev) {
            zone.addEventListener(ev, function (e) {
                e.preventDefault(); e.stopPropagation();
                zone.style.background = 'var(--accent-color)22';
            });
        });
        ['dragleave', 'drop'].forEach(function (ev) {
            zone.addEventListener(ev, function (e) {
                e.preventDefault(); e.stopPropagation();
                zone.style.background = 'var(--accent-color)0d';
            });
        });
        zone.addEventListener('drop', function (e) {
            var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (f) handleFile(f, say);
        });
    }

    /**
     * 读文件 → 解析 → 出预览。只有这一条路。
     * @param {File} file
     * @param {Function} say 往页面上写一行提示
     */
    function handleFile(file, say) {
        if (!file) return;
        say('正在读「' + file.name + '」…');

        var reader;
        try {
            reader = new FileReader();
        } catch (e) {
            say('这个浏览器不支持读取本地文件：' + e.message, true);
            return;
        }

        reader.onload = function () {
            try {
                var text = String(reader.result || '');
                var sentences = parseDialogue(text);

                S.fileName = file.name;
                S.sentences = sentences;
                S.cards = [];
                S.showAll = false;

                if (!sentences.length) {
                    say('「' + file.name + '」读到了 ' + text.length + ' 个字符，但里面没有可用的正文。', true);
                    return;
                }
                S.stage = 'preview';
                render(true);
            } catch (err) {
                say('解析出错：' + (err && err.message ? err.message : err), true);
            }
        };

        reader.onerror = function () {
            var err = reader.error || {};
            var name = err.name || '';
            var hint = (name === 'NotReadableError' || name === 'SecurityError')
                ? '这个文件还在 iCloud 云端、没下载到本地（Finder 里图标带云朵）。' +
                  '请在 Finder 里右键它选「现在下载」，或先复制到「下载」文件夹再选。'
                : (err.message || '未知原因');
            say('读不了这个文件：' + hint, true);
        };

        try {
            reader.readAsText(file);
        } catch (e) {
            say('读不了这个文件：' + e.message, true);
        }
    }

    function renderPreview(body) {
        var total = S.sentences.length;
        var limit = S.showAll ? total : Math.min(30, total);
        var list = '';

        for (var i = 0; i < limit; i++) {
            list += '<div style="padding:4px 0;border-bottom:1px dashed var(--border-color);">' + esc(S.sentences[i]) + '</div>';
        }
        if (total > 30) {
            list += '<div style="padding:6px 0;">' +
                smallBtn(S.showAll ? '收起' : ('展开全部 ' + total + ' 句'), 'muted', 'id="mjp-more"') + '</div>';
        }

        body.innerHTML =
            '<div style="border:1.5px solid var(--border-color);border-radius:14px;padding:12px 14px;background:var(--primary-bg);">' +
                '<div style="font-size:13px;font-weight:700;color:var(--text-primary);word-break:break-all;">' + esc(S.fileName) + '</div>' +
                '<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">拆出 ' + total + ' 句他说过的话</div>' +
                '<div style="margin-top:10px;max-height:300px;overflow:auto;font-size:12px;line-height:1.8;' +
                    'color:var(--text-secondary);">' + list + '</div>' +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;">' +
                bigBtn('就是这份，让他挑', 'ok', 'id="mjp-go"') +
                bigBtn('换一份', 'no', 'id="mjp-change"') +
            '</div>';
    }

    function renderThinking(body) {
        var left = Math.max(0, Math.ceil((S.deadline - Date.now()) / 1000));
        body.innerHTML =
            '<div style="text-align:center;padding:34px 10px;">' +
                '<i class="fas fa-book-open" style="font-size:24px;color:var(--accent-color);opacity:.7;"></i>' +
                '<div style="margin-top:14px;font-size:13px;color:var(--text-primary);">他正在读这份对话…</div>' +
                '<div style="margin-top:8px;font-size:12px;color:var(--text-secondary);">还剩 <span id="mjp-count">' + left + '</span> 秒</div>' +
                '<div style="margin-top:10px;font-size:11px;color:var(--text-secondary);">可以先关掉面板，回来他可能已经挑好了</div>' +
            '</div>';
    }

    function renderOffer(body) {
        body.innerHTML =
            '<div style="text-align:center;padding:34px 10px;">' +
                '<div style="font-size:13px;font-weight:700;color:var(--text-primary);">已加入 ' + S.lastApproved + ' 张</div>' +
                '<div style="font-size:12px;color:var(--text-secondary);margin-top:8px;">他好像还有想选的。这份对话，要再让他挑一轮吗？</div>' +
                '<div style="margin-top:18px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">' +
                    smallBtn('让他再挑一轮（第 ' + (S.round + 1) + ' 轮）', 'ok', 'id="mjp-offer-yes"') +
                    smallBtn('就到这吧', 'muted', 'id="mjp-offer-no"') +
                '</div>' +
            '</div>';
    }

    /* ── 清单 ── */

    function renderList(body) {
        var approved = S.cards.filter(function (c) { return c.status === 'approved'; });

        if (!S.cards.length) {
            body.innerHTML =
                '<div style="text-align:center;padding:34px 10px;">' +
                    '<div style="font-size:13px;color:var(--text-primary);">这次他没有想留的。</div>' +
                    '<div style="font-size:12px;color:var(--text-secondary);margin-top:8px;">这份对话里，没有哪句让他想单独收起来。</div>' +
                    '<div style="margin-top:16px;">' + smallBtn('再换一份', 'muted', 'id="mjp-again"') + '</div>' +
                '</div>';
            return;
        }

        var html =
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;">' +
                '<div style="font-size:13px;font-weight:700;color:var(--text-primary);flex:1;">他挑了 ' + S.cards.length + ' 张' +
                    (S.round > 1 ? '<span style="font-weight:400;font-size:11px;color:var(--text-secondary);">（第 ' + S.round + ' 轮）</span>' : '') +
                '</div>' +
                smallBtn('全选', 'muted', 'id="mjp-all"') +
                smallBtn('全不选', 'muted', 'id="mjp-none"') +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center;">' +
                smallBtn('批量通过', 'ok', 'id="mjp-pass-all"') +
                smallBtn('批量拒绝', 'no', 'id="mjp-reject-all"') +
                '<span style="font-size:11px;color:var(--text-secondary);">（没勾选时作用于全部未处理的卡）</span>' +
            '</div>';

        S.cards.forEach(function (c) { html += cardHtml(c); });
        body.innerHTML = html;

        // 吸底：只在有通过的卡时出现
        if (approved.length) {
            var bar = _modal.querySelector('#mjp-commit-bar');
            var toLib = approved.filter(function (c) { return (c.kind || 'card') !== 'poke'; });
            var note = '已通过 ' + approved.length + ' 张';
            if (toLib.length < approved.length) {
                note += '（其中 ' + (approved.length - toLib.length) + ' 张只进拍一拍）';
            }
            bar.innerHTML =
                '<span style="font-size:11px;color:var(--text-secondary);">' + note + '</span>' +
                bigBtn(toLib.length ? '加入回复库' : '录进拍一拍', 'ok', 'id="mjp-commit"');
            bar.style.display = 'flex';
        }
    }

    /** 卡片上的小标签。配色沿用原来那套：已通过=主题色、他坚持要=粉、他让步=灰、他不接受=红 */
    function badge(text, tone) {
        var s = 'display:inline-block;font-size:10px;line-height:18px;padding:0 8px;border-radius:9px;white-space:nowrap;';
        if (tone === 'solid') s += 'background:#F0659518;border:1px solid #F0659530;color:#F06595;';
        else if (tone === 'accent') s += 'border:1px solid var(--accent-color);color:var(--accent-color);';
        else if (tone === 'warn') s += 'border:1px solid #e24b4a55;color:#e24b4a;';
        else s += 'border:1px solid var(--border-color);color:var(--text-secondary);';
        return '<span style="' + s + '">' + esc(text) + '</span>';
    }

    /**
     * 反悔：跟状态标签同尺寸的虚线气泡，紧挨着标签站。
     * 用虚线不用实线，是因为两个实线框并排会被读成「两个状态」；虚线本身带「还没定死」的意思。
     */
    function undoChip(cid) {
        return '<button data-act="undo" data-cid="' + cid + '" style="display:inline-flex;align-items:center;' +
            'height:20px;padding:0 10px;margin-left:2px;border:1px dashed var(--text-secondary);' +
            'border-radius:9px;background:transparent;color:var(--text-secondary);font-size:10px;' +
            'line-height:1;font-family:var(--font-family);cursor:pointer;white-space:nowrap;flex-shrink:0;">反悔</button>';
    }

    /**
     * 分组下拉。选中即写回状态（onchange 走委托），不用等入库时再回收。
     * @param {Object} card
     * @returns {string}
     */
    function groupSelect(card) {
        var groups = getGroups();
        var opts = '<option value="">未分组</option>';
        groups.forEach(function (g) {
            if (g.name === INSIST) return;             // 系统分组，不给选
            opts += '<option value="' + esc(g.name) + '"' + (card.group === g.name ? ' selected' : '') + '>' +
                esc(g.name) + '</option>';
        });
        return '<select data-gid="' + card.id + '" style="font-size:12px;padding:5px 8px;border-radius:9px;' +
            'border:1.5px solid var(--border-color);background:var(--primary-bg);color:var(--text-primary);' +
            'font-family:var(--font-family);max-width:170px;">' + opts + '</select>';
    }

    function cardHtml(c) {
        var kind = c.kind || 'card';

        // 来源标：纯字卡不挂图标（字卡是默认形态）；♡ 是拍一拍；两者都要才同时出 ✍️ 和 ♡
        var src = '';
        if (kind === 'poke') {
            src = '<span title="他只想放进拍一拍，不进字卡" style="font-size:12px;color:#F06595;">♡</span>';
        } else if (kind === 'both') {
            src = '<span title="字卡和拍一拍都要" style="font-size:12px;">✍️<span style="color:#F06595;">♡</span></span>';
        }

        var stateBadge = '';
        var extra = '';                                   // 状态行下面：分组下拉 / 一句说明

        if (c.status === 'approved') {
            if (c.forced) {
                stateBadge = badge('他坚持要', 'solid');
                extra = '<div style="margin-top:8px;font-size:11px;color:var(--text-secondary);">固定归入「' + INSIST + '」，不用选分组</div>';
            } else if (kind === 'poke') {
                stateBadge = badge('已通过', 'accent');
                extra = '<div style="margin-top:8px;font-size:11px;color:var(--text-secondary);">只进拍一拍，不用选分组</div>';
            } else {
                stateBadge = badge('已通过', 'accent');
                extra = '<div style="margin-top:9px;">' + groupSelect(c) + '</div>';
            }
        } else if (c.status === 'rejected') {
            stateBadge = badge('他让步了，不加', 'muted');
        } else if (c.status === 'arguing') {
            stateBadge = badge('他不接受', 'warn');
        }

        // 状态行：来源标 → 状态标签 → 反悔，靠左并排。
        // 允许换行：像「他让步了，不加」这种长标签，小屏上和反悔挤一行会溢出。
        var undoBtn = (c.status === 'approved' || c.status === 'rejected') ? undoChip(c.id) : '';
        var statusRow = (src || stateBadge || undoBtn)
            ? '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:9px;">' +
                src + stateBadge + undoBtn + '</div>'
            : '';

        var actions = '';
        if (c.status === 'pending') {
            actions = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center;">' +
                smallBtn('通过', 'ok', 'data-act="pass" data-cid="' + c.id + '"') +
                smallBtn('拒绝', 'no', 'data-act="reject" data-cid="' + c.id + '"') +
            '</div>';
        } else if (c.status === 'arguing') {
            actions = '<div style="margin-top:10px;">' +
                '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">他说这张要留下。你的最后机会：</div>' +
                '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
                    smallBtn('算了，让他加', 'muted', 'data-act="yield" data-cid="' + c.id + '"') +
                    smallBtn('我还是要拒绝', 'no', 'data-act="last" data-cid="' + c.id + '"') +
                '</div>' +
            '</div>';
        }

        var check = (c.status === 'pending')
            ? '<input type="checkbox" data-act="check" data-cid="' + c.id + '"' + (c.checked ? ' checked' : '') +
              ' style="margin-top:3px;flex-shrink:0;">'
            : '';

        var done = (c.status === 'approved' || c.status === 'rejected');
        return '<div style="border:1.5px solid var(--border-color);border-radius:14px;padding:12px 14px;margin:10px 0;' +
            'background:' + (done ? 'var(--secondary-bg)' : 'var(--primary-bg)') + ';">' +
            '<div style="display:flex;gap:10px;align-items:flex-start;">' + check +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="font-size:13px;line-height:1.7;color:var(--text-primary);white-space:pre-wrap;word-break:break-word;">' +
                        esc(c.text) + '</div>' +
                    statusRow + extra + actions +
                '</div>' +
            '</div></div>';
    }

    /* ══════════════════════ 9 历史与长图 ══════════════════════ */

    // 标签：跟导出长图同一套语义，配色跟随页面主题
    var CHIP_BASE = 'display:inline-block;font-size:10px;line-height:18px;padding:0 8px;border-radius:9px;white-space:nowrap;';

    function chip(text, tone) {
        var s = CHIP_BASE;
        if (tone === 'solid') s += 'background:#9E2F3D;color:#fff;';
        else if (tone === 'accent') s += 'border:1px solid #9E2F3D;color:#9E2F3D;';
        else if (tone === 'pink') s += 'border:1px solid #E07A9E;color:#E07A9E;';
        else if (tone === 'group') s += 'background:var(--secondary-bg);color:var(--text-secondary);';
        else s += 'border:1px solid var(--border-color);color:var(--text-secondary);';
        return '<span style="' + s + '">' + esc(text) + '</span>';
    }

    /** @param {Object} c 历史里的一张卡 @returns {string} */
    function histChips(c) {
        var out = [];
        var kind = c.kind || 'card';

        if (c.forced) out.push(chip('他坚持要', 'solid'));
        else if (c.status === 'approved') out.push(chip(kind === 'poke' ? '只进拍一拍' : '已加入', kind === 'poke' ? 'pink' : 'accent'));
        else if (c.status === 'rejected') out.push(chip('他让步了，不加', 'muted'));
        else if (c.status === 'arguing') out.push(chip('他不接受', 'solid'));
        else out.push(chip('没处理', 'muted'));

        if (kind === 'both') out.push(chip('♡ 拍一拍', 'pink'));
        else if (kind === 'poke') { /* 上面已经有「只进拍一拍」 */ }
        // 老数据只有 poke 布尔，没有 kind
        else if (c.poke) out.push(chip('♡ 拍一拍', 'pink'));

        // 分组：已经由状态标签表达过的系统分组不再重复一遍
        if (c.group && c.group !== '未分组' && c.group !== INSIST) out.push(chip(c.group, 'group'));
        return out.join('');
    }

    var _delTimer = null;

    /**
     * 历史条目的显示标题：自己改过就用改过的，没改过沿用文件名。
     * @param {{title?: string, fileName?: string}} h
     * @returns {string}
     */
    function histTitle(h) {
        return h.title || h.fileName || '未命名';
    }

    /**
     * 就地给历史记录改名。点标题 → 原文字变成输入框。
     * Enter / 点别处保存，Esc 放弃；清空保存则退回文件名，等于「恢复原名」。
     * 保存后不整块重画（只把标题节点原地放回去），否则紧接着那次点击会落空。
     * @param {number} i 历史下标
     * @param {HTMLElement} el 标题节点
     */
    function startRename(i, el) {
        var h = S.history[i];
        if (!h || !el.parentNode) return;

        var input = document.createElement('input');
        input.type = 'text';
        input.value = histTitle(h);
        input.maxLength = 40;
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('enterkeyhint', 'done');
        // 字号必须是 16px：iOS Safari 在输入框 <16px 时会自动放大整个页面，且常常不缩回，
        // 弹窗会跑偏。标题本身是 12px，编辑态大一号，也算「正在编辑」的提示。
        input.style.cssText = 'display:block;width:100%;box-sizing:border-box;font-size:16px;' +
            'font-weight:700;font-family:inherit;color:var(--text-primary);background:var(--secondary-bg);' +
            'border:1px solid var(--accent-color);border-radius:8px;padding:4px 8px;outline:none;';
        el.parentNode.replaceChild(input, el);

        var done = false;
        function finish(save) {
            if (done) return;
            done = true;
            var v = (input.value || '').trim();
            if (save) {
                if (v && v !== histTitle(h)) { h.title = v; dbSave(K_HISTORY, S.history); }
                else if (!v && h.title) { delete h.title; dbSave(K_HISTORY, S.history); }
            }
            el.textContent = histTitle(h);
            if (input.parentNode) input.parentNode.replaceChild(el, input);
        }

        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', function () { finish(true); });

        input.focus();
        input.select();
    }

    /**
     * 删除历史：第一次点只把按钮变成「确定删除」，3 秒内再点一次才真删。
     * 不弹窗、不打断，也不至于一下手滑就没了。
     * @param {number} i
     */
    function askDelete(i) {
        if (S.pendingDel === i) {
            S.history.splice(i, 1);
            S.detail = -1;
            S.pendingDel = -1;
            clearTimeout(_delTimer);
            dbSave(K_HISTORY, S.history);
            render();
            notify('已删除这条记录', 'info');
            return;
        }
        S.pendingDel = i;
        render();
        clearTimeout(_delTimer);
        _delTimer = setTimeout(function () {
            if (S.pendingDel === i) { S.pendingDel = -1; render(); }
        }, 3000);
    }

    function renderHistory(body) {
        if (!S.history.length) {
            body.innerHTML = '<div style="text-align:center;padding:34px 10px;font-size:12px;color:var(--text-secondary);">还没有挑选记录</div>';
            return;
        }

        var html = '';
        S.history.forEach(function (h, i) {
            var d = new Date(h.ts);
            var stamp = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
                ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
            var all = h.cards || [];
            var kept = all.filter(function (c) { return c.status === 'approved'; }).length;
            var forced = all.filter(function (c) { return c.forced; }).length;
            var poke = all.filter(function (c) {
                var k = c.kind || (c.poke ? 'both' : 'card');
                return k === 'poke' || k === 'both';
            }).length;

            html += '<div style="border:1.5px solid var(--border-color);border-radius:14px;padding:12px 14px;margin:10px 0;background:var(--primary-bg);">' +
                '<div style="display:flex;gap:8px;align-items:center;">' +
                    '<div style="flex:1;min-width:0;">' +
                        '<div data-rename="' + i + '" title="点击改名" style="font-size:12px;font-weight:700;color:var(--text-primary);word-break:break-all;cursor:text;">' + esc(histTitle(h)) + '</div>' +
                        '<div style="font-size:11px;color:var(--text-secondary);margin-top:3px;">' + stamp +
                            ' · 挑出 ' + all.length + ' 张 · 加入 ' + kept + ' 张' +
                            (forced ? ' · 他坚持 ' + forced + ' 张' : '') +
                            (poke ? ' · 拍一拍 ' + poke + ' 张' : '') + '</div>' +
                    '</div>' +
                    smallBtn(S.detail === i ? '收起' : '查看', 'muted', 'data-hist="' + i + '"') +
                    smallBtn(S.pendingDel === i ? '确定删除' : '删除', 'no', 'data-del="' + i + '"') +
                '</div>';

            if (S.detail === i) {
                var inner = '';
                all.forEach(function (c) {
                    inner += '<div style="border:1px solid var(--border-color);border-radius:12px;padding:10px 12px;margin:8px 0;' +
                        'background:var(--secondary-bg);">' +
                        '<div style="font-size:12.5px;line-height:1.75;color:var(--text-primary);white-space:pre-wrap;">' + esc(c.text) + '</div>' +
                        '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">' + histChips(c) + '</div>' +
                        '</div>';
                });
                if (!all.length) {
                    inner = '<div style="font-size:12px;color:var(--text-secondary);padding:8px 0;">（没有卡片）</div>';
                }
                html += '<div style="margin-top:10px;max-height:320px;overflow:auto;">' + inner + '</div>' +
                    '<div style="display:flex;gap:10px;margin-top:12px;align-items:center;justify-content:space-between;">' +
                        '<span style="font-size:11px;color:var(--text-secondary);">黑红版式 · 只含留下来的卡</span>' +
                        smallBtn('导出长图', 'ok', 'data-img="' + i + '"') +
                    '</div>';
            }
            html += '</div>';
        });
        body.innerHTML = html;
    }

    /* ── 导出长图 ──
     * 版式和配色见 js/features/mj-pick-image.js。
     * 生成后先进预览层：电脑可复制到剪贴板 / 下载，手机长按存相册（移动端不走任何 API，最稳）。
     */

    function exportImage(item) {
        if (!item) return;
        if (!window.MJPickImage) {
            notify('导出模块没加载上，刷新一下页面', 'warning');
            return;
        }
        try {
            var cv = window.MJPickImage.draw(item, { layout: 'card', theme: 'dark', red: MJP_RED, scale: 2 });
            var d = new Date(item.ts || Date.now());
            // 带年份：跨年不撞名，同一天导出两次浏览器会自己加 (1)
            var name = '挑选记录-' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '.png';
            showImagePreview(cv, name);
        } catch (e) {
            console.warn('[mj-pick] 导出失败', e);
            notify('导出失败了，再试一次', 'error');
        }
    }

    var _imgWrap = null;

    function isMobileUA() {
        return /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent || '');
    }

    function closeImagePreview() {
        if (_imgWrap) {
            try { document.body.removeChild(_imgWrap); } catch (e) { }
            _imgWrap = null;
        }
        document.removeEventListener('keydown', onImgEsc);
    }

    function onImgEsc(e) {
        if (e.key === 'Escape') closeImagePreview();
    }

    /**
     * 把 canvas 放进剪贴板。
     * Safari 要求「在点击手势里同步调用 write、值传 Promise」，所以不能先 await toBlob 再 write，
     * 否则手势过期会静默失败。
     * @param {HTMLCanvasElement} canvas
     * @param {Function} cb (ok: boolean) => void
     */
    function copyCanvasToClipboard(canvas, cb) {
        try {
            if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function' || !window.ClipboardItem) {
                return cb(false);
            }
            if (window.ClipboardItem.supports && !window.ClipboardItem.supports('image/png')) return cb(false);

            var blobPromise = new Promise(function (resolve) {
                canvas.toBlob(function (b) { resolve(b); }, 'image/png');
            });
            navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blobPromise })])
                .then(function () { cb(true); }, function (err) {
                    console.warn('[mj-pick] 复制失败', err);
                    cb(false);
                });
        } catch (e) {
            console.warn('[mj-pick] 复制不可用', e);
            cb(false);
        }
    }

    function showImagePreview(canvas, name) {
        closeImagePreview();

        var mobile = isMobileUA();
        var wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;inset:0;z-index:10003;background:rgba(0,0,0,.72);' +
            'display:flex;align-items:center;justify-content:center;padding:16px;';

        var card = document.createElement('div');
        // min-width:0 必须加：flex 子项默认 min-width:auto，会被图片原始宽度撑破手机屏
        card.style.cssText = 'width:100%;max-width:520px;min-width:0;box-sizing:border-box;max-height:92vh;' +
            'display:flex;flex-direction:column;' +
            'background:var(--primary-bg,#fff);border-radius:18px;overflow:hidden;' +
            'box-shadow:0 12px 40px rgba(0,0,0,.35);';

        var head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px 16px 8px;';
        var htitle = document.createElement('div');
        htitle.style.cssText = 'flex:1;font-size:13px;font-weight:700;color:var(--text-primary);';
        htitle.textContent = '长图已生成';
        var hx = document.createElement('button');
        hx.textContent = '×';
        hx.style.cssText = 'width:28px;height:28px;border:none;background:transparent;color:var(--text-secondary);' +
            'font-size:20px;line-height:1;cursor:pointer;font-family:var(--font-family);';
        hx.onclick = closeImagePreview;
        head.appendChild(htitle);
        head.appendChild(hx);

        var scroll = document.createElement('div');
        scroll.style.cssText = 'flex:1;min-height:0;min-width:0;overflow:auto;padding:0 16px;';
        var img = document.createElement('img');
        img.src = canvas.toDataURL('image/png');
        img.style.cssText = 'display:block;width:100%;max-width:100%;height:auto;border-radius:12px;';
        if (mobile) img.style.webkitTouchCallout = 'default';   // 允许长按出「存储到照片」
        scroll.appendChild(img);

        var foot = document.createElement('div');
        foot.style.cssText = 'padding:12px 16px calc(12px + env(safe-area-inset-bottom, 0px));';

        if (mobile) {
            var tip = document.createElement('div');
            tip.style.cssText = 'text-align:center;font-size:12px;line-height:1.6;color:var(--text-secondary);';
            tip.textContent = '长按上面的图片，选「存储到照片」';
            foot.appendChild(tip);
        } else {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:10px;align-items:center;justify-content:flex-end;';

            var dl = document.createElement('button');
            dl.textContent = '下载';
            dl.style.cssText = 'padding:8px 16px;border-radius:12px;border:1.5px solid var(--border-color);' +
                'background:transparent;color:var(--text-secondary);font-size:13px;font-weight:700;' +
                'cursor:pointer;font-family:var(--font-family);';
            dl.onclick = function () {
                window.MJPickImage.download(canvas, name);
                closeImagePreview();
            };

            var cp = document.createElement('button');
            cp.textContent = '复制图片';
            cp.style.cssText = 'padding:8px 18px;border-radius:12px;border:1.5px solid var(--accent-color);' +
                'background:var(--accent-color);color:#fff;font-size:13px;font-weight:700;' +
                'cursor:pointer;font-family:var(--font-family);';
            cp.onclick = function () {
                cp.disabled = true;
                cp.textContent = '复制中…';
                copyCanvasToClipboard(canvas, function (ok) {
                    if (ok) {
                        closeImagePreview();
                        notify('已复制，可以直接粘贴了', 'success');
                    } else {
                        // 剪贴板不可用（file:// 打开、浏览器不支持）：退回下载，别留一个点了没反应的按钮
                        window.MJPickImage.download(canvas, name);
                        closeImagePreview();
                        notify('这个环境不能复制，已改成下载', 'info');
                    }
                });
            };

            row.appendChild(dl);
            row.appendChild(cp);
            foot.appendChild(row);
        }

        card.appendChild(head);
        card.appendChild(scroll);
        card.appendChild(foot);
        wrap.appendChild(card);
        wrap.addEventListener('click', function (e) { if (e.target === wrap) closeImagePreview(); });
        document.addEventListener('keydown', onImgEsc);
        document.body.appendChild(wrap);
        _imgWrap = wrap;
    }

    /* ══════════════════════ 10 注入 ══════════════════════
     *
     * 设置面板那块 HTML、功能入口、回复库那行小字，全部由这里在运行时插进去。
     * index.html 因此从 +28 行降到 +1 行（一个 script 标签），老师以后改设置页不会跟你撞车。
     */

    var BADGE_HTML = '<span id="mj-pick-entry-badge" style="display:none;position:absolute;top:10px;right:10px;' +
        'width:8px;height:8px;background:var(--accent-color);border-radius:50%;' +
        'border:1.5px solid var(--primary-bg);pointer-events:none;"></span>';

    var SETTINGS_HTML =
        '<p class="cs-group-label" style="margin-top:4px;">挑卡思考时间</p>' +
        '<div class="cs-card" style="margin-bottom:10px;">' +
            '<div class="cs-slider-row">' +
                '<span class="cs-slider-label">最短等待</span>' +
                '<input type="range" min="5" max="60" step="1" value="60" class="font-size-slider" id="mjp-min">' +
                '<span class="cs-slider-val" id="mjp-min-val">1分钟</span>' +
            '</div>' +
            '<div class="cs-slider-row">' +
                '<span class="cs-slider-label">最长等待</span>' +
                '<input type="range" min="1" max="5" step="1" value="5" class="font-size-slider" id="mjp-max">' +
                '<span class="cs-slider-val" id="mjp-max-val">5分钟</span>' +
            '</div>' +
            '<div class="setting-pill-row" id="mjp-he-row" style="border-top:1px solid var(--border-color);">' +
                '<span class="setting-pill-icon"><i class="fas fa-dice"></i></span>' +
                '<span class="setting-pill-label">他来决定 <span style="font-size:11px;color:var(--text-secondary);font-weight:400;">开启后等待区间也由他随机定</span></span>' +
                '<div class="setting-pill-switch"><div class="setting-pill-knob"></div></div>' +
            '</div>' +
            '<div style="font-size:11px;color:var(--text-secondary);padding:0 14px 10px;line-height:1.6;">' +
                '他挑字卡前会「读」一遍对话，实际时长在这个区间里随机' +
            '</div>' +
        '</div>';

    function injectStyle() {
        if (document.getElementById('mjp-style')) return;
        var st = document.createElement('style');
        st.id = 'mjp-style';
        st.textContent =
            // 通知卡片的上滑动画（原来每次都往页面里塞一个 <style>，现在收进这里）
            '@keyframes _mjpSlideUp{' +
                'from{opacity:0;transform:translateX(-50%) translateY(24px) scale(.9)}' +
                '60%{transform:translateX(-50%) translateY(-4px) scale(1.02)}' +
                'to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}' +
            // 回复库那行小字：做成子标签的 ::after，跟着子标签一起显示/隐藏，
            // 这样 features.js 里专门隐藏它的代码可以删掉
            '#cr-sub-tabs{flex-wrap:wrap;}' +
            '#cr-sub-tabs::after{content:"✍️ 他挑选的 · 📖 我写他挑的";flex:0 0 100%;width:100%;' +
                'text-align:right;font-size:10px;line-height:1.5;color:var(--text-secondary);' +
                'padding:2px 2px 0;box-sizing:border-box;}' +
            '.rl-mjp-flag{font-size:13px;flex-shrink:0;margin-right:2px;cursor:default;}';
        document.head.appendChild(st);
    }

    /**
     * 把设置面板那块插进「聊天设置 → 节奏」，位置在「主动发送」之前。
     * 找不到锚点就挂到面板末尾——宁可位置不完美，也不能让设置项消失。
     * @returns {boolean} 是否已经就位
     */
    function injectSettings() {
        if (document.getElementById('mjp-min')) return true;

        var panel = document.getElementById('cs-panel-rhythm');
        if (!panel) return false;

        var anchor = null;
        var labels = panel.querySelectorAll('p.cs-group-label');
        for (var i = 0; i < labels.length; i++) {
            if ((labels[i].textContent || '').indexOf('主动发送') !== -1) { anchor = labels[i]; break; }
        }

        var box = document.createElement('div');
        box.innerHTML = SETTINGS_HTML;

        var frag = document.createDocumentFragment();
        while (box.firstChild) frag.appendChild(box.firstChild);

        if (anchor && anchor.parentNode === panel) panel.insertBefore(frag, anchor);
        else panel.appendChild(frag);
        return true;
    }

    /**
     * 把功能入口插到「问卷」后面。
     * @returns {boolean} 是否已经就位
     */
    function injectEntry() {
        if (document.getElementById('mj-pick-function')) return true;

        var survey = document.getElementById('survey-function');
        if (!survey || !survey.parentNode) return false;

        var el = document.createElement('div');
        el.className = 'settings-item';
        el.id = 'mj-pick-function';
        el.innerHTML = '<i class="fas fa-book-open"></i><span>和他一起选字卡</span>' + BADGE_HTML;

        survey.parentNode.insertBefore(el, survey.nextSibling);
        return true;
    }

    /** 入口用 document 委托：注入晚一点、面板重画几次都不影响 */
    function bindEntry() {
        document.addEventListener('click', function (e) {
            var t = e.target;
            var el = (t && typeof t.closest === 'function') ? t.closest('#mj-pick-function') : null;
            if (!el) return;
            try {
                var adv = document.getElementById('advanced-modal');
                if (adv && typeof hideModal === 'function') hideModal(adv);
            } catch (err) { }
            open();
        }, true);
    }

    /* ── 设置项的读写 ── */

    function paintMinLabel(v) {
        var el = document.getElementById('mjp-min-val');
        if (el) el.textContent = (v >= 60 ? '1分钟' : v + '秒');
    }

    function paintMaxLabel(v) {
        var el = document.getElementById('mjp-max-val');
        if (el) el.textContent = v + '分钟';
    }

    /** 全量刷新滑轨与开关（不动用户正在拖的那个控件时调用才安全） */
    function paintSettings() {
        var s = getSettings();
        var minSec = clampInt(s.mjpMinSec, MIN_SEC.lo, MIN_SEC.hi, 60);
        var maxMin = clampInt(s.mjpMaxMin, MAX_MIN.lo, MAX_MIN.hi, 5);

        var min = document.getElementById('mjp-min');
        var max = document.getElementById('mjp-max');
        if (min) min.value = minSec;
        if (max) max.value = maxMin;

        paintMinLabel(minSec);
        paintMaxLabel(maxMin);

        var row = document.getElementById('mjp-he-row');
        if (row) row.classList.toggle('active', !!s.mjpHeDecides);
    }

    function setSetting(key, val) {
        var s = getSettings();
        if (!s || typeof s !== 'object') return;
        try { s[key] = val; } catch (e) { return; }
        persist();
    }

    /**
     * 她自己动了滑轨 → 开关自动关掉。
     * 这是「我动了轴就听我的」的落地：她想自己控制，就不该再被他覆盖。
     */
    function dropHeDecides() {
        var s = getSettings();
        if (!s.mjpHeDecides) return;
        setSetting('mjpHeDecides', false);
        var row = document.getElementById('mjp-he-row');
        if (row) row.classList.remove('active');
    }

    function bindSettings() {
        // 拖动滑轨：只刷文字，不整体重画（否则拖到一半值会被打回去）
        document.addEventListener('input', function (e) {
            var el = e.target;
            if (!el || !el.id) return;

            if (el.id === 'mjp-min') {
                var v = clampInt(el.value, MIN_SEC.lo, MIN_SEC.hi, 60);
                paintMinLabel(v);
                setSetting('mjpMinSec', v);
                dropHeDecides();
            } else if (el.id === 'mjp-max') {
                var m = clampInt(el.value, MAX_MIN.lo, MAX_MIN.hi, 5);
                paintMaxLabel(m);
                setSetting('mjpMaxMin', m);
                dropHeDecides();
            }
        }, true);

        document.addEventListener('click', function (e) {
            var t = e.target;

            var row = (t && typeof t.closest === 'function') ? t.closest('#mjp-he-row') : null;
            if (row) {
                e.preventDefault();
                e.stopPropagation();
                setSetting('mjpHeDecides', !getSettings().mjpHeDecides);
                paintSettings();
                return;
            }

            // 切到「节奏」标签、或打开设置面板时，把值刷一遍
            if (t && typeof t.closest === 'function' && t.closest('.cs-tab, #settings-function, #cs-panel-rhythm')) {
                setTimeout(paintSettings, 0);
            }
        }, true);
    }

    /* ══════════════════════ 11 通知 ══════════════════════
     * 外观照抄问卷（js/features/survey.js 的 _showMergedReminder）：底部上滑卡片，
     * 头像 + 「XX · 挑选动态」+ 一句话 + 〔稍后〕〔立即查看 ✦〕，8 秒自动消失。
     * 不做持久化：刷新/关页面后这次思考就没了，这是有意为之的简化。
     */

    function partnerName() {
        return getSettings().partnerName || '他';
    }

    function showPickNotif(count) {
        hidePickNotif();

        var bodyText = count ? ('他挑好了 ' + count + ' 张字卡') : '这份对话里没有他想留的';

        // 头像直接借主界面挂着的那张，跟问卷取法一致
        var realImg = document.querySelector('#partner-avatar img');
        var avatarHtml = (realImg && realImg.src)
            ? '<img src="' + realImg.src + '" style="width:100%;height:100%;object-fit:cover;">'
            : '<i class="fas fa-user" style="font-size:18px;color:var(--text-secondary);"></i>';

        var popup = document.createElement('div');
        popup.id = 'mjp-notif-popup';
        popup.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
            'background:var(--secondary-bg);border:1px solid var(--border-color);' +
            'border-radius:20px;padding:18px 20px;z-index:9000;max-width:320px;width:88%;' +
            'box-shadow:0 8px 32px rgba(0,0,0,0.18);display:flex;flex-direction:column;gap:12px;' +
            'animation:_mjpSlideUp 0.4s cubic-bezier(0.22,1,0.36,1);';
        popup.innerHTML =
            '<div style="display:flex;align-items:center;gap:10px;">' +
                '<div style="width:36px;height:36px;border-radius:50%;background:rgba(var(--accent-color-rgb),0.12);' +
                    'display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;">' + avatarHtml + '</div>' +
                '<div>' +
                    '<div style="font-size:14px;font-weight:700;color:var(--text-primary);">' + esc(partnerName()) + ' · 挑选动态</div>' +
                    '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;opacity:0.8;">' + esc(bodyText) + '</div>' +
                '</div>' +
            '</div>' +
            '<div style="display:flex;gap:8px;">' +
                '<button id="mjp-notif-later" style="flex:1;padding:8px 0;border-radius:12px;border:1px solid var(--border-color);' +
                    'background:var(--primary-bg);color:var(--text-secondary);font-size:13px;cursor:pointer;font-family:inherit;">稍后</button>' +
                '<button id="mjp-notif-view" style="flex:2;padding:8px 0;border-radius:12px;border:none;' +
                    'background:var(--accent-color);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">立即查看 ✦</button>' +
            '</div>';

        document.body.appendChild(popup);
        popup.querySelector('#mjp-notif-later').onclick = function () { popup.remove(); };
        popup.querySelector('#mjp-notif-view').onclick = function () { popup.remove(); open(); };
        setTimeout(function () { if (popup.parentNode) popup.remove(); }, 8000);
    }

    function hidePickNotif() {
        var p = document.getElementById('mjp-notif-popup');
        if (p) p.remove();
    }

    function updateEntryBadge() {
        var el = document.getElementById('mj-pick-entry-badge');
        if (el) el.style.display = (S.badgeOn && S.stage === 'list') ? 'inline-block' : 'none';
    }

    /* ══════════════════════ 12 登记表接口 ══════════════════════
     * 回复库渲染卡片和筛选时调用，拿每张卡的来源：
     *   'pick'    让他挑选 → ✍️
     *   'written' 我写他挑 → 📖（功能还没做，先把位置留住）
     *
     * 按文字匹配（回复库里的条目是纯字符串，没有 id）。归一化掉空白和引号，
     * 所以在回复库里改个引号、加个空格不会丢标识；但改字会——这是纯字符串数据结构决定的。
     */

    var _regMap = null;
    var _regDirty = true;

    function normText(t) {
        return String(t == null ? '' : t)
            .replace(/\s+/g, '')
            .replace(/[“”"「」『』‘’]/g, '');
    }

    /** 登记表变了就调这个，让缓存失效 */
    function invalidateRegistry() {
        _regDirty = true;
    }

    window.__mjpRegistry = function () {
        if (_regDirty || !_regMap) {
            var map = {};
            for (var i = 0; i < S.picked.length; i++) {
                var p = S.picked[i];
                if (!p || !p.text) continue;
                var k = normText(p.text);
                if (!map[k]) map[k] = p.src || 'pick';
            }
            _regMap = map;
            _regDirty = false;
        }
        var snapshot = _regMap;
        return {
            /**
             * @param {string} text
             * @returns {string|null} 'pick' | 'written' | null
             */
            srcOf: function (text) {
                return snapshot[normText(text)] || null;
            }
        };
    };

    /* ══════════════════════ 13 启动 ══════════════════════ */

    var _booted = false;

    /**
     * 旧版本的键名是自己猜的前缀（可能不带梦角ID或带错），做一次性搬家：
     * 只搬「属于当前梦角」的旧键，合并去重后删旧键。
     * @param {string} properPicked
     * @param {string} properHistory
     * @returns {Promise<void>}
     */
    function migrateOldKeys(properPicked, properHistory) {
        if (typeof localforage === 'undefined') return Promise.resolve();

        var tag = sessionTag();
        if (!tag) return Promise.resolve();

        return localforage.keys().then(function (keys) {
            var legacy = keys.filter(function (k) {
                if (k === properPicked || k === properHistory) return false;
                if (k.indexOf(tag) !== 0) return false;
                return k.indexOf('_mjPickHistory') !== -1 || k.indexOf('_mjPickedCards') !== -1;
            });
            if (!legacy.length) return;

            return Promise.all(legacy.map(function (k) {
                return localforage.getItem(k).then(function (v) { return { k: k, v: v }; });
            })).then(function (found) {
                return Promise.all(found.map(function (f) {
                    var arr = Array.isArray(f.v) ? f.v : [];
                    if (!arr.length) return localforage.removeItem(f.k).catch(function () { });

                    var isPicked = f.k.indexOf('_mjPickedCards') !== -1;
                    var proper = isPicked ? properPicked : properHistory;

                    return localforage.getItem(proper).then(function (cur) {
                        var merged = (Array.isArray(cur) ? cur : []).slice();
                        arr.forEach(function (it) {
                            if (!it) return;
                            var dup = merged.some(function (m) {
                                if (!m) return false;
                                return isPicked ? m.text === it.text : (m.ts === it.ts && m.fileName === it.fileName);
                            });
                            if (!dup) merged.push(it);
                        });
                        return localforage.setItem(proper, merged).then(function () {
                            return localforage.removeItem(f.k).catch(function () { });
                        });
                    });
                }));
            });
        }).catch(function () { });
    }

    /**
     * 老历史里每条都带着整份对话 HTML（字段 html / raw），界面从来不读。
     * 她已经确认要清，所以这里一次性摘掉这两个字段并写回；其它字段原样保留。
     */
    function slimHistory() {
        var changed = false;

        S.history = S.history.map(function (h) {
            if (!h || typeof h !== 'object') return h;
            if (!('html' in h) && !('raw' in h) && !('log' in h)) return h;

            changed = true;
            var copy = {};
            for (var k in h) {
                if (!Object.prototype.hasOwnProperty.call(h, k)) continue;
                if (k === 'html' || k === 'raw' || k === 'log') continue;
                copy[k] = h[k];
            }
            return copy;
        });

        if (changed) dbSave(K_HISTORY, S.history);
    }

    /** 等梦角身份初始化完再读数据（keyFor 依赖 SESSION_ID） */
    function loadAfterReady() {
        var tries = 0;

        (function attempt() {
            var kp = keyFor(K_PICKED), kh = keyFor(K_HISTORY);
            if ((!kp || !kh) && tries++ < 40) { setTimeout(attempt, 250); return; }
            if (!kp || !kh) return;

            migrateOldKeys(kp, kh).then(function () {
                return Promise.all([localforage.getItem(kp), localforage.getItem(kh)]);
            }).then(function (r) {
                // 只在确有数据时覆盖，避免启动加载晚于一次提交时把刚写入的冲掉
                if (Array.isArray(r[0]) && r[0].length) S.picked = r[0];
                if (Array.isArray(r[1]) && r[1].length) S.history = r[1];

                invalidateRegistry();
                slimHistory();
            }).catch(function () { });
        })();
    }

    function boot() {
        if (_booted) return;
        _booted = true;

        try { injectStyle(); } catch (e) { console.warn('[mj-pick] 样式注入失败', e); }
        try { injectSettings(); } catch (e) { }
        try { injectEntry(); } catch (e) { }
        try { bindEntry(); } catch (e) { console.warn('[mj-pick] 入口绑定失败', e); }
        try { bindSettings(); } catch (e) { console.warn('[mj-pick] 设置绑定失败', e); }
        try { paintSettings(); } catch (e) { }

        // 站点可能还在渲染：没注上就再试几次
        var tries = 0;
        (function retry() {
            var okS = injectSettings();
            var okE = injectEntry();
            if (okS && okE) { paintSettings(); return; }
            if (tries++ >= 12) return;
            setTimeout(retry, 300);
        })();

        // 设置面板每次打开都要重新刷（上游会重绘）
        setTimeout(function () { try { paintSettings(); } catch (e) { } }, 1200);

        loadAfterReady();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
        setTimeout(boot, 1500);      // 兜底：万一 DOMContentLoaded 已经错过
    } else {
        boot();
    }

    // 供调试与自测
    window._mjp = {
        open: open,
        state: S,
        parse: parseDialogue,
        split: splitSentences,
        clean: cleanText,
        roll: roll,
        thinkWindow: thinkWindow,
        pickCards: pickCards,
        will: WILL
    };
})();
