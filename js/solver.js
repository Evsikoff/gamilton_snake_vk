// Построение гамильтонова цикла на поле уровня.
//
// Идея: поле без вертикальных wrap-рёбер — двудольный граф (клетки красятся
// в шахматном порядке). Берём в нём два непересекающихся совершенных
// паросочетания: их объединение даёт 2-фактор — набор непересекающихся циклов,
// покрывающих все свободные клетки. Затем сливаем циклы 2-opt-ходами
// (здесь уже разрешены любые рёбра, включая вертикальный wrap), пока не
// останется один цикл — он и есть гамильтонов.

var Solver = (function () {

  function buildGraph(W, H, wall) {
    var idOf = new Int32Array(W * H).fill(-1);
    var cells = [];
    for (var r = 0; r < H; r++) {
      for (var c = 0; c < W; c++) {
        var id = r * W + c;
        if (!wall[id]) { idOf[id] = cells.length; cells.push(id); }
      }
    }
    var n = cells.length;
    var adj = new Array(n), bip = new Array(n);
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var k = 0; k < n; k++) {
      var cid = cells[k], cc = cid % W, cr = (cid / W) | 0;
      var a = [], b = [];
      for (var d = 0; d < 4; d++) {
        var nc = (cc + dirs[d][0] + W) % W;
        var rr = cr + dirs[d][1];
        var nr = (rr + H) % H;
        var j = idOf[nr * W + nc];
        if (j < 0) continue;
        a.push(j);
        if (dirs[d][1] === 0 || (rr >= 0 && rr < H)) b.push(j);
      }
      adj[k] = a; bip[k] = b;
    }
    return { W: W, H: H, cells: cells, idOf: idOf, adj: adj, bip: bip, n: n };
  }

  // --- простое случайное ГПСЧ, чтобы решение было воспроизводимым ---
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rand) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = (rand() * (i + 1)) | 0;
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // Совершенное паросочетание в двудольном графе (алгоритм Куна).
  // xs / ys — списки вершин графа; cand[i] — допустимые позиции в ys для xs[i].
  function kuhn(xs, ys, cand) {
    var nx = xs.length, ny = ys.length;
    var matchY = new Int32Array(ny).fill(-1);
    var matchX = new Int32Array(nx).fill(-1);
    var seen = new Int32Array(ny).fill(-1);

    function tryK(x, stamp) {
      var list = cand[x];
      for (var i = 0; i < list.length; i++) {
        var y = list[i];
        if (seen[y] === stamp) continue;
        seen[y] = stamp;
        if (matchY[y] === -1 || tryK(matchY[y], stamp)) {
          matchY[y] = x; matchX[x] = y;
          return true;
        }
      }
      return false;
    }

    for (var x = 0; x < nx; x++) {
      if (matchX[x] === -1 && !tryK(x, x)) return null;
    }
    return matchX;
  }

  function twoFactor(g, rand) {
    var n = g.n, W = g.W;
    var col = new Uint8Array(n);
    for (var k = 0; k < n; k++) {
      var id = g.cells[k];
      col[k] = ((id % W) + ((id / W) | 0)) & 1;
    }
    var xs = [], ys = [];
    for (var i = 0; i < n; i++) (col[i] ? ys : xs).push(i);
    if (xs.length !== ys.length) return null;
    shuffle(xs, rand); shuffle(ys, rand);

    var yPos = new Int32Array(n).fill(-1);
    for (var q = 0; q < ys.length; q++) yPos[ys[q]] = q;

    var cand = new Array(xs.length);
    for (var a = 0; a < xs.length; a++) {
      var list = [];
      var nb = g.bip[xs[a]];
      for (var t = 0; t < nb.length; t++) list.push(yPos[nb[t]]);
      cand[a] = shuffle(list, rand);
    }

    var link = new Array(n);
    for (var z = 0; z < n; z++) link[z] = [];

    for (var round = 0; round < 2; round++) {
      var m = kuhn(xs, ys, cand);
      if (!m) return null;
      for (var x = 0; x < xs.length; x++) {
        var u = xs[x], v = ys[m[x]];
        link[u].push(v); link[v].push(u);
        // во втором раунде это ребро уже нельзя использовать
        var lst = cand[x], p = lst.indexOf(m[x]);
        if (p >= 0) lst.splice(p, 1);
      }
    }
    for (var w = 0; w < n; w++) {
      if (link[w].length !== 2 || link[w][0] === link[w][1]) return null;
    }
    return link;
  }

  function cycleIds(link, n) {
    var cid = new Int32Array(n).fill(-1), cnt = 0;
    for (var s = 0; s < n; s++) {
      if (cid[s] !== -1) continue;
      var v = s, prev = -1;
      while (cid[v] === -1) {
        cid[v] = cnt;
        var nx = link[v][0] !== prev ? link[v][0] : link[v][1];
        prev = v; v = nx;
      }
      cnt++;
    }
    return { cid: cid, count: cnt };
  }

  function mergeCycles(g, link, rand) {
    var n = g.n, adj = g.adj;
    var st = cycleIds(link, n);
    var guard = 0;
    while (st.count > 1) {
      if (++guard > n) return null;
      var order = [];
      for (var i = 0; i < n; i++) order.push(i);
      shuffle(order, rand);
      var done = false;
      for (var oi = 0; oi < order.length && !done; oi++) {
        var u = order[oi], nb = adj[u];
        for (var t = 0; t < nb.length && !done; t++) {
          var v = nb[t];
          if (st.cid[v] === st.cid[u]) continue;
          for (var p = 0; p < 2 && !done; p++) {
            var a2 = link[u][p];
            for (var q = 0; q < 2 && !done; q++) {
              var b2 = link[v][q];
              if (a2 === b2 || a2 === v || b2 === u) continue;
              if (adj[a2].indexOf(b2) < 0) continue;
              // разрываем (u,a2) и (v,b2), сшиваем (u,v) и (a2,b2)
              link[u].splice(link[u].indexOf(a2), 1);
              link[a2].splice(link[a2].indexOf(u), 1);
              link[v].splice(link[v].indexOf(b2), 1);
              link[b2].splice(link[b2].indexOf(v), 1);
              link[u].push(v); link[v].push(u);
              link[a2].push(b2); link[b2].push(a2);
              done = true;
            }
          }
        }
      }
      if (!done) return null;
      st = cycleIds(link, n);
    }
    var out = [], vv = 0, pv = -1;
    for (var s2 = 0; s2 < n; s2++) {
      out.push(g.cells[vv]);
      var nx2 = link[vv][0] !== pv ? link[vv][0] : link[vv][1];
      pv = vv; vv = nx2;
    }
    return out;
  }

  // Возвращает массив id клеток — гамильтонов цикл, или null.
  function hamiltonCycle(W, H, wall, seed) {
    var g = buildGraph(W, H, wall);
    if (g.n < 4) return null;
    for (var attempt = 0; attempt < 25; attempt++) {
      var rand = rng((seed || 1) * 7919 + attempt * 104729);
      var link = twoFactor(g, rand);
      if (!link) continue;
      var cyc = mergeCycles(g, link, rand);
      if (cyc && cyc.length === g.n) return cyc;
    }
    return null;
  }

  return { hamiltonCycle: hamiltonCycle, buildGraph: buildGraph };
})();
