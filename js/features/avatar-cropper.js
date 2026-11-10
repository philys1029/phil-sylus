/* 头像手动裁剪（2026-11-10 雨霏定 Q2-A：圆形取景框 + 拖动移位 + 滑杆/滚轮/双指缩放）
   原来的 cropImageToSquare（utils.js）是自动居中切方形，构图没法选；这个让人自己选。
   输出 size×size 的方图——站里头像显示处本来就是圆的，方形带全部像素更保险。
   用法：window.AvatarCropper.open(file, { size: 512 }) → Promise<base64>；点取消 reject('cancel')。 */
(function () {
  'use strict';

  var MAX_ZOOM = 6;

  /* 缩小下限不写死 1：按图的长宽比算，刚好能让整张图进圆框（长边贴圆直径）。
     正方形图仍是 1（再小只会露底），竖图/横图可以缩到 0.5 上下，看全整张再选。 */
  function fitZoomOf(nw, nh) {
    return Math.min(1, Math.min(nw, nh) / Math.max(nw, nh));
  }

  var BACKDROP = '#161616';   // 缩到露底时的底色，与取景器底色一致

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function injectStyle() {
    if (document.getElementById('avc-style')) return;
    var st = document.createElement('style');
    st.id = 'avc-style';
    st.textContent = [
      '.avc-mask{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.86);',
      'display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;',
      '-webkit-user-select:none;user-select:none;}',
      '.avc-panel{width:100%;max-width:380px;display:flex;flex-direction:column;align-items:center;gap:16px;}',
      '.avc-title{color:#fff;font-size:15px;letter-spacing:.06em;opacity:.9;}',
      '.avc-view{position:relative;border-radius:50%;overflow:hidden;background:#161616;',
      'box-shadow:0 0 0 1px rgba(255,255,255,.16),0 12px 40px rgba(0,0,0,.45);',
      'touch-action:none;cursor:grab;}',
      '.avc-view:active{cursor:grabbing;}',
      '.avc-view canvas{display:block;width:100%;height:100%;}',
      '.avc-zoom{display:flex;align-items:center;gap:10px;color:#fff;width:100%;}',
      '.avc-zoom input[type=range]{flex:1;accent-color:#c5a47e;height:2px;}',
      '.avc-tip{color:rgba(255,255,255,.48);font-size:12px;letter-spacing:.02em;}',
      '.avc-btns{display:flex;gap:12px;width:100%;}',
      '.avc-btns button{flex:1;padding:11px 0;border-radius:12px;border:none;font-size:14px;',
      'cursor:pointer;font-family:inherit;transition:opacity .15s;}',
      '.avc-btns button:active{opacity:.75;}',
      '.avc-cancel{background:rgba(255,255,255,.12);color:#fff;}',
      '.avc-ok{background:#c5a47e;color:#231a12;font-weight:600;}'
    ].join('');
    document.head.appendChild(st);
  }

  function open(file, opts) {
    opts = opts || {};
    var outSize = opts.size || 512;
    injectStyle();

    return new Promise(function (resolve, reject) {
      var objUrl = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { build(); };
      img.onerror = function () { URL.revokeObjectURL(objUrl); reject(new Error('decode')); };
      img.src = objUrl;

      function build() {
        var viewport = window.innerWidth || 375;
        var viewportH = window.innerHeight || 667;
        var D = Math.floor(Math.min(viewport - 96, 300, viewportH * 0.46));
        if (D < 140) D = 140;

        var stage = document.createElement('div');
        stage.className = 'avc-mask';
        stage.innerHTML =
          '<div class="avc-panel">' +
            '<div class="avc-title">调整头像</div>' +
            '<div class="avc-view" style="width:' + D + 'px;height:' + D + 'px;"><canvas></canvas></div>' +
            '<div class="avc-zoom"><span style="font-size:13px;opacity:.7">－</span>' +
              '<input type="range" min="1" max="' + MAX_ZOOM + '" step="0.01" value="1">' +
              '<span style="font-size:13px;opacity:.7">＋</span></div>' +
            '<div class="avc-tip">拖动调整位置 · 双指或滑杆缩放</div>' +
            '<div class="avc-btns">' +
              '<button type="button" class="avc-cancel">取消</button>' +
              '<button type="button" class="avc-ok">确定</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(stage);

        var view = stage.querySelector('.avc-view');
        var cvs = view.querySelector('canvas');
        var ctx = cvs.getContext('2d');
        var slider = stage.querySelector('input[type=range]');
        var dpr = Math.min(window.devicePixelRatio || 1, 2);

        var naturalW = img.naturalWidth || img.width;
        var naturalH = img.naturalHeight || img.height;
        var baseScale = D / Math.min(naturalW, naturalH);   // cover：短边先填满圆
        var minZoom = fitZoomOf(naturalW, naturalH);
        var zoom = 1;
        var offsetX = 0;
        var offsetY = 0;

        slider.min = String(minZoom);
        slider.value = '1';

        cvs.width = Math.round(D * dpr);
        cvs.height = Math.round(D * dpr);

        function scaledW() { return naturalW * baseScale * zoom; }
        function scaledH() { return naturalH * baseScale * zoom; }

        function clampOffsets() {
          var maxX = Math.max(0, (scaledW() - D) / 2);
          var maxY = Math.max(0, (scaledH() - D) / 2);
          offsetX = clamp(offsetX, -maxX, maxX);
          offsetY = clamp(offsetY, -maxY, maxY);
        }

        function draw() {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, D, D);
          ctx.fillStyle = BACKDROP;
          ctx.fillRect(0, 0, D, D);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          var w = scaledW();
          var h = scaledH();
          ctx.drawImage(img, (D - w) / 2 + offsetX, (D - h) / 2 + offsetY, w, h);
        }

        function exportBase64() {
          var out = document.createElement('canvas');
          out.width = outSize;
          out.height = outSize;
          var ox = out.getContext('2d');
          var k = outSize / D;
          ox.fillStyle = BACKDROP;
          ox.fillRect(0, 0, outSize, outSize);
          var w = scaledW() * k;
          var h = scaledH() * k;
          ox.imageSmoothingEnabled = true;
          ox.imageSmoothingQuality = 'high';
          ox.drawImage(img, (outSize - w) / 2 + offsetX * k, (outSize - h) / 2 + offsetY * k, w, h);
          return out.toDataURL('image/jpeg', 0.92);
        }

        /* 指针：单指拖动 / 双指捏合缩放（鼠标 + 触摸统一走 pointer 事件） */
        var pointers = {};
        var dragRef = null;
        var pinchRef = null;

        function rel(e) {
          var r = view.getBoundingClientRect();
          return { x: e.clientX - r.left, y: e.clientY - r.top };
        }
        function ids() { return Object.keys(pointers); }
        function pinchDist() {
          var k = ids();
          if (k.length < 2) return 0;
          var a = pointers[k[0]];
          var b = pointers[k[1]];
          return Math.hypot(a.x - b.x, a.y - b.y);
        }

        view.addEventListener('pointerdown', function (e) {
          try { view.setPointerCapture(e.pointerId); } catch (err) {}
          pointers[e.pointerId] = rel(e);
          var k = ids();
          if (k.length === 1) {
            dragRef = { p: pointers[k[0]], ox: offsetX, oy: offsetY };
            pinchRef = null;
          } else if (k.length === 2) {
            pinchRef = { d: Math.max(1, pinchDist()), zoom: zoom };
            dragRef = null;
          }
        });

        view.addEventListener('pointermove', function (e) {
          if (!pointers[e.pointerId]) return;
          pointers[e.pointerId] = rel(e);
          var k = ids();
          if (k.length >= 2 && pinchRef) {
            zoom = clamp(pinchRef.zoom * (pinchDist() / pinchRef.d), minZoom, MAX_ZOOM);
            slider.value = zoom;
            clampOffsets();
            draw();
          } else if (dragRef) {
            offsetX = dragRef.ox + (pointers[e.pointerId].x - dragRef.p.x);
            offsetY = dragRef.oy + (pointers[e.pointerId].y - dragRef.p.y);
            clampOffsets();
            draw();
          }
        });

        function endPointer(e) {
          if (!pointers[e.pointerId]) return;
          delete pointers[e.pointerId];
          var k = ids();
          if (k.length === 1) {
            dragRef = { p: pointers[k[0]], ox: offsetX, oy: offsetY };
            pinchRef = null;
          } else if (k.length === 0) {
            dragRef = null;
            pinchRef = null;
          }
        }
        view.addEventListener('pointerup', endPointer);
        view.addEventListener('pointercancel', endPointer);

        view.addEventListener('wheel', function (e) {
          e.preventDefault();
          zoom = clamp(zoom - e.deltaY * 0.0016, minZoom, MAX_ZOOM);
          slider.value = zoom;
          clampOffsets();
          draw();
        }, { passive: false });

        slider.addEventListener('input', function () {
          zoom = clamp(parseFloat(slider.value) || 1, minZoom, MAX_ZOOM);
          clampOffsets();
          draw();
        });

        function close() {
          document.removeEventListener('keydown', onKey);
          if (stage.parentNode) stage.parentNode.removeChild(stage);
          URL.revokeObjectURL(objUrl);
        }
        function onKey(e) { if (e.key === 'Escape') { close(); reject(new Error('cancel')); } }

        stage.querySelector('.avc-cancel').addEventListener('click', function () {
          close();
          reject(new Error('cancel'));
        });
        stage.querySelector('.avc-ok').addEventListener('click', function () {
          var data = exportBase64();
          close();
          resolve(data);
        });
        document.addEventListener('keydown', onKey);

        draw();
      }
    });
  }

  window.AvatarCropper = { open: open };
})();
