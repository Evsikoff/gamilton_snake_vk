# -*- coding: utf-8 -*-
"""Разбор скриншотов Snake II (mazes/2.jpg … mazes/8.jpg) в сетку клеток.

Калибровка получена по уровню-рамке (2.jpg): игровое поле занимает
x = 10.44 … 288.6 и y = 12.08 … 162.4 пикселя, клетка — 7.128 x 8.844 px,
то есть поле оригинала 39 x 17 клеток. Стены везде толщиной ровно в клетку.

Скрипт печатает карты; они лежат в основе tools/levels.py (там поле расширено
до 40 x 17 и подправлено на 1-3 клетки, чтобы у каждого уровня существовал
гамильтонов цикл — см. README).
"""
import os
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
X0, DX, Y0, DY = 10.44, 7.128, 12.08, 8.844
W, H = 39, 17

def mask(path):
    lum = np.asarray(Image.open(path).convert('RGB')).astype(float).sum(2)
    bg = ndimage.percentile_filter(lum, 85, size=45)   # снимаем виньетку фона
    return lum < 0.72 * bg

def grid(path, margin=1):
    m = mask(path)
    rows = []
    for j in range(-margin, H + margin):
        row = ''
        for i in range(-margin, W + margin):
            cx, cy = X0 + DX * (i + .5), Y0 + DY * (j + .5)
            x0, x1 = int(round(cx - 2)), int(round(cx + 3))
            y0, y1 = int(round(cy - 2)), int(round(cy + 3))
            if x0 < 0 or y0 < 0 or x1 > m.shape[1] or y1 > m.shape[0]:
                row += '?'
            else:
                row += '#' if m[y0:y1, x0:x1].mean() > .5 else '.'
        rows.append(row)
    return rows

if __name__ == '__main__':
    for n in range(2, 9):
        path = os.path.join(ROOT, 'mazes', '%d.jpg' % n)
        if not os.path.exists(path):
            continue
        print('===== %d.jpg  (с рамкой полей в 1 клетку)' % n)
        for row in grid(path):
            print('  ' + row)
