/* 挑选记录 · 长图导出（纯 Canvas 手绘，零外部依赖）
 * ── 把一条挑选历史画成一张可分享的竖图。
 * ── 定位：这是一份「交互记录」，不是文艺摘抄——标签（已加入/他坚持要/他让步了）才是主角，
 *    所以被拒绝的卡也照画，argue 的结果要看得见。
 *
 * 用法：
 *   var canvas = MJPickImage.draw(historyItem, { layout: 'list' | 'card', theme: 'dark' });
 *   MJPickImage.download(canvas, '挑选记录.png');
 */
(function () {
    'use strict';

    var BASE_W = 900;
    var PAD = 72;
    var TOP = 88;
    var BOTTOM = 76;

    var SERIF = '"Songti SC","STSong","Source Han Serif SC","Noto Serif CJK SC",serif';
    var SANS = '-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';

    var THEMES = {
        // 黑红：默认
        dark: {
            bg: '#0F0F12',
            panel: '#17171B',
            panelLine: '#26262C',
            ink: '#F0ECE7',
            dim: '#9B9BA4',
            faint: '#5E5E68',
            line: '#26262C',
            red: '#9E2F3D',
            redDeep: '#8E2723',
            pink: '#E07A9E'
        },
        // 暖纸：留着作为备选
        paper: {
            bg: '#FBF7F1',
            panel: '#F4EEE5',
            panelLine: '#E6DCCE',
            ink: '#2C2A27',
            dim: '#8C8378',
            faint: '#B4A899',
            line: '#E6DCCE',
            red: '#B3453C',
            redDeep: '#D8BEB4',
            pink: '#D2718F'
        }
    };

    // 红色候选：都往冷（蓝）调走、饱和度压低一档，避免正红发橘
    var REDS = {
        a: { name: 'A 冷玫红', hex: '#C63A4C' },
        b: { name: 'B 深枣红', hex: '#B23446' },
        c: { name: 'C 灰砖红', hex: '#AD3F49' },
        d: { name: 'D 暗朱红', hex: '#9E2F3D' },
        e: { name: 'E 亮莓红', hex: '#CE3F55' }
    };

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function fmtStamp(ts) {
        var d = new Date(ts || Date.now());
        return d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate()) +
            '　' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    // 不能出现在行首的标点：换行时留在上一行末尾，避免标点单独成行
    var NO_HEAD = '，。、；：？！）」』】…—～·,.;:?!)]}';

    function wrapText(ctx, text, maxWidth) {
        var out = [];
        String(text || '').split('\n').forEach(function (para) {
            if (!para) { out.push(''); return; }
            var line = '';
            for (var i = 0; i < para.length; i++) {
                var ch = para.charAt(i);
                var over = line && ctx.measureText(line + ch).width > maxWidth;
                if (over && NO_HEAD.indexOf(ch) === -1) {
                    out.push(line);
                    line = ch;
                } else {
                    line += ch;
                }
            }
            if (line) out.push(line);
        });
        return out.length ? out : [''];
    }

    // 一张卡的标签：状态在前、分组在后。argue 的结果就在这里体现。
    function chipsOf(c) {
        var chips = [];
        var kind = c.kind || (c.poke ? 'both' : 'card');
        if (c.forced) {
            chips.push({ text: '他坚持要', style: 'solid' });
        } else if (c.status === 'approved') {
            if (kind === 'poke') chips.push({ text: '只进拍一拍', style: 'line' });
            else chips.push({ text: '已加入', style: 'line' });
        } else if (c.status === 'rejected') {
            chips.push({ text: '他让步了，不加', style: 'muted' });
        } else if (c.status === 'arguing') {
            chips.push({ text: '他不接受', style: 'solid' });
        } else {
            chips.push({ text: '没处理', style: 'muted' });
        }
        if (kind === 'both' || kind === 'poke') {
            if (kind === 'both') chips.push({ text: '♡ 拍一拍', style: 'pink' });
        } else if (c.poke) {
            chips.push({ text: '♡ 拍一拍', style: 'pink' });
        }
        // 分组名属隐私，不上图（历史面板里照旧显示）
        return chips;
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    var CHIP_H = 22;
    var CHIP_GAP = 8;
    var CHIP_FONT = '500 11px ' + SANS;

    function chipWidth(ctx, text) {
        ctx.font = CHIP_FONT;
        return ctx.measureText(text).width + 20;
    }

    // 把 chips 排成若干行（宽度不够就换行），返回 [[chip,...], ...]
    function chipRows(ctx, chips, maxWidth) {
        var rows = [], cur = [], w = 0;
        chips.forEach(function (ch) {
            var cw = chipWidth(ctx, ch.text);
            if (cur.length && w + CHIP_GAP + cw > maxWidth) {
                rows.push(cur); cur = [ch]; w = cw;
            } else {
                w += (cur.length ? CHIP_GAP : 0) + cw;
                cur.push(ch);
            }
        });
        if (cur.length) rows.push(cur);
        return rows;
    }

    function drawChip(ctx, x, y, chip, T) {
        var w = chipWidth(ctx, chip.text);
        var h = CHIP_H;
        ctx.font = CHIP_FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        if (chip.style === 'solid') {
            ctx.fillStyle = T.red;
            roundRect(ctx, x, y, w, h, h / 2);
            ctx.fill();
            ctx.fillStyle = T.bg;
            ctx.fillText(chip.text, x + 10, y + h / 2 + 0.5);
        } else if (chip.style === 'line') {
            // 2px：细线在缩放/抗锯齿后会把 #9E2F3D 压暗，看上去像另一种红；
            // 加粗到 2px 才有实心像素，和左侧红条（同色）读起来一致。
            ctx.strokeStyle = T.red;
            ctx.lineWidth = 2;
            roundRect(ctx, x + 1, y + 1, w - 2, h - 2, (h - 2) / 2);
            ctx.stroke();
            ctx.fillStyle = T.red;
            ctx.fillText(chip.text, x + 10, y + h / 2 + 0.5);
        } else if (chip.style === 'pink') {
            ctx.strokeStyle = T.pink;
            ctx.lineWidth = 1;
            roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, (h - 1) / 2);
            ctx.stroke();
            ctx.fillStyle = T.pink;
            ctx.fillText(chip.text, x + 10, y + h / 2 + 0.5);
        } else if (chip.style === 'ghost') {
            ctx.fillStyle = T.redDeep;
            ctx.globalAlpha = 0.28;
            roundRect(ctx, x, y, w, h, h / 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = T.dim;
            ctx.fillText(chip.text, x + 10, y + h / 2 + 0.5);
        } else {   // muted
            ctx.strokeStyle = T.line;
            ctx.lineWidth = 1;
            roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, (h - 1) / 2);
            ctx.stroke();
            ctx.fillStyle = T.faint;
            ctx.fillText(chip.text, x + 10, y + h / 2 + 0.5);
        }
        ctx.textBaseline = 'alphabetic';
        return w;
    }

    function drawChipRows(ctx, rows, x, y, T) {
        rows.forEach(function (row, ri) {
            var cx = x;
            var cy = y + ri * (CHIP_H + CHIP_GAP);
            row.forEach(function (ch) {
                cx += drawChip(ctx, cx, cy, ch, T) + CHIP_GAP;
            });
        });
        return rows.length ? rows.length * (CHIP_H + CHIP_GAP) : 0;
    }

    function draw(item, opts) {
        item = item || {};
        opts = opts || {};
        var layout = opts.layout === 'card' ? 'card' : 'list';
        var themeName = opts.theme === 'paper' ? 'paper' : 'dark';
        var T = THEMES[themeName];
        // 支持换红：传 REDS 的键，或直接传 '#xxxxxx'
        if (opts.red) {
            var pick = REDS[opts.red];
            var shade = pick ? pick.hex : String(opts.red);
            if (/^#[0-9a-f]{6}$/i.test(shade)) {
                T = {};
                for (var k in THEMES[themeName]) T[k] = THEMES[themeName][k];
                T.red = shade;
            }
        }
        var scale = opts.scale || 2;

        // 分享用：只画留下来的卡。他不要的（连同分组名、来源文件名）都不进图，隐私优先。
        var all = (item.cards || []);
        var cards = all.filter(function (c) { return c.status === 'approved'; });
        var mc = (document.createElement('canvas')).getContext('2d');
        var blocks = [];
        var y = TOP;

        /* ── 头部 ── */
        mc.font = '500 11px ' + SANS;
        try { mc.letterSpacing = '4px'; } catch (e) { }
        blocks.push({ type: 'label', y: y, text: '挑选记录' });
        try { mc.letterSpacing = '0px'; } catch (e) { }
        y += 16 + 20;

        mc.font = '600 30px ' + SERIF;
        blocks.push({ type: 'title', y: y, text: '他这次挑了...' });
        y += 40 + 16;

        var fname = '';   // 来源文件名属隐私，不上图
        var meta = fmtStamp(item.ts) + (fname ? '　·　来自《' + fname + '》' : '');
        mc.font = '400 12.5px ' + SANS;
        blocks.push({ type: 'meta', y: y, text: meta });
        y += 18 + 30;

        blocks.push({ type: 'divider', y: y });
        y += 1 + 40;

        /* ── 卡片 ── */
        var kept = cards.length;
        var forcedN = cards.filter(function (c) { return c.forced; }).length;
        var pokeN = cards.filter(function (c) {
            var k = c.kind || (c.poke ? 'both' : 'card');
            return k === 'poke' || k === 'both';
        }).length;

        var LH = layout === 'card' ? 42 : 43;
        var FONT = '400 24px ' + SERIF;

        cards.forEach(function (c, i) {
            if (layout === 'card') {
                var padIn = 26;
                var textX = PAD + padIn;
                var textW = BASE_W - PAD * 2 - padIn * 2;
                mc.font = FONT;
                var lines = wrapText(mc, String(c.text || '').trim(), textW);
                var rows = chipRows(mc, chipsOf(c), textW);
                var bodyH = lines.length * LH;
                var chipsH = rows.length ? (12 + (rows.length - 1) * (CHIP_H + CHIP_GAP)) : 0;
                // 标签紧贴末行字底往下 17px，不留大空档
                var chipsTop = bodyH - 1;
                var h = padIn + chipsTop + chipsH + CHIP_H + padIn - 12;
                blocks.push({ type: 'cardBlock', y: y, card: c, lines: lines, rows: rows, h: h });
                y += h + 18;
            } else {
                var seqW = 46;
                var tx = PAD + seqW;
                var tw = BASE_W - PAD - tx;
                mc.font = FONT;
                var lns = wrapText(mc, String(c.text || '').trim(), tw);
                var rws = chipRows(mc, chipsOf(c), tw);
                var bh = lns.length * LH;
                var ch = rws.length ? (12 + (rws.length - 1) * (CHIP_H + CHIP_GAP)) : 0;
                blocks.push({ type: 'lineRow', y: y, card: c, lines: lns, rows: rws, seq: i + 1, bh: bh });
                y += bh + ch + (rws.length ? CHIP_H : 0) + 34;
            }
        });

        if (!cards.length) {
            mc.font = '400 15px ' + SANS;
            blocks.push({ type: 'empty', y: y, text: '这次他没有想留下的。' });
            y += 22 + 20;
        }

        /* ── 统计 ── */
        y += 14;
        blocks.push({ type: 'divider', y: y });
        y += 1 + 26;
        var stat = '挑出 ' + all.length + ' 张　·　加入 ' + kept + ' 张' +
            (forcedN ? '　·　他坚持 ' + forcedN + ' 张' : '') +
            (pokeN ? '　·　拍一拍 ' + pokeN + ' 张' : '');
        mc.font = '400 12px ' + SANS;
        blocks.push({ type: 'foot', y: y, text: stat });
        y += 18 + 26;
        y += BOTTOM;

        var H = Math.round(y);
        if (H * scale > 30000) scale = 1;

        var canvas = document.createElement('canvas');
        canvas.width = Math.round(BASE_W * scale);
        canvas.height = Math.round(H * scale);
        var ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.textBaseline = 'alphabetic';

        ctx.fillStyle = T.bg;
        ctx.fillRect(0, 0, BASE_W, H);

        blocks.forEach(function (b) {
            if (b.type === 'label') {
                ctx.font = '500 11px ' + SANS;
                ctx.fillStyle = T.red;
                ctx.textAlign = 'left';
                try { ctx.letterSpacing = '4px'; } catch (e) { }
                ctx.fillText(b.text, PAD, b.y + 12);
                try { ctx.letterSpacing = '0px'; } catch (e) { }
            } else if (b.type === 'title') {
                ctx.font = '600 30px ' + SERIF;
                ctx.fillStyle = T.ink;
                ctx.textAlign = 'left';
                ctx.fillText(b.text, PAD, b.y + 30);
            } else if (b.type === 'meta') {
                ctx.font = '400 12.5px ' + SANS;
                ctx.fillStyle = T.dim;
                ctx.textAlign = 'left';
                ctx.fillText(b.text, PAD, b.y + 13);
            } else if (b.type === 'divider') {
                ctx.strokeStyle = T.line;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(PAD, b.y + 0.5);
                ctx.lineTo(BASE_W - PAD, b.y + 0.5);
                ctx.stroke();
            } else if (b.type === 'cardBlock') {
                drawCardBlock(ctx, b, T, layout, LH);
            } else if (b.type === 'lineRow') {
                drawLineRow(ctx, b, T, LH);
            } else if (b.type === 'empty') {
                ctx.font = '400 15px ' + SANS;
                ctx.fillStyle = T.faint;
                ctx.textAlign = 'left';
                ctx.fillText(b.text, PAD, b.y + 16);
            } else if (b.type === 'foot') {
                ctx.font = '400 12px ' + SANS;
                ctx.fillStyle = T.dim;
                ctx.textAlign = 'left';
                ctx.fillText(b.text, PAD, b.y + 13);
            }
        });

        return canvas;
    }

    // 卡牌版：每张卡一个面板，左侧红条表示「留下了」，被拒绝的不给红条
    function drawCardBlock(ctx, b, T, layout, LH) {
        var padIn = 26;
        ctx.fillStyle = T.panel;
        roundRect(ctx, PAD, b.y, BASE_W - PAD * 2, b.h, 16);
        ctx.fill();

        var kept = b.card.status === 'approved';
        if (kept) {
            ctx.fillStyle = T.red;
            roundRect(ctx, PAD, b.y + 18, 3, b.h - 36, 2);
            ctx.fill();
        }

        var textX = PAD + padIn;
        var textW = BASE_W - PAD * 2 - padIn * 2;
        ctx.font = '400 24px ' + SERIF;
        ctx.fillStyle = kept ? T.ink : T.dim;
        ctx.textAlign = 'left';
        b.lines.forEach(function (ln, i) {
            ctx.fillText(ln, textX, b.y + padIn + 24 + i * LH);
        });

        var chipsY = b.y + padIn + b.lines.length * LH - 1;
        drawChipRows(ctx, b.rows, textX, chipsY, T);
    }

    // 清单版：编号 + 正文 + 下方标签
    function drawLineRow(ctx, b, T, LH) {
        var seqW = 46;
        var tx = PAD + seqW;
        var kept = b.card.status === 'approved';

        ctx.font = '500 12px ' + SANS;
        ctx.fillStyle = kept ? T.red : T.faint;
        ctx.textAlign = 'left';
        ctx.fillText(pad2(b.seq), PAD, b.y + 26);

        ctx.font = '400 24px ' + SERIF;
        ctx.fillStyle = kept ? T.ink : T.dim;
        b.lines.forEach(function (ln, i) {
            ctx.fillText(ln, tx, b.y + 26 + i * LH);
        });

        var chipsY = b.y + b.lines.length * LH + 12;
        drawChipRows(ctx, b.rows, tx, chipsY, T);
    }

    function download(canvas, name) {
        var fname = name || ('挑选记录-' + Date.now() + '.png');
        canvas.toBlob(function (blob) {
            if (!blob) return;
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = fname;
            document.body.appendChild(a);
            a.click();
            setTimeout(function () {
                URL.revokeObjectURL(a.href);
                a.remove();
            }, 4000);
        }, 'image/png');
    }

    window.MJPickImage = { draw: draw, download: download };
})();
