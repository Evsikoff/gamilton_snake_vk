"""Определения уровней «Змейки Гамильтона».

Поле 40 x 17 клеток (оригинал Snake II — 39 x 17; одна колонка добавлена,
чтобы у каждого уровня существовал гамильтонов цикл).
Карты получены попиксельным разбором скриншотов mazes/*.jpg.
"""
W, H = 40, 17

def blank():
    return [['.'] * W for _ in range(H)]

def hline(g, r, c0, c1):
    for c in range(c0, c1 + 1):
        g[r][c] = '#'

def vline(g, c, r0, r1):
    for r in range(r0, r1 + 1):
        g[r][c] = '#'

def lvl1():
    return blank()

def lvl2():                                   # 2.jpg — сплошная рамка
    g = blank()
    hline(g, 0, 0, W - 1); hline(g, H - 1, 0, W - 1)
    vline(g, 0, 0, H - 1); vline(g, W - 1, 0, H - 1)
    return g

def lvl3():                                   # 3.jpg — уголки + два бруска
    g = blank()
    for c0, c1 in ((0, 2), (W - 3, W - 1)):
        hline(g, 0, c0, c1); hline(g, H - 1, c0, c1)
    for c in (0, W - 1):
        vline(g, c, 1, 2); vline(g, c, H - 3, H - 2)
    hline(g, 6, 16, 25); hline(g, 10, 16, 25)
    return g

def lvl4():                                   # 4.jpg — «вертушка»
    g = blank()
    vline(g, 16, 0, 8)
    hline(g, 4, 21, W - 1)
    vline(g, 24, 7, H - 1)
    hline(g, 12, 0, 19)
    return g

def lvl5():                                   # 5.jpg — рамка с проходами + два столба
    g = blank()
    hline(g, 0, 0, W - 1); hline(g, H - 1, 0, W - 1)
    for c in (0, W - 1):
        vline(g, c, 1, 6); vline(g, c, 10, H - 2)   # проёмы в рядах 7,8,9
    vline(g, 14, 4, 13); vline(g, 26, 4, 13)
    return g

def lvl6():                                   # 6.jpg — три яруса
    g = blank()
    hline(g, 0, 0, 5); hline(g, 0, 10, 33)
    vline(g, 0, 1, 2); vline(g, 16, 1, 5)
    hline(g, 6, 0, 16); hline(g, 6, 22, W - 1)
    hline(g, 12, 0, W - 1)
    vline(g, 22, 13, H - 1)
    return g

def lvl7():                                   # 7.jpg — крест
    g = blank()
    vline(g, 20, 0, H - 1); hline(g, 8, 0, W - 1)
    return g

def lvl8():                                   # 8.jpg — «стол»
    g = blank()
    hline(g, 8, 0, W - 1)
    vline(g, 10, 9, H - 1); vline(g, 29, 9, H - 1)
    return g

LEVELS = [lvl1(), lvl2(), lvl3(), lvl4(), lvl5(), lvl6(), lvl7(), lvl8()]
MAPS = ["".join("".join(r) for r in g) for g in LEVELS]

if __name__ == '__main__':
    for i, g in enumerate(LEVELS, 1):
        free = sum(r.count('.') for r in g)
        print(f"--- уровень {i}: свободных {free}")
        for r in g:
            print("   " + "".join(r))
