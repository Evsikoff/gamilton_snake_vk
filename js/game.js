// «Змейка Гамильтона» — игрок не управляет змейкой, а заранее прокладывает
// ей замкнутые рельсы. Затем змейка бежит по кольцу, ест и растёт.
(function () {
  'use strict';

  var W = FIELD_W, H = FIELD_H, N = W * H;
  var STORE_KEY = 'gamilton-snake-v1';
  var COL_BG = '#96c306';
  var COL_INK = '#334702';
  var COL_FOOD = '#d63b22';
  var START_LEN = 3;
  var TARGET_SECONDS = 24;   // на сколько примерно растягиваем показ забега
  var RAMP_SHARE = 0.30;     // доля показа на долгий разгон и столько же на торможение
  var FAST_FADE_SHARE = 0.04;// мягкий вход в режим ускоренной прокрутки
  var START_CPS = 10;        // стартовая/финишная скорость — видно отдельные клетки
  var MIN_AVERAGE_CPS = 5;   // короткие забеги не растягиваем дольше необходимого
  var Platform = window.VKGames || null;

  // ---------------------------------------------------------------- состояние
  var G = {
    level: 0,
    wall: new Uint8Array(N),
    freeIds: [],
    path: [],
    posInPath: new Int32Array(N),
    closed: false,
    mode: 'draw',            // draw | run | replay | over
    tool: 'line',            // line — отрезками, brush — кистью
    hover: -1,               // клетка под курсором
    preview: null,           // что произойдёт по клику
    score: 0,
    runScore: 0,
    unlocked: 1,
    solutions: {},           // кэш подсказок
    run: null
  };

  var undoStack = [];
  var anim = {
    raf: 0, t: 0, frame: 0, spf: 1, maxSpf: 1,
    duration: 0, startedAt: null, lastAt: null, baseSlope: 0,
    baseCps: START_CPS, u: 0
  };
  var runtimePauseReasons = {};
  var startupReady = false;

  var canvas = document.getElementById('field');
  var ctx = canvas.getContext('2d');
  var cs = 20, ox = 0, oy = 0, dpr = 1;

  var el = {
    level: document.getElementById('hudLevel'),
    name: document.getElementById('hudName'),
    cover: document.getElementById('hudCover'),
    len: document.getElementById('hudLen'),
    score: document.getElementById('hudScore'),
    speed: document.getElementById('hudSpeed'),
    status: document.getElementById('status'),
    strip: document.getElementById('levelStrip'),
    bar: document.getElementById('progressBar'),
    overlay: document.getElementById('overlay'),
    ovTitle: document.getElementById('ovTitle'),
    ovText: document.getElementById('ovText'),
    ovActions: document.getElementById('ovActions'),
    btnRun: document.getElementById('btnRun'),
    btnClose: document.getElementById('btnClose'),
    btnUndo: document.getElementById('btnUndo'),
    btnClear: document.getElementById('btnClear'),
    btnFullscreen: document.getElementById('btnFullscreen'),
    solutionTools: document.getElementById('solutionTools'),
    solutionBtns: document.querySelectorAll('#solutionTools button'),
    btnSkip: document.getElementById('btnSkip'),
    btnStop: document.getElementById('btnStop'),
    playback: document.getElementById('playbackControls'),
    btnReplayStart: document.getElementById('btnReplayStart'),
    btnReplayPrev: document.getElementById('btnReplayPrev'),
    btnReplayPlay: document.getElementById('btnReplayPlay'),
    btnReplayNext: document.getElementById('btnReplayNext'),
    btnReplayEnd: document.getElementById('btnReplayEnd'),
    btnReplayEdit: document.getElementById('btnReplayEdit'),
    replaySeek: document.getElementById('replaySeek'),
    replayPosition: document.getElementById('replayPosition'),
    tools: document.getElementById('toolSwitch'),
    toolBtns: document.querySelectorAll('#toolSwitch button'),
    rules: document.querySelector('.rules'),
    app: document.querySelector('.app'),
    scrollbar: document.getElementById('customScrollbar'),
    scrollbarThumb: document.getElementById('customScrollbarThumb')
  };

  // ------------------------------------------------------------- вспомогалки
  function col(id) { return id % W; }
  function row(id) { return (id / W) | 0; }
  function cellId(c, r) { return r * W + c; }

  function isNeighbour(a, b) {
    var ac = col(a), ar = row(a), bc = col(b), br = row(b);
    var dc = Math.abs(ac - bc), dr = Math.abs(ar - br);
    if (dc === W - 1) dc = 1;
    if (dr === H - 1) dr = 1;
    return (dc + dr) === 1;
  }

  function rngFrom(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ----------------------------------------------------------- сохранение
  function load() {
    if (Platform) return Platform.getProgress();
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch (e) { return {}; }
  }

  function save(immediateCloud) {
    var data = load();
    data.unlocked = G.unlocked;
    data.score = G.score;
    data.paths = data.paths || {};
    data.paths[G.level] = G.path.join(',');
    data.closed = data.closed || {};
    data.closed[G.level] = G.closed ? 1 : 0;
    data.tool = G.tool;
    data.updatedAt = Date.now();
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
    catch (e) { /* Облачное сохранение работает и без localStorage. */ }
    // Локальная и облачная копии обновляются одним снимком данных. Частые
    // изменения рельсов объединяются платформенным адаптером, чтобы не
    // превысить лимит запросов; важный прогресс отправляется сразу.
    if (Platform) Platform.saveProgress(data, !!immediateCloud);
  }

  // -------------------------------------------------------------- уровень
  function loadLevel(i, keepScore, suppressGameplayStart) {
    stopAnim();
    G.level = i;
    G.mode = 'draw';
    G.runScore = 0;
    G.run = null;
    G.wall = new Uint8Array(N);
    G.freeIds = [];
    var map = LEVELS[i].map;
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        var id = cellId(c, r);
        if (map[r].charAt(c) === '#') G.wall[id] = 1;
        else G.freeIds.push(id);
      }
    }
    G.path = [];
    G.posInPath = new Int32Array(N).fill(-1);
    G.closed = false;
    G.hover = -1;
    G.preview = null;
    undoStack.length = 0;

    var data = load();
    if (data.tool === 'brush' || data.tool === 'line') G.tool = data.tool;
    if (!keepScore) G.score = data.score || 0;
    G.unlocked = Math.max(G.unlocked, data.unlocked || 1);
    if (data.paths && data.paths[i]) {
      var ids = data.paths[i].split(',').filter(function (s) { return s.length; })
        .map(Number);
      if (validPath(ids)) {
        G.path = ids;
        for (var k = 0; k < ids.length; k++) G.posInPath[ids[k]] = k;
        G.closed = !!(data.closed && data.closed[i]) &&
          ids.length > 3 && isNeighbour(ids[ids.length - 1], ids[0]);
      }
    }
    hideOverlay();
    resize();
    syncUI();
    say(G.closed
      ? 'Кольцо замкнуто. Жми «Запустить змейку».'
      : 'Нарисуй замкнутый цикл — «рельсы», по которым побежит змейка.');
    if (!suppressGameplayStart) startGameplayIfInteractive();
  }

  // ------------------------------------------------------ путь и отмена
  function setPathState(ids, closed) {
    G.path = ids.slice();
    G.posInPath.fill(-1);
    for (var i = 0; i < G.path.length; i++) G.posInPath[G.path[i]] = i;
    G.closed = !!closed;
    G.preview = null;
  }

  function pushUndo() {
    undoStack.push({ path: G.path.slice(), closed: G.closed });
    if (undoStack.length > 200) undoStack.shift();
  }

  function undo() {
    var prev = undoStack.pop();
    if (!prev) return;
    setPathState(prev.path, prev.closed);
    if (G.hover >= 0) updatePreview(G.hover);
    save(); draw(); syncUI();
    say('Отменено.');
  }

  function validPath(ids) {
    if (!ids.length) return false;
    var seen = {};
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (!(id >= 0 && id < N) || G.wall[id] || seen[id]) return false;
      seen[id] = 1;
      if (i && !isNeighbour(ids[i - 1], id)) return false;
    }
    return true;
  }

  // -------------------------------------------------------------- геометрия
  function resize() {
    var wrap = canvas.parentElement;
    var avail = wrap.clientWidth || 900;
    cs = Math.max(1, Math.floor(avail / W));
    dpr = window.devicePixelRatio || 1;
    var cw = W * cs, ch = H * cs;
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ox = 0; oy = 0;
    draw();
    syncCustomScrollbar();
  }

  function syncCustomScrollbar() {
    if (!el.app || !el.scrollbar || !el.scrollbarThumb) return;
    var maxScroll = Math.max(0, el.app.scrollHeight - el.app.clientHeight);
    if (maxScroll <= 1) {
      el.scrollbar.hidden = true;
      return;
    }

    el.scrollbar.hidden = false;
    var inset = 3;
    var trackHeight = Math.max(1, el.scrollbar.clientHeight - inset * 2);
    var thumbHeight = Math.max(44,
      Math.round(trackHeight * el.app.clientHeight / el.app.scrollHeight));
    thumbHeight = Math.min(trackHeight, thumbHeight);
    var travel = Math.max(0, trackHeight - thumbHeight);
    var top = inset + travel * el.app.scrollTop / maxScroll;
    el.scrollbarThumb.style.height = thumbHeight + 'px';
    el.scrollbarThumb.style.transform = 'translateY(' + Math.round(top) + 'px)';
  }

  function cx(c) { return ox + c * cs + cs / 2; }
  function cy(r) { return oy + r * cs + cs / 2; }

  // ---------------------------------------------------------------- отрисовка
  function draw() {
    ctx.fillStyle = COL_BG;
    ctx.fillRect(0, 0, W * cs, H * cs);

    if (G.mode === 'draw') drawGrid();
    drawWalls();

    if (G.mode === 'run' || G.mode === 'replay' || G.mode === 'over') {
      drawRun();
    } else {
      drawRails(0.34);
      drawPreview();
      drawEnds();
    }
  }

  // Сетка нужна, чтобы считать клетки: тонкие линии по границам,
  // каждая пятая — заметнее.
  function drawGrid() {
    var right = ox + W * cs, bottom = oy + H * cs;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(51,71,2,0.15)';
    ctx.beginPath();
    for (var c = 1; c < W; c++) {
      if (c % 5 === 0) continue;
      var x = Math.round(ox + c * cs) + 0.5;
      ctx.moveTo(x, oy); ctx.lineTo(x, bottom);
    }
    for (var r = 1; r < H; r++) {
      if (r % 5 === 0) continue;
      var y = Math.round(oy + r * cs) + 0.5;
      ctx.moveTo(ox, y); ctx.lineTo(right, y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(51,71,2,0.32)';
    ctx.beginPath();
    for (var c2 = 5; c2 < W; c2 += 5) {
      var x2 = Math.round(ox + c2 * cs) + 0.5;
      ctx.moveTo(x2, oy); ctx.lineTo(x2, bottom);
    }
    for (var r2 = 5; r2 < H; r2 += 5) {
      var y2 = Math.round(oy + r2 * cs) + 0.5;
      ctx.moveTo(ox, y2); ctx.lineTo(right, y2);
    }
    ctx.stroke();
  }

  function drawWalls() {
    ctx.fillStyle = COL_INK;
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        if (!G.wall[cellId(c, r)]) continue;
        ctx.fillRect(ox + c * cs, oy + r * cs, cs, cs);
      }
    }
    // «жидкокристаллическая» насечка: каждая клетка стены — четыре пикселя,
    // так стена не сливается с телом змейки
    ctx.fillStyle = 'rgba(150,195,6,0.20)';
    var t = Math.max(1, Math.round(cs / 14));
    var half = cs / 2;
    for (var r2 = 0; r2 < H; r2++) {
      for (var c2 = 0; c2 < W; c2++) {
        if (!G.wall[cellId(c2, r2)]) continue;
        var x = ox + c2 * cs, y = oy + r2 * cs;
        ctx.fillRect(x, y + half - t / 2, cs, t);
        ctx.fillRect(x + half - t / 2, y, t, cs);
      }
    }
  }

  function segsBetween(a, b) {
    var ac = col(a), ar = row(a), bc = col(b), br = row(b);
    var ax = cx(ac), ay = cy(ar), bx = cx(bc), by = cy(br);
    if (Math.abs(ac - bc) <= 1 && Math.abs(ar - br) <= 1) return [[ax, ay, bx, by]];
    if (ac !== bc) {
      var dx = (ac === 0) ? -1 : 1;
      return [[ax, ay, ax + dx * cs * 0.6, ay], [bx - dx * cs * 0.6, by, bx, by]];
    }
    var dy = (ar === 0) ? -1 : 1;
    return [[ax, ay, ax, ay + dy * cs * 0.6], [bx, by - dy * cs * 0.6, bx, by]];
  }

  function drawRails(alpha) {
    if (!G.path.length) return;
    ctx.strokeStyle = 'rgba(51,71,2,' + alpha + ')';
    ctx.lineWidth = Math.max(2, cs * 0.3);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    var n = G.path.length;
    var last = G.closed ? n : n - 1;
    for (var i = 0; i < last; i++) {
      var a = G.path[i], b = G.path[(i + 1) % n];
      var segs = segsBetween(a, b);
      for (var s = 0; s < segs.length; s++) {
        ctx.moveTo(segs[s][0], segs[s][1]);
        ctx.lineTo(segs[s][2], segs[s][3]);
      }
    }
    ctx.stroke();
    if (n === 1) {
      ctx.fillStyle = 'rgba(51,71,2,' + alpha + ')';
      ctx.beginPath();
      ctx.arc(cx(col(G.path[0])), cy(row(G.path[0])), cs * 0.16, 0, 6.284);
      ctx.fill();
    }
  }

  function canClose() {
    return !G.closed && G.path.length >= 4 &&
      isNeighbour(G.path[G.path.length - 1], G.path[0]);
  }

  // ---------------------------------------------------- инструмент «отрезки»
  // Прямой отрезок от конца рельсов до указанной клетки: направление берём
  // по большей из двух разниц, тянем до первого препятствия.
  function lineCells(from, tc, tr) {
    // направление следует за реальной траекторией указателя (raw-координаты),
    // а не за кратчайшим путём по тору
    var dc = tc - col(from);
    var dr = tr - row(from);
    var sc = 0, sr = 0, n;
    if (Math.abs(dc) >= Math.abs(dr)) { sc = dc > 0 ? 1 : -1; n = Math.abs(dc); }
    else { sr = dr > 0 ? 1 : -1; n = Math.abs(dr); }

    var cells = [], closes = false, cur = from, blocked = false;
    for (var i = 0; i < n; i++) {
      var nx = cellId((col(cur) + sc + W) % W, (row(cur) + sr + H) % H);
      if (nx === G.path[0] && G.path.length + cells.length >= 4) { closes = true; break; }
      if (G.wall[nx] || G.posInPath[nx] >= 0) { blocked = true; break; }
      cells.push(nx);
      cur = nx;
    }
    return { cells: cells, closes: closes, blocked: blocked, wanted: n };
  }

  // Что произойдёт, если кликнуть по клетке target.
  function updatePreview(target, rawC, rawR) {
    G.preview = null;
    if (G.mode !== 'draw' || G.tool !== 'line' || target < 0 || G.wall[target]) return;

    // без raw-координат (клавиатура, undo) — прежнее поведение по клетке target
    var tc = (rawC === undefined) ? col(target) : rawC;
    var tr = (rawR === undefined) ? row(target) : rawR;

    if (!G.path.length) { G.preview = { kind: 'start', target: target }; return; }

    var idx = G.posInPath[target];
    if (idx >= 0) {
      if (target === G.path[0] && !G.closed) {
        if (canClose()) {
          G.preview = { kind: 'close', target: target };
          return;
        }
        // Пользователь может замкнуть кольцо не только последним коротким
        // шагом, но и целым прямым отрезком до самой первой точки.
        var closingSeg = lineCells(G.path[G.path.length - 1], tc, tr);
        if (closingSeg.closes) {
          G.preview = {
            kind: 'add', target: target, cells: closingSeg.cells,
            closes: true, blocked: closingSeg.blocked
          };
          return;
        }
      }
      if (idx < G.path.length - 1 || G.closed) {
        G.preview = { kind: 'erase', target: target, index: idx };
      }
      return;
    }
    if (G.closed) return;      // замкнутое кольцо правим только обрезкой

    var seg = lineCells(G.path[G.path.length - 1], tc, tr);
    if (!seg.cells.length && !seg.closes) return;
    G.preview = {
      kind: 'add', target: target, cells: seg.cells,
      closes: seg.closes, blocked: seg.blocked
    };
  }

  function commitPreview(target, rawC, rawR) {
    if (!G.preview || G.preview.target !== target) updatePreview(target, rawC, rawR);
    var p = G.preview;
    if (!p) {
      if (G.closed) say('Кольцо замкнуто. Клик по рельсам обрежет их до этой клетки.', 'warn');
      return false;
    }
    pushUndo();
    if (p.kind === 'start') {
      setPathState([target], false);
    } else if (p.kind === 'erase') {
      var kept = G.path.slice(0, p.index + 1);
      setPathState(kept, false);
    } else if (p.kind === 'close') {
      G.closed = true;
      G.preview = null;
      reportClosed();
    } else {
      for (var i = 0; i < p.cells.length; i++) {
        G.path.push(p.cells[i]);
        G.posInPath[p.cells[i]] = G.path.length - 1;
      }
      if (p.closes) { G.closed = true; reportClosed(); }
      G.preview = null;
    }
    updatePreview(target);
    return true;
  }

  function drawPreview() {
    var p = G.preview;
    if (!p) { drawHover(); return; }
    ctx.save();
    ctx.lineWidth = Math.max(2, cs * 0.3);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (p.kind === 'add' || p.kind === 'close') {
      var chain = (p.cells || []).slice();
      if (p.closes || p.kind === 'close') chain.push(G.path[0]);
      ctx.strokeStyle = 'rgba(51,71,2,0.5)';
      ctx.setLineDash([cs * 0.34, cs * 0.24]);
      ctx.beginPath();
      var prev = G.path[G.path.length - 1];
      for (var i = 0; i < chain.length; i++) {
        var segs = segsBetween(prev, chain[i]);
        for (var s = 0; s < segs.length; s++) {
          ctx.moveTo(segs[s][0], segs[s][1]); ctx.lineTo(segs[s][2], segs[s][3]);
        }
        prev = chain[i];
      }
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (p.kind === 'erase') {
      // гасим фоном ту часть рельсов, которая исчезнет
      ctx.strokeStyle = 'rgba(150,195,6,0.8)';
      ctx.beginPath();
      var pv = G.path[p.index];
      for (var j = p.index + 1; j < G.path.length; j++) {
        var sg = segsBetween(pv, G.path[j]);
        for (var k = 0; k < sg.length; k++) {
          ctx.moveTo(sg[k][0], sg[k][1]); ctx.lineTo(sg[k][2], sg[k][3]);
        }
        pv = G.path[j];
      }
      if (G.closed) {
        var cl = segsBetween(G.path[G.path.length - 1], G.path[0]);
        for (var m = 0; m < cl.length; m++) {
          ctx.moveTo(cl[m][0], cl[m][1]); ctx.lineTo(cl[m][2], cl[m][3]);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
    drawHover();
  }

  // рамка вокруг клетки под курсором — видно, куда придётся клик
  function drawHover() {
    if (G.tool !== 'line' || G.hover < 0 || G.wall[G.hover]) return;
    ctx.strokeStyle = 'rgba(51,71,2,0.55)';
    ctx.lineWidth = Math.max(1, cs * 0.08);
    ctx.strokeRect(ox + col(G.hover) * cs + 1.5, oy + row(G.hover) * cs + 1.5,
      cs - 3, cs - 3);
  }

  function drawEnds() {
    if (!G.path.length) return;
    var s = G.path[0], h = G.path[G.path.length - 1];
    ctx.lineWidth = Math.max(2, cs * 0.16);
    ctx.strokeStyle = COL_INK;
    if (canClose()) {                       // подсказка: кольцо можно замкнуть
      ctx.save();
      ctx.setLineDash([cs * 0.18, cs * 0.18]);
      ctx.beginPath();
      var segs = segsBetween(h, s);
      for (var i = 0; i < segs.length; i++) {
        ctx.moveTo(segs[i][0], segs[i][1]);
        ctx.lineTo(segs[i][2], segs[i][3]);
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(cx(col(s)), cy(row(s)), cs * 0.3, 0, 6.284);
    ctx.stroke();
    if (!G.closed) {
      ctx.fillStyle = COL_INK;
      ctx.beginPath();
      ctx.arc(cx(col(h)), cy(row(h)), cs * 0.28, 0, 6.284);
      ctx.fill();
    }
  }

  function block(id, shrink) {
    var c = col(id), r = row(id);
    var m = shrink;
    ctx.fillRect(ox + c * cs + m, oy + r * cs + m, cs - 2 * m, cs - 2 * m);
  }

  function drawRun() {
    var run = G.run;
    if (!run) return;
    var st = stateAt(run, Math.floor(Math.min(anim.t, run.total)));
    ctx.fillStyle = COL_INK;
    var m = Math.max(1, cs * 0.11);
    for (var k = 0; k < st.len; k++) {
      var idx = (st.head - k + run.L * 2) % run.L;
      block(run.cycle[idx], k === 0 ? Math.max(0, m - 2) : m);
    }
    // В таймлапсе быстро прыгающая еда давала случайное мерцание. На медленных
    // участках показываем её как обычно, а в середине заменяем цель шлейфом.
    if (st.food >= 0 && fastForwardStrength() < 0.55 &&
        (Math.floor(anim.frame / 12) % 2 === 0 || G.mode === 'over')) {
      var c = col(st.food), r = row(st.food);
      var q = cs / 5;
      ctx.fillStyle = COL_FOOD;
      ctx.fillRect(ox + c * cs + 2 * q, oy + r * cs + q, q, 3 * q);
      ctx.fillRect(ox + c * cs + q, oy + r * cs + 2 * q, 3 * q, q);
    }
    drawFastForward(st);
  }

  // В быстрой середине показываем не россыпь несвязанных кадров, а намеренную
  // ускоренную прокрутку: светящийся хвост отмечает направление движения,
  // а спокойный сканирующий луч визуально связывает последовательные кадры.
  function drawFastForward(st) {
    var strength = fastForwardStrength();
    if (strength <= 0.001 || (G.mode !== 'run' && G.mode !== 'replay')) return;

    ctx.save();
    var echoes = Math.min(12, Math.max(0, st.len - 1));
    for (var i = 1; i <= echoes; i++) {
      var idx = (st.head - i + G.run.L * 2) % G.run.L;
      var alpha = strength * 0.48 * (1 - (i - 1) / (echoes + 1));
      ctx.fillStyle = 'rgba(150,195,6,' + alpha + ')';
      block(G.run.cycle[idx], cs * (0.30 + i * 0.006));
    }

    var elapsed = anim.startedAt === null ? 0 : anim.lastAt - anim.startedAt;
    var sweep = ((elapsed / 1800) % 1 + 1) % 1;
    var sx = sweep * W * cs;
    ctx.fillStyle = 'rgba(150,195,6,' + (0.13 * strength) + ')';
    ctx.fillRect(sx - cs * 0.55, 0, cs * 1.1, H * cs);
    ctx.fillStyle = 'rgba(150,195,6,' + (0.28 * strength) + ')';
    ctx.fillRect(sx - Math.max(1, cs * 0.08), 0,
      Math.max(2, cs * 0.16), H * cs);

    var factor = Math.max(2, Math.round(anim.spf * 60 / Math.max(1, anim.baseCps)));
    var label = '» УСКОРЕННАЯ ПРОКРУТКА ×' + factor;
    var fontSize = Math.max(10, Math.round(cs * 0.52));
    var padX = Math.max(6, cs * 0.34);
    var boxW = label.length * fontSize * 0.62 + padX * 2;
    var boxH = fontSize + Math.max(7, cs * 0.42);
    var boxX = W * cs - boxW - cs * 0.45;
    var boxY = cs * 0.45;
    ctx.fillStyle = 'rgba(51,71,2,' + (0.78 * strength) + ')';
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.fillStyle = 'rgba(150,195,6,' + (0.95 * strength) + ')';
    ctx.font = '700 ' + fontSize + 'px monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, boxX + padX, boxY + boxH / 2);
    ctx.restore();
  }

  // -------------------------------------------------------------- симуляция
  function simulate(cycle, seed) {
    var L = cycle.length;
    var posOn = new Int32Array(N).fill(-1);
    for (var i = 0; i < L; i++) posOn[cycle[i]] = i;
    var rand = rngFrom(seed);
    var free = G.freeIds;
    var startLen = Math.min(START_LEN, L);
    var len = startLen, h = 0, t = 0;
    var events = [];
    var res = { events: events, startLen: startLen, L: L, cycle: cycle, posOn: posOn };

    while (len < free.length) {
      var food = -1;
      for (var tries = 0; tries < 50000; tries++) {
        var cand = free[(rand() * free.length) | 0];
        var p = posOn[cand];
        if (p >= 0 && ((h - p + L) % L) < len) continue;   // занято змейкой
        food = cand; break;
      }
      if (food < 0) break;
      var pf = posOn[food];
      if (pf < 0) {
        res.outcome = 'unreachable';
        res.stallFood = food;
        res.total = t + 2 * L;
        res.finalLen = len;
        return res;
      }
      var d = (pf - h + L) % L;
      if (d === 0) d = L;
      t += d; h = pf; len++;
      events.push({ t: t, food: food });
    }
    res.outcome = (len >= free.length) ? 'win' : 'unreachable';
    res.total = t;
    res.finalLen = len;
    return res;
  }

  function stateAt(run, t) {
    var lo = 0, hi = run.events.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (run.events[mid].t <= t) lo = mid + 1; else hi = mid;
    }
    var eaten = lo;
    var food = eaten < run.events.length ? run.events[eaten].food
      : (run.stallFood !== undefined ? run.stallFood : -1);
    return {
      eaten: eaten,
      len: run.startLen + eaten,
      head: t % run.L,
      food: food
    };
  }

  // ------------------------------------------------------------- анимация
  function runtimePaused() {
    return Object.keys(runtimePauseReasons).length > 0;
  }

  function pauseRuntime(reason) {
    runtimePauseReasons[reason || 'external'] = true;
    if (G.mode === 'run' || G.mode === 'replay') {
      stopAnim();
      // Не учитываем время, проведённое в другой вкладке или в рекламе.
      anim.startedAt = null;
      anim.lastAt = null;
    }
  }

  function resumeRuntime(reason) {
    delete runtimePauseReasons[reason || 'external'];
    if (runtimePaused() || (G.mode !== 'run' && G.mode !== 'replay') || anim.raf) return;
    anim.startedAt = null;
    anim.lastAt = null;
    anim.raf = requestAnimationFrame(step);
  }

  function startGameplayIfInteractive() {
    if (!Platform || runtimePaused() || !el.overlay.hidden) return;
    if (G.mode === 'draw' || G.mode === 'run' || G.mode === 'replay') {
      Platform.startGameplay();
    }
  }

  // Интеграл плавного профиля скорости: первые RAMP_SHARE времени змейка
  // разгоняется, в середине идёт быстро, в последние RAMP_SHARE — тормозит.
  // Функция возвращает долю уже пройденного маршрута.
  function smoothstep01(x) {
    x = Math.max(0, Math.min(1, x));
    return x * x * (3 - 2 * x);
  }

  function fastForwardStrength() {
    var fade = FAST_FADE_SHARE;
    var fadeIn = smoothstep01((anim.u - (RAMP_SHARE - fade)) / (2 * fade));
    var fadeOut = 1 - smoothstep01((anim.u - (1 - RAMP_SHARE - fade)) / (2 * fade));
    return Math.min(fadeIn, fadeOut);
  }

  function pacedProgress(u, baseSlope) {
    u = Math.max(0, Math.min(1, u));
    var ramp = RAMP_SHARE;
    var peakSlope = (1 - baseSlope * ramp) / (1 - ramp);

    function rampDistance(x) {
      var s = x / ramp;
      // Интеграл smoothstep(s) = s^3 - s^4 / 2.
      return baseSlope * x + (peakSlope - baseSlope) * ramp *
        (s * s * s - 0.5 * s * s * s * s);
    }

    if (u < ramp) return rampDistance(u);
    if (u > 1 - ramp) return 1 - rampDistance(1 - u);
    return rampDistance(ramp) + peakSlope * (u - ramp);
  }

  // Находим временную позицию для произвольной точки ползунка. Обратная
  // функция нужна, чтобы повтор можно было продолжить после ручной перемотки.
  function progressToU(progress, baseSlope) {
    var lo = 0, hi = 1;
    progress = Math.max(0, Math.min(1, progress));
    for (var i = 0; i < 28; i++) {
      var mid = (lo + hi) / 2;
      if (pacedProgress(mid, baseSlope) < progress) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function startRun() {
    if (!G.closed || G.path.length < 4) {
      say('Сначала замкни кольцо: доведи конец рельсов до стартовой клетки.', 'warn');
      return;
    }
    G.run = simulate(G.path.slice(), 12345 + G.level * 7);
    G.run.reviewStarted = false;
    G.mode = 'run';
    G.runScore = 0;
    anim.t = 0; anim.frame = 0;
    var durationSeconds = Math.min(TARGET_SECONDS,
      G.run.total / MIN_AVERAGE_CPS);
    anim.duration = Math.max(250, durationSeconds * 1000);
    var averageCps = G.run.total / (anim.duration / 1000);
    anim.baseSlope = Math.min(0.25, START_CPS / Math.max(1, averageCps));
    anim.baseCps = averageCps * anim.baseSlope;
    anim.maxSpf = averageCps *
      ((1 - anim.baseSlope * RAMP_SHARE) / (1 - RAMP_SHARE)) / 60;
    anim.spf = anim.baseCps / 60;
    anim.startedAt = null;
    anim.lastAt = null;
    anim.u = 0;
    hideOverlay();
    startGameplayIfInteractive();
    syncUI();
    say(G.run.L === G.freeIds.length
      ? 'Рельсы покрывают всё поле — смотрим, как змейка его заполняет.'
      : 'Рельсы покрывают не всё поле. Смотрим, что из этого выйдет…', 'warn');
    if (!runtimePaused()) anim.raf = requestAnimationFrame(step);
  }

  function step(timestamp) {
    if (G.mode !== 'run' && G.mode !== 'replay') return;
    if (runtimePaused()) return;
    var run = G.run;
    var replaying = G.mode === 'replay';
    anim.frame++;
    if (anim.startedAt === null) {
      anim.startedAt = timestamp - anim.u * anim.duration;
      anim.lastAt = timestamp;
    }
    var elapsed = timestamp - anim.startedAt;
    anim.u = Math.max(0, Math.min(1, elapsed / anim.duration));
    var progress = pacedProgress(anim.u, anim.baseSlope);
    var nextT = Math.min(run.total, run.total * progress);
    var frameMs = Math.max(1, timestamp - anim.lastAt);
    anim.spf = (nextT - anim.t) * 1000 / frameMs / 60;
    anim.t = nextT;
    anim.lastAt = timestamp;
    var st = stateAt(run, Math.floor(anim.t));
    if (!replaying) G.runScore = st.eaten * 10;
    el.len.textContent = st.len + ' / ' + G.freeIds.length;
    el.score.textContent = replaying ? G.score : G.score + G.runScore;
    el.speed.textContent = Math.round(anim.spf * 60) + ' кл/с';
    el.bar.style.width = (100 * anim.t / Math.max(1, run.total)) + '%';
    syncPlaybackUI();
    draw();
    if (anim.t >= run.total) {
      if (replaying) finishReplay(); else finishRun();
      return;
    }
    anim.raf = requestAnimationFrame(step);
  }

  function stopAnim() {
    if (anim.raf) cancelAnimationFrame(anim.raf);
    anim.raf = 0;
  }

  function seekReview(t, message) {
    if (!G.run) return;
    stopAnim();
    hideOverlay();
    G.run.reviewStarted = true;
    G.mode = 'over';
    if (Platform) Platform.stopGameplay();
    anim.t = Math.max(0, Math.min(G.run.total, t));
    if (anim.t <= 0) anim.u = 0;
    else if (anim.t >= G.run.total) anim.u = 1;
    else anim.u = progressToU(anim.t / G.run.total, anim.baseSlope);
    anim.spf = 0;
    anim.startedAt = null;
    anim.lastAt = null;
    draw();
    syncUI();
    if (message) say(message);
  }

  function startReplay(restart) {
    if (!G.run) return;
    stopAnim();
    hideOverlay();
    G.run.reviewStarted = true;
    G.runScore = 0;
    if (restart || anim.t >= G.run.total) {
      anim.t = 0;
      anim.u = 0;
      anim.frame = 0;
    } else {
      anim.u = progressToU(anim.t / G.run.total, anim.baseSlope);
    }
    anim.spf = 0;
    anim.startedAt = null;
    anim.lastAt = null;
    G.mode = 'replay';
    startGameplayIfInteractive();
    draw();
    syncUI();
    say(anim.t === 0 ? 'Повтор запущен с начала.' : 'Повтор продолжен.');
    if (!runtimePaused()) anim.raf = requestAnimationFrame(step);
  }

  function pauseReplay() {
    if (G.mode !== 'replay') return;
    stopAnim();
    G.mode = 'over';
    if (Platform) Platform.stopGameplay();
    anim.spf = 0;
    draw();
    syncUI();
    say('Повтор на паузе. Можно листать запись по кадрам.');
  }

  function toggleReplay() {
    if (G.mode === 'replay') pauseReplay();
    else startReplay(anim.t >= (G.run ? G.run.total : 0));
  }

  function finishReplay() {
    stopAnim();
    anim.t = G.run.total;
    anim.u = 1;
    anim.spf = 0;
    G.mode = 'over';
    if (Platform) Platform.stopGameplay();
    draw();
    syncUI();
    say('Повтор завершён. Его можно запустить снова или отмотать назад.');
  }

  function finishRun() {
    stopAnim();
    var run = G.run;
    G.mode = 'over';
    if (Platform) Platform.stopGameplay();
    draw();
    syncUI();
    if (run.outcome === 'win') {
      G.score += G.runScore + 500;
      G.runScore = 0;
      G.unlocked = Math.max(G.unlocked, Math.min(LEVELS.length, G.level + 2));
      save(true);
      el.score.textContent = G.score;
      var isLast = G.level + 1 >= LEVELS.length;
      var show = showOverlay.bind(null, 'Уровень пройден',
        'Змейка заполнила всё поле: ' + G.freeIds.length + ' клеток. Бонус +500.' +
        (isLast ? ' Пройдены все лабиринты Snake II!' : ''),
        isLast
          ? [['Посмотреть повтор', function () { startReplay(true); }],
             ['Пройти заново', function () { loadLevel(G.level, true); }]]
          : [['Следующий уровень', goToNextLevel],
             ['Посмотреть повтор', function () { startReplay(true); }],
             ['К рельсам', function () { backToDraw(); }]]);
      var lvlAtWin = G.level;
      var runAtWin = run;
      setTimeout(function () {                 // дать полюбоваться заполненным полем
        if (G.mode === 'over' && G.level === lvlAtWin && G.run === runAtWin &&
            !runAtWin.reviewStarted) show();
      }, 900);
    } else {
      G.score += G.runScore;
      G.runScore = 0;
      save(true);
      showOverlay('Змейка застряла',
        'Еда появилась там, куда рельсы не заходят. Змейка выросла до ' +
        run.finalLen + ' из ' + G.freeIds.length +
        ' клеток и дальше расти не может. Рельсы должны проходить через каждую клетку.',
        [['Посмотреть повтор', function () { startReplay(true); }],
         ['Доработать рельсы', function () { backToDraw(); }]]);
    }
  }

  function backToDraw() {
    stopAnim();
    hideOverlay();
    G.mode = 'draw';
    G.run = null;
    anim.t = 0; anim.frame = 0;
    anim.u = 0;
    el.bar.style.width = '0%';
    draw();
    syncUI();
    startGameplayIfInteractive();
  }

  // Полноэкранную рекламу показываем только после победы и только по явному
  // переходу игрока к следующему уровню — то есть строго между уровнями.
  function goToNextLevel() {
    var nextLevel = G.level + 1;
    if (nextLevel >= LEVELS.length) return;
    if (!Platform || !Platform.canShowAds()) {
      loadLevel(nextLevel, true);
      return;
    }
    say('Переходим к следующему уровню…');
    var launched = Platform.showFullscreenAd({
      onClose: function () { loadLevel(nextLevel, true); }
    });
    if (!launched) loadLevel(nextLevel, true);
  }

  function openLockedLevelWithAd(levelIndex) {
    if (!Platform || !Platform.canShowAds()) {
      say('Видео для разблокировки сейчас недоступно. Проходи уровни по порядку.', 'warn');
      return;
    }

    var rewarded = false;
    var launched = Platform.showRewardedAd({
      onRewarded: function () {
        rewarded = true;
        // unlocked хранит непрерывно открытую часть кампании: выбор далёкого
        // уровня за видео открывает также все предыдущие уровни.
        G.unlocked = Math.max(G.unlocked, levelIndex + 1);
        save(true);
      },
      onClose: function () {
        if (rewarded) {
          loadLevel(levelIndex, true);
          say('Уровень ' + (levelIndex + 1) + ' открыт за просмотр видео.', 'good');
        } else {
          syncUI();
          say('Чтобы открыть уровень, досмотри видео до награды.', 'warn');
        }
      }
    });
    if (launched) say('После просмотра откроется уровень ' + (levelIndex + 1) + '.');
    else say('Реклама сейчас недоступна. Попробуй ещё раз позже.', 'warn');
  }

  // ------------------------------------------------------------ рисование
  var drag = { on: false, last: -1 };

  function cellFromEvent(e) {
    var rect = canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) * (W * cs) / rect.width;
    var y = (e.clientY - rect.top) * (H * cs) / rect.height;
    var c = Math.floor((x - ox) / cs);
    var r = Math.floor((y - oy) / cs);
    c = ((c % W) + W) % W;
    r = ((r % H) + H) % H;
    return cellId(c, r);
  }

  // незавёрнутые координаты клетки: c может быть <0 или >=W — это честный
  // жест «рисую через край»; завёрнутый id даёт cellFromEvent
  function rawCellFromEvent(e) {
    var rect = canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) * (W * cs) / rect.width;
    var y = (e.clientY - rect.top) * (H * cs) / rect.height;
    return { c: Math.floor((x - ox) / cs), r: Math.floor((y - oy) / cs) };
  }

  function pushCell(id) {
    if (G.closed || G.wall[id]) return false;
    var n = G.path.length;
    if (!n) { G.path.push(id); G.posInPath[id] = 0; return true; }
    var head = G.path[n - 1];
    if (id === head) return false;
    if (n >= 2 && id === G.path[n - 2]) {          // назад по себе — стираем
      G.posInPath[head] = -1;
      G.path.pop();
      return true;
    }
    if (G.posInPath[id] >= 0) {                     // клик по своему пути
      if (id === G.path[0] && n >= 4 && isNeighbour(head, id)) { closeLoop(); return true; }
      truncateTo(G.posInPath[id]);
      return true;
    }
    if (!isNeighbour(head, id)) return false;
    G.path.push(id);
    G.posInPath[id] = G.path.length - 1;
    return true;
  }

  function truncateTo(index) {
    for (var i = index + 1; i < G.path.length; i++) G.posInPath[G.path[i]] = -1;
    G.path.length = index + 1;
  }

  function reportClosed() {
    if (G.path.length === G.freeIds.length) {
      say('Кольцо замкнуто и покрывает всё поле — это гамильтонов цикл. Запускай!', 'good');
    } else {
      say('Кольцо замкнуто, но покрыто ' + G.path.length + ' из ' + G.freeIds.length +
        ' клеток. Змейка не сможет заполнить поле.', 'warn');
    }
  }

  function closeLoop() {
    if (G.path.length < 4) { say('Кольцо слишком короткое.', 'warn'); return; }
    if (!isNeighbour(G.path[G.path.length - 1], G.path[0])) {
      say('Чтобы замкнуть кольцо, конец рельсов должен встать рядом со стартовой клеткой.', 'warn');
      return;
    }
    pushUndo();
    G.closed = true;
    save();
    syncUI();
    draw();
    reportClosed();
  }

  canvas.addEventListener('pointerdown', function (e) {
    if (G.mode !== 'draw') return;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { }
    drag.on = true;
    var id = cellFromEvent(e);
    drag.last = id;
    G.hover = id;

    if (G.tool === 'line') {
      // отрезок фиксируется на отпускании — так работает и клик, и протяжка
      var raw = rawCellFromEvent(e);
      updatePreview(id, raw.c, raw.r);
      draw();
      e.preventDefault();
      return;
    }

    if (G.closed) {                    // кистью замкнутое кольцо только обрезаем
      if (G.posInPath[id] < 0) { e.preventDefault(); return; }
      pushUndo();
      G.closed = false;
      truncateTo(G.posInPath[id]);
      say('Кольцо разомкнуто — правь рельсы.');
      draw(); syncUI();
      e.preventDefault();
      return;
    }
    pushUndo();
    pushCell(id);
    draw(); syncUI();
    e.preventDefault();
  });

  function dropUndoIfUnchanged() {
    var top = undoStack[undoStack.length - 1];
    if (top && top.closed === G.closed && top.path.length === G.path.length &&
        top.path.join(',') === G.path.join(',')) undoStack.pop();
  }

  // мышь может «перепрыгнуть» несколько клеток — доводим путь по шагам
  function walkTo(from, to, tc, tr) {
    if (tc === undefined) tc = col(to);
    if (tr === undefined) tr = row(to);
    var changed = false;
    var cur = from;
    // остаток жеста: считаем один раз — после заворота col(cur) пересчёт
    // от col(cur) с сырым tc никогда не занулился бы и намотал кольцо
    var dc = tc - col(cur);
    var dr = tr - row(cur);
    for (var guard = 0; guard < 80 && cur !== to; guard++) {
      if (dc === 0 && dr === 0) break;   // страховка от шага в никуда
      var sc = 0, sr = 0;
      if (Math.abs(dc) >= Math.abs(dr)) sc = dc > 0 ? 1 : -1; else sr = dr > 0 ? 1 : -1;
      cur = cellId((col(cur) + sc + W) % W, (row(cur) + sr + H) % H);
      dc -= sc; dr -= sr;
      if (pushCell(cur)) changed = true;
    }
    return changed;
  }

  canvas.addEventListener('pointermove', function (e) {
    if (G.mode !== 'draw') return;
    var id = cellFromEvent(e);
    if (G.tool === 'brush') {
      if (!drag.on || id === drag.last) return;
      var raw = rawCellFromEvent(e);
      var changed = walkTo(drag.last, id, raw.c, raw.r);
      drag.last = id;
      if (changed) { draw(); syncUI(); }
      return;
    }
    if (id === G.hover) return;        // курсор всё в той же клетке
    G.hover = id;
    var raw = rawCellFromEvent(e);
    updatePreview(id, raw.c, raw.r);
    draw();
  });

  canvas.addEventListener('pointerleave', function () {
    if (G.mode !== 'draw' || drag.on) return;
    G.hover = -1;
    G.preview = null;
    draw();
  });

  function endDrag(e) {
    if (!drag.on) return;
    drag.on = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { }
    if (G.tool === 'line') {
      var raw = rawCellFromEvent(e);
      commitPreview(cellFromEvent(e), raw.c, raw.r);
    } else {
      dropUndoIfUnchanged();
    }
    save();
    draw();
    syncUI();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  document.addEventListener('keydown', function (e) {
    if (!startupReady || runtimePauseReasons.platform) return;
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (G.run && (G.mode === 'over' || G.mode === 'replay')) {
      if (e.key === 'ArrowLeft') {
        seekReview(Math.floor(anim.t) - 1, 'Кадр назад.');
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowRight') {
        seekReview(Math.floor(anim.t) + 1, 'Кадр вперёд.');
        e.preventDefault();
        return;
      }
      if (e.key === 'Home') {
        seekReview(0, 'Повтор отмотан в начало.');
        e.preventDefault();
        return;
      }
      if (e.key === 'End') {
        seekReview(G.run.total, 'Повтор перемотан в конец.');
        e.preventDefault();
        return;
      }
      if (e.key === ' ') {
        toggleReplay();
        e.preventDefault();
        return;
      }
    }
    var map = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    if (map[e.key] && G.mode === 'draw' && G.path.length && !G.closed) {
      var head = G.path[G.path.length - 1];
      var id = cellId((col(head) + map[e.key][0] + W) % W, (row(head) + map[e.key][1] + H) % H);
      pushUndo();
      pushCell(id);
      dropUndoIfUnchanged();
      if (G.hover >= 0) updatePreview(G.hover);
      draw(); syncUI(); save();
      e.preventDefault();
      return;
    }
    if ((e.key === 'Backspace' || (e.key === 'z' && (e.ctrlKey || e.metaKey))) &&
        G.mode === 'draw') {
      undo();
      e.preventDefault();
    } else if (e.key === 'Tab' && G.mode === 'draw') {
      setTool(G.tool === 'line' ? 'brush' : 'line');
      e.preventDefault();
    } else if (e.key === 'Enter' && G.mode === 'draw') {
      closeLoop();
    } else if (e.key === ' ') {
      if (G.mode === 'draw') startRun();
      e.preventDefault();
    } else if (e.key === 'c' || e.key === 'C' || e.key === 'с' || e.key === 'С') {
      if (G.mode === 'draw') clearPath();
    }
  });

  function clearPath() {
    if (!G.path.length) return;
    pushUndo();
    setPathState([], false);
    save();
    draw(); syncUI();
    say('Рельсы стёрты.');
  }

  function setTool(tool) {
    G.tool = tool;
    G.preview = null;
    if (G.hover >= 0) updatePreview(G.hover);
    save();
    draw(); syncUI();
    say(tool === 'line'
      ? 'Отрезки: клик — начало, следующий клик — конец отрезка. Дальше каждый клик продолжает рельсы.'
      : 'Кисть: нажми и веди — рельсы тянутся за курсором.');
  }

  // ------------------------------------------------------------- решение
  function showSolution(share) {
    share = Math.max(0, Math.min(1, Number(share) || 0));
    if (!share) return;
    var requestedLevel = G.level;
    say('Считаю гамильтонов цикл…');
    setTimeout(function () {
      if (G.level !== requestedLevel || G.mode !== 'draw') return;
      var cyc = G.solutions[requestedLevel];
      if (!cyc) {
        cyc = Solver.hamiltonCycle(W, H, G.wall, requestedLevel + 1);
        G.solutions[requestedLevel] = cyc;
      }
      if (!cyc) { say('Не удалось построить цикл для этого лабиринта.', 'warn'); return; }
      var count = share >= 1 ? cyc.length : Math.max(1, Math.floor(cyc.length * share));
      pushUndo();
      setPathState(cyc.slice(0, count), share >= 1);
      save(true);
      draw(); syncUI();
      if (share >= 1) {
        say('Показано полное решение: ' + cyc.length + ' клеток, цикл замкнут.', 'good');
      } else {
        say('Показано ' + Math.round(share * 100) + '% решения — ' + count +
          ' из ' + cyc.length + ' клеток. Продолжи рельсы самостоятельно.', 'good');
      }
    }, 20);
  }

  // ------------------------------------------------------------------- UI
  function say(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function showOverlay(title, text, actions) {
    if (Platform) Platform.stopGameplay();
    el.ovTitle.textContent = title;
    el.ovText.textContent = text;
    el.ovActions.innerHTML = '';
    actions.forEach(function (a, i) {
      var b = document.createElement('button');
      b.textContent = a[0];
      if (i === 0) b.className = 'primary';
      b.onclick = a[1];
      el.ovActions.appendChild(b);
    });
    el.overlay.hidden = false;
  }

  function hideOverlay() { el.overlay.hidden = true; }

  function buildStrip() {
    el.strip.innerHTML = '';
    for (var i = 0; i < LEVELS.length; i++) {
      (function (i) {
        var b = document.createElement('button');
        var locked = i >= G.unlocked;
        b.textContent = locked ? '🎬' : (i + 1);
        b.title = locked
          ? 'Смотреть видео, чтобы открыть уровень ' + (i + 1) + ': ' + LEVELS[i].name
          : LEVELS[i].name;
        b.setAttribute('aria-label', b.title);
        b.disabled = locked && (!Platform || !Platform.canShowAds());
        if (i === G.level) b.className = 'current';
        else if (i < G.unlocked - 1) b.className = 'done';
        else if (locked) b.className = 'reward';
        b.onclick = function () {
          if (i < G.unlocked) loadLevel(i, true);
          else openLockedLevelWithAd(i);
        };
        el.strip.appendChild(b);
      })(i);
    }
  }

  function syncPlaybackUI() {
    if (!G.run) return;
    var total = Math.max(1, Math.floor(G.run.total));
    var current = Math.max(0, Math.min(total, Math.floor(anim.t)));
    el.replaySeek.max = total;
    el.replaySeek.value = current;
    el.replayPosition.textContent = current + ' / ' + total;
    el.replayPosition.title = Math.round(1000 * current / total) / 10 + '%';
    el.btnReplayStart.disabled = current <= 0;
    el.btnReplayPrev.disabled = current <= 0;
    el.btnReplayNext.disabled = current >= total;
    el.btnReplayEnd.disabled = current >= total;
    var replaying = G.mode === 'replay';
    el.btnReplayPlay.textContent = replaying ? '❚❚ Пауза' :
      (current >= total ? '▶ Снова' : '▶ Продолжить');
    el.btnReplayPlay.setAttribute('aria-pressed', replaying ? 'true' : 'false');
  }

  function syncUI() {
    buildStrip();
    el.level.textContent = (G.level + 1) + ' / ' + LEVELS.length;
    el.name.textContent = LEVELS[G.level].name;
    el.cover.textContent = G.path.length + ' / ' + G.freeIds.length +
      (G.closed ? ' ●' : '');
    var running = G.mode === 'run';
    var replaying = G.mode === 'replay';
    var reviewing = G.mode === 'over' && !!G.run;
    var editing = G.mode === 'draw';
    el.score.textContent = G.score + (running ? G.runScore : 0);

    el.tools.hidden = !editing;
    for (var t = 0; t < el.toolBtns.length; t++) {
      var on = el.toolBtns[t].getAttribute('data-tool') === G.tool;
      el.toolBtns[t].classList.toggle('on', on);
      el.toolBtns[t].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    el.btnRun.hidden = !editing;
    el.btnRun.disabled = !G.closed;
    el.btnClose.hidden = !editing;
    el.btnClose.disabled = !canClose();
    el.btnUndo.hidden = !editing;
    el.btnUndo.disabled = !undoStack.length;
    el.btnClear.hidden = !editing;
    el.btnClear.disabled = !G.path.length;
    el.solutionTools.hidden = !editing;
    el.btnSkip.hidden = !running;
    el.btnStop.hidden = !running;
    el.playback.hidden = !(replaying || reviewing);

    if (G.run && (replaying || reviewing)) {
      var st = stateAt(G.run, Math.floor(anim.t));
      el.len.textContent = st.len + ' / ' + G.freeIds.length;
      if (reviewing) el.speed.textContent = 'Пауза';
      syncPlaybackUI();
    } else if (!running) {
      el.len.textContent = '—';
      el.speed.textContent = '—';
    }
    syncCustomScrollbar();
  }

  // inert блокирует ввод в новых браузерах, перехват — также в старых WebView.
  if (el.app) {
    ['click', 'pointerdown', 'pointermove', 'pointerup', 'input'].forEach(function (type) {
      el.app.addEventListener(type, function (event) {
        if (startupReady && !runtimePauseReasons.platform) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    });
  }

  el.btnRun.onclick = startRun;
  el.btnClose.onclick = closeLoop;
  el.btnClear.onclick = clearPath;
  el.btnUndo.onclick = undo;
  for (var ti = 0; ti < el.toolBtns.length; ti++) {
    (function (btn) {
      btn.onclick = function () { setTool(btn.getAttribute('data-tool')); };
    })(el.toolBtns[ti]);
  }
  for (var si = 0; si < el.solutionBtns.length; si++) {
    (function (btn) {
      btn.onclick = function () {
        showSolution(btn.getAttribute('data-solution-share'));
      };
    })(el.solutionBtns[si]);
  }
  el.btnReplayStart.onclick = function () {
    seekReview(0, 'Повтор отмотан в начало.');
  };
  el.btnReplayPrev.onclick = function () {
    seekReview(Math.floor(anim.t) - 1, 'Кадр назад.');
  };
  el.btnReplayPlay.onclick = toggleReplay;
  el.btnReplayNext.onclick = function () {
    seekReview(Math.floor(anim.t) + 1, 'Кадр вперёд.');
  };
  el.btnReplayEnd.onclick = function () {
    seekReview(G.run ? G.run.total : 0, 'Повтор перемотан в конец.');
  };
  el.replaySeek.oninput = function () {
    seekReview(Number(el.replaySeek.value));
    say('Ручная перемотка. Нажми «Продолжить» или листай по кадрам.');
  };
  el.btnReplayEdit.onclick = function () {
    backToDraw();
    say('Можно снова редактировать рельсы.');
  };
  el.btnSkip.onclick = function () {
    if (G.mode !== 'run') return;
    anim.t = G.run.total;
    anim.u = 1;
    var st = stateAt(G.run, Math.floor(anim.t));
    G.runScore = st.eaten * 10;
    finishRun();
  };
  el.btnStop.onclick = function () { G.runScore = 0; backToDraw(); say('Забег прерван.'); };

  function syncFullscreenUI() {
    if (!el.btnFullscreen || !Platform) return;
    var active = Platform.fullscreenStatus();
    el.btnFullscreen.hidden = !Platform.canFullscreen();
    el.btnFullscreen.setAttribute('aria-pressed', active ? 'true' : 'false');
    el.btnFullscreen.textContent = active ? 'Выйти из полного экрана' : 'На весь экран';
  }

  if (el.btnFullscreen && Platform) {
    el.btnFullscreen.onclick = function () {
      var entering = !Platform.fullscreenStatus();
      // Вызов остаётся внутри обработчика клика: браузеру нужен жест игрока.
      var change = Platform.toggleFullscreen();
      el.btnFullscreen.disabled = true;
      Promise.resolve(change).then(function (succeeded) {
        if (!succeeded && entering) {
          say('Полный экран недоступен в этом окне.', 'warn');
        }
      }).catch(function () {
        say('Не удалось изменить полноэкранный режим.', 'warn');
      }).finally(function () {
        el.btnFullscreen.disabled = false;
        syncFullscreenUI();
        resize();
      });
    };
  }

  window.addEventListener('resize', resize);
  window.addEventListener('vkconfigchange', function () {
    resize();
    syncFullscreenUI();
  });
  window.addEventListener('vkfullscreenchange', function () {
    syncFullscreenUI();
    resize();
  });
  window.addEventListener('load', syncCustomScrollbar);

  var scrollbarDrag = null;
  if (el.app && el.scrollbar && el.scrollbarThumb) {
    el.app.addEventListener('scroll', syncCustomScrollbar, { passive: true });

    el.scrollbar.addEventListener('pointerdown', function (event) {
      event.preventDefault();
      syncCustomScrollbar();
      var trackRect = el.scrollbar.getBoundingClientRect();
      var thumbHeight = el.scrollbarThumb.offsetHeight;
      var inset = 3;
      var travel = Math.max(1, trackRect.height - inset * 2 - thumbHeight);
      var maxScroll = Math.max(0, el.app.scrollHeight - el.app.clientHeight);

      if (event.target !== el.scrollbarThumb) {
        var targetTop = event.clientY - trackRect.top - inset - thumbHeight / 2;
        var share = Math.max(0, Math.min(1, targetTop / travel));
        el.app.scrollTop = share * maxScroll;
        syncCustomScrollbar();
        return;
      }

      scrollbarDrag = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startScroll: el.app.scrollTop,
        maxScroll: maxScroll,
        travel: travel
      };
      el.scrollbar.classList.add('dragging');
      el.scrollbar.setPointerCapture(event.pointerId);
    });

    el.scrollbar.addEventListener('pointermove', function (event) {
      if (!scrollbarDrag || event.pointerId !== scrollbarDrag.pointerId) return;
      event.preventDefault();
      var delta = event.clientY - scrollbarDrag.startY;
      el.app.scrollTop = scrollbarDrag.startScroll +
        delta * scrollbarDrag.maxScroll / scrollbarDrag.travel;
    });

    function endScrollbarDrag(event) {
      if (!scrollbarDrag || event.pointerId !== scrollbarDrag.pointerId) return;
      try { el.scrollbar.releasePointerCapture(event.pointerId); } catch (error) { }
      scrollbarDrag = null;
      el.scrollbar.classList.remove('dragging');
      syncCustomScrollbar();
    }

    el.scrollbar.addEventListener('pointerup', endScrollbarDrag);
    el.scrollbar.addEventListener('pointercancel', endScrollbarDrag);
  }

  if (el.rules) {
    el.rules.addEventListener('toggle', function () {
      if (el.rules.open) {
        pauseRuntime('rules');
        if (Platform) Platform.stopGameplay();
      } else {
        resumeRuntime('rules');
        if (Platform && el.overlay.hidden &&
            (G.mode === 'draw' || G.mode === 'run' || G.mode === 'replay')) {
          startGameplayIfInteractive();
        }
      }
      requestAnimationFrame(syncCustomScrollbar);
    });
  }

  // Убираем системное меню по правому клику и по долгому тапу.
  document.addEventListener('contextmenu', function (event) {
    event.preventDefault();
  });

  if (Platform) {
    Platform.registerLifecycleHooks({
      pause: function () {
        pauseRuntime('platform');
        drag.on = false;
        if (el.app) el.app.inert = true;
      },
      resume: function () {
        if (el.app) el.app.inert = !startupReady;
        resumeRuntime('platform');
        startGameplayIfInteractive();
      }
    });
  }

  // отладочный доступ для тестов/консоли
  window.GamiltonSnake = {
    state: G, anim: anim, loadLevel: loadLevel, simulate: simulate,
    startRun: startRun, stateAt: stateAt, draw: draw, syncUI: syncUI,
    platform: Platform,
    setPath: function (ids) {
      G.path = ids.slice();
      G.posInPath.fill(-1);
      for (var i = 0; i < ids.length; i++) G.posInPath[ids[i]] = i;
      G.closed = ids.length > 3 && isNeighbour(ids[ids.length - 1], ids[0]);
      draw(); syncUI();
    }
  };

  // ---------------------------------------------------------------- запуск
  (function init() {
    var startup = Platform ? Platform.init() : Promise.resolve({ initialData: load() });
    startup.then(function (platformState) {
      var data = platformState.initialData || load();
      G.unlocked = data.unlocked || 1;
      G.score = data.score || 0;
      var start = Math.min(Math.max(0, (data.unlocked || 1) - 1), LEVELS.length - 1);
      loadLevel(start, true, true);
      startupReady = true;
      if (el.app) el.app.inert = !!runtimePauseReasons.platform;
      syncFullscreenUI();
      // К этому кадру облачный прогресс применён, интерфейс и canvas готовы.
      requestAnimationFrame(function () {
        if (Platform) {
          Platform.gameReady();
          startGameplayIfInteractive();
        }
      });
    }).catch(function (error) {
      console.error('Не удалось запустить игру.', error);
      var data = load();
      G.unlocked = data.unlocked || 1;
      G.score = data.score || 0;
      loadLevel(Math.min(G.unlocked - 1, LEVELS.length - 1), true, true);
      startupReady = true;
      if (el.app) el.app.inert = !!runtimePauseReasons.platform;
      syncFullscreenUI();
      if (Platform) Platform.gameReady();
    });
  })();

})();
