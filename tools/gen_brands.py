# -*- coding: utf-8 -*-
"""
从 tools/beadcolors/*.csv 生成 data/brands.js。

数据来源：https://github.com/maxcleme/beadcolors （社区维护拼豆色卡库）
CSV 格式：[色号, 名称, R, G, B, 贡献者]

重跑方式：python3 tools/gen_brands.py
不要手改 data/brands.js —— 它由本脚本生成，手改会在下次重跑时丢失。
"""
import io
import os
import csv
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, 'tools', 'beadcolors')
OUT = os.path.join(ROOT, 'data', 'brands.js')

# key, 显示名, 规格, CSV 文件名, 默认品牌
BRANDS = [
    ('mard',     'MARD',     '2.6mm 中豆', 'mard.csv'),
    ('artkal_c', 'Artkal C', '2.6mm 中豆', 'artkal_c.csv'),
    ('artkal_s', 'Artkal S', '5mm 大豆',   'artkal_s.csv'),
    ('hama',     'Hama',     '5mm 大豆',   'hama.csv'),
    ('perler',   'Perler',   '5mm 大豆',   'perler.csv'),
]
DEFAULT_BRAND = 'mard'


def short_code(code, used):
    """给色号挑一个能印进格子（≤4 字符）的短码，并保证品牌内唯一。

    Perler 的色号是 80-15179 这种长 SKU，直接印不下。
    规则：先去掉 '80-' 之类的前缀；仍超 4 字符则取末 4 位；冲突就逐位加长。
    """
    cand = code.split('-')[-1] if '-' in code else code
    if len(cand) <= 4 and cand not in used:
        used.add(cand)
        return cand
    for n in (4, 5, 6, 7, 8):
        s = cand[-n:]
        if s not in used:
            used.add(s)
            return s
    # 极端情况：加序号兜底（理论上不会走到）
    i = 2
    while ('%s%d' % (cand[-3:], i)) in used:
        i += 1
    s = '%s%d' % (cand[-3:], i)
    used.add(s)
    return s


def load(path):
    rows = [r for r in csv.reader(io.open(path, encoding='utf-8', errors='ignore'))
            if r and any(x.strip() for x in r)]
    out = []
    for r in rows:
        if len(r) < 5:
            continue
        code = (r[0] or '').strip()
        name = (r[1] or '').strip()
        try:
            R, G, B = int(float(r[2])), int(float(r[3])), int(float(r[4]))
        except ValueError:
            continue
        if not code:
            continue
        if not (0 <= R <= 255 and 0 <= G <= 255 and 0 <= B <= 255):
            print('  ! 跳过越界色值: %s %s' % (code, (R, G, B)))
            continue
        out.append({'code': code, 'name': name or code, 'hex': '#%02X%02X%02X' % (R, G, B)})
    return out


def js_str(s):
    return "'" + str(s).replace('\\', '\\\\').replace("'", "\\'") + "'"


def main():
    brands = []
    total = 0
    problems = []

    for key, label, size, fname in BRANDS:
        path = os.path.join(RAW_DIR, fname)
        if not os.path.exists(path):
            print('缺少数据文件: %s' % path)
            return 1
        colors = load(path)

        # 校验：品牌内色号唯一
        seen = {}
        uniq = []
        for c in colors:
            if c['code'] in seen:
                problems.append('%s 色号重复: %s' % (label, c['code']))
                continue
            seen[c['code']] = True
            uniq.append(c)

        used = set()
        for c in uniq:
            c['short'] = short_code(c['code'], used)

        # 校验：hex 合法
        for c in uniq:
            h = c['hex']
            if len(h) != 7 or h[0] != '#':
                problems.append('%s hex 非法: %s %s' % (label, c['code'], h))
            try:
                int(h[1:], 16)
            except ValueError:
                problems.append('%s hex 非十六进制: %s %s' % (label, c['code'], h))

        brands.append((key, label, size, uniq))
        total += len(uniq)

        longest = max(uniq, key=lambda c: len(c['short']))['short']
        print('  %-10s %4d 色   最长短码=%s' % (label, len(uniq), longest))

    assert not problems, '数据校验失败:\n  ' + '\n  '.join(problems)

    lines = []
    lines.append('// data/brands.js')
    lines.append('// 拼豆品牌色板（真实色号）。')
    lines.append('//')
    lines.append('// 【自动生成，请勿手改】由 tools/gen_brands.py 从 tools/beadcolors/*.csv 生成，')
    lines.append('// 数据源：https://github.com/maxcleme/beadcolors （社区维护色卡库）')
    lines.append('// 重新生成：python3 tools/gen_brands.py')
    lines.append('//')
    lines.append('// 每个颜色：')
    lines.append('//   code  品牌真实色号（购买时按它对货）')
    lines.append('//   name  颜色名（部分品牌与色号相同，说明官方未给名）')
    lines.append('//   hex   色值。注意：社区从实物拍照取色整理，与实物存在色差，非官方值。')
    lines.append('//   short 格内标注用短码（Perler 的长 SKU 会截断，保证品牌内唯一）')
    lines.append('')
    lines.append("module.exports = {")
    lines.append("  DEFAULT_BRAND: %s," % js_str(DEFAULT_BRAND))
    lines.append("  BRANDS: [")
    for key, label, size, colors in brands:
        lines.append("    {")
        lines.append("      key: %s, name: %s, size: %s," % (js_str(key), js_str(label), js_str(size)))
        lines.append("      colors: [")
        for c in colors:
            lines.append("        { code: %s, name: %s, hex: %s, short: %s },"
                         % (js_str(c['code']), js_str(c['name']), js_str(c['hex']), js_str(c['short'])))
        lines.append("      ]")
        lines.append("    },")
    lines.append("  ]")
    lines.append("};")
    lines.append('')

    text = '\n'.join(lines)
    d = os.path.dirname(OUT)
    if not os.path.isdir(d):
        os.makedirs(d)
    io.open(OUT, 'w', encoding='utf-8', newline='\n').write(text)

    size_kb = len(text.encode('utf-8')) / 1024.0
    print('')
    print('生成 %s' % OUT)
    print('  品牌 %d 个，颜色 %d 个，%.1f KB' % (len(brands), total, size_kb))
    return 0


if __name__ == '__main__':
    sys.exit(main())
