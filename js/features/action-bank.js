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

    /* 2026-11-17 挪到文件作用域：全量导入面板（reply-library.js）和字卡转动作
       向导也要用同一套归一化/合并逻辑，原来闭在 _renderBankTab 里够不着。 */
    function _normAct(x) {
        return { n: x.n, e: x.e || '', him: (x.him || []).slice(), me: (x.me || []).slice() };
    }

    /* 追加合并：按名字判断，重名保留现有；返回 {list, added} */
    function _mergeActs(cur, incoming) {
        var seen = {};
        for (var i = 0; i < cur.length; i++) seen[cur[i].n] = true;
        var added = 0;
        for (var j = 0; j < incoming.length; j++) {
            if (!incoming[j] || !incoming[j].n || seen[incoming[j].n]) continue;
            cur.push(_normAct(incoming[j]));
            seen[incoming[j].n] = true;
            added++;
        }
        return { list: cur, added: added };
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
            '</div>' +
            /* 2026-11-17 雨霏定：单独导出/导入动作卡片 + 动作专属云同步（独立通道） */
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:-6px 0 14px;">' +
                '<button id="ab-export" style="padding:8px 13px;border:1.5px solid var(--border-color);border-radius:11px;background:none;color:var(--text-secondary);font-size:12px;cursor:pointer;font-family:inherit;">导出动作</button>' +
                '<button id="ab-import" style="padding:8px 13px;border:1.5px solid var(--border-color);border-radius:11px;background:none;color:var(--text-secondary);font-size:12px;cursor:pointer;font-family:inherit;">导入动作</button>' +
                '<button id="ab-cloud-push" style="padding:8px 13px;border:1.5px solid var(--border-color);border-radius:11px;background:none;color:var(--text-secondary);font-size:12px;cursor:pointer;font-family:inherit;">推送云端</button>' +
                '<button id="ab-cloud-pull" style="padding:8px 13px;border:1.5px solid var(--border-color);border-radius:11px;background:none;color:var(--text-secondary);font-size:12px;cursor:pointer;font-family:inherit;">从云端拉取</button>' +
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
                /* 2026-11-17 雨霏定：允许只写一侧（字卡转录的动作另一侧可留空），
                   两侧都空才算无效——跟 actions.js applyCustomActs 的口径一致 */
                if (!him.length && !me.length) {
                    if (typeof showNotification === 'function') showNotification('第 ' + (j + 1) + ' 个动作（' + n + '）至少要有一句文案', 'warning');
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

        /* ═══ 2026-11-17 雨霏定：单独导出/导入动作卡片 + 动作专属云同步 ═══
           弹窗复用字卡导入的 _showIOSheet（reply-library.js），导入方式
           单选文字原样：「追加」/「覆盖」，默认追加。追加按动作名字去重，
           重名的保留现有、只加新的；覆盖 = 整表替换。
           （_normAct / _mergeActs 已挪到文件作用域，全量导入面板共用） */

        function _showActsImportSheet(incoming) {
            if (typeof _showIOSheet !== 'function') {
                if (typeof showNotification === 'function') showNotification('导入界面组件没加载好，刷新页面再试', 'error');
                return;
            }
            var modules = [{
                id: '_ab_mod_acts',
                icon: (typeof ICONS !== 'undefined' && ICONS.magic) ? ICONS.magic : '💗',
                label: '动作卡片',
                data: incoming
            }];
            _showIOSheet('导入动作卡片', '文件中包含 ' + incoming.length + ' 个动作', modules,
                (typeof ICONS !== 'undefined' && ICONS.import) ? ICONS.import : '📥',
                function (selected, mode) {
                    var overwrite = mode === 'overwrite';
                    var cur = collect();          /* 跟添加/删除同一套：未保存的编辑不丢 */
                    if (!cur) return;
                    var next, note;
                    if (overwrite) {
                        next = incoming.filter(function (x) { return x && x.n; }).map(_normAct);
                        note = '覆盖';
                    } else {
                        var r = _mergeActs(cur, incoming);
                        next = r.list;
                        note = '追加' + (r.added > 0 ? '，新增 ' + r.added + ' 个' : '，没有新动作（全部重名）');
                    }
                    if (!window.Actions || !window.Actions.applyCustomActs(next)) {
                        if (typeof showNotification === 'function') showNotification('动作库没加载好，导入失败', 'warning');
                        return;
                    }
                    _save(next).then(function () {
                        if (typeof showNotification === 'function') showNotification('✓ 导入成功（' + note + '）', 'success', 3000);
                    }).catch(function () {
                        if (typeof showNotification === 'function') showNotification('已生效，但本地保存失败', 'warning');
                    });
                    _renderBankTab(list);
                }, true);
        }

        /* 导出：下载 动作卡片-日期.json */
        list.querySelector('#ab-export').addEventListener('click', function () {
            var arr = collect();
            if (!arr) return;
            var payload = { version: 1, exportedAt: new Date().toISOString(), actionActs: arr };
            var blob = new Blob(['\uFEFF' + JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            var d = new Date();
            var stamp = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
            a.href = url;
            a.download = '动作卡片-' + stamp + '.json';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
            if (typeof showNotification === 'function') showNotification('✓ 已导出 ' + arr.length + ' 个动作', 'success', 3000);
        });

        /* 导入：选 JSON 文件 → 弹「追加/覆盖」 */
        list.querySelector('#ab-import').addEventListener('click', function () {
            var inp = document.createElement('input');
            inp.type = 'file';
            inp.accept = '.json,application/json';
            inp.onchange = function () {
                var f = inp.files && inp.files[0];
                if (!f) return;
                var fr = new FileReader();
                fr.onload = function () {
                    try {
                        var data = JSON.parse(String(fr.result).replace(/^\uFEFF/, ''));
                        var inc = Array.isArray(data) ? data : data.actionActs;
                        if (!Array.isArray(inc) || !inc.length) {
                            if (typeof showNotification === 'function') showNotification('文件里没有动作数据', 'error');
                            return;
                        }
                        _showActsImportSheet(inc);
                    } catch (e) {
                        if (typeof showNotification === 'function') showNotification('文件解析失败：' + e.message, 'error');
                    }
                };
                fr.readAsText(f);
            };
            inp.click();
        });

        /* 云端连接前置检查（提示文案指向 数据与同步 面板） */
        function _cloudReady() {
            if (!(window.CloudSyncEngine && typeof window.CloudSyncEngine.pushActionActs === 'function')) {
                if (typeof showNotification === 'function') showNotification('云同步模块没加载好，刷新页面再试', 'error');
                return false;
            }
            if (!(window.CloudSync && window.CloudSync.isConnected())) {
                if (typeof showNotification === 'function') showNotification('还没连接云端，先到「数据与同步」里连接', 'warning', 4000);
                return false;
            }
            return true;
        }

        /* 推送云端：当前动作整体覆盖到云端专属文件（sync/<梦角>/action-acts.json） */
        list.querySelector('#ab-cloud-push').addEventListener('click', function () {
            if (!_cloudReady()) return;
            var arr = collect();
            if (!arr) return;
            var btn = this;
            btn.disabled = true;
            window.CloudSyncEngine.pushActionActs(arr).then(function () {
                if (typeof showNotification === 'function') showNotification('✓ 已推送到云端（' + arr.length + ' 个动作）', 'success', 3000);
            }).catch(function (e) {
                if (typeof showNotification === 'function') showNotification('推送失败：' + (e && e.message ? e.message : '未知错误'), 'error', 4000);
            }).finally(function () { btn.disabled = false; });
        });

        /* 从云端拉取：读专属文件 → 弹「追加/覆盖」 */
        list.querySelector('#ab-cloud-pull').addEventListener('click', function () {
            if (!_cloudReady()) return;
            var btn = this;
            btn.disabled = true;
            window.CloudSyncEngine.pullActionActs().then(function (inc) {
                if (!inc || !inc.length) {
                    if (typeof showNotification === 'function') showNotification('云端还没有动作数据，先在另一台设备上推送一次', 'warning', 4000);
                    return;
                }
                _showActsImportSheet(inc);
            }).catch(function (e) {
                if (typeof showNotification === 'function') showNotification('拉取失败：' + (e && e.message ? e.message : '未知错误'), 'error', 4000);
            }).finally(function () { btn.disabled = false; });
        });
    }

    /* 快捷新增（2026-11-10 雨霏定）：＋面板 / 卡内滑条 / 展开层侧栏的「＋」共用。
       追加一个动作并保存，走编辑页同一套链（applyCustomActs + _save），
       不另开 storage key —— 免得快捷口和编辑页各存一份、读的时候打架。
       入参 {n,e,him:[],me:[]}。
       2026-11-10 修（雨霏报「展开层开着要刷新才出现」）：原来返回 Promise、
       UI 刷新串在 _save 后面——IndexedDB 忙时（手机上大写入排队）要等数秒，
       三个入口全都干等。现在内存生效即返回 true、界面立刻刷新；
       写盘转后台，失败单独提醒（此时刷新页面会丢，提醒她导出备份）。 */
    window._actionBankAppend = function (act) {
        if (!act || !act.n) return false;
        var cur = [], acts = _currentActs();
        for (var i = 0; i < acts.length; i++) {
            cur.push({
                n: acts[i].n,
                e: acts[i].e || '',
                him: (acts[i].him || []).slice(),
                me: (acts[i].me || []).slice()
            });
        }
        cur.push({
            n: act.n,
            e: act.e || '',
            him: (act.him || []).slice(),
            me: (act.me || []).slice()
        });
        if (!(window.Actions && window.Actions.applyCustomActs(cur))) return false;
        _save(cur).catch(function () {
            if (typeof showNotification === 'function') {
                showNotification('动作「' + act.n + '」已加上，但本地保存失败——建议马上导出备份', 'warning');
            }
        });
        return true;
    };

    /* ═══ 2026-11-17 雨霏定：给外面用的三个口子 ═══
       1) _actionBankList：全量导出面板拿动作清单（同步返回深拷贝；没加载好返回 []）
       2) _actionBankImportBatch：全量导入面板批量写动作，mode 'append'|'overwrite'
       3) _actionBankAddTo：字卡转动作向导「加入已有动作」——往指定动作的某一侧追加文案
       都走 applyCustomActs + _save 同一条链，不另开存储。 */

    window._actionBankList = function () {
        return _currentActs().map(_normAct);
    };

    /* 返回 {total, added}；数据或动作库不合法返回 null */
    window._actionBankImportBatch = function (incoming, mode) {
        if (!Array.isArray(incoming)) return null;
        var next, added;
        if (mode === 'overwrite') {
            next = incoming.filter(function (x) { return x && x.n; }).map(_normAct);
            added = next.length;
        } else {
            var cur = _currentActs().map(_normAct);
            var r = _mergeActs(cur, incoming);
            next = r.list;
            added = r.added;
        }
        if (!(window.Actions && window.Actions.applyCustomActs(next))) return null;
        _save(next).catch(function () {
            if (typeof showNotification === 'function') {
                showNotification('动作已生效，但本地保存失败——建议马上导出备份', 'warning');
            }
        });
        return { total: next.length, added: added };
    };

    /* name=动作名；side 'him'|'me'；lines=[句子]。同句不重复加。
       找不到动作 / 一句有效文案都没有 → false；全部已存在（没加新的）→ true */
    window._actionBankAddTo = function (name, side, lines) {
        if (!name || (side !== 'him' && side !== 'me') || !Array.isArray(lines) || !lines.length) return false;
        var cur = _currentActs().map(_normAct);
        var hit = null;
        for (var i = 0; i < cur.length; i++) {
            if (cur[i].n === name) { hit = cur[i]; break; }
        }
        if (!hit) return false;
        var added = 0;
        for (var j = 0; j < lines.length; j++) {
            var s = String(lines[j] || '').trim();
            if (!s || hit[side].indexOf(s) !== -1) continue;
            hit[side].push(s);
            added++;
        }
        if (!added) return true;
        if (!(window.Actions && window.Actions.applyCustomActs(cur))) return false;
        _save(cur).catch(function () {
            if (typeof showNotification === 'function') {
                showNotification('动作「' + name + '」已更新，但本地保存失败——建议马上导出备份', 'warning');
            }
        });
        return true;
    };

    window._actionRenderBankTab = _renderBankTab;
    _load();
})();
