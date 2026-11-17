/* ═══════════════════════════════════════════════════════════════
   动作系统 · 幕布层（actions.js）
   视觉从 幕布-预览/film.html（两幕连演定稿）原样移植：
   第一幕 11.2s（播到全黑）→ 第二幕 7.7s（animation-delay:-1.3s 跳过承接段）
   → 动作面板升起（约 17.9–18.6s）→ 停住。
   所有 keyframes 加 mu- 前缀、样式收在 #curtain-overlay 下，
   动画数值与 film.html 一处未改（撞名检查 2026-11-07：css/ 目录无同名）。

   对外接口（core.js 调用）：
     Actions.getCurtainCardText()  → 清场卡的认卡文本
     Actions.onCurtainCardSent()   → 清场卡发出后调用：收"正在输入" + 拉幕布
     Actions.raiseCurtain()        → 直接拉幕布
     Actions.buildPanel(opts)      → 共用动作面板（幕布 / 同框卡展开层共用，②共用组件 2026-11-08）
     Actions.ACTION_NAMES          → 16 个动作名（a1–a16 顺序，与面板原型、暗点专线档案一致）

   幕内（live.html 原样）：两幕开场 18.9s → 面板 B 停住 → 转 live 界面（景深动作区 +
   金线滚轴 + 4×2 可点面板 + 小海星）；他先动，你点动作后他 1.8–3.0s 回应。
   【放过她】= 他的结束键（和全部 him 文案同库等概率，摸到即散场）；【小海星】= 她的退出键（安全词）。
   两个退出**都走 B 合幕、都落清场留痕**（2026-11-08 雨霏：清场文案跟谁结束没关系）。
   幕内动作只在幕内滚，不落聊天同框卡。
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* 清场卡：字卡池里认这段文本。不进「通用字卡」组 → 熔断白名单自动挡掉。 */
  var CURTAIN_CARD_TEXT = '清场';

  var T1 = 11200;   // 第一幕时长（播到全黑）
  var T2 = 7700;    // 第二幕可见时长（9s - 1.3s 承接段跳过）
  var AFTER_PANEL = 400; // 面板升起到位后留的余量，再开放退出

  var _overlay = null;
  var _canExit = false;

  var STYLE =
    '#curtain-overlay{position:fixed;inset:0;z-index:999999;background:#070605;' +
      'opacity:1;transition:opacity .8s ease;font-family:"Noto Serif SC",serif}' +
    '#curtain-overlay.mu-fading{opacity:0}' +
    /* ── 退场 B · 合幕（2026-11-08 雨霏定）──
       左右两片黑幕向中间合拢 → 中缝亮一道金线 → 两句文案居中压在金线上（十字交叉）→
       合死 → 文案与金线同时淡去 → 0.4s 黑场 → 聊天浮现 0.5s。
       层序（DOM 顺序即层序）：幕布 < 金线 < 文案，所以线从字后穿过、字压着线。 */
    '#curtain-overlay .mu-shut{position:absolute;inset:0;z-index:30;pointer-events:none}' +
    '#curtain-overlay .mu-shut-l,#curtain-overlay .mu-shut-r{position:absolute;top:0;bottom:0;width:50.4%;' +
      'background:#070605;will-change:transform}' +
    '#curtain-overlay .mu-shut-l{left:0;transform:translateX(-101%);' +
      'animation:mu-shut-l 1.6s cubic-bezier(.4,0,.3,1) 1.5s forwards}' +
    '#curtain-overlay .mu-shut-r{right:0;transform:translateX(101%);' +
      'animation:mu-shut-r 1.6s cubic-bezier(.4,0,.3,1) 1.5s forwards}' +
    '@keyframes mu-shut-l{from{transform:translateX(-101%)}to{transform:translateX(0)}}' +
    '@keyframes mu-shut-r{from{transform:translateX(101%)}to{transform:translateX(0)}}' +
    '#curtain-overlay .mu-shut-line{position:absolute;left:50%;top:10%;height:80%;width:1px;margin-left:-0.5px;' +
      'background:linear-gradient(180deg,transparent,#c5a47e 16%,#c5a47e 84%,transparent);' +
      'transform-origin:50% 50%;opacity:0;' +
      'animation:mu-shut-line .7s ease 2.2s forwards,mu-shut-line-out 1.4s ease 2.9s forwards}' +
    '@keyframes mu-shut-line{from{opacity:0;transform:scaleY(.45)}to{opacity:.9;transform:scaleY(1)}}' +
    '@keyframes mu-shut-line-out{from{opacity:.9}to{opacity:0}}' +
    '#curtain-overlay .mu-shut-txt{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
      'padding:0 10%;text-align:center;font-size:14px;line-height:1.95;letter-spacing:2px;color:#efe5d5;' +
      'font-family:"Noto Serif SC",serif;white-space:nowrap;' +   /* 一句一行硬断，禁止自动折行 */
      'opacity:0;animation:mu-shut-txt 1s ease forwards}' +
    '#curtain-overlay .mu-shut-txt.safe{font-size:16px;letter-spacing:8px;padding:0}' +
    '@keyframes mu-shut-txt{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}' +
    '#curtain-overlay .mu-frame{position:absolute;inset:0;overflow:hidden;background:#070605}' +
    '#curtain-overlay #mu-act1,#curtain-overlay #mu-act2{position:absolute;inset:0}' +
    '#curtain-overlay #mu-act1 *{animation-iteration-count:1!important}' +
    '#curtain-overlay #mu-act2 .a{animation-iteration-count:1!important}' +

    /* ── 第一幕（film.html 原样）── */
    '#curtain-overlay .stage{animation:mu-screen-shake var(--mu-dur) linear infinite both;' +
      'position:absolute;inset:0;display:flex;flex-direction:column}' +
    '#curtain-overlay .hair{height:1px;background:var(--mu-hair);animation:mu-hair-fade var(--mu-dur) ease-out infinite both}' +
    '#curtain-overlay .hair.top{margin:26px 30px 0}' +
    '#curtain-overlay .hair.bot{margin:0 30px 26px}' +
    '#curtain-overlay .mid{flex:1;position:relative}' +
    '#curtain-overlay .dot{animation:mu-flicker var(--mu-dur) linear infinite both;position:absolute;' +
      'top:36%;left:50%;width:5px;height:5px;margin-left:-2.5px;border-radius:50%;background:var(--mu-gold)}' +
    '#curtain-overlay .title{animation:mu-title-land var(--mu-dur) cubic-bezier(.4,.05,.8,.55) infinite both;' +
      'position:absolute;top:41%;left:0;right:0;text-align:center;font-family:"Songti SC",serif;' +
      'font-size:32px;color:var(--mu-ink);white-space:nowrap}' +
    '#curtain-overlay .sub{animation:mu-second-line var(--mu-dur) ease-out infinite both;' +
      'position:absolute;top:56%;left:0;right:0;text-align:center;font-family:"Songti SC",serif;' +
      'font-size:14px;line-height:2.3;letter-spacing:3px;color:var(--mu-ink-soft)}' +
    '#curtain-overlay .seal-row{padding-bottom:24px;text-align:center}' +
    '#curtain-overlay .seal{animation:mu-seal-in var(--mu-dur) ease-out infinite both;' +
      'font-size:11px;color:var(--mu-seal)}' +
    '#curtain-overlay .blackout{animation:mu-blackout var(--mu-dur) ease-out infinite both;' +
      'position:absolute;inset:0;background:#000;pointer-events:none}' +

    /* ── 第二幕 keyframes（原文，未改）── */
    '@keyframes mu-gone{0%,8.5%{opacity:1}14.5%,100%{opacity:0}}' +
    '@keyframes mu-hd{0%,17.5%{opacity:0;transform:translateY(6px)}20.5%{opacity:1;transform:translateY(0)}63%{opacity:1}68%,100%{opacity:0}}' +
    '@keyframes mu-ln{0%,18.5%{transform:scaleX(0)}23%{transform:scaleX(1)}63%{opacity:1}68%,100%{opacity:0}}' +
    '@keyframes mu-l1{0%,21.5%{opacity:0;transform:translateY(8px)}24.5%{opacity:1;transform:translateY(0)}63%{opacity:1}68%,100%{opacity:0}}' +
    '@keyframes mu-l2{0%,25%{opacity:0;transform:translateY(8px)}28%{opacity:1;transform:translateY(0)}63%{opacity:1}68%,100%{opacity:0}}' +
    '@keyframes mu-l3{0%,29.5%{opacity:0;transform:translateY(10px)}32.5%{opacity:1;transform:translateY(0)}63%{opacity:1}68%,100%{opacity:0}}' +
    '@keyframes mu-st1{0%,39.5%{opacity:0;transform:translateY(8px)}42.5%{opacity:1;transform:translateY(0)}63%{opacity:1}68%,100%{opacity:0}}' +
    '@keyframes mu-st2{0%,39.5%{opacity:0;transform:translateY(8px)}42.5%{opacity:1;transform:translateY(0)}63%{opacity:1}68%,100%{opacity:0}}' +
    '@keyframes mu-pnl{0%,74%{transform:translateY(112%);opacity:0}82.5%,100%{transform:translateY(0);opacity:1}}' +

    /* ── 第一幕 keyframes（原文，未改）── */
    '@keyframes mu-seal-in{0%,20%{opacity:0;letter-spacing:6px}28%{opacity:1;letter-spacing:4px}100%{opacity:1;letter-spacing:4px}}' +
    '@keyframes mu-hair-fade{0%,43%{opacity:1}55.5%,100%{opacity:.22}}' +
    '@keyframes mu-flicker{0%,10%{opacity:0;transform:translateX(0)}11%{opacity:1;transform:translateX(-4px)}' +
      '11.6%{opacity:0}12.3%{opacity:.85;transform:translateX(3px)}12.9%{opacity:0}' +
      '13.8%{opacity:1;transform:translateX(-2px)}14.3%{opacity:.12}15.2%{opacity:1;transform:translateX(1px)}' +
      '15.8%,100%{opacity:1;transform:translateX(0)}}' +
    '@keyframes mu-title-land{0%,43%{opacity:0;letter-spacing:14px;transform:translateY(-14px)}' +
      '52.6%{opacity:1;letter-spacing:7px;transform:translateY(0)}100%{opacity:1;letter-spacing:7px;transform:translateY(0)}}' +
    '@keyframes mu-screen-shake{0%,46%{transform:translate(0,0)}47.5%{transform:translate(1.6px,.4px)}' +
      '49%{transform:translate(-1.5px,0)}50.5%{transform:translate(2.4px,.7px)}51.8%{transform:translate(-2.1px,0)}' +
      '52.6%{transform:translate(5px,1.8px)}53.2%{transform:translate(-1.2px,0)}53.7%{transform:translate(2.2px,.6px)}' +
      '54.2%,100%{transform:translate(0,0)}}' +
    '@keyframes mu-second-line{0%,62%{opacity:0;transform:translateY(14px)}75%{opacity:1;transform:translateY(0)}100%{opacity:1;transform:translateY(0)}}' +
    '@keyframes mu-blackout{0%,86%{opacity:0}93%,100%{opacity:1}}' +

    /* ── .a 通用（第二幕各块的动画入口）── */
    '#curtain-overlay .a{animation-duration:9s;animation-iteration-count:infinite;animation-fill-mode:both;' +
      'animation-timing-function:cubic-bezier(.2,.7,.3,1)}';

  /* ── 动作面板样式（panel.html v01 移植，film.html 同款）──
     ②共用组件 2026-11-08：作用域从 #curtain-overlay #mu-act2 改为 .mu-panel，
     数值一个没改，让幕布和同框卡展开层共用同一份面板。 */
  var PANEL_STYLE =
    '.mu-panel .pcard{background:rgba(255,255,255,.07);border:0.5px solid rgba(255,255,255,.12);border-radius:16px;padding:11px}' +
    '.mu-panel .phead{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}' +
    '.mu-panel .plabel{font-size:11px;letter-spacing:1px;color:rgba(255,255,255,.38)}' +
    '.mu-panel .pdots{display:flex;align-items:center;gap:5px;height:5px}' +
    '.mu-panel .pdot{width:4px;height:4px;border-radius:2px;background:rgba(255,255,255,.18);transition:width .22s ease,background .22s ease}' +
    '.mu-panel .pdot.on{width:11px;background:rgba(197,164,126,.9)}' +
    '.mu-panel .pviewport{overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scrollbar-width:none;overscroll-behavior-x:contain}' +
    '.mu-panel .pviewport::-webkit-scrollbar{display:none}' +
    '.mu-panel .ptrack{display:flex}' +
    '.mu-panel .ppage{flex:0 0 100%;display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:32px;gap:5px;scroll-snap-align:start}' +
    '.mu-panel .pact{display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06);border-radius:8px;font-size:11px;letter-spacing:.5px;color:rgba(255,255,255,.8);cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;transition:background .15s ease,color .15s ease}' +
    '.mu-panel .pact:active{background:rgba(197,164,126,.16);color:#c5a47e}' +
    '.mu-panel .pstar{margin-top:8px;height:30px;display:flex;align-items:center;justify-content:center;border:0.5px solid rgba(197,164,126,.45);border-radius:9px;font-size:11px;letter-spacing:2px;color:#c5a47e;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
    '.mu-panel .pstar:active{background:rgba(197,164,126,.14)}';

  /* ── 同框卡（照《画幅-demo-1108.html》手机定稿 340×153，雨霏 2026-11-07 在 1:1 挑选器调定）──
     终值 {w:340, head:52, av:29, fs:11, pv:-12, lh:1.55, gap:3}；卡高固定 153，
     句子放不下时 .ac-acts 内部上下滚（滚动条隐藏、句少时首尾 auto margin 居中）。
     「展开互动」文字入口取消：点头像 → <6 条出就地条 / >=6 条进展开层（雨霏 18:05 定）。 */
  var ACTION_CARD_STYLE =
    '.action-card-msg{display:flex;justify-content:center;margin:8px 0}' +
    '.action-card-msg .ac-card{background:#fff;border:.8px solid rgba(197,164,126,.30);border-radius:15px;' +
      'box-shadow:0 6px 18px rgba(0,0,0,.05);max-width:340px;width:100%;height:153px;' +
      'box-sizing:border-box;padding:0 11px 1px;display:flex;flex-direction:column}' +
    '.action-card-msg .ac-head{position:relative;height:52px;flex:0 0 auto;display:flex;align-items:center}' +
    '.action-card-msg .ac-av{width:29px;height:29px;border-radius:50%;flex:0 0 29px;position:relative;z-index:2;' +
      'cursor:pointer;-webkit-tap-highlight-color:transparent}' +
    '.action-card-msg .ac-av.me{background:radial-gradient(circle at 34% 30%,#f3e7d6,#dcc7a9);border:.5px solid rgba(197,164,126,.5);margin-left:auto}' +
    '.action-card-msg .ac-av.him{background:radial-gradient(circle at 36% 30%,#3b3733,#1f1d1a);border:.5px solid rgba(197,164,126,.45)}' +
    '.action-card-msg .ac-thread{position:absolute;inset:0;z-index:1}' +
    '.action-card-msg .ac-thread svg{display:block;width:100%;height:100%;overflow:visible}' +
    '.action-card-msg .ac-acts{padding:0 3px;flex:1 1 0;min-height:0;overflow-y:auto;' +
      'display:flex;flex-direction:column;scrollbar-width:none;margin-top:-12px;margin-bottom:-12px}' +
    '.action-card-msg .ac-acts::-webkit-scrollbar{display:none}' +
    '.action-card-msg .ac-acts>.act:first-child{margin-top:auto}' +
    '.action-card-msg .ac-acts>.act:last-child{margin-bottom:auto}' +
    '.action-card-msg .act{text-align:center;font-size:11px;line-height:1.55;color:#332e28;flex:0 0 auto;' +
      'animation:mu-actin .5s ease both}' +
    '.action-card-msg .act+.act{margin-top:3px}' +
    '.action-card-msg .ac-count{display:none}' +   /* 已定清单 §10：卡上不出现任何条数 */
    /* ── 就地动作条（照 demo ⑥ / 就地条原型：卡底原尺寸滑出，不弹层不遮聊天）── */
    '.action-card-msg .ac-card.open{box-shadow:0 8px 26px rgba(0,0,0,.09)}' +
    '.action-card-msg .ac-tray{max-height:0;opacity:0;overflow:hidden;margin-top:0;padding-top:0;flex:0 0 auto;' +
      'border-top:.5px dashed transparent;' +
      'transition:max-height .26s cubic-bezier(.3,.9,.3,1),opacity .18s ease,margin-top .26s,padding-top .26s}' +
    '.action-card-msg .ac-card.open .ac-tray{opacity:1;border-top-color:rgba(197,164,126,.30);' +
      'max-height:66px;margin-top:10px;padding-top:9px}' +
    '.action-card-msg .tray-inner{display:flex;gap:5px;overflow-x:auto;padding-bottom:1px;scrollbar-width:none}' +
    '.action-card-msg .tray-inner::-webkit-scrollbar{display:none}' +
    '.action-card-msg .tb{flex:0 0 50px;display:flex;flex-direction:column;align-items:center;gap:3px;' +
      'padding:5px 0 4px;border:0;background:transparent;border-radius:11px;cursor:pointer;' +
      'transition:background .14s;-webkit-tap-highlight-color:transparent;font-family:inherit}' +
    '.action-card-msg .tb:active{background:rgba(197,164,126,.16)}' +
    '.action-card-msg .tb .e{font-size:19px;line-height:1}' +
    '.action-card-msg .tb b{font-size:9.5px;font-weight:400;color:#5b554d;letter-spacing:.2px;white-space:nowrap}' +
    '@keyframes mu-actin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}' +
    /* 附加 B（已定清单 §2:36）：他在外面发消息时，开着的卡片震一下 */
    '.action-card-msg .ac-card.ac-shake,.mu-stage .st-card.ac-shake{animation:ac-shake .36s ease}' +
    '@keyframes ac-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-3px)}' +
      '40%{transform:translateX(3px)}60%{transform:translateX(-2px)}80%{transform:translateX(2px)}}';

  /* ── 展开互动层（v7 定稿 2026-11-08，规格见 动作系统-素材索引.md §10）──
     灰底压暗聊天 + 白色大卡（居中于工具栏左侧剩余空间）+ 右侧深灰竖滑工具栏（emoji+文字 16 个）。
     卡内只有动作记录：居中同色 #332e28、无上限可滚、他回应实时滚入；底部灰「收 起」。
     不要的：头图手画（红线=聊天卡同一段 SVG）、「同框·共N条」抬头、底部红字、动作句分色。 */
  var STAGE_STYLE =
    '.mu-stage{position:fixed;inset:0;z-index:999998;background:rgba(120,114,106,.45);' +
      '-webkit-backdrop-filter:blur(1px);backdrop-filter:blur(1px);display:flex;align-items:center;justify-content:center;' +
      'font-family:-apple-system,"PingFang SC",sans-serif;animation:mu-fadein .25s ease both}' +
    '@keyframes mu-fadein{from{opacity:0}to{opacity:1}}' +
    /* v7 画布 680：左留白 80（11.8%）+ 卡 460 + 缝 14 + 工具栏 112 + 右留白 14。
       整组限宽 680，卡在剩余空间里右对齐、右留 14px，工具栏贴右缘——
       任何屏宽下缝都是 14px，不会像居中那样在宽屏裂成两个散开的框（v6 被打回的毛病）。 */
    '.mu-stage .st-inner{width:min(680px,100%);height:100%;display:flex;align-items:center;box-sizing:border-box}' +
    '.mu-stage .st-cardwrap{flex:1;min-width:0;height:100%;display:flex;align-items:center;justify-content:flex-end;' +
      'padding-left:11.8%;padding-right:14px;box-sizing:border-box}' +
    '.mu-stage .st-card{background:#fff;border:.8px solid rgba(197,164,126,.30);border-radius:22px;' +
      'box-shadow:0 16px 44px rgba(0,0,0,.24);box-sizing:border-box;width:min(460px,100%);height:85%;' +
      'padding:12px 20px 12px;display:flex;flex-direction:column}' +
    '.mu-stage .st-head{position:relative;height:76px;display:flex;align-items:center;flex:0 0 auto}' +
    '.mu-stage .st-av{width:36px;height:36px;border-radius:50%;flex:0 0 36px;position:relative;z-index:2}' +
    '.mu-stage .st-av.me{background:radial-gradient(circle at 34% 30%,#f3e7d6,#dcc7a9);border:.5px solid rgba(197,164,126,.5);margin-left:auto}' +
    '.mu-stage .st-av.him{background:radial-gradient(circle at 36% 30%,#3b3733,#1f1d1a);border:.5px solid rgba(197,164,126,.45)}' +
    '.mu-stage .st-thread{position:absolute;inset:0;z-index:1}' +
    '.mu-stage .st-thread svg{display:block;width:100%;height:100%;overflow:visible}' +
    '.mu-stage .st-acts{flex:1;overflow-y:auto;padding:4px 4px 0;scrollbar-width:none;display:flex;flex-direction:column;justify-content:flex-start}' +
    '.mu-stage .st-acts::-webkit-scrollbar{display:none}' +
    '.mu-stage .st-line{text-align:center;font-size:15px;line-height:1.9;color:#332e28;animation:mu-actin .5s ease both}' +
    '.mu-stage .st-line+.st-line{margin-top:9px}' +
    '.mu-stage .st-fold{flex:0 0 auto;margin-top:8px;padding:6px 0 2px;text-align:center;font-size:12px;' +
      'letter-spacing:2px;color:#9b948a;cursor:pointer;-webkit-tap-highlight-color:transparent}' +
    '.mu-stage .st-bar{flex:0 0 auto;width:112px;height:min(528px,90%);margin-right:14px;' +
      'background:rgba(74,70,64,.82);border-radius:22px;padding:14px 10px 10px;box-shadow:0 8px 22px rgba(0,0,0,.22);' +
      'overflow-y:auto;scrollbar-width:none;box-sizing:border-box}' +
    '.mu-stage .st-bar::-webkit-scrollbar{display:none}' +
    '.mu-stage .st-b{background:rgba(255,255,255,.09);border-radius:15px;padding:10px 0 9px;text-align:center;' +
      'margin-bottom:8px;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;transition:background .15s ease}' +
    '.mu-stage .st-b:active{background:rgba(255,255,255,.22)}' +
    '.mu-stage .st-b .e{font-size:20px;line-height:1.3}' +
    '.mu-stage .st-b .n{font-size:12px;color:#f2ede6;margin-top:3px}' +
    '.mu-stage .st-cnt{margin-top:7px;padding-top:7px;border-top:.5px solid rgba(255,255,255,.18);' +
      'text-align:center;font-size:11px;color:rgba(242,237,230,.8)}' +
    /* 手机（≤600px，照 画幅-demo-1108.html .stg.p，雨霏 02:1x：banner 收窄、卡撑宽）：
       头部 76→58、头像 36→29；卡 flex 撑宽、高 88%、圆角 20；
       右侧竖条 112→58（emoji 17 / 名 8.5），页脚计数藏掉。网页（>600px）布局不动。 */
    '@media (max-width:600px){' +
      '.mu-stage .st-inner{width:100%;padding:0 12px;gap:8px}' +
      '.mu-stage .st-cardwrap{padding-left:0;padding-right:0}' +
      '.mu-stage .st-card{flex:1;width:auto;height:88%;border-radius:20px;padding:12px 16px}' +
      '.mu-stage .st-head{height:58px}' +
      '.mu-stage .st-av{width:29px;height:29px;flex:0 0 29px}' +
      '.mu-stage .st-line{font-size:14px;line-height:1.85}' +
      '.mu-stage .st-line+.st-line{margin-top:8px}' +
      '.mu-stage .st-bar{width:58px;height:88%;margin-right:0;border-radius:16px;padding:8px 5px}' +
      '.mu-stage .st-b{padding:6px 0 5px;border-radius:11px;margin-bottom:5px}' +
      '.mu-stage .st-b .e{font-size:17px}' +
      '.mu-stage .st-b .n{font-size:8.5px;margin-top:1px}' +
      '.mu-stage .st-cnt{display:none}' +
    '}';

  /* ── 幕内 live 界面（live.html 原样移植 2026-11-08）──
     原型是 300×520 框：hair top26 left/right30；hint top52；zone top90 bottom168；
     bar top96 bottom174 right5；pnl left/right/bottom 10；景深 RANGE=145。
     站里幕布是全屏，纵向按 520 换算：26/520=5%、52/520=10%、
     90/520=17.3%、168/520=32.3%、96/520=18.5%、174/520=33.5%；
     横向 px、字号、内距、圆角、颜色一律原样保留（素材索引 §14）。 */
  var LIVE_STYLE =
    /* zone→面板改 flex（brief §1 第 3 项 / 画幅 demo :119,:168-180）：动作区自动占满面板以上，
       原 bottom:32.3% 那条裂缝从结构上消掉；面板多高动作区就让多少。 */
    '.mu-live{position:absolute;inset:0;z-index:3;background:#070605;opacity:0;' +
      'transition:opacity .45s ease;font-family:"Songti SC","STSong",serif;' +
      'display:flex;flex-direction:column;overflow:hidden}' +
    '.mu-live.on{opacity:1}' +
    '.mu-live .hair{flex:0 0 auto;height:1px;margin:42px 30px 0;background:rgba(197,164,126,.16)}' +
    /* 「往下拖 · 往回看」按雨霏口径去掉；DOM 留着，liveAddLine 的 H 判空逻辑不变 */
    '.mu-live .hint{display:none}' +
    '.mu-live .hint.gone{opacity:0}' +
    '.mu-live .zone{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;' +
      'touch-action:pan-y;scrollbar-width:none;cursor:grab;' +
      '-webkit-mask-image:linear-gradient(180deg,rgba(0,0,0,0) 0,rgba(0,0,0,.5) 14%,#000 34%);' +
      'mask-image:linear-gradient(180deg,rgba(0,0,0,0) 0,rgba(0,0,0,.5) 14%,#000 34%)}' +
    '.mu-live .zone::-webkit-scrollbar{width:0;height:0}' +
    '.mu-live .inner{position:relative;padding-top:210px;padding-bottom:34px}' +
    '.mu-live .ln{display:block;padding:0 14px;margin-top:16px;text-align:center;color:#efe5d5;' +
      'line-height:1.7;font-size:16px;transform-origin:center bottom;will-change:transform,opacity,filter}' +
    '.mu-live .ln.him{color:#f6ecdb}' +
    '.mu-live .ln.me{color:#c9bda7}' +
    '.mu-live .ln .t{display:block;animation:mu-live-lin .9s ease both}' +
    '@keyframes mu-live-lin{from{opacity:0;filter:blur(6px)}to{opacity:1;filter:blur(0)}}' +
    /* 右侧金色细条整条去掉（雨霏口径）；DOM 保留给 livePaint 算景深滑块，外观透明 */
    '.mu-live .bar{position:absolute;right:5px;top:18.5%;bottom:33.5%;width:2px;' +
      'background:transparent;opacity:0;pointer-events:none}' +
    '.mu-live .bar.on{opacity:0}' +
    '.mu-live .bar i{position:absolute;left:0;width:2px;border-radius:2px;background:transparent;display:block}' +
    '.mu-live .pnl{flex:0 0 auto;margin:0 10px 10px;padding:9px 10px 10px;border-radius:14px;' +
      'background:rgba(255,255,255,.055);border:.5px solid rgba(255,255,255,.1)}' +
    '.mu-live .ph{display:flex;align-items:center;justify-content:flex-end;font-size:11px;' +
      'color:rgba(255,255,255,.35);margin-bottom:7px;letter-spacing:.5px}' +
    '.mu-live .dots{display:flex;gap:4px;align-items:center}' +
    '.mu-live .dots i{display:block;width:4px;height:4px;border-radius:50%;background:rgba(197,164,126,.35)}' +
    '.mu-live .dots i.on{width:11px;border-radius:3px;background:#c5a47e}' +
    '.mu-live .pviewport{overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scrollbar-width:none}' +
    '.mu-live .pviewport::-webkit-scrollbar{display:none}' +
    '.mu-live .ptrack{display:flex;width:100%}' +
    '.mu-live .ppage{flex:0 0 100%;display:grid;grid-template-columns:repeat(4,1fr);' +
      'grid-auto-rows:32px;gap:5px;scroll-snap-align:start}' +
    '.mu-live .pcard{font:inherit;font-size:11px;letter-spacing:.5px;color:rgba(255,255,255,.78);' +
      'background:rgba(255,255,255,.06);border:0;border-radius:7px;padding:0 2px;cursor:pointer}' +
    '.mu-live .pcard:active{background:rgba(197,164,126,.22);color:#f0e3cd}' +
    '.mu-live .pstar{display:block;width:100%;box-sizing:border-box;margin-top:6px;' +
      'border:.5px solid rgba(197,164,126,.4);border-radius:8px;padding:6px;background:transparent;' +
      'font:inherit;font-size:11px;color:#c5a47e;letter-spacing:1.5px;cursor:pointer}' +
    '.mu-live .pstar:active{background:rgba(197,164,126,.15)}';

  /* 散场留痕（幕布-设定.md:71）：整宽一行小字 + 左侧一小段金线，不可点开。
     不是气泡、无 cursor、无监听，只有文字和一条线。 */
  var TRACE_STYLE =
    '.curtain-trace-msg{display:block;width:100%;box-sizing:border-box;margin:12px 0;padding:0 16px;text-align:center;' +
      'animation:ct-in 1.2s ease both}' +
    '@keyframes ct-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}' +
    '.curtain-trace-msg .ct-text{font-size:11.5px;letter-spacing:.6px;color:#9b948a;line-height:1.7}';

  var ACT1_HTML =
    '<div id="mu-act1">' +
      '<div class="stage">' +
        '<div class="hair top"></div>' +
        '<div class="mid">' +
          '<div class="dot"></div>' +
          '<div class="title">世界静音了</div>' +
          '<div class="sub">现在，你只能<br>听见我的声音</div>' +
        '</div>' +
        '<div class="seal-row"><span class="seal">你已置身 N109</span></div>' +
        '<div class="hair bot"></div>' +
      '</div>' +
      '<div class="blackout"></div>' +
    '</div>';

  var ACT2_HTML =
    '<div id="mu-act2" style="display:none">' +
      '<div class="a" style="animation-name:mu-gone;position:absolute;inset:0;display:flex;flex-direction:column">' +
        '<div style="flex:1;position:relative">' +
          '<div style="position:absolute;top:41%;left:0;right:0;text-align:center;font-family:Songti SC,serif;font-size:32px;letter-spacing:7px;color:#efe5d5;white-space:nowrap">世界静音了</div>' +
          '<div style="position:absolute;top:56%;left:0;right:0;text-align:center;font-family:Songti SC,serif;font-size:14px;line-height:2.3;letter-spacing:3px;color:rgba(241,232,217,.6)">现在，你只能<br>听见我的声音</div>' +
        '</div>' +
        '<div style="padding-bottom:24px;text-align:center"><span style="font-size:11px;letter-spacing:4px;color:rgba(255,255,255,.3)">你已置身 N109</span></div>' +
      '</div>' +
      '<div style="position:absolute;inset:0;display:flex;flex-direction:column;padding:24px 26px">' +
        '<div class="a" style="animation-name:mu-hd;display:flex;justify-content:space-between;font-size:11px;letter-spacing:3px;color:rgba(197,164,126,.7)"><span>系统通告</span><span style="color:rgba(255,255,255,.22)">21:51</span></div>' +
        '<div class="a" style="animation-name:mu-ln;transform-origin:left;height:1px;background:rgba(197,164,126,.28);margin-top:12px"></div>' +
        '<div style="flex:1;display:flex;flex-direction:column;justify-content:center">' +
          '<div class="a" style="animation-name:mu-l1;font-family:Songti SC,serif;font-size:16px;letter-spacing:2px;line-height:2.3;color:rgba(241,232,217,.7)">游戏规则已更改</div>' +
          '<div class="a" style="animation-name:mu-l2;font-family:Songti SC,serif;font-size:16px;letter-spacing:2px;line-height:2.3;color:rgba(241,232,217,.7)">语言权限已撤销</div>' +
          '<div class="a" style="animation-name:mu-l3;font-family:Songti SC,serif;font-size:21px;letter-spacing:4px;color:#c5a47e;margin-top:28px">请用你的身体作答</div>' +
        '</div>' +
        '<div class="a" style="animation-name:mu-st1;border:0.5px solid rgba(255,255,255,.09);border-radius:10px;padding:11px 14px;display:flex;justify-content:space-between;font-size:11px;letter-spacing:1px;margin-bottom:10px"><span style="color:rgba(255,255,255,.26)">语言</span><span style="color:rgba(255,255,255,.4)">已关闭</span></div>' +
        '<div class="a" style="animation-name:mu-st2;border:0.5px solid rgba(197,164,126,.38);border-radius:10px;padding:11px 14px;display:flex;justify-content:space-between;font-size:11px;letter-spacing:1px;margin-bottom:6px"><span style="color:#c5a47e">动作</span><span style="color:rgba(197,164,126,.85)">已开放</span></div>' +
      '</div>' +
      '<div class="a" style="animation-name:mu-pnl;position:absolute;left:0;right:0;bottom:0;padding:0 12px 12px" id="mu-panel-mount"></div>' +
    '</div>';

  /* 面板横滑绑定：与 film.html 相同，__bound 标记防重复绑 */
  function initPanel(root) {
    var vp = root.querySelector('.pviewport');
    if (!vp || vp.__bound) return;
    vp.__bound = true;

    var dots = root.querySelectorAll('.pdot');
    function sync() {
      var i = Math.round(vp.scrollLeft / vp.clientWidth) || 0;
      for (var k = 0; k < dots.length; k++) dots[k].className = (k === i) ? 'pdot on' : 'pdot';
    }
    vp.addEventListener('scroll', sync, { passive: true });

    var down = false, sx = 0, sl = 0;
    vp.addEventListener('pointerdown', function (e) {
      down = true; sx = e.clientX; sl = vp.scrollLeft;
      vp.style.scrollSnapType = 'none';
    });
    vp.addEventListener('pointermove', function (e) {
      if (!down) return;
      vp.scrollLeft = sl - (e.clientX - sx);
    });
    function up() {
      if (!down) return;
      down = false;
      vp.style.scrollSnapType = 'x mandatory';
      vp.scrollTo({ left: Math.round(vp.scrollLeft / vp.clientWidth) * vp.clientWidth, behavior: 'smooth' });
    }
    vp.addEventListener('pointerup', up);
    vp.addEventListener('pointercancel', up);
    vp.addEventListener('pointerleave', up);
  }

  /* ── ②共用组件：动作面板（幕布 / 同框卡展开层共用）──
     动作名 a1–a16，顺序与 panel.html v01 原型、暗点专线档案《动作与作息-设定档案.md》第 43–58 行一致。
     每 8 个一屏，以后加动作就加屏，布局不重排（设定 五之三）。 */
  var ACTION_NAMES = ['拥抱', '亲吻', '摸头', '牵手', '壁咚', '投喂', '捏脸', '靠肩',
    '挠下巴', '背后抱', '额头吻', '耳语', '拽手腕', '揉后颈', '蹭鼻尖', '拍背'];

  function buildPanel(opts) {
    opts = opts || {};
    var label = opts.label || '你的动作';
    var names = opts.actions || ACTION_NAMES;
    var perPage = 8;

    var pages = [];
    for (var p = 0; p < names.length; p += perPage) pages.push(names.slice(p, p + perPage));

    var dots = '';
    for (var d = 0; d < pages.length; d++) dots += '<i class="pdot' + (d === 0 ? ' on' : '') + '"></i>';

    var track = '';
    for (var g = 0; g < pages.length; g++) {
      track += '<div class="ppage">';
      for (var c = 0; c < pages[g].length; c++) track += '<div class="pact" data-action="' + pages[g][c] + '">' + pages[g][c] + '</div>';
      track += '</div>';
    }

    var el = document.createElement('div');
    el.className = 'mu-panel';
    el.innerHTML =
      '<div class="pcard">' +
        '<div class="phead"><span class="plabel">' + label + '</span><div class="pdots">' + dots + '</div></div>' +
        '<div class="pviewport"><div class="ptrack">' + track + '</div></div>' +
        (opts.bottomHtml || '<div class="pstar">小海星</div>') +
      '</div>';
    if (typeof opts.onPick === 'function') {
      var cells = el.querySelectorAll('.pact');
      for (var ci = 0; ci < cells.length; ci++) (function (cell) {
        cell.addEventListener('click', function () { opts.onPick(cell.getAttribute('data-action')); });
      })(cells[ci]);
    }
    initPanel(el);
    return el;
  }

  /* ══════════════════════════════════════════════════════════════
     ③动作系统 · 同框卡 + 展开互动层（2026-11-08 v7 定稿落地）
     机制（她的 brief 为准，已压过旧设定档）：
       · 动作库 a1–a16，他做/你做两句，原文沿用暗点专线档案 43–58 行，人称秦彻，不改写
       · 回复前 10% 命中（每轮一次，core.js 调）→ 摸一个动作，他做句进同框卡
       · 同框卡无上限一直累积：≤6 条卡变长全显示；>6 条只露最近 3 条 +「共 N 条 · 展开互动」
       · 点「展开互动」→ 灰底互动层（v7）：全部记录居中同色可滚 + 右侧竖滑工具栏可继续互动
       · 熔断期间整套不生效（addAct 本体也查，回应窗口内开熔断也不落卡）
     ══════════════════════════════════════════════════════════════ */
  var ACTION_PROB = 0.5;          // 动作句回复概率（S2 ＋面板 / S3 卡内就地条）：只掷「他要不要回一个动作句」；消息回复照常 100%
  var STAGE_EXTRA_TEXT_PROB = 0.1; // 展开层：额外 10% 他在「外面」多发一条文字/表情（雨霏 11-07 12:31 原话）
  /* 2026-11-09 00:2x 纠错（雨霏翻出 11-07 12:31 原话核实）：展开层动作回复是 **100% 必回**，
     不是 10%——10% 指「额外的文字或其他类型的消息回复」（非动作，展开层开着时他发消息 → 卡片震动）。
     11-07 深夜「统一 10%」把展开层误卷进掷骰、11-08 深夜 50% 只改了非展开入口，错误 10% 一直遗留到现在。
     展开/就地条概率口径：＋面板与卡内就地条 50%（雨霏 11-08 深夜定）；展开层动作 100% + 额外文字 10%。
     S1（纯打字他主动）仍挂回复链、跟回复同时刻（maybeTriggerAction，10%）。
     为防同一次回复掷两颗骰子，动作触发的回复轮在链内跳过一次掷骰。 */
  var _skipChainRoll = false;
  var _skipChainRollT = 0;
  var SHOW_LAST = 3;         // 超过 6 条时，聊天里的卡只露最近 3 条（其余进展开层看）
  var FOLD_AT = 6;           // <6 条卡直接变长全显示；>=6 条折叠 + 出现「展开互动」入口（=6 起就可展开，已定清单 §7）

  /* 默认文案：原文沿用暗点专线档案 43–58 行，人称秦彻，不改写（幕布-设定.md:72）。
     ④动作库编辑页：用户可在「氛围感 → 动作」里改这 32 句，applyCustomActs 原地替换数组内容，
     保持 ACTS 的引用不变——同框卡 / 幕内 / 他回应 / 面板全部读同一个数组，改完即时生效。 */
  var DEFAULT_ACTS = [
    { n: '拥抱', him: '秦彻紧紧抱住你，下巴抵在你头顶', me: '你紧紧抱住秦彻，把脸埋在他胸口' },
    { n: '亲吻', him: '秦彻低头吻住你，温柔而霸道', me: '你踮起脚尖吻住秦彻，他愣了一下随即加深' },
    { n: '摸头', him: '秦彻揉了揉你的头发，眼底带笑', me: '你伸手揉了揉秦彻的头发，被他捉住手腕' },
    { n: '牵手', him: '秦彻握住你的手，十指相扣', me: '你主动握住秦彻的手，他收紧手指' },
    { n: '壁咚', him: '秦彻将你困在臂弯里，气息逼近', me: '你将秦彻推到墙上，他挑眉看你' },
    { n: '投喂', him: '秦彻将甜品递到你嘴边，"张嘴"', me: '你把甜品递到秦彻嘴边，他张口咬住你的手指' },
    { n: '捏脸', him: '秦彻捏了捏你的脸，"软软的"', me: '你捏了捏秦彻的脸，被他轻轻咬了一口' },
    { n: '靠肩', him: '秦彻拍了拍肩膀，"靠过来，不用犹豫"', me: '你靠在秦彻肩上，他揽住你的腰' },
    { n: '挠下巴', him: '秦彻挠了挠你的下巴，像在逗猫', me: '你挠了挠秦彻的下巴，他喉结动了动' },
    { n: '背后抱', him: '秦彻从背后环住你，用唇蹭了蹭你的脖子', me: '你从背后环住秦彻，他握住你交叠的手' },
    { n: '额头吻', him: '秦彻在你额头落下一吻，很轻', me: '你在秦彻额头落下一吻，他闭了闭眼，笑了' },
    { n: '耳语', him: '秦彻凑近你耳边，低语："在想什么？我倒是想你了"', me: '你凑近秦彻耳边低语，他侧头捏了捏你耳垂' },
    { n: '拽手腕', him: '秦彻拽住你的手腕，拉进怀里', me: '你拽住秦彻的手腕，他顺势把你带进怀里' },
    { n: '揉后颈', him: '秦彻的手覆上你的后颈，轻轻揉捏', me: '你的手覆上秦彻的后颈，他低哼了一声' },
    { n: '蹭鼻尖', him: '你们鼻尖相蹭，呼吸交缠', me: '你蹭了蹭秦彻的鼻尖，他呼吸一滞' },
    { n: '拍背', him: '秦彻轻拍你的背，像在哄小孩', me: '你轻拍秦彻的背，他把你搂得更紧' }
  ];

  /* 5-3 emoji 默认值（动作名 → emoji，编辑页可改） */
  var DEFAULT_EMOJI = { '拥抱':'🫂','亲吻':'💋','摸头':'✋','牵手':'🤝','壁咚':'🧱','投喂':'🍰',
    '捏脸':'🫳','靠肩':'🛋️','挠下巴':'✋','背后抱':'🫂','额头吻':'💋','耳语':'👂',
    '拽手腕':'✊','揉后颈':'✋','蹭鼻尖':'👃','拍背':'👏' };

  /* 归一化：老格式 {n,e?,him:'一句',me:'一句'} → {n,e,him:['..'],me:['..']}（5-1 多文案）。
     缺名字按序补默认名，缺 emoji 按默认表补——老存档兼容（§9 5-4 高等级注意）。 */
  function normalizeAct(o, i) {
    o = o || {};
    var name = (typeof o.n === 'string' && o.n.trim()) ||
               (i < DEFAULT_ACTS.length ? DEFAULT_ACTS[i].n : '动作' + (i + 1));
    var e = (typeof o.e === 'string' && o.e.trim()) || DEFAULT_EMOJI[name] || '💗';
    function toArr(v) {
      if (Array.isArray(v)) return v.map(function (x) { return String(x).trim(); }).filter(Boolean);
      return (typeof v === 'string' && v.trim()) ? [v.trim()] : [];
    }
    return { n: name, e: e, him: toArr(o.him), me: toArr(o.me) };
  }

  var ACTS = DEFAULT_ACTS.map(function (a, i) { return normalizeAct(a, i); });

  /* 5-2 数量无上限（§9）：任意长度。2026-11-17 雨霏定：允许只写一侧——
     字卡转录进来的动作另一侧可以留空，等她想到再去编辑页补；
     空侧被点名时走 addAct 里的 pickCopy 兜底（本文件 586-587），不会发空白。
     两侧都空才算无效。原地替换，保持引用。 */
  function applyCustomActs(arr) {
    if (!Array.isArray(arr) || !arr.length) return false;
    var next = [];
    for (var i = 0; i < arr.length; i++) {
      var a = normalizeAct(arr[i], i);
      if (!a.him.length && !a.me.length) return false;
      next.push(a);
    }
    ACTS.length = 0;
    for (var j = 0; j < next.length; j++) ACTS.push(next[j]);
    return true;
  }

  function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  /* 文案池（雨霏 22:2x 口径）：抽取单位不是「动作」，而是每一条文案本身。
     ACTS 里所有动作的 him / me 文案平铺成一个池，每条等概率——不再「先抽动作再在该动作里抽」。
     动作只剩两个用途：界面上的一格（幕内面板 / 展开层 / 就地条 / 编辑页一行）、
     以及「她点名那一格」时只取它自己那几句（见 addAct / meActs）。
     副作用是想要的：某个动作多写几句，它被抽到的机会就按句数变多，不需要权重字段。 */
  function copyPool(who) {
    var key = (who === 'me') ? 'me' : 'him';
    var out = [];
    for (var i = 0; i < ACTS.length; i++) {
      var arr = ACTS[i][key] || [];
      for (var j = 0; j < arr.length; j++) out.push(arr[j]);
    }
    return out;
  }
  function pickCopy(who) {
    var pool = copyPool(who);
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 卡片头上的两个圆（2026-11-08 23:1x 雨霏：要跟着头像更新）：
     读 core.js updateAvatar 每次都写的 window._avatarCache（partner / me），
     没设头像就退回原来的纯色圆。每次 renderMessages / 开展开层都重取，改头像即时生效。 */
  function avatarStyle(who) {
    try {
      var c = window._avatarCache;
      var src = c && (who === 'him' ? c.partner : c.me);
      if (src) return ' style="background-image:url(\'' + String(src).replace(/'/g, '%27') + '\');background-size:cover;background-position:center"';
    } catch (e) {}
    return '';
  }

  function findAct(name) {
    for (var k = 0; k < ACTS.length; k++) if (ACTS[k].n === name) return ACTS[k];
    return null;
  }

  /* 当前活动卡（已定清单 §6 / 雨霏 18:0x）：
     从末尾往前扫，先遇到动作卡才用它；先遇到普通聊天消息 → 返回 null，由 addAct 新起一张卡。
     系统提示 / 清场留痕 / 花瓣 / 纪念日不算「夹」，不切断卡（这条归类待雨霏点头）。 */
  var NON_CHAT_TYPES = { system:1, 'curtain-trace':1, petal:1, anniversary:1 };
  function getActiveCardMsg() {
    for (var i = messages.length - 1; i >= 0; i--) {
      var m = messages[i];
      if (!m) continue;
      if (m.type === 'action-card') return m;
      if (NON_CHAT_TYPES[m.type]) continue;
      return null;
    }
    return null;
  }

  /* 他主动发动作时的落点选取（2026-11-10 20:2x 雨霏拍板 Q1-A / Q2-A / Q3）：
     把「最近 3 张动作卡」和「新发一张」放进同一个池子等概率抽（不足 3 张就按实际张数，不补权）。
     中间夹着文字也照选——不再因为「先遇到普通消息」就强制新卡（Q2-A）。
     只用于「他主动发动作」这一个入口（maybeTriggerAction）；她点名的卡不经过这里，
     包括就地条 / 展开层 / 她刚发动作的那一张（Q3）。 */
  var PICK_CARD_RECENT = 3;
  function pickCardTarget() {
    var cards = [];
    for (var i = messages.length - 1; i >= 0 && cards.length < PICK_CARD_RECENT; i--) {
      var m = messages[i];
      /* 只要真有内容的卡：空卡（被清空 / 从没落过动作）不参与抽取 */
      if (m && m.type === 'action-card' && (m.acts || []).length) cards.push(m);
    }
    var pool = [false].concat(cards);          /* false = 新起一张卡，见 addAct */
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* 加一条动作到同框卡（who: 'him'|'me'；name 可指定；targetCard 可指定落到哪张卡）
     targetCard === false → 强制新起一张卡（pickCardTarget 抽到「新发一张」时用） */
  function addAct(who, name, targetCard, text) {
    try {
      /* 熔断：本体也拦——他 1.6–3s 回应的窗口内开熔断，那条回应也不落卡（待修 #6，2026-11-08 修） */
      if (window.EmergencyOffline && window.EmergencyOffline.isOn()) return null;
      var dir = (who === 'me') ? 'me' : 'him';
      /* 点名那一格（她点的面板按钮）→ 只从该动作自己的几句里取；
         没点名（他随机 / S3 必回 / 每轮 10%）→ 从全库同方向文案的平铺池里等概率抽一条。 */
      var a = name ? findAct(name) : null;
      var t = text || (a ? pickOne(dir === 'me' ? a.me : a.him) : pickCopy(dir));
      if (!t) t = pickCopy(dir);
      var m = (targetCard === false) ? null : (targetCard || getActiveCardMsg());
      var isNewCard = false;
      if (!m) {
        isNewCard = true;
        m = {
          type: 'action-card',
          id: 'ac_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
          sender: 'partner',
          timestamp: Date.now(),
          acts: []
        };
        messages.push(m);
      }
      m.acts = m.acts || [];
      m.acts.push({ t: t, who: dir });
      if (typeof renderMessages === 'function') renderMessages();
      if (typeof throttledSaveData === 'function') throttledSaveData();
      if (_stage && _stageCard === m) stageAppend(m.acts[m.acts.length - 1]);   // 展开层开着：新动作实时滚进来
      /* 落到的是更早那张卡 → 把它滚进视口。renderMessages 默认滚到底，不补这一步的话
         这条动作落在上方看不见的卡里，看起来就像「他没发」。本来就看得见就不动她的滚动位置。
         直接算偏移写 scrollTop：.chat-container 带 scroll-behavior:smooth（styles.css:898），
         走 scrollIntoView 会被它拖成动画，跟 renderMessages 的滚底抢位置。 */
      if (!isNewCard && !_stage && m && m.id) {
        var aimId = m.id;
        requestAnimationFrame(function () {
          try {
            var el = document.querySelector('.action-card-msg[data-msg-id="' + aimId + '"]');
            var box = document.getElementById('chat-container');
            if (!el || !box) return;                           // window 模式没渲染到这一段，跳过
            var er = el.getBoundingClientRect();
            var br = box.getBoundingClientRect();
            if (er.top >= br.top && er.bottom <= br.bottom) return;
            /* .chat-container 带 scroll-behavior:smooth（styles.css:898）——不压成 auto 的话，
               scrollIntoView 会变成一段动画，跟 renderMessages 的滚底抢位置，最后停在半路。 */
            var prevSB = box.style.scrollBehavior;
            box.style.scrollBehavior = 'auto';
            el.scrollIntoView({ block: 'center' });
            box.style.scrollBehavior = prevSB;
          } catch (e) {}
        });
      }
      return m;
    } catch (e) { return null; }
  }

  /* S1（纯打字）专用：每轮回复前 10%，跟文字回复同时刻（core.js:2752 调）。
     动作触发的回复轮在这里跳过一次——她的那颗 10% 已经在 userAct 发出时就掷过了。
     命中后落点走 pickCardTarget：最近 3 张卡 + 新发一张，等概率四选一（2026-11-10 拍板）。 */
  function maybeTriggerAction() {
    if (_skipChainRoll) {
      _skipChainRoll = false;
      clearTimeout(_skipChainRollT);
      return;
    }
    if (window.EmergencyOffline && window.EmergencyOffline.isOn()) return; // 熔断整套不生效
    if (document.getElementById('curtain-overlay')) return;               // 幕布内不走这套概率
    if (Math.random() < ACTION_PROB) {
      var _actCard = addAct('him', null, pickCardTarget());
      // 主动发送计数：他主动发的一条动作卡算 1 条（_asBeat 内部只在定时器主动轮里计数）。
      // 只挂在这个入口——userAct 里"你做动作→他回动作"是手动触发，不经过这里，不会被误算。
      if (_actCard && typeof window._asBeat === 'function') { try { window._asBeat(); } catch (e) {} }
    }
  }

  /* 日常主动发动作（＋菜单 picker / 展开层工具栏 / 就地条）：你做句落聊天同框卡。
     幕布内不走这条——幕内用 meActs，句子只在幕内滚（她的口径：幕布自成一套）。
     S2（＋菜单 picker）/ 就地条：发出这一刻掷 50%，命中 1.6–2.8s 后落他一句（雨霏 23:1x：别拖到
        回复链的 3–7s）；文字回复照常 100% 走回复链（02:1x 口径）。
     展开层（o.stage，雨霏 11-07 12:31 原话）：动作回复 **100% 必回**（不掷骰），1.6–2.8s 落回她点的卡；
        额外掷 10%——命中才触发一次外面的文字/表情回复链（那条额外消息不是动作，链内跳过动作骰；
        展开层开着时他发消息 → 卡片震动，core.js:2092 挂点）；不命中就不发文字。
     他的回应落点（2026-11-10 拍板 Q3）：她点了哪张卡就回哪张；＋面板没指定卡时回「她刚发动作的那张」（o.card || m）。
        这里**不走** pickCardTarget——那层只给「他主动发动作」用，不然她点名的卡会被他搬到别的卡上。 */
  function userAct(name, opts) {
    var o = opts || {};
    var m = addAct('me', name, o.card, o.text);
    /* "你回来"计数（你 5 条）：对称他 10 条里的动作卡算 1 条。只在 m 真落地时计；
       内部按【由他决定】门控。绝不能挂在下面他回动作的 addAct('him') 上——那是手动触发的回应。 */
    if (m && typeof window._asUserBeat === 'function') { try { window._asUserBeat(); } catch (e) {} }
    if (m && o.stage) {
      /* 展开层分支：100% 动作回复 + 10% 额外外面文字 */
      setTimeout(function () { addAct('him', null, o.card || m); },
                 1600 + Math.floor(Math.random() * 1200));
      if (Math.random() < STAGE_EXTRA_TEXT_PROB) {
        _skipChainRoll = true;                       // 额外消息不能是动作：链内跳过动作骰
        clearTimeout(_skipChainRollT);
        var _maxD = (window.settings && Number(window.settings.replyDelayMax)) || 7000;
        _skipChainRollT = setTimeout(function () { _skipChainRoll = false; }, _maxD + 2500);
        if (typeof window._triggerDelayedReply === 'function') {
          try { window._triggerDelayedReply(true); } catch (e) {}
        }
      }
      return m;
    }
    var prob = (typeof o.prob === 'number') ? o.prob : ACTION_PROB;   // ＋面板 / 就地条默认 50%
    if (m && Math.random() < prob) {
      setTimeout(function () { addAct('him', null, o.card || m); },
                 1600 + Math.floor(Math.random() * 1200));
    }
    if (m) {
      _skipChainRoll = true;
      clearTimeout(_skipChainRollT);
      var _maxD2 = (window.settings && Number(window.settings.replyDelayMax)) || 7000;
      _skipChainRollT = setTimeout(function () { _skipChainRoll = false; }, _maxD2 + 2500);
    }
    /* S2 / 就地条照常走消息回复链（雨霏 02:1x 口径）：没开已读不回 → 文字消息 100% 回。
       （链内的动作掷骰这一轮跳过——上面已掷过。） */
    if (m && typeof window._triggerDelayedReply === 'function') {
      try { window._triggerDelayedReply(true); } catch (e) {}
    }
    return m;
  }

  /* 同框卡渲染（core.js 的 createMessageFragment 调这个）
     <6 条全显示（不显示条数）；>=6 条只露最近 3 条。
     「展开互动」文字入口取消（雨霏 17:2x）：点头像 → <6 出就地条 / >=6 进展开层（18:05 定）。 */
  function renderActionCard(msg) {
    var wrap = document.createElement('div');
    wrap.className = 'action-card-msg';
    wrap.dataset.msgId = msg.id;
    var acts = msg.acts || [];
    var folded = acts.length >= FOLD_AT;
    var from = folded ? acts.length - SHOW_LAST : 0;
    var body = '';
    for (var i = from; i < acts.length; i++) body += '<div class="act">' + escapeHtml(acts[i].t) + '</div>';
    /* 就地动作条：照 demo ⑥ 只取底部滑条这一层，无条数、无提示、无输入框；
       末尾一格「＋ 新建」→ 快捷新建动作（2026-11-10 雨霏定：滑条里也要加号选项） */
    var tray = '<div class="ac-tray"><div class="tray-inner">';
    for (var t = 0; t < ACTS.length; t++) tray += trayCellHtml(ACTS[t]);
    tray += '<button class="tb tb-add" type="button"><span class="e">＋</span><b>新建</b></button>';
    tray += '</div></div>';
    wrap.innerHTML =
      '<div class="ac-card">' +
        '<div class="ac-head">' +
          '<div class="ac-av him"' + avatarStyle('him') + '></div>' +
          '<div class="ac-thread"><svg viewBox="0 0 228 76" preserveAspectRatio="none"><path d="M-6,48 C12,48 20,18 42,13 C60,9 66,40 46,45 C26,50 36,12 60,15 C86,18 92,58 118,62 C142,66 146,22 168,16 C188,10 196,44 212,48 C222,50 230,46 234,44" fill="none" stroke="#96272a" stroke-width="2" stroke-linecap="round"/></svg></div>' +
          '<div class="ac-av me"' + avatarStyle('me') + '></div>' +
        '</div>' +
        '<div class="ac-acts">' + body + '</div>' +
        tray +
      '</div>';

    var card = wrap.querySelector('.ac-card');
    /* 点任一头像：<6 条 → 卡底就地条；>=6 条 → 卡片展开层 */
    var avs = wrap.querySelectorAll('.ac-av');
    for (var a = 0; a < avs.length; a++) avs[a].addEventListener('click', function (e) {
      e.stopPropagation();
      if (folded) openStageLayer(msg);
      else card.classList.toggle('open');
    });
    /* 选一条 → 落到「被点中的这张卡」（不是当前活动卡），S3 100% 必回；随后 renderMessages 重建卡片，滑条自然收起 */
    var tbs = wrap.querySelectorAll('.tb[data-name]');
    for (var b = 0; b < tbs.length; b++) bindTrayCell(tbs[b], msg);
    var trayAdd = wrap.querySelector('.tb-add');
    if (trayAdd) trayAdd.addEventListener('click', function (e) {
      e.stopPropagation();
      openQuickAdd();
    });
    return wrap;
  }

  /* 展开互动层（v7 定稿 2026-11-08）：
     点「共 N 条 · 展开互动」进来；灰底压暗聊天，白色大卡装全部记录（无上限、可滚），
     右侧竖滑工具栏（emoji+文字 16 个）点了继续互动——你做句进同一张卡，他照常 1.6–3s 回应、
     实时滚进来。底部灰「收 起」退回聊天。没有「同框·共N条」抬头、没有红字。 */
  var _stage = null;
  var _stageCard = null;

  function stageAppend(o) {
    if (!_stage) return;
    var body = _stage.querySelector('.st-acts');
    if (!body || !o) return;
    var d = document.createElement('div');
    d.className = 'st-line';
    d.textContent = o.t;
    body.appendChild(d);
    body.scrollTop = body.scrollHeight;
  }

  function openStageLayer(cardMsg) {
    if (!cardMsg) {
      /* 没点名卡时：找最近一张有内容的卡 */
      for (var i = messages.length - 1; i >= 0; i--) {
        var mm = messages[i];
        if (mm && mm.type === 'action-card' && (mm.acts || []).length > 0) { cardMsg = mm; break; }
      }
    }
    if (!cardMsg) return;
    closeStageLayer(true);   // 已开着就先收，避免叠层

    var acts = cardMsg.acts || [];
    var lines = '';
    for (var k = 0; k < acts.length; k++) lines += '<div class="st-line">' + escapeHtml(acts[k].t) + '</div>';
    var bar = '';
    for (var b = 0; b < ACTS.length; b++) bar += stageCellHtml(ACTS[b]);
    bar += '<div class="st-b st-b-add"><div class="e">＋</div><div class="n">新建</div></div>';

    var ov = document.createElement('div');
    ov.className = 'mu-stage';
    ov.innerHTML =
      '<div class="st-inner"><div class="st-cardwrap"><div class="st-card">' +
        '<div class="st-head">' +
          '<div class="st-av him"' + avatarStyle('him') + '></div>' +
          '<div class="st-thread"><svg viewBox="0 0 228 76" preserveAspectRatio="none"><path d="M-6,48 C12,48 20,18 42,13 C60,9 66,40 46,45 C26,50 36,12 60,15 C86,18 92,58 118,62 C142,66 146,22 168,16 C188,10 196,44 212,48 C222,50 230,46 234,44" fill="none" stroke="#96272a" stroke-width="2" stroke-linecap="round"/></svg></div>' +
          '<div class="st-av me"' + avatarStyle('me') + '></div>' +
        '</div>' +
        '<div class="st-acts">' + lines + '</div>' +
        '<div class="st-fold">收 起</div>' +
      '</div></div>' +
      '<div class="st-bar">' + bar + '<div class="st-cnt">↓ 竖滑共 ' + ACTS.length + '</div></div></div>';
    document.body.appendChild(ov);

    /* 右侧工具栏：点 = 你做句进这张卡（addAct 里检测 _stageCard===m 自动 stageAppend） */
    var cells = ov.querySelectorAll('.st-b[data-name]');
    for (var c = 0; c < cells.length; c++) bindStageCell(cells[c], cardMsg);
    var stAdd = ov.querySelector('.st-b-add');
    if (stAdd) stAdd.addEventListener('click', function () { openQuickAdd(); });

    var fold = ov.querySelector('.st-fold');
    fold.addEventListener('click', function () { closeStageLayer(); });

    _stage = ov;
    _stageCard = cardMsg;
    var actsEl = ov.querySelector('.st-acts');
    actsEl.scrollTop = actsEl.scrollHeight;   // 停在最新一句
  }

  /* 附加 B（已定清单 §2:36，雨霏「先记着看着办」授权）：
     展开层开着时，他在外面发了文字或其他消息 → 那张卡震一下。
     2026-11-10 雨霏：只震展开层这一张。原来还会震聊天里卡底滑条拉着（open）的卡，
     日常发动作卡片时被他外面的消息带得抖一下，很干扰，这条去掉。 */
  function shakeOpenCards() {
    if (!_stage) return;
    var sc = _stage.querySelector('.st-card');
    if (!sc) return;
    sc.classList.remove('ac-shake');
    void sc.offsetWidth;          /* 强制回流，连续两次也能重播 */
    sc.classList.add('ac-shake');
  }

  function closeStageLayer(instant) {
    if (!_stage) return;
    var ov = _stage;
    _stage = null; _stageCard = null;
    if (instant) { if (ov.parentNode) ov.parentNode.removeChild(ov); return; }
    ov.style.opacity = '0';
    ov.style.transition = 'opacity .25s ease';
    setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 260);
  }

  /* ── 退场 · B 合幕（2026-11-08 雨霏定；替代原先 0.8s 纯淡出的 dismiss）──
     放过她 → 幕上居中显出他那句 → 左右合幕；
     小海星 → 幕上居中显出「小海星」→ 左右合幕。
     两句都与中缝金线成垂直交叉。留痕与谁结束无关，合死那一刻就落（她定：幕布结束就出现）。
     时间轴（2026-11-08 按她选定的演示速度重排，整段约 6.5s）：
      文案 0–1.0s 浮出 → 1.5–3.1s 两片合拢 → 2.2s 金线亮、2.9s 起 1.4s 渐隐
      → 3.9–5.3s 整层化开、聊天浮现 → 5.3s 留痕落地、1.2s 渐入 → 6.5s 移除。 */
  var CLOSE_JOIN_MS   = 3100;   // 左右合死
  var CLOSE_FADE_AT   = 3900;   // 整层开始化开
  var CLOSE_FADE_MS   = 1400;   // 化开 / 聊天浮现
  var CLOSE_TRACE_AT  = 5300;   // 清场留痕落地（聊天已露出）
  var CLOSE_GONE_MS   = 6500;   // 移除 overlay

  /* 定稿 demo：一句一行硬断、去逗号。文案是常量、不经用户输入，故用 innerHTML 渲染 <br>。 */
  var SHUT_WORD = {
    fangguo: '我不会让你掉下去的<br>永远不会',
    pstar: '小海星'
  };

  function closeCurtain(kind) {
    if (!_overlay) return;
    var ov = _overlay;
    _overlay = null;
    _live = null;

    var shut = document.createElement('div');
    shut.className = 'mu-shut';
    shut.innerHTML =
      '<div class="mu-shut-l"></div><div class="mu-shut-r"></div>' +
      '<div class="mu-shut-line"></div><div class="mu-shut-txt"></div>';
    var txt = shut.querySelector('.mu-shut-txt');
    if (kind === 'pstar') txt.classList.add('safe');          // 小海星：16px / 字距 8
    txt.innerHTML = SHUT_WORD[kind] || SHUT_WORD.fangguo;     // 固定两句，不经用户输入
    ov.appendChild(shut);

    /* 文案与金线都不单独淡出：金线自己 2.9s 起渐隐，文案跟着整层一起化开，
       跟演示里一致（旧版是合死后先清字再黑场，快得发飘） */

    /* 整层化开：此刻两片已合死、画面纯黑，观感是暗场转亮，不是闪退 */
    setTimeout(function () {
      ov.style.transition = 'opacity ' + (CLOSE_FADE_MS / 1000) + 's ease';
      ov.style.opacity = '0';
    }, CLOSE_FADE_AT);

    /* 聊天露出后再落留痕（她定「幕布结束就出现，和谁结束没关系」） */
    setTimeout(function () { leaveCurtainTrace(); }, CLOSE_TRACE_AT);

    setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, CLOSE_GONE_MS);
  }

  /* ── 幕内 live 界面（live.html 原型移植 2026-11-08）──
     顺序（幕布-设定.md:69）：宣言退场 → 面板升起 → 他先落一个动作 → 你才能动手。
     他的每次摸取含【放过她】（与全部 him 文案同库等概率，见 liveRoll；设定档:64 原话
     「16 日常动作 + 放过她 + 小海星，同一库等概率摸取」），摸到即散场并留痕；
     【小海星】= 她的退出键（安全词），同样散场留痕。 */
  var _live = null;
  var _liveEls = [];
  var _liveRaf = 0, _liveHideT = 0, _liveDragging = false, _liveSy = 0, _liveSt0 = 0;
  var LIVE_RANGE = 145;        // live.html:147 / 设定档 §7
  /* 【放过她】不写死概率（雨霏 22:4x 定「跟所有其他的一样就行」）：
     把它当成池子里的第 N+1 项，和他每一条文案一样等概率——见 liveRoll()。
     16 条 him 文案时仍是 1/17（与旧口径等价），她每加一句文案就自然变稀。 */

  /* 幕内他回应的正文走 pickCopy('him')：文案平铺、每条等概率，不按「先动作再文案」两段抽。 */

  /* 他的「摸取」：从「全部 him 文案 + 放过她」里等概率抽一项。
     返回文案字符串；返回 null 表示摸到【放过她】→ 由调用方散场。
     与设定档:64「16 日常动作 + 放过她 + 小海星，同一库等概率摸取」同口径，
     只是把「动作」换成「文案条」，跟上面 22:2x 的平铺改造对齐。 */
  function liveRoll() {
    var pool = copyPool('him');
    var i = Math.floor(Math.random() * (pool.length + 1));
    return i >= pool.length ? null : pool[i];
  }

  /* 景深（live.html:153-172 原样）：离焦点越远越小越暗，低于 .12 归零并清 blur */
  function livePaint() {
    if (!_live) return;
    var Z = _live.querySelector('.zone');
    var I = _live.querySelector('.inner');
    var BT = _live.querySelector('.bar i');
    if (!Z || !I || !BT) return;
    var zH = Z.clientHeight, focal = zH - 42, st = Z.scrollTop;
    for (var i = 0; i < _liveEls.length; i++) {
      var el = _liveEls[i];
      var bottomIn = el.offsetTop + el.offsetHeight - st;
      var a = Math.abs(bottomIn - focal);
      if (a >= LIVE_RANGE) { el.style.opacity = '0'; el.style.filter = 'none'; continue; }
      var k = a / LIVE_RANGE, op = Math.pow(1 - k, 2);
      if (op < 0.12) { el.style.opacity = '0'; el.style.filter = 'none'; continue; }
      el.style.transform = 'scale(' + (1 - k * 0.22).toFixed(3) + ')';
      el.style.opacity = op.toFixed(3);
      el.style.filter = 'blur(' + (k * 1).toFixed(2) + 'px)';
    }
    var total = I.scrollHeight;
    if (total > zH) {
      var th = Math.max(26, zH * zH / total);
      BT.style.height = th + 'px';
      BT.style.top = (st / (total - zH)) * (zH - th) + 'px';
    }
  }

  /* 让最新一句贴住焦点（焦点 = 动作区底部往上 42px，live.html:154 原式）。
     原型是 300×520 的框、动作区高 262px，首句留白写死 210px 正好落在焦点上；
     站里幕布是全屏，动作区被拉到 652px，210px 的留白让句子停在可见带上方 350px 的死区，
     livePaint 直接判 opacity:0——实测进幕内前 6 句一个字都看不见（2026-11-08 修）。
     这里每加一句重算一次：不足一屏时用首句留白把内容顶到焦点；超过一屏时留白归零、自然滚动。
     景深、可见带、字号一个都没动，只是把「首句贴焦点」这个原意搬到任意屏高。 */
  function liveFit() {
    if (!_live) return;
    var Z = _live.querySelector('.zone');
    var I = _live.querySelector('.inner');
    if (!Z || !I) return;
    I.style.paddingTop = '0px';
    var slack = Z.clientHeight - I.scrollHeight;   // scrollHeight 已含 padding-bottom 34
    I.style.paddingTop = Math.max(0, slack) + 'px';
  }

  function liveAddLine(text, who) {
    if (!_live) return;
    var I = _live.querySelector('.inner');
    var Z = _live.querySelector('.zone');
    var H = _live.querySelector('.hint');
    if (!I || !Z) return;
    var el = document.createElement('div');
    el.className = 'ln ' + who;
    var t = document.createElement('span'); t.className = 't'; t.textContent = text;
    el.appendChild(t); I.appendChild(el); _liveEls.push(el);
    liveFit();
    Z.scrollTop = Z.scrollHeight;
    livePaint();
    if (H) H.classList.add('gone');
  }

  /* 他摸一次：和全部 him 文案 + 放过她同库等概率；摸到放过她就散场（他的结束键，不进她的面板）。
     safe=true（开场第一句）：免掷放过她，必出一句——雨霏 23:1x 定「需要的需要的」，
     进幕第一下就散太扫兴；散场从第二摸起才参与。 */
  function heActs(safe) {
    if (!_live || !_overlay) return;
    var t = safe ? pickCopy('him') : liveRoll();
    if (t === null) { endCurtain('fangguo'); return; }
    liveAddLine(t, 'him');
  }

  /* 你点面板：你做句幕内滚入，他 1.8–3.0s 回应
     （2026-11-08 雨霏「幕布里面他的回复速度稍微有点快」：原 1.2–2.1s 放慢一档）
     她点的那一格有确定名字 → 只从该动作的「你做」几句里取；无名兜底才走平铺池。 */
  function meActs(name, text) {
    if (!_live || !_overlay) return;
    var a = name ? findAct(name) : null;
    var t = text || (a ? pickOne(a.me) : pickCopy('me'));
    if (!t) t = pickCopy('me');
    liveAddLine(t, 'me');
    setTimeout(function () {
      if (_live && _overlay) heActs();
    }, 1800 + Math.floor(Math.random() * 1200));
  }

  function buildLivePanel() {
    var TR = _live.querySelector('.ptrack');
    var D = _live.querySelector('.dots');
    var VP = _live.querySelector('.pviewport');
    if (!TR || !D || !VP) return;
    TR.innerHTML = ''; D.innerHTML = '';
    var pages = Math.ceil(ACTS.length / 8);
    for (var p = 0; p < pages; p++) {
      var page = document.createElement('div'); page.className = 'ppage';
      ACTS.slice(p * 8, p * 8 + 8).forEach(function (a) {
        var b = document.createElement('button');
        b.className = 'pcard'; b.type = 'button'; b.textContent = a.n;
        b.addEventListener('click', function () {
          chooseCopy(a.n, 'me', function (txt) { if (txt) meActs(a.n, txt); });   /* 5-1：多条文案挑一条 */
        });
        page.appendChild(b);
      });
      TR.appendChild(page);
      var dot = document.createElement('i');
      if (p === 0) dot.className = 'on';
      D.appendChild(dot);
    }
    function syncDots() {
      var n = Math.round(VP.scrollLeft / VP.clientWidth);
      var ds = D.children;
      for (var i = 0; i < ds.length; i++) ds[i].className = (i === n ? 'on' : '');
    }
    VP.addEventListener('scroll', syncDots, { passive: true });
  }

  function enterLive(ov) {
    if (!ov || _live) return;
    var lv = document.createElement('div');
    lv.className = 'mu-live';
    lv.innerHTML =
      '<div class="hair"></div>' +
      '<div class="zone"><div class="inner"></div></div>' +
      '<div class="bar"><i></i></div>' +
      '<div class="hint">往下拖 · 往回看</div>' +
      '<div class="pnl">' +
        '<div class="ph"><span class="dots"></span></div>' +
        '<div class="pviewport"><div class="ptrack"></div></div>' +
        '<button class="pstar" type="button">小海星</button>' +
      '</div>';
    ov.appendChild(lv);
    _live = lv;
    _liveEls = [];
    /* 面板 B → live 的交接（2026-11-08 修闪屏）：
       原来这里立刻把 act2 display:none，而 live 是 opacity:0 起、.45s 才淡到 1，
       中间有 .45s 整屏纯黑（实测：act2=none、live opacity=0、可见句子 0）——观感就是「闪一下」。
       现在 act2 先留着当底，等 live 淡到不透明再撤，变成一次覆盖式淡入，不再有黑窗。 */
    var a1 = ov.querySelector('#mu-act1'); if (a1) a1.style.display = 'none';
    var a2 = ov.querySelector('#mu-act2');
    if (a2) setTimeout(function () {
      if (_live === lv) a2.style.display = 'none';
    }, 470);

    buildLivePanel();
    liveFit();
    if (!window.__liveFitBound) {
      window.__liveFitBound = true;
      window.addEventListener('resize', liveFit);
    }
    var Z = lv.querySelector('.zone'), S = lv.querySelector('.bar');
    Z.addEventListener('scroll', function () {
      if (_liveRaf) return;
      _liveRaf = requestAnimationFrame(function () { _liveRaf = 0; livePaint(); });
      S.classList.add('on');
      clearTimeout(_liveHideT);
      _liveHideT = setTimeout(function () { if (!_liveDragging) S.classList.remove('on'); }, 700);
    }, { passive: true });
    Z.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse') return;
      _liveDragging = true; _liveSy = e.clientY; _liveSt0 = Z.scrollTop;
      Z.setPointerCapture(e.pointerId); S.classList.add('on');
    });
    Z.addEventListener('pointermove', function (e) {
      if (_liveDragging) Z.scrollTop = _liveSt0 - (e.clientY - _liveSy);
    });
    Z.addEventListener('pointerup', function () {
      if (!_liveDragging) return; _liveDragging = false;
      clearTimeout(_liveHideT);
      _liveHideT = setTimeout(function () { S.classList.remove('on'); }, 700);
    });
    Z.addEventListener('wheel', function () { S.classList.add('on'); }, { passive: true });
    lv.querySelector('.pstar').addEventListener('click', function () { endCurtain('pstar'); });
    requestAnimationFrame(function () { lv.classList.add('on'); });
    /* 他先动（live.html:243 / 设定档:69）；开场第一句免掷放过她（雨霏 23:1x） */
    setTimeout(function () { if (_live === lv && _overlay === ov) heActs(true); }, 600);
  }

  function endCurtain(kind) { closeCurtain(kind === 'pstar' ? 'pstar' : 'fangguo'); }

  /* 散场留痕：聊天流里整宽一行小字、居中、无横线（2026-11-08 雨霏：我不要横线）。
     文案 =「{HH:MM}，他清场了」，时间取站内同一套格式化（core.js:1442），不手写死。
     与谁结束无关（她定：幕布结束就出现）。 */
  function leaveCurtainTrace() {
    var hm = '';
    try {
      hm = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (e) {}
    var text = (hm ? hm + '，' : '') + '他清场了';
    try {
      messages.push({
        type: 'curtain-trace',
        id: 'ct_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        sender: 'system',
        timestamp: Date.now(),
        text: text
      });
      if (typeof renderMessages === 'function') renderMessages();
      if (typeof throttledSaveData === 'function') throttledSaveData();
    } catch (e) {}
  }

  /* 样式注入（幂等）：脚本加载即注入，不等第一次拉幕布——
     否则同框卡在没拉过幕布的会话里没有样式（2026-11-08 实测踩过）。 */
  /* 日常主动发动作的面板（补设定档缺口）：加号菜单原地替换方式（用户定案"方式2"，不另起浮层）。
     浅底、跟随主题（延续面板 B 定案）；emoji + 动作名，无标题（2026-11-08 拍板：不要「你的动作」抬头）。 */
  var PICKER_STYLE =
    '.mu-picker{width:100%;box-sizing:border-box;padding:10px 10px 12px;animation:mu-picker-in .18s ease}' +
    '.mu-picker-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}' +
    '.mu-picker-cell{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;height:66px;' +
      'background:var(--toolbar-btn-bg,#f5f5f5);border:1px solid var(--border-color,rgba(0,0,0,.06));border-radius:12px;cursor:pointer;' +
      '-webkit-tap-highlight-color:transparent;transition:background .15s ease}' +
    '.mu-picker-cell:active{background:rgba(192,57,43,.08)}' +
    '.mu-picker-emoji{font-size:22px;line-height:1}' +
    '.mu-picker-name{font-size:11px;color:var(--text-primary,#333)}' +
    /* 底栏（2026-11-10 雨霏定：取消旁边加文字按钮「＋ 新建动作」，动作格子保持纯动作） */
    '.mu-picker-foot{display:flex;gap:8px;margin-top:10px}' +
    '.mu-picker-foot>button{flex:1;height:36px;border-radius:10px;font-size:13px;cursor:pointer;' +
      'font-family:inherit;-webkit-tap-highlight-color:transparent}' +
    '.mu-picker-add{background:transparent;border:1px solid var(--border-color,rgba(0,0,0,.1));' +
      'color:var(--accent-color,#c5a47e)}' +
    '.mu-picker-cancel{background:transparent;' +
      'border:1px solid var(--border-color,rgba(0,0,0,.1));border-radius:10px;font-size:13px;' +
      'color:var(--text-secondary,#666);cursor:pointer;-webkit-tap-highlight-color:transparent}' +
    '@keyframes mu-picker-in{from{opacity:0}to{opacity:1}}' +
    /* 分页（5-2） */
    '.mu-picker-viewport{overflow-x:auto;scrollbar-width:none}' +
    '.mu-picker-viewport::-webkit-scrollbar{display:none}' +
    '.mu-picker-track{display:flex}' +
    '.mu-picker-page{min-width:100%;flex:0 0 100%}' +
    '.mu-picker-dots{display:flex;justify-content:center;gap:5px;margin-bottom:8px}' +
    '.mu-picker-dot{width:5px;height:5px;border-radius:50%;background:var(--border-color,rgba(0,0,0,.15))}' +
    '.mu-picker-dot.on{background:var(--accent-color,#c5a47e)}' +
    /* 多文案挑选浮层（5-1） */
    '.mu-copy{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,.35);' +
      'display:flex;align-items:center;justify-content:center;animation:mu-picker-in .18s ease}' +
    '.mu-copy-card{width:min(320px,86%);max-height:70%;background:var(--primary-bg,#fff);border-radius:16px;' +
      'padding:14px;display:flex;flex-direction:column;box-sizing:border-box}' +
    '.mu-copy-head{font-size:14px;font-weight:700;color:var(--text-primary,#333);text-align:center;margin-bottom:10px}' +
    '.mu-copy-list{overflow-y:auto;scrollbar-width:none}' +
    '.mu-copy-list::-webkit-scrollbar{display:none}' +
    '.mu-copy-it{display:block;width:100%;box-sizing:border-box;margin-bottom:8px;padding:10px 12px;' +
      'background:var(--toolbar-btn-bg,#f5f5f5);border:1px solid var(--border-color,rgba(0,0,0,.06));' +
      'border-radius:11px;font-size:13px;line-height:1.6;color:var(--text-primary,#333);text-align:left;' +
      'cursor:pointer;font-family:inherit;-webkit-tap-highlight-color:transparent}' +
    '.mu-copy-it:active{background:rgba(192,57,43,.08)}' +
    '.mu-copy-cancel{margin-top:2px;width:100%;height:36px;background:transparent;' +
      'border:1px solid var(--border-color,rgba(0,0,0,.1));border-radius:10px;font-size:13px;' +
      'color:var(--text-secondary,#666);cursor:pointer;font-family:inherit}' +
    /* 快捷新建动作（2026-11-10 雨霏定：三入口共用 E2-A 轻量弹层 + 「打开完整动作库」跳转）
       三个入口的「＋」格：就地条 / 展开层侧栏 */
    '.action-card-msg .tb-add{opacity:.72}' +
    '.action-card-msg .tb-add .e{font-size:17px;color:var(--text-secondary,#999)}' +
    '.action-card-msg .tb-add b{color:var(--text-secondary,#999)}' +
    '.mu-stage .st-b-add{background:rgba(255,255,255,.05);border:.5px dashed rgba(255,255,255,.34)}' +
    '.mu-stage .st-b-add .n{color:rgba(242,237,230,.82)}' +
    '.qa{position:fixed;inset:0;z-index:1000006;background:rgba(0,0,0,.35);' +
      'display:flex;align-items:center;justify-content:center;animation:mu-picker-in .18s ease;' +
      'font-family:-apple-system,"PingFang SC",sans-serif}' +
    '.qa-card{width:min(340px,88%);max-height:84%;overflow-y:auto;background:var(--primary-bg,#fff);' +
      'border-radius:16px;padding:16px;box-sizing:border-box}' +
    '.qa-title{font-size:14px;font-weight:700;color:var(--text-primary,#333);text-align:center;margin-bottom:12px}' +
    '.qa-row{display:flex;gap:8px;margin-bottom:10px}' +
    '.qa-e{width:56px;flex:0 0 56px;height:38px;box-sizing:border-box;text-align:center;font-size:18px;' +
      'border:1px solid var(--border-color,rgba(0,0,0,.1));border-radius:10px;background:var(--toolbar-btn-bg,#f7f7f7);' +
      'color:var(--text-primary,#333);font-family:inherit;outline:none}' +
    '.qa-n{flex:1;min-width:0;height:38px;box-sizing:border-box;padding:0 10px;font-size:13px;font-weight:700;' +
      'border:1px solid var(--border-color,rgba(0,0,0,.1));border-radius:10px;background:var(--toolbar-btn-bg,#f7f7f7);' +
      'color:var(--text-primary,#333);font-family:inherit;outline:none}' +
    '.qa-lab{display:block;font-size:11px;color:var(--text-secondary,#666);margin:0 0 4px}' +
    '.qa-ta{width:100%;box-sizing:border-box;min-height:58px;padding:8px 10px;border-radius:10px;' +
      'border:1px solid var(--border-color,rgba(0,0,0,.1));background:var(--toolbar-btn-bg,#f7f7f7);' +
      'color:var(--text-primary,#333);font-size:12px;line-height:1.6;font-family:inherit;resize:vertical;outline:none}' +
    '.qa-foot{display:flex;gap:8px;margin-top:14px}' +
    '.qa-btn{flex:1;height:38px;border-radius:10px;font-size:13px;cursor:pointer;font-family:inherit;' +
      '-webkit-tap-highlight-color:transparent}' +
    '.qa-cancel{background:transparent;border:1px solid var(--border-color,rgba(0,0,0,.1));color:var(--text-secondary,#666)}' +
    '.qa-save{background:var(--accent-color,#c5a47e);border:none;color:#fff;font-weight:700}' +
    '.qa-more{display:block;width:100%;margin-top:10px;height:34px;background:transparent;border:none;' +
      'color:var(--text-secondary,#666);font-size:12px;cursor:pointer;font-family:inherit;' +
      'text-decoration:underline;-webkit-tap-highlight-color:transparent}';

  function ensureStyles() {
    if (document.getElementById('curtain-style')) return;
    var st = document.createElement('style');
    st.id = 'curtain-style';
    st.textContent = STYLE + PANEL_STYLE + ACTION_CARD_STYLE + STAGE_STYLE + PICKER_STYLE + LIVE_STYLE + TRACE_STYLE;
    document.head.appendChild(st);
  }
  ensureStyles();

  /* 拉幕布：单一实例，已在幕中就不再叠一层 */
  function raiseCurtain() {
    if (_overlay) return;
    if (_stage) closeStageLayer(true);   // 幕布盖住展开层，退场后会蒙在聊天上——起幕时顺手收掉
    _canExit = false;

    var ov = document.createElement('div');
    ov.id = 'curtain-overlay';
    ov.innerHTML =
      '<div class="mu-frame">' + ACT1_HTML + ACT2_HTML + '</div>';
    document.body.appendChild(ov);

    ensureStyles();
    /* 变量挂在 overlay 上（原 film.html :root 值） */
    ov.style.cssText += '--mu-frame-w:300px;--mu-frame-h:520px;--mu-frame-r:26px;' +
      '--mu-bg:#070605;--mu-gold:#c5a47e;--mu-ink:#efe5d5;' +
      '--mu-ink-soft:rgba(241,232,217,.6);--mu-seal:rgba(255,255,255,.3);' +
      '--mu-hair:rgba(197,164,126,.16);--mu-dur:12s;';

    _overlay = ov;

    var a1 = ov.querySelector('#mu-act1');
    var a2 = ov.querySelector('#mu-act2');
    a2.style.display = 'none';

    /* 第一幕播完 → 黑里切第二幕（跳承接段），面板升起后开放退出 */
    setTimeout(function () {
      if (_overlay !== ov) return;
      a1.style.display = 'none';
      a2.style.display = 'block';
      var kids = a2.querySelectorAll('.a');
      for (var i = 0; i < kids.length; i++) kids[i].style.animationDelay = '-1.3s';
      var mount = a2.querySelector('#mu-panel-mount');
      /* 开场的面板 B 只作展示（设定档:69「他先动 → 你才能动手」）：
         面板停住后由 enterLive 接上可点的 live 面板；幕内点动作不再落聊天同框卡（她的口径）。 */
      if (mount) mount.appendChild(buildPanel());
      var star = a2.querySelector('.pstar');
      if (star) star.addEventListener('click', function () {
        /* 小海星 = 她的退出键，同样走 B 合幕 + 清场留痕（面板 B 的兜底；enterLive 后 act2 隐藏，由 live 面板接管） */
        if (_canExit) endCurtain('pstar');
      });
      /* 面板升起到位、画面停住 → 转 live 幕内界面（绝对时间 T1+T2 = 18.9s，
         对应 film.html 时间轴 18.9–21.9s「面板停住」） */
      setTimeout(function () {
        if (_overlay !== ov) return;
        enterLive(ov);
      }, T2);
      setTimeout(function () {
        if (_overlay !== ov) return;
        _canExit = true;
      }, T2 + AFTER_PANEL);
    }, T1);
  }

  /* 清场卡发出后：收掉"正在输入中"，稍等字卡被看见，再拉幕布 */
  function onCurtainCardSent() {
    try {
      if (window._typingIndicatorAutoHideTimer) {
        clearTimeout(window._typingIndicatorAutoHideTimer);
        window._typingIndicatorAutoHideTimer = null;
      }
      var tiW = document.getElementById('typing-indicator-wrapper');
      if (tiW) {
        var tiInner = tiW.querySelector('.typing-indicator');
        if (tiInner) {
          tiInner.classList.add('hiding');
          setTimeout(function () {
            tiW.style.display = 'none';
            if (tiInner) tiInner.classList.remove('hiding');
          }, 240);
        } else {
          tiW.style.display = 'none';
        }
      }
    } catch (e) {}
    setTimeout(raiseCurtain, 900);
  }

  /* 5-1 多条文案（已定清单 §9）：发动作时把该动作的文案列出来，雨霏挑一条；
     只有一条时直接发，不弹选择。cb(文案 or null)。 */
  function chooseCopy(name, who, cb) {
    var a = findAct(name);
    var arr = a ? (who === 'me' ? a.me : a.him) : [];
    if (!arr.length) { cb(null); return; }
    if (arr.length === 1) { cb(arr[0]); return; }
    var ov = document.createElement('div');
    ov.className = 'mu-copy';
    var items = '';
    for (var i = 0; i < arr.length; i++) {
      items += '<button class="mu-copy-it" type="button">' + escapeHtml(arr[i]) + '</button>';
    }
    ov.innerHTML = '<div class="mu-copy-card">' +
      '<div class="mu-copy-head">' + escapeHtml((a && a.e) ? a.e + ' ' : '') + escapeHtml(name) + '</div>' +
      '<div class="mu-copy-list">' + items + '</div>' +
      '<button class="mu-copy-cancel" type="button">取消</button></div>';
    document.body.appendChild(ov);
    var done = false;
    function close(val) {
      if (done) return;
      done = true;
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      cb(val);
    }
    var its = ov.querySelectorAll('.mu-copy-it');
    for (var k = 0; k < its.length; k++) (function (btn) {
      btn.addEventListener('click', function () { close(btn.textContent); });
    })(its[k]);
    ov.querySelector('.mu-copy-cancel').addEventListener('click', function () { close(null); });
    ov.addEventListener('click', function (e) { if (e.target === ov) close(null); });
  }

  /* ───── 快捷新建动作（2026-11-10 雨霏定）─────
     三入口共用：＋面板底栏「＋ 新建动作」/ 卡内就地条末格「＋」/ 展开层侧栏「＋」。
     弹层：emoji、动作名、他做、你做（一行一句，可多句）；存完只入库、不自动发（E3-A）。
     弹层里再给一条「打开完整动作库」，跳到 内容管理 → 氛围感 → 动作 做精细编辑（E2-A + 跳转）。
     持久化交给 action-bank.js 的 _actionBankAppend（同一套 storage key，不另存一份）。 */

  var _pickerHost = null;   // 当前挂着的＋面板（container + onDone），新增动作后用来原地重挂

  function trayCellHtml(a) {
    return '<button class="tb" type="button" data-name="' + escapeHtml(a.n) + '">' +
      '<span class="e">' + escapeHtml(a.e) + '</span>' +
      '<b>' + escapeHtml(a.n) + '</b></button>';
  }

  function stageCellHtml(a) {
    return '<div class="st-b" data-name="' + escapeHtml(a.n) + '">' +
      '<div class="e">' + escapeHtml(a.e) + '</div>' +
      '<div class="n">' + escapeHtml(a.n) + '</div></div>';
  }

  /* 卡内就地条：落回被点的这张卡（S3，50% + 1.6–2.8s） */
  function bindTrayCell(btn, msg) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var nm = btn.getAttribute('data-name');
      chooseCopy(nm, 'me', function (txt) {
        if (txt) userAct(nm, { card: msg, text: txt });
      });
    });
  }

  /* 展开层侧栏：动作回复 100%（1.6–2.8s 落本卡）+ 额外 10% 外面文字（11-07 12:31 原话） */
  function bindStageCell(cell, cardMsg) {
    cell.addEventListener('click', function () {
      var nm = cell.getAttribute('data-name');
      chooseCopy(nm, 'me', function (txt) {
        if (txt) userAct(nm, { card: cardMsg, text: txt, stage: true });
      });
    });
  }

  function qaLines(text) {
    return String(text || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function qaWarn(msg) {
    if (typeof showNotification === 'function') showNotification(msg, 'warning');
    else alert(msg);
  }

  /* 跳到完整编辑页：内容管理 → 氛围感 → 动作（复用现成 tab，不重造编辑器） */
  function openActionBankPanel() {
    try {
      var modal = document.getElementById('custom-replies-modal');
      if (!modal) { qaWarn('找不到内容管理面板，刷新一下再试'); return; }
      if (typeof showModal === 'function') showModal(modal); else modal.style.display = 'flex';
      var major = modal.querySelector('.sidebar-btn[data-major="atmosphere"]');
      if (major) major.click();                     // 子 tab 由这次点击重画
      var pickTab = function () {
        var tab = modal.querySelector('.reply-tab-btn[data-id="actionBank"]');
        if (tab) tab.click();
      };
      pickTab();
      setTimeout(pickTab, 80);                      // 兜一次：子 tab 重画若走异步
    } catch (e) {}
  }

  /* 存完刷新三处已开着的入口，新动作立刻能点（不自动发） */
  function refreshActHosts() {
    var i, last = ACTS[ACTS.length - 1];
    /* ＋面板：整块重挂（分页可能从 1 页变 2 页），滚到最后一页让新动作可见 */
    if (_pickerHost && _pickerHost.container && document.body.contains(_pickerHost.container)) {
      var hostC = _pickerHost.container, hostDone = _pickerHost.onDone;
      mountPicker(hostC, hostDone);
      var vp = hostC.querySelector('.mu-picker-viewport');
      if (vp) vp.scrollLeft = vp.scrollWidth;
    }
    /* 卡内就地条：插在「＋ 新建」格前面 */
    var inners = document.querySelectorAll('.ac-tray .tray-inner');
    if (last && inners.length) {
      for (i = 0; i < inners.length; i++) {
        var host = inners[i];
        var holder = document.createElement('div');
        holder.innerHTML = trayCellHtml(last);
        var node = holder.firstChild;
        if (!node) continue;
        var wrapEl = host.parentNode;
        while (wrapEl && !(wrapEl.classList && wrapEl.classList.contains('action-card-msg'))) wrapEl = wrapEl.parentNode;
        var msgObj = null;
        if (wrapEl && wrapEl.dataset && wrapEl.dataset.msgId) {
          for (var k = 0; k < messages.length; k++) {
            if (messages[k] && messages[k].id === wrapEl.dataset.msgId) { msgObj = messages[k]; break; }
          }
        }
        bindTrayCell(node, msgObj);
        host.insertBefore(node, host.querySelector('.tb-add'));
      }
    }
    /* 展开层侧栏：插在「＋ 新建」格前面（与滑条/面板同款位置），顺带更新条数 */
    if (_stage && last) {
      var barEl = _stage.querySelector('.st-bar');
      var cnt = _stage.querySelector('.st-cnt');
      if (barEl) {
        var addEl = barEl.querySelector('.st-b-add');
        var h2 = document.createElement('div');
        h2.innerHTML = stageCellHtml(last);
        var node2 = h2.firstChild;
        if (node2) {
          bindStageCell(node2, _stageCard);
          barEl.insertBefore(node2, addEl || cnt || null);
        }
      }
      if (cnt) cnt.textContent = '↓ 竖滑共 ' + ACTS.length;
    }
  }

  function openQuickAdd() {
    var ov = document.createElement('div');
    ov.className = 'qa';
    ov.innerHTML =
      '<div class="qa-card">' +
        '<div class="qa-title">新建动作</div>' +
        '<div class="qa-row">' +
          '<input class="qa-e" maxlength="4" placeholder="💗" value="💗">' +
          '<input class="qa-n" maxlength="10" placeholder="动作名（如：牵手）">' +
        '</div>' +
        '<label class="qa-lab">他做（一行一句，可多句）</label>' +
        '<textarea class="qa-ta qa-him" placeholder="他做的一句话"></textarea>' +
        '<label class="qa-lab" style="margin-top:10px;">你做（一行一句，可多句）</label>' +
        '<textarea class="qa-ta qa-me" placeholder="你做的一句话"></textarea>' +
        '<div class="qa-foot">' +
          '<button class="qa-btn qa-cancel" type="button">取消</button>' +
          '<button class="qa-btn qa-save" type="button">保存</button>' +
        '</div>' +
        '<button class="qa-more" type="button">打开完整动作库</button>' +
      '</div>';
    document.body.appendChild(ov);

    var done = false;
    function close() {
      if (done) return;
      done = true;
      if (ov.parentNode) ov.parentNode.removeChild(ov);
    }

    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('.qa-cancel').addEventListener('click', close);
    /* 跳完整库：先把当前入口收起来，别让菜单/展开层压在内容管理上面 */
    ov.querySelector('.qa-more').addEventListener('click', function () {
      close();
      if (_stage) closeStageLayer(true);
      if (_pickerHost && typeof _pickerHost.onDone === 'function') _pickerHost.onDone();
      openActionBankPanel();
    });
    ov.querySelector('.qa-save').addEventListener('click', function () {
      var n = ov.querySelector('.qa-n').value.trim();
      var e = ov.querySelector('.qa-e').value.trim() || '💗';
      var him = qaLines(ov.querySelector('.qa-him').value);
      var me = qaLines(ov.querySelector('.qa-me').value);
      if (!n) { qaWarn('动作名还没填'); return; }
      for (var i = 0; i < ACTS.length; i++) {
        if (ACTS[i].n === n) { qaWarn('已经有叫「' + n + '」的动作了，换个名字'); return; }
      }
      if (!him.length || !me.length) { qaWarn('他做 / 你做至少各要一句'); return; }
      if (typeof window._actionBankAppend !== 'function') { qaWarn('动作库没加载好，刷新一下再试'); return; }
      /* 2026-11-10 修：append 改同步返回（内存生效即 true），界面立刻刷新；
         写盘在 action-bank 后台跑、失败自己会提醒。不再让 UI 等存储 IO。 */
      var ok = false;
      try { ok = window._actionBankAppend({ n: n, e: e, him: him, me: me }); } catch (err) { ok = false; }
      if (!ok) { qaWarn('保存失败，再试一次'); return; }
      close();
      refreshActHosts();
      if (typeof showNotification === 'function') showNotification('✓ 已添加动作「' + n + '」', 'success');
    });

    setTimeout(function () { try { ov.querySelector('.qa-n').focus(); } catch (e) {} }, 60);
  }

  /* 日常主动发动作：挂进加号菜单面板（原地替换，more-menu.js 调用）。
     点动作格 = 发"你做"句进同框卡（userAct，复用无上限累积/折叠 + 他 1.6–3s 必回应）；
     onDone 由 more-menu 提供：恢复菜单网格并收起面板。 */
  function mountPicker(container, onDone) {
    if (!container) return;
    /* 5-2 数量无上限：>16 个动作自动分页（每页 16，横滑 + 页点，照幕内面板那套） */
    var PAGES = [], pp = [];
    for (var i = 0; i < ACTS.length; i++) {
      pp.push(ACTS[i]);
      if (pp.length === 16) { PAGES.push(pp); pp = []; }
    }
    if (pp.length) PAGES.push(pp);

    var dots = '';
    for (var d = 0; d < PAGES.length; d++) dots += '<i class="mu-picker-dot' + (d === 0 ? ' on' : '') + '"></i>';
    var track = '';
    for (var g = 0; g < PAGES.length; g++) {
      track += '<div class="mu-picker-page"><div class="mu-picker-grid">';
      for (var c = 0; c < PAGES[g].length; c++) {
        track += '<button class="mu-picker-cell" data-name="' + escapeHtml(PAGES[g][c].n) + '">' +
          '<span class="mu-picker-emoji">' + escapeHtml(PAGES[g][c].e) + '</span>' +
          '<span class="mu-picker-name">' + escapeHtml(PAGES[g][c].n) + '</span></button>';
      }
      track += '</div></div>';
    }
    container.innerHTML = '<div class="mu-picker">' +
      (PAGES.length > 1 ? '<div class="mu-picker-dots">' + dots + '</div>' : '') +
      '<div class="mu-picker-viewport"><div class="mu-picker-track">' + track + '</div></div>' +
      '<div class="mu-picker-foot">' +
        '<button class="mu-picker-add" type="button">＋ 新建动作</button>' +
        '<button class="mu-picker-cancel" type="button">取消</button>' +
      '</div></div>';
    _pickerHost = { container: container, onDone: onDone };

    if (PAGES.length > 1) {
      var vp = container.querySelector('.mu-picker-viewport');
      var ds = container.querySelectorAll('.mu-picker-dot');
      vp.addEventListener('scroll', function () {
        var n = Math.round(vp.scrollLeft / vp.clientWidth);
        for (var x = 0; x < ds.length; x++) ds[x].className = 'mu-picker-dot' + (x === n ? ' on' : '');
      }, { passive: true });
    }

    var cells = container.querySelectorAll('.mu-picker-cell');
    for (var k = 0; k < cells.length; k++) (function (cell) {
      cell.addEventListener('click', function () {
        var nm = cell.getAttribute('data-name');
        chooseCopy(nm, 'me', function (txt) {
          if (txt) userAct(nm, { text: txt });   /* S2 ＋面板：50% + 1.6–2.8s（默认骰），消息回复链照常走 */
        });
        _pickerHost = null;
        if (typeof onDone === 'function') onDone();
      });
    })(cells[k]);

    var cancel = container.querySelector('.mu-picker-cancel');
    if (cancel) cancel.addEventListener('click', function () {
      _pickerHost = null;
      if (typeof onDone === 'function') onDone();
    });
    var pAdd = container.querySelector('.mu-picker-add');
    if (pAdd) pAdd.addEventListener('click', function () { openQuickAdd(); });
  }

  window.Actions = {
    getCurtainCardText: function () { return CURTAIN_CARD_TEXT; },
    onCurtainCardSent: onCurtainCardSent,
    raiseCurtain: raiseCurtain,
    buildPanel: buildPanel,
    ACTION_NAMES: ACTION_NAMES,
    maybeTriggerAction: maybeTriggerAction,
    userAct: userAct,
    mountPicker: mountPicker,
    testAdd: function (who, name) { return addAct(who, name); },
    renderActionCard: renderActionCard,
    shakeOpenCards: shakeOpenCards,
    ACTS: ACTS,
    DEFAULT_ACTS: DEFAULT_ACTS,
    defaultActs: function () { var out = []; for (var i = 0; i < DEFAULT_ACTS.length; i++) out.push(normalizeAct(DEFAULT_ACTS[i], i)); return out; },
    applyCustomActs: applyCustomActs,
    /* 仅自验用：跳过 18.9s 开场直接进幕内、触发他摸取、强制散场（不产生界面元素） */
    _enterLiveDebug: function () { if (_overlay) enterLive(_overlay); },
    _openStageDebug: function () { openStageLayer(getActiveCardMsg()); },
    _heActsDebug: function () { if (_live) heActs(); },
    _fangguoDebug: function () { if (_live) endCurtain('fangguo'); },
    _pickCopy: pickCopy,
    _copyPool: copyPool,
    _liveRoll: liveRoll,
    /* 仅自验用（2026-11-10）：落点选取与落卡，探针直接调，界面上没有入口 */
    _pickCardTarget: pickCardTarget,
    _addActDebug: addAct
  };
})();
