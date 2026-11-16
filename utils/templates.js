// utils/templates.js
// 内置模板图形：手绘像素网格，'.'=背景(不拼)，其他字母=对应颜色下标。
// 套用后生成 { w, h, shape, colors, grid }，可直接作为编辑器初始图纸。

const TEMPLATES = [
  {
    key: 'heart', name: '爱心', w: 15, h: 15, shape: 'rect',
    colors: [{ key: 'R', name: '红色', hex: '#E0301E' }],
    rows: [
      '......RRR......',
      '....RRRRRRR....',
      '...RRRRRRRRR...',
      '..RRRRRRRRRRR..',
      '..RRRRRRRRRRR..',
      '..RRRRRRRRRRR..',
      '...RRRRRRRRR...',
      '....RRRRRRR....',
      '.....RRRRR.....',
      '......RRR......',
      '.......R.......',
      '...............',
      '...............',
      '...............',
      '...............'
    ]
  },
  {
    key: 'star', name: '五角星', w: 11, h: 11, shape: 'rect',
    colors: [{ key: 'Y', name: '黄色', hex: '#FFD800' }],
    rows: [
      '.....Y.....',
      '.....Y.....',
      '....YYY....',
      '....YYY....',
      'YYYYYYYYYYY',
      '.YYYYYYYYY.',
      '..YYYYYYY..',
      '.YY.....YY.',
      '.YY.....YY.',
      '.Y.......Y.',
      '.Y.......Y.'
    ]
  },
  {
    key: 'cat', name: '小猫', w: 11, h: 11, shape: 'rect',
    colors: [
      { key: 'O', name: '橙色', hex: '#FF7F00' },
      { key: 'K', name: '黑色', hex: '#1A1A1A' }
    ],
    rows: [
      '.O.......O.',
      '.OO.....OO.',
      '.OOO...OOO.',
      '.OOOO.OOOO.',
      'OOOOOOOOOOO',
      'OKKOOOOKKOO',
      'OOOOOOOOOOO',
      'OOOOKKOOOOO',
      'OOOOOOOOOOO',
      '.OOOKKOOOO.',
      '..OOOOOOO..'
    ]
  },
  {
    key: 'smiley', name: '笑脸', w: 11, h: 11, shape: 'rect',
    colors: [
      { key: 'Y', name: '黄色', hex: '#FFD800' },
      { key: 'K', name: '黑色', hex: '#1A1A1A' }
    ],
    rows: [
      'YYYYYYYYYYY',
      'YKKYYYKKYYY',
      'YYYYYYYYYYY',
      'YYYYYYYYYYY',
      'YYKKKKKKKYY',
      'YYKYYYYYKYY',
      'YYKKKKKKKYY',
      'YYYYYYYYYYY',
      'YYYYYYYYYYY',
      'YYYYYYYYYYY',
      'YYYYYYYYYYY'
    ]
  },
  {
    key: 'flower', name: '小花', w: 11, h: 11, shape: 'rect',
    colors: [
      { key: 'P', name: '粉色', hex: '#F06292' },
      { key: 'Y', name: '黄色', hex: '#FFD800' }
    ],
    rows: [
      '....PPP....',
      '..PPPPPPP..',
      '.PPPPPPPPP.',
      'PPPPPPPPPPP',
      'PPPPYPPPPP',
      'PPPPYPPPPP',
      'PPPPPPPPPPP',
      '.PPPPPPPPP.',
      '..PPPPPPP..',
      '....PPP....',
      '...........'
    ]
  },
  {
    key: 'letterA', name: '字母 A', w: 11, h: 11, shape: 'rect',
    colors: [{ key: 'B', name: '蓝色', hex: '#1B7FC2' }],
    rows: [
      '.....B.....',
      '....BBB....',
      '....BBB....',
      '...BBBBB...',
      '...BBBBB...',
      '..BBBBBBB..',
      '..BBBBBBB..',
      '.BBBBBBBBB.',
      '.B.B.B.B.B.',
      '.B.....B...',
      '.B.....B...'
    ]
  }
];

function parse(t) {
  const colorByKey = {};
  t.colors.forEach((c, i) => { colorByKey[c.key] = i; });
  const grid = new Array(t.w * t.h).fill(-1);
  for (let y = 0; y < t.h; y++) {
    const row = t.rows[y] || '';
    for (let x = 0; x < t.w; x++) {
      const ch = row[x] || '.';
      if (ch !== '.' && colorByKey[ch] !== undefined) {
        grid[y * t.w + x] = colorByKey[ch];
      }
    }
  }
  const colors = t.colors.map(c => ({ name: c.name, hex: c.hex }));
  return { w: t.w, h: t.h, shape: t.shape || 'rect', colors, grid };
}

function getTemplate(key) {
  const t = TEMPLATES.find(x => x.key === key);
  return t ? parse(t) : null;
}

function getTemplateList() {
  return TEMPLATES.map(t => ({ key: t.key, name: t.name }));
}

module.exports = { TEMPLATES, getTemplate, getTemplateList, parse };
