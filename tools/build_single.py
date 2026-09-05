# -*- coding: utf-8 -*-
"""Собирает релизные файлы игры.

dist/gamilton-snake.html — полноценная страница (открывается двойным кликом);
dist/artifact.html       — то же без <html>/<head>/<body>, для публикации артефактом.
dist/vk-games.zip        — архив с index.html в корне для размещения игры VK.
"""
import io
import os
import re
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def read(rel):
    with io.open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()

def write(rel, text):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    return os.path.getsize(path)

def build():
    page = read('index.html')
    css = read('css/style.css')
    js = '\n'.join(read('js/' + n) for n in
                   ('levels.js', 'solver.js', 'vk-games.js', 'game.js'))
    # Deferred Bridge must load before game initialization in the bundled page.
    # The ready-state branch also permits insertion of the artifact after load.
    bundled_js = ('(function () {\nfunction startGame() {\n' + js +
                  '\n}\nif (document.readyState === "loading") {\n'
                  '  document.addEventListener("DOMContentLoaded", startGame, { once: true });\n'
                  '} else {\n  startGame();\n}\n})();')

    head = page.split('<body>', 1)[0]
    external_assets = '\n'.join(re.findall(
        r'<link [^>]*href="https://[^"]+"[^>]*>|'
        r'<script [^>]*src="https://[^"]+"[^>]*></script>', head))
    body = page.split('<body>', 1)[1].rsplit('</body>', 1)[0]
    body = re.sub(r'\s*<script\b[^>]*\bsrc="js/[^"]+"[^>]*></script>', '', body).strip()

    standalone = (page.split('<body>', 1)[0]
                  .replace('<link rel="stylesheet" href="css/style.css">',
                           '<style>\n' + css + '\n</style>')
                  + '<body>\n' + body
                  + '\n<script>\n' + bundled_js + '\n</script>\n</body>\n</html>\n')

    artifact = ('<title>Змейка Гамильтона</title>\n' + external_assets +
                '\n<style>\n' + css + '\n</style>\n'
                + body + '\n<script>\n' + bundled_js + '\n</script>\n')

    print('dist/gamilton-snake.html', write('dist/gamilton-snake.html', standalone), 'bytes')
    print('dist/artifact.html      ', write('dist/artifact.html', artifact), 'bytes')

    archive_path = os.path.join(ROOT, 'dist', 'vk-games.zip')
    archive_files = (
        'index.html',
        'css/style.css',
        'js/levels.js',
        'js/solver.js',
        'js/vk-games.js',
        'js/game.js',
    )
    with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for rel in archive_files:
            archive.write(os.path.join(ROOT, rel), rel.replace(os.sep, '/'))
    print('dist/vk-games.zip       ', os.path.getsize(archive_path), 'bytes')

if __name__ == '__main__':
    build()
