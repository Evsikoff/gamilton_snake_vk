# -*- coding: utf-8 -*-
"""Гамильтонов цикл на поле уровня.

Алгоритм: 2-фактор из двух непересекающихся совершенных паросочетаний
двудольного графа (сетка + горизонтальный wrap), затем слияние
получившихся циклов 2-opt-ходами (разрешены и вертикальные wrap-рёбра).
"""
import sys, random, time, json, io
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import maximum_bipartite_matching
from levels import LEVELS, W, H

def build(grid):
    idx = {}; cells = []
    for r in range(H):
        for c in range(W):
            if grid[r][c] == '.':
                idx[(c, r)] = len(cells); cells.append((c, r))
    adj = [[] for _ in cells]          # полный граф (с обоими wrap)
    bip = [[] for _ in cells]          # двудольная часть (без вертикального wrap)
    for k, (c, r) in enumerate(cells):
        for dc, dr in ((1,0),(0,1),(-1,0),(0,-1)):
            nc, nr = (c+dc) % W, (r+dr) % H
            j = idx.get((nc, nr))
            if j is None: continue
            adj[k].append(j)
            if dr == 0 or 0 <= r + dr < H:
                bip[k].append(j)
    return cells, adj, bip, idx

def two_factor(cells, bip, rnd):
    col = [(c + r) % 2 for (c, r) in cells]
    X = [k for k in range(len(cells)) if col[k] == 0]
    Y = [k for k in range(len(cells)) if col[k] == 1]
    if len(X) != len(Y): return None
    rnd.shuffle(X); rnd.shuffle(Y)
    xi = {v: i for i, v in enumerate(X)}; yi = {v: i for i, v in enumerate(Y)}
    edges = [(xi[u], yi[v]) for u in X for v in bip[u]]
    banned = set()
    link = {k: [] for k in range(len(cells))}
    for _round in range(2):
        e = [(a, b) for (a, b) in edges if (a, b) not in banned]
        rows = np.array([a for a, b in e]); cs = np.array([b for a, b in e])
        m = csr_matrix((np.ones(len(e), dtype=np.uint8), (rows, cs)), shape=(len(X), len(Y)))
        mt = maximum_bipartite_matching(m, perm_type='column')
        if (mt < 0).any(): return None
        for a in range(len(X)):
            b = int(mt[a]); banned.add((a, b))
            u, v = X[a], Y[b]
            link[u].append(v); link[v].append(u)
    for k in link:
        if len(link[k]) != 2 or link[k][0] == link[k][1]: return None
    return link

def cycles_of(link, n):
    cid = [-1]*n; cnt = 0
    for s in range(n):
        if cid[s] != -1: continue
        v, prev = s, None
        while cid[v] == -1:
            cid[v] = cnt
            nxt = link[v][0] if link[v][0] != prev else link[v][1]
            prev, v = v, nxt
        cnt += 1
    return cid, cnt

def merge_all(adj, link, n, rnd):
    cid, cnt = cycles_of(link, n)
    guard = 0
    while cnt > 1:
        guard += 1
        if guard > n: return None
        order = list(range(n)); rnd.shuffle(order)
        done = False
        for u in order:
            for v in adj[u]:
                if cid[v] == cid[u]: continue
                for a2 in link[u]:
                    for b2 in link[v]:
                        if b2 in adj[a2] and a2 != v and b2 != u and a2 != b2:
                            link[u].remove(a2); link[a2].remove(u)
                            link[v].remove(b2); link[b2].remove(v)
                            link[u].append(v); link[v].append(u)
                            link[a2].append(b2); link[b2].append(a2)
                            done = True; break
                    if done: break
                if done: break
            if done: break
        if not done: return None
        cid, cnt = cycles_of(link, n)
    v, prev, out = 0, None, []
    for _ in range(n):
        out.append(v)
        nxt = link[v][0] if link[v][0] != prev else link[v][1]
        prev, v = v, nxt
    return out

def check(adj, n, cyc):
    return (cyc is not None and len(cyc) == n and len(set(cyc)) == n
            and all(cyc[(k+1) % n] in adj[cyc[k]] for k in range(n)))

if __name__ == '__main__':
    data = {}; ok_all = True
    for i, g in enumerate(LEVELS, 1):
        cells, adj, bip, idx = build(g)
        n = len(cells); t0 = time.time(); sol = None
        for seed in range(40):
            rnd = random.Random(seed * 7919 + i)
            link = two_factor(cells, bip, rnd)
            if link is None: continue
            sol = merge_all(adj, link, n, rnd)
            if check(adj, n, sol): break
            sol = None
        dt = time.time() - t0
        if sol:
            data[i] = [[cells[k][0], cells[k][1]] for k in sol]
            print(f'level {i}: {n} cells -> OK ({dt:.1f}s, seed={seed})')
        else:
            ok_all = False; print(f'level {i}: {n} cells -> FAIL ({dt:.1f}s)')
    with io.open('solutions.json', 'w', encoding='utf-8') as f:
        json.dump(data, f)
    print('saved', len(data), 'solutions; all ok =', ok_all)
