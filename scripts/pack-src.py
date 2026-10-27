#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把当前工程打成源码 zip。

两种用途：
  默认（干净版）—— 发给别人 / 新机：带 data/config.default.json，
                   里面没有任何商品、券、秒杀卡，装好要自己抓。
  --dev（开发版）—— 换设备继续开发：额外带上本机的 data/config.json（含已抓好的业务数据）。

只装源码 + 脚本 + 图标 + 配置，排除 node_modules / release / .git / 抓取产物。
zip 内统一带一层 巡洋战略舰-<版本>/ 目录，解压不会散落一地。

用法：python scripts/pack-src.py [输出目录] [--dev]
"""
import json
import os
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
pkg = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
VERSION = pkg['version']
NAME = '巡洋战略舰'

args = [a for a in sys.argv[1:] if not a.startswith('--')]
DEV = '--dev' in sys.argv            # 带本机业务数据（换设备继续开发用）

out_dir = Path(args[0]) if args else ROOT / 'release'
out_dir.mkdir(parents=True, exist_ok=True)
out_path = out_dir / (f'{NAME}-源码-{VERSION}-dev.zip' if DEV else f'{NAME}-源码-{VERSION}.zip')

# 单个文件（按需增删）
FILES = [
    'main.js', 'guest.js', 'preload.js',
    'package.json', 'package-lock.json',
    'HANDOVER.md', 'README.md', 'README-PC.txt',
    'start.bat', 'install.bat',
    'start.command', '首次安装.command', '抓取后台结构.command',
    '.gitattributes', '.gitignore',
    # 出厂配置：干净，新机装好没有任何业务数据
    'data/config.default.json',
] + (['data/config.json'] if DEV else [])
# 目录（整目录带进去，但按 SUFFIX/SKIP 过滤）
DIRS = ['src', 'build', 'test', 'scripts']

SKIP_DIR_NAMES = {'node_modules', 'release', '.git', 'icon.iconset', '.ui-test-userdata', '__pycache__'}
SKIP_SUFFIX = {'.log', '.log.json', '.pyc', '.map'}
SKIP_FILES = {'live-all.log.json', 'Thumbs.db', 'desktop.ini', '.DS_Store'}


def wanted(p: Path) -> bool:
    if p.name in SKIP_FILES or p.suffix in SKIP_SUFFIX:
        return False
    return True


prefix = f'{NAME}-{VERSION}/'
count = 0
total = 0
with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    def add(path: Path):
        global count, total
        if not wanted(path):
            return
        arc = prefix + path.relative_to(ROOT).as_posix()
        z.write(path, arc)
        count += 1
        total += path.stat().st_size

    for f in FILES:
        p = ROOT / f
        if p.exists():
            add(p)
        else:
            print(f'  [跳过] 缺文件：{f}')

    for d in DIRS:
        base = ROOT / d
        if not base.exists():
            continue
        for cur, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x not in SKIP_DIR_NAMES]
            for fn in filenames:
                add(Path(cur) / fn)

size = out_path.stat().st_size
print(f'\n打包完成：{out_path}   [{"开发版·含本机业务数据" if DEV else "干净版·无任何业务数据"}]')
print(f'  条目 {count} 个 · 原始 {total / 1024 / 1024:.1f} MB · 压缩后 {size / 1024 / 1024:.1f} MB')

# 自检：能不能正常读出来
with zipfile.ZipFile(out_path) as z:
    bad = z.testzip()
    names = z.namelist()
    print(f'  自检：{len(names)} 个条目，CRC {"异常：" + str(bad) if bad else "全部正常"}')
    for must in ['main.js', 'src/app.js', 'start.command', '首次安装.command',
                 'package.json', 'data/config.default.json']:
        ok = any(n.endswith('/' + must) for n in names)
        print(f'    {"✓" if ok else "✗"} {must}')
    # 干净版绝不能把开发机的业务数据带出去
    leaked = [n for n in names if n.endswith('/data/config.json')]
    if DEV:
        print(f'    {"✓" if leaked else "✗"} data/config.json（--dev 应带）')
    else:
        print(f'    {"✗ 泄漏了开发机配置！" if leaked else "✓"} 干净版不含 data/config.json')
