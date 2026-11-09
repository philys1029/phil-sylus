/* ═════════════════════════════════════════════════════════════
   ④ 动作库编辑页（回复库 → 氛围感 → 动作）
   已定清单 §9（5-1~5-4，2026-11-08 雨霏定案）：
     5-1 一个动作多条文案（他做/你做各若干句，一行一句）
     5-2 动作数量无上限（可增删，发动作处自动分页）
     5-3 每个动作配 emoji（挑选）
     5-4 归【自定义回复】板块；导出/云备份跟该板块规则一致；
         老存档兼容——旧格式 {n?,him:'一句',me:'一句'} 由 actions.js
         normalizeAct 归一化，本页读写都用新格式数组。

   架构照问卷题库 / 红包留言库：reply-library.js 把整个 list 交给
   window._actionRenderBankTab(list) 自己渲染。
   存 localforage，按 SESSION_ID 隔离（key 取法照 survey.js:71-90）。
   Actions.applyCustomActs() 原地替换数组内容，改完同框卡 / 幕内 /
   picker / 展开层即时生效。
   ═════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var _storageKey = null;

    function _waitForSessionId(maxWaitMs) {
        return new Promise(function (resolve) {
            var waited = 0;
            (function check() {
                if ((typeof SESSION_ID !== 'undefined' && SESSION_ID) || waited >= maxWaitMs) {
                    resolve();
                } else {
                    waited += 100;
                    setTimeout(check, 100);
                }
            })();
        });
    }

    function _getKey() {
        if (_storageKey) return Promise.resolve(_storageKey);
        return _waitForSessionId(5000).then(function () {
            var properKey = null;
            try {
                if (typeof SESSION_ID !== 'undefined' && SESSION_ID && typeof window.getStorageKey === 'function') {
                    properKey = window.getStorageKey('actionActs');
                }
            } catch (e) { /* SESSION_ID 可能还没初始化 */ }
            if (properKey) { _storageKey = properKey; return properKey; }
            try {
                return localforage.keys().then(function (allKeys) {
                    var found = allKeys.find(function (k) { return k.indexOf('_actionActs') !== -1; });
                    if (found) return found;
                    var msgKey = allKeys.find(function (k) { return k.indexOf('_chatMessages') !== -1; });
                    var prefix = msgKey ? msgKey.replace('_chatMessages', '') : 'CHAT_APP_V3_';
                    return prefix + '_actionActs';
                });
            } catch (e) {
                return 'CHAT_APP_V3__actionActs';
            }
        });
    }

    function _load() {
        if (typeof localforage === 'undefined' || !window.Actions) return;
        _getKey().then(function (key) {
            return localforage.getItem(key);
        }).then(function (saved) {
            /* 老存档（旧格式字符串）也交给 applyCustomActs，normalizeAct 会归一化 */
            if (saved && Array.isArray(saved) && typeof window.Actions.applyCustomActs === 'function') {
                window.Actions.applyCustomActs(saved);
            }
        }).catch(function () { /* 没有存档 = 用默认动作，正常 */ });
    }

    function _save(arr) {
        return _getKey().then(function (key) { return localforage.setItem(key, arr); });
    }

    function _clear() {
        return _getKey().then(function (key) { return localforage.removeItem(key); });
    }

    function _currentActs() {
        if (window.Actions && window.Actions.ACTS && window.Actions.ACTS.length) return window.Actions.ACTS;
        return [];
    }

    function _esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /* 数组 → 多行文本（一行一句），供 textarea 显示 */
    function _toLines(arr) { return (arr || []).join('\n'); }
    /* 多行文本 → 数组（一行一句，去空行） */
    function _fromLines(t) {
        return String(t).split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    }

    function _renderBankTab(list) {
        var acts = _currentActs();
        if (!acts.length) {
            list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-secondary);font-size:13px;">动作库还没加载好，关掉重开一下</div>';
            return;
        }

        var head =
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px;">' +
                '<div>' +
                    '<div style="font-size:15px;font-weight:700;color:var(--text-primary);">动作文案</div>' +
                    '<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;line-height:1.6;">' +
                        '共 <b id="ab-count">' + acts.length + '</b> 个动作。每个动作：名字、emoji、他做/你做各若干句（<b>一行一句</b>，可写多句，发动作时挑一条）。' +
                        '动作数量不限，可加可删；改完点保存，聊天、幕布、动作面板立即生效。</div>' +
                '</div>' +
                '<div style="display:flex;gap:8px;flex-shrink:0;">' +
                    '<button id="ab-restore" style="padding:9px 14px;border:1.5px solid var(--border-color);border-radius:11px;background:none;color:var(--text-secondary);font-size:12px;cursor:pointer;font-family:inherit;">恢复默认</button>' +
                    '<button id="ab-add" style="padding:9px 14px;border:1.5px solid var(--border-color);border-radius:11px;background:none;color:var(--text-primary);font-size:12px;cursor:pointer;font-family:inherit;">＋ 添加动作</button>' +
                    '<button id="ab-save" style="padding:9px 18px;border:none;border-radius:11px;background:var(--accent-color);color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">保存</button>' +
                '</div>' +
            '</div>';

        var rows = '';
        for (var i = 0; i < acts.length; i++) {
            rows +=
                '<div class="ab-row" data-idx="' + i + '" style="background:var(--primary-bg);border:1px solid var(--border-color);border-radius:14px;padding:12px 14px;margin-bottom:10px;">' +
                    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:9px;">' +
                        '<span style="display:inline-block;min-width:22px;color:var(--accent-color);font-size:13px;font-weight:700;">' + (i + 1) + '</span>' +
                        '<input class="ab-e" data-idx="' + i + '" maxlength="4" placeholder="💗" value="' + _esc(acts[i].e || '') + '" style="width:44px;text-align:center;padding:6px 4px;border:1px solid var(--border-color);border-radius:9px;background:var(--secondary-bg);color:var(--text-primary);font-size:15px;font-family:inherit;outline:none;">' +
                        '<input class="ab-n" data-idx="' + i + '" maxlength="10" placeholder="动作名" value="' + _esc(acts[i].n || '') + '" style="flex:1;min-width:0;padding:6px 10px;border:1px solid var(--border-color);border-radius:9px;background:var(--secondary-bg);color:var(--text-primary);font-size:13px;font-weight:700;font-family:inherit;outline:none;">' +
                        '<button class="ab-del" data-idx="' + i + '" title="删除这个动作" style="flex:0 0 auto;width:30px;height:30px;border:1px solid var(--border-color);border-radius:9px;background:none;color:var(--text-secondary);font-size:15px;cursor:pointer;font-family:inherit;">×</button>' +
                    '</div>' +
                    '<label style="display:block;font-size:11px;color:var(--text-secondary);margin-bottom:4px;">他做（一行一句）</label>' +
                    '<textarea class="ab-him" data-idx="' + i + '" rows="' + Math.max(2, (acts[i].him || []).length) + '" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border-color);border-radius:9px;background:var(--secondary-bg);color:var(--text-primary);font-size:12px;line-height:1.6;font-family:inherit;resize:vertical;outline:none;"></textarea>' +
                    '<label style="display:block;font-size:11px;color:var(--text-secondary);margin:8px 0 4px;">你做（一行一句）</label>' +
                    '<textarea class="ab-me" data-idx="' + i + '" rows="' + Math.max(2, (acts[i].me || []).length) + '" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border-color);border-radius:9px;background:var(--secondary-bg);color:var(--text-primary);font-size:12px;line-height:1.6;font-family:inherit;resize:vertical;outline:none;"></textarea>' +
                '</div>';
        }

        list.innerHTML = '<div id="action-bank-list" style="padding:0 2px 40px;">' + head + rows +
            '<button id="ab-add2" style="width:100%;padding:12px 0;border:1.5px dashed var(--border-color);border-radius:12px;background:none;color:var(--text-secondary);font-size:13px;cursor:pointer;font-family:inherit;">＋ 添加动作</button>' +
            '</div>';

        /* 用 value 写入，不把用户文案拼进 HTML */
        var rows2 = list.querySelectorAll('.ab-row');
        function rowAt(el) {
            var i = parseInt(el.getAttribute('data-idx'), 10);
            return list.querySelectorAll('.ab-row')[i];
        }
        for (var k = 0; k < rows2.length; k++) {
            var a = acts[k];
            rows2[k].querySelector('.ab-him').value = _toLines(a.him);
            rows2[k].querySelector('.ab-me').value = _toLines(a.me);
        }

        function collect() {
            var arr = [];
            var rs = list.querySelectorAll('.ab-row');
            for (var j = 0; j < rs.length; j++) {
                var n = rs[j].querySelector('.ab-n').value.trim();
                var e = rs[j].querySelector('.ab-e').value.trim();
                var him = _fromLines(rs[j].querySelector('.ab-him').value);
                var me = _fromLines(rs[j].querySelector('.ab-me').value);
                if (!n) {
                    if (typeof showNotification === 'function') showNotification('第 ' + (j + 1) + ' 个动作还没有名字', 'warning');
                    return null;
                }
                if (!him.length || !me.length) {
                    if (typeof showNotification === 'function') showNotification('第 ' + (j + 1) + ' 个动作（' + n + '）他做/你做至少各要一句', 'warning');
                    return null;
                }
                arr.push({ n: n, e: e, him: him, me: me });
            }
            return arr;
        }

        /* 收集当前 UI → 生效 + 存档（新增/保存共用） */
        function commit(arr, okMsg) {
            if (!window.Actions || !window.Actions.applyCustomActs(arr)) {
                if (typeof showNotification === 'function') showNotification('保存失败，动作库没加载好', 'warning');
                return;
            }
            _save(arr).then(function () {
                if (typeof showNotification === 'function') showNotification(okMsg, 'success');
            }).catch(function () {
                if (typeof showNotification === 'function') showNotification('已生效，但本地保存失败', 'warning');
            });
        }

        /* 加一行（保存时统一收集，未保存的编辑不丢） */
        function addRow() {
            var cur = collect();
            if (!cur) return;
            cur.push({ n: '新动作', e: '💗', him: ['（他做的一句）'], me: ['（你做的一句）'] });
            if (window.Actions && window.Actions.applyCustomActs(cur)) _renderBankTab(list);
        }

        list.querySelector('#ab-save').addEventListener('click', function () {
            var arr = collect();
            if (!arr) return;
            commit(arr, '✓ 动作文案已保存');
        });

        var addBtns = [list.querySelector('#ab-add'), list.querySelector('#ab-add2')];
        for (var b = 0; b < addBtns.length; b++) {
            if (addBtns[b]) addBtns[b].addEventListener('click', addRow);
        }

        var dels = list.querySelectorAll('.ab-del');
        for (var d = 0; d < dels.length; d++) (function (btn) {
            btn.addEventListener('click', function () {
                var cur = collect();
                if (!cur) return;
                if (cur.length <= 1) {
                    if (typeof showNotification === 'function') showNotification('至少要留一个动作', 'warning');
                    return;
                }
                var idx = parseInt(btn.getAttribute('data-idx'), 10);
                cur.splice(idx, 1);
                /* 2026-11-08 修：原来只 commit 不重绘——内存里 ACTS 已经少了，
                   页面上这一行却还在；再点保存会把删掉的动作按旧 DOM 收回来。
                   这里删完立刻按新数组重画（重画会重新绑定所有按钮）。 */
                if (window.Actions && window.Actions.applyCustomActs(cur)) {
                    _save(cur).catch(function () {});
                    _renderBankTab(list);
                    if (typeof showNotification === 'function') showNotification('✓ 已删除这个动作', 'success');
                } else {
                    if (typeof showNotification === 'function') showNotification('删除失败，动作库没加载好', 'warning');
                }
            });
        })(dels[d]);

        list.querySelector('#ab-restore').addEventListener('click', function () {
            var def = (window.Actions && window.Actions.defaultActs) ? window.Actions.defaultActs() : [];
            if (!def.length) return;
            commit(def, '✓ 已恢复默认 32 句');
            _clear().catch(function () {});
            _renderBankTab(list);
        });
    }

    window._actionRenderBankTab = _renderBankTab;
    _load();
})();
