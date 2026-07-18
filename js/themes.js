// ─────────────────────────────────────────────────────────
//  LOCATION THEMES  (3 floors each, 7 themes for 20 floors)
//  buildTileCanvas() in game.js uses these data fields;
//  no per-tile draw functions needed any more.
// ─────────────────────────────────────────────────────────
const THEMES = [

  // ── 0: Лес (этажи 1-3) ──────────────────────────────
  {
    name: '🌲 Лес', bg: '#020a02', mmFloor: '#1e4010',
    wallColor:     '#08140a',   // dark forest wall
    wallEdge:      '#162c12',   // lighter stone edge for masonry lines
    wallHighlight:  0.10,       // white highlight alpha on 3-D top edge
    floorA:        '#0d1a07',   // grass tile A
    floorB:        '#101e09',   // grass tile B (alternating)
    grout:         '#080e04',   // 1-px grout between tiles
    crackColor:    '#1e4010',   // floor detail lines
    crackAlpha:    0.28,
  },

  // ── 1: Пещера (этажи 4-6) ───────────────────────────
  {
    name: '⛏️ Пещера', bg: '#020106', mmFloor: '#201840',
    wallColor:     '#0e0820',
    wallEdge:      '#1c1040',
    wallHighlight:  0.18,
    floorA:        '#0c0a18',
    floorB:        '#0f0d1e',
    grout:         '#06040e',
    crackColor:    '#5018b0',
    crackAlpha:    0.30,
  },

  // ── 2: Руины (этажи 7-9) ────────────────────────────
  {
    name: '🏛️ Руины', bg: '#060402', mmFloor: '#2e2416',
    wallColor:     '#1c1608',
    wallEdge:      '#302814',
    wallHighlight:  0.14,
    floorA:        '#181208',
    floorB:        '#1e1a0e',
    grout:         '#0c0904',
    crackColor:    '#a07840',
    crackAlpha:    0.25,
  },

  // ── 3: Болото (этажи 10-12) ─────────────────────────
  {
    name: '🌿 Болото', bg: '#020601', mmFloor: '#182e0c',
    wallColor:     '#060e06',
    wallEdge:      '#0e1c0a',
    wallHighlight:  0.08,
    floorA:        '#091208',
    floorB:        '#0c160a',
    grout:         '#050a04',
    crackColor:    '#1e4e0e',
    crackAlpha:    0.25,
  },

  // ── 4: Тундра / Лёд (этажи 13-15) ──────────────────
  {
    name: '❄️ Тундра', bg: '#010308', mmFloor: '#182840',
    wallColor:     '#0c1828',
    wallEdge:      '#1c3252',
    wallHighlight:  0.22,
    floorA:        '#09192a',
    floorB:        '#0c2030',
    grout:         '#060e18',
    crackColor:    '#4090c8',
    crackAlpha:    0.25,
  },

  // ── 5: Вулкан (этажи 16-18) ─────────────────────────
  {
    name: '🌋 Вулкан', bg: '#060100', mmFloor: '#301002',
    wallColor:     '#180804',
    wallEdge:      '#381208',
    wallHighlight:  0.22,
    floorA:        '#100400',
    floorB:        '#160802',
    grout:         '#080200',
    crackColor:    '#ff4800',
    crackAlpha:    0.35,
  },

  // ── 6: Бездна (этажи 19-20) ─────────────────────────
  {
    name: '🌑 Бездна', bg: '#000000', mmFloor: '#14061e',
    wallColor:     '#050014',
    wallEdge:      '#120038',
    wallHighlight:  0.25,
    floorA:        '#010008',
    floorB:        '#030012',
    grout:         '#000006',
    crackColor:    '#7000cc',
    crackAlpha:    0.30,
  },
];

function getTheme(lvl) {
  return THEMES[Math.min(Math.floor((lvl - 1) / 3), 6)];
}
