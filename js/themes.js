// ─────────────────────────────────────────────────────────
//  LOCATION THEMES  — one per floor (20 total, 7 zones)
//  buildTileCanvas() in game.js handles all drawing.
//  drawWallDecor(ctx, px, py, h) is called once per wall tile
//  that faces a floor tile below (h = tile hash 0-255).
// ─────────────────────────────────────────────────────────

// ── Decoration helpers ────────────────────────────────────
function _drawLantern(c, x, y, glowColor) {
  // x, y = desired center of lantern body
  c.fillStyle = '#a09878';
  c.fillRect(x - 2, y - 10, 3, 5);    // hook stem
  c.fillRect(x - 2, y - 10, 8, 2);    // hook arm
  c.fillStyle = '#3a3020';
  c.fillRect(x + 3, y - 8, 9, 13);    // body
  c.fillStyle = '#605040';
  c.fillRect(x + 2, y - 9, 11, 2);    // top cap
  c.fillRect(x + 2, y + 5, 11, 2);    // bottom cap
  c.fillStyle = glowColor; c.globalAlpha = 0.88;
  c.fillRect(x + 4, y - 7, 7, 11);    // glass
  c.globalAlpha = 1;
  c.fillStyle = glowColor; c.globalAlpha = 0.22;
  c.beginPath(); c.arc(x + 7, y - 1, 14, 0, Math.PI * 2); c.fill();
  c.globalAlpha = 1;
}

function _drawTorch(c, x, y, flameColor) {
  c.fillStyle = '#6a4820'; c.fillRect(x - 2, y, 4, 14);  // handle
  c.fillStyle = '#503810'; c.fillRect(x - 3, y - 2, 6, 5); // wrap
  c.fillStyle = flameColor; c.globalAlpha = 0.9;
  c.beginPath(); c.moveTo(x - 3, y - 2); c.lineTo(x + 3, y - 2); c.lineTo(x, y - 14); c.closePath(); c.fill();
  c.fillStyle = '#ffffa0'; c.globalAlpha = 0.7;
  c.beginPath(); c.moveTo(x - 1, y - 2); c.lineTo(x + 1, y - 2); c.lineTo(x, y - 10); c.closePath(); c.fill();
  c.globalAlpha = 0.20; c.fillStyle = flameColor;
  c.beginPath(); c.arc(x, y - 6, 12, 0, Math.PI * 2); c.fill();
  c.globalAlpha = 1;
}

function _drawSkull(c, x, y, color) {
  const bc = color || '#d4ccb4';
  c.fillStyle = bc;
  c.beginPath(); c.ellipse(x, y, 7, 6, 0, 0, Math.PI * 2); c.fill();
  c.fillRect(x - 4, y + 5, 9, 3);     // jaw
  c.fillStyle = '#0e0e0e';
  c.beginPath(); c.ellipse(x - 2.5, y - 0.5, 2, 2.5, 0, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.ellipse(x + 2.5, y - 0.5, 2, 2.5, 0, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.ellipse(x, y + 2.5, 1.2, 1.5, 0, 0, Math.PI * 2); c.fill();
  c.fillRect(x - 4, y + 5, 2, 3); c.fillRect(x - 1, y + 5, 2, 3);
  c.fillRect(x + 2, y + 5, 2, 3);
}

function _drawChain(c, x, y, links, color) {
  c.fillStyle = color || '#909090';
  for (let i = 0; i < links; i++) {
    const ly = y + i * 5;
    if (i % 2 === 0) {
      c.fillRect(x - 3, ly, 7, 2); c.fillRect(x - 3, ly + 2, 1, 2); c.fillRect(x + 3, ly + 2, 1, 2);
    } else {
      c.fillRect(x - 1, ly, 3, 4);
    }
  }
}

function _drawCrystal(c, x, y, color, h2) {
  const ch = 10 + h2 % 8;
  c.fillStyle = color;
  c.beginPath(); c.moveTo(x - 4, y + ch); c.lineTo(x + 4, y + ch); c.lineTo(x, y); c.closePath(); c.fill();
  c.fillStyle = 'rgba(255,255,255,0.45)';
  c.beginPath(); c.moveTo(x, y + ch); c.lineTo(x + 4, y + ch); c.lineTo(x, y); c.closePath(); c.fill();
  c.globalAlpha = 0.22; c.fillStyle = color;
  c.beginPath(); c.arc(x, y + ch * 0.5, ch * 0.7, 0, Math.PI * 2); c.fill();
  c.globalAlpha = 1;
}

// ── Themes ────────────────────────────────────────────────
const THEMES = [

  // ── Zone 1: Лес (floors 1-3) ────────────────────────────

  // Floor 1 — Лесная опушка
  {
    name: '🌳 Лесная опушка', bg: '#061408', mmFloor: '#2e5818',
    wallColor: '#0e2010', wallEdge: '#204018', wallHighlight: 0.11,
    floorA: '#162408', floorB: '#1c2c0c', grout: '#0c1806',
    crackColor: '#2e5018', crackAlpha: 0.25,
    drawWallDecor(c, px, py, h) {
      if (h % 5 === 0) {
        // Red mushroom cluster
        const mx = px + 8 + h % 20, my = py + TILE - 10;
        c.fillStyle = '#cc4040'; c.beginPath(); c.ellipse(mx, my - 3, 6, 4, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#fff'; c.beginPath(); c.ellipse(mx - 2, my - 5, 1.5, 1.5, 0, 0, Math.PI * 2); c.fill();
        c.beginPath(); c.ellipse(mx + 2, my - 4, 1, 1, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#e8d8a0'; c.fillRect(mx - 1, my, 3, 6);
      }
    }
  },

  // Floor 2 — Дремучий лес
  {
    name: '🌲 Дремучий лес', bg: '#030e04', mmFloor: '#224014',
    wallColor: '#0c1c0a', wallEdge: '#1a3410', wallHighlight: 0.10,
    floorA: '#121e08', floorB: '#16240c', grout: '#09110a',
    crackColor: '#284e14', crackAlpha: 0.28,
    drawWallDecor(c, px, py, h) {
      if (h % 3 === 0) {
        // Hanging vines
        const vx = px + 10 + h % 18;
        c.fillStyle = '#205814';
        for (let i = 0; i < 5; i++) c.fillRect(vx, py + i * 7 + 2, 2, 5);
        c.fillStyle = '#2e7020';
        for (let i = 1; i < 5; i++) { c.beginPath(); c.ellipse(vx + 5, py + i * 7 + 4, 4, 3, 0.3, 0, Math.PI * 2); c.fill(); }
      }
    }
  },

  // Floor 3 — Лесная чаща
  {
    name: '🌿 Лесная чаща', bg: '#020c04', mmFloor: '#1a3410',
    wallColor: '#0a180c', wallEdge: '#182e14', wallHighlight: 0.09,
    floorA: '#0e1e08', floorB: '#12220c', grout: '#070f06',
    crackColor: '#224012', crackAlpha: 0.30,
    drawWallDecor(c, px, py, h) {
      if (h % 4 === 0) {
        // Glowing fungus
        const fx = px + 10 + h % 18, fy = py + TILE - 10;
        c.globalAlpha = 0.38; c.fillStyle = '#50ff30';
        c.beginPath(); c.arc(fx, fy, 9, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1; c.fillStyle = '#90ff68';
        c.beginPath(); c.ellipse(fx, fy, 5, 4, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#d0ffb0'; c.beginPath(); c.arc(fx - 1, fy - 1, 2, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#d0d090'; c.fillRect(fx - 1, fy + 4, 3, 6);
      }
    }
  },

  // ── Zone 2: Пещера (floors 4-6) ─────────────────────────

  // Floor 4 — Верхняя пещера
  {
    name: '⛏ Верхняя пещера', bg: '#060410', mmFloor: '#302050',
    wallColor: '#161030', wallEdge: '#282048', wallHighlight: 0.16,
    floorA: '#121028', floorB: '#16142e', grout: '#09080e',
    crackColor: '#6838c8', crackAlpha: 0.28,
    drawWallDecor(c, px, py, h) {
      if (h % 4 === 0) _drawTorch(c, px + 14 + h % 14, py + TILE - 22, '#ffa020');
    }
  },

  // Floor 5 — Кристальная пещера
  {
    name: '💎 Кристальная пещера', bg: '#04011a', mmFloor: '#242060',
    wallColor: '#120a30', wallEdge: '#221848', wallHighlight: 0.20,
    floorA: '#100e28', floorB: '#14122e', grout: '#080610',
    crackColor: '#9050e8', crackAlpha: 0.35,
    drawWallDecor(c, px, py, h) {
      if (h % 3 === 0) {
        const cx = px + 8 + h % 22, cy = py + TILE - 6;
        const colors = ['#a060ff', '#60a0ff', '#ff60d0'];
        _drawCrystal(c, cx, cy, colors[h % 3], h);
        if (h % 6 === 0) _drawCrystal(c, cx + 9, cy - 3, colors[(h + 1) % 3], h * 3);
      }
    }
  },

  // Floor 6 — Подземное озеро
  {
    name: '💧 Подземное озеро', bg: '#020814', mmFloor: '#142c48',
    wallColor: '#0c1e38', wallEdge: '#163250', wallHighlight: 0.20,
    floorA: '#0e2038', floorB: '#122440', grout: '#070e18',
    crackColor: '#3080b8', crackAlpha: 0.28,
    drawWallDecor(c, px, py, h) {
      // Stalactites
      c.fillStyle = '#1e4060';
      const pts = [[5, 12 + h % 6], [12, 8 + h % 5], [20, 14 + h % 7], [28, 9 + h % 5], [34, 11 + h % 4]];
      pts.forEach(([ox, oh], i) => {
        if ((h + i) % 3 < 2) {
          c.beginPath(); c.moveTo(px + ox - 3, py); c.lineTo(px + ox + 3, py); c.lineTo(px + ox, py + oh); c.closePath(); c.fill();
          c.fillStyle = 'rgba(130,200,255,0.35)'; c.fillRect(px + ox - 1, py + oh - 4, 2, 4);
          c.fillStyle = '#1e4060';
        }
      });
      // Water drip glow at bottom
      if (h % 5 === 0) {
        c.globalAlpha = 0.3; c.fillStyle = '#40a8e0';
        c.beginPath(); c.arc(px + 10 + h % 18, py + TILE - 4, 5, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;
      }
    }
  },

  // ── Zone 3: Руины (floors 7-9) ──────────────────────────

  // Floor 7 — Древние руины
  {
    name: '🏛 Древние руины', bg: '#0c0a06', mmFloor: '#3e3020',
    wallColor: '#2e2416', wallEdge: '#443820', wallHighlight: 0.15,
    floorA: '#261e0e', floorB: '#2c2414', grout: '#161008',
    crackColor: '#c09850', crackAlpha: 0.22,
    drawWallDecor(c, px, py, h) {
      if (h % 5 === 0) {
        _drawLantern(c, px + 6 + h % 16, py + TILE - 26, '#ffaa30');
      } else if (h % 7 === 0) {
        // Carved rune symbol
        c.strokeStyle = '#907050'; c.lineWidth = 1.5; c.globalAlpha = 0.55;
        const rx = px + 16, ry = py + 14;
        c.beginPath();
        c.moveTo(rx - 7, ry); c.lineTo(rx + 7, ry);
        c.moveTo(rx, ry - 7); c.lineTo(rx, ry + 7);
        c.moveTo(rx - 5, ry - 5); c.lineTo(rx + 5, ry + 5);
        c.stroke(); c.globalAlpha = 1;
      }
    }
  },

  // Floor 8 — Разрушенный храм
  {
    name: '🏚 Разрушенный храм', bg: '#080600', mmFloor: '#382a18',
    wallColor: '#2a1e0c', wallEdge: '#403014', wallHighlight: 0.13,
    floorA: '#221808', floorB: '#281e10', grout: '#130e06',
    crackColor: '#b08848', crackAlpha: 0.28,
    drawWallDecor(c, px, py, h) {
      if (h % 4 === 0) {
        _drawSkull(c, px + 16 + (h % 12) - 6, py + TILE - 18);
      }
      if (h % 6 === 0) {
        _drawTorch(c, px + 8 + h % 22, py + TILE - 22, '#ff8818');
      }
    }
  },

  // Floor 9 — Катакомбы
  {
    name: '💀 Катакомбы', bg: '#060404', mmFloor: '#321e16',
    wallColor: '#221616', wallEdge: '#342020', wallHighlight: 0.13,
    floorA: '#1c1008', floorB: '#20140c', grout: '#0e0a06',
    crackColor: '#906050', crackAlpha: 0.30,
    drawWallDecor(c, px, py, h) {
      if (h % 3 === 0) {
        _drawSkull(c, px + 14 + h % 10, py + TILE - 16);
        if (h % 6 === 0) {
          // Crossed bones
          c.fillStyle = '#c8c0a8'; c.globalAlpha = 0.8;
          c.save();
          c.translate(px + 14 + h % 10, py + TILE - 4);
          c.rotate(0.4); c.fillRect(-9, -1, 18, 2);
          c.rotate(-0.8); c.fillRect(-9, -1, 18, 2);
          c.restore(); c.globalAlpha = 1;
        }
      } else if (h % 5 === 0) {
        _drawChain(c, px + 12 + h % 14, py + 2, 6, '#888');
        _drawSkull(c, px + 12 + h % 14, py + TILE - 8);
      } else if (h % 7 === 0) {
        // Wall torch
        _drawTorch(c, px + 18, py + TILE - 22, '#ff6010');
      }
    }
  },

  // ── Zone 4: Болото (floors 10-12) ───────────────────────

  // Floor 10 — Болото
  {
    name: '🌿 Болото', bg: '#030701', mmFloor: '#1e3610',
    wallColor: '#0a1408', wallEdge: '#142010', wallHighlight: 0.08,
    floorA: '#0e1a0a', floorB: '#121e0e', grout: '#070d06',
    crackColor: '#306028', crackAlpha: 0.28,
    drawWallDecor(c, px, py, h) {
      if (h % 4 === 0) {
        // Moss + will-o-wisp
        c.fillStyle = '#1e4810'; c.globalAlpha = 0.55;
        c.beginPath(); c.ellipse(px + 14 + h % 10, py + TILE - 8, 12, 6, 0, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;
        if (h % 8 === 0) {
          c.globalAlpha = 0.42; c.fillStyle = '#70ff38';
          c.beginPath(); c.arc(px + 8 + h % 20, py + 14, 6, 0, Math.PI * 2); c.fill();
          c.globalAlpha = 1; c.fillStyle = '#b0ff80';
          c.beginPath(); c.arc(px + 8 + h % 20, py + 14, 2, 0, Math.PI * 2); c.fill();
        }
      }
    }
  },

  // Floor 11 — Ядовитые топи
  {
    name: '☠ Ядовитые топи', bg: '#030702', mmFloor: '#263e14',
    wallColor: '#0e1c0a', wallEdge: '#1c3010', wallHighlight: 0.09,
    floorA: '#121e08', floorB: '#162408', grout: '#090e06',
    crackColor: '#80d020', crackAlpha: 0.34,
    drawWallDecor(c, px, py, h) {
      if (h % 3 === 0) {
        // Toxic drip
        const dx = px + 8 + h % 22, dy = py + TILE - 6;
        c.fillStyle = '#60c010'; c.globalAlpha = 0.75;
        c.fillRect(dx, dy - 14, 3, 14);
        c.beginPath(); c.arc(dx + 1, dy, 4, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 0.28; c.fillStyle = '#a0ff20';
        c.beginPath(); c.arc(dx + 1, dy, 9, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;
      }
      if (h % 6 === 0) _drawSkull(c, px + 10 + h % 18, py + TILE - 20, '#c8e870');
    }
  },

  // Floor 12 — Гнилые глубины
  {
    name: '🍄 Гнилые глубины', bg: '#050402', mmFloor: '#2c2010',
    wallColor: '#1a1208', wallEdge: '#282010', wallHighlight: 0.09,
    floorA: '#161008', floorB: '#1a140a', grout: '#0b0a06',
    crackColor: '#705030', crackAlpha: 0.30,
    drawWallDecor(c, px, py, h) {
      if (h % 4 === 0) {
        // Rot fungus cap
        const fx = px + 10 + h % 18, fy = py + TILE - 8;
        c.fillStyle = '#904030'; c.beginPath(); c.ellipse(fx, fy - 6, 8, 5, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#c06040'; c.beginPath(); c.ellipse(fx, fy - 8, 6, 4, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#c8c8a0'; c.globalAlpha = 0.3;
        for (let i = 0; i < 3; i++) { c.beginPath(); c.arc(fx - 3 + i * 3, fy - 10, 1.5, 0, Math.PI * 2); c.fill(); }
        c.globalAlpha = 1;
        c.fillStyle = '#583020'; c.fillRect(fx - 2, fy - 3, 4, 6);
      }
      if (h % 6 === 0) {
        _drawChain(c, px + 18, py + 2, 6, '#706040');
        _drawSkull(c, px + 18, py + TILE - 8, '#c8c090');
      }
    }
  },

  // ── Zone 5: Лёд (floors 13-15) ──────────────────────────

  // Floor 13 — Ледяная пещера
  {
    name: '❄ Ледяная пещера', bg: '#030a18', mmFloor: '#1e3458',
    wallColor: '#12243e', wallEdge: '#203a5e', wallHighlight: 0.22,
    floorA: '#102030', floorB: '#142638', grout: '#091018',
    crackColor: '#58a8d8', crackAlpha: 0.26,
    drawWallDecor(c, px, py, h) {
      // Icicles
      c.fillStyle = 'rgba(170,228,255,0.88)';
      [[4, 13 + h % 5], [10, 8 + h % 6], [17, 15 + h % 4], [24, 9 + h % 6], [31, 12 + h % 5]].forEach(([ox, oh], i) => {
        if ((h * 3 + i) % 3 < 2) {
          c.beginPath(); c.moveTo(px + ox - 3, py); c.lineTo(px + ox + 3, py); c.lineTo(px + ox, py + oh); c.closePath(); c.fill();
          c.fillStyle = 'rgba(230,248,255,0.6)'; c.fillRect(px + ox - 1, py, 1, oh * 0.6);
          c.fillStyle = 'rgba(170,228,255,0.88)';
        }
      });
    }
  },

  // Floor 14 — Ледяные чертоги
  {
    name: '🏔 Ледяные чертоги', bg: '#040c1e', mmFloor: '#203858',
    wallColor: '#162e4e', wallEdge: '#244268', wallHighlight: 0.24,
    floorA: '#122838', floorB: '#162e40', grout: '#0a1420',
    crackColor: '#60c0e8', crackAlpha: 0.28,
    drawWallDecor(c, px, py, h) {
      if (h % 4 === 0) {
        _drawLantern(c, px + 6 + h % 18, py + TILE - 26, '#88e0ff');
      }
      // Ice crack streaks on wall face
      if (h % 3 === 0) {
        c.strokeStyle = 'rgba(160,228,255,0.40)'; c.lineWidth = 1;
        c.beginPath();
        c.moveTo(px + h % 18 + 4, py + 6);
        c.lineTo(px + h % 18 + 16, py + 22);
        c.lineTo(px + h % 18 + 10, py + 30);
        c.stroke();
      }
    }
  },

  // Floor 15 — Ледяной дворец
  {
    name: '👑 Ледяной дворец', bg: '#040e22', mmFloor: '#283e60',
    wallColor: '#1a3458', wallEdge: '#2c4e78', wallHighlight: 0.30,
    floorA: '#16304e', floorB: '#1c3856', grout: '#0c1c2c',
    crackColor: '#88e0ff', crackAlpha: 0.30,
    drawWallDecor(c, px, py, h) {
      if (h % 5 === 0) {
        // Ice chandelier
        c.fillStyle = '#2e5880'; c.fillRect(px + 12, py, 16, 4);
        c.fillStyle = 'rgba(190,238,255,0.85)';
        [[7, 12], [12, 16], [17, 11], [22, 15], [27, 10], [32, 13]].forEach(([ox, oh]) => {
          c.beginPath(); c.moveTo(px + ox - 2, py + 4); c.lineTo(px + ox + 2, py + 4); c.lineTo(px + ox, py + oh); c.closePath(); c.fill();
        });
        c.globalAlpha = 0.18; c.fillStyle = '#88e0ff';
        c.beginPath(); c.arc(px + 20, py + 12, 16, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;
      } else if (h % 4 === 0) {
        _drawLantern(c, px + 8 + h % 16, py + TILE - 26, '#b8f0ff');
      }
    }
  },

  // ── Zone 6: Вулкан (floors 16-18) ───────────────────────

  // Floor 16 — Вулкан
  {
    name: '🌋 Вулкан', bg: '#0a0200', mmFloor: '#401804',
    wallColor: '#241008', wallEdge: '#481c08', wallHighlight: 0.22,
    floorA: '#1c0a00', floorB: '#220e02', grout: '#100500',
    crackColor: '#ff5500', crackAlpha: 0.40,
    drawWallDecor(c, px, py, h) {
      if (h % 3 === 0) {
        // Lava drip
        const dx = px + 8 + h % 22, dy = py + TILE;
        c.fillStyle = '#ff4800'; c.globalAlpha = 0.82;
        c.fillRect(dx, dy - 18, 4, 18);
        c.beginPath(); c.arc(dx + 2, dy, 5, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 0.28; c.fillStyle = '#ff9020';
        c.beginPath(); c.arc(dx + 2, dy, 10, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;
      }
    }
  },

  // Floor 17 — Лавовые пещеры
  {
    name: '🔥 Лавовые пещеры', bg: '#080000', mmFloor: '#481a04',
    wallColor: '#2a1006', wallEdge: '#501808', wallHighlight: 0.24,
    floorA: '#220800', floorB: '#280e02', grout: '#120400',
    crackColor: '#ff6600', crackAlpha: 0.42,
    drawWallDecor(c, px, py, h) {
      if (h % 4 === 0) {
        _drawLantern(c, px + 6 + h % 18, py + TILE - 26, '#ff7020');
      } else if (h % 5 === 0) {
        _drawSkull(c, px + 14 + h % 10, py + TILE - 18, '#c09080');
      }
      if (h % 3 === 0) {
        // Ember glow on wall
        c.globalAlpha = 0.22; c.fillStyle = '#ff5500';
        c.beginPath(); c.arc(px + 12 + h % 14, py + TILE - 10, 8, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;
      }
    }
  },

  // Floor 18 — Кратер
  {
    name: '💥 Кратер', bg: '#050000', mmFloor: '#300e00',
    wallColor: '#1e0800', wallEdge: '#381000', wallHighlight: 0.20,
    floorA: '#180600', floorB: '#1e0a00', grout: '#0e0300',
    crackColor: '#ff4400', crackAlpha: 0.48,
    drawWallDecor(c, px, py, h) {
      if (h % 3 === 0) {
        // Pulsing ember crack
        c.globalAlpha = 0.32; c.fillStyle = '#ff3800';
        c.beginPath(); c.arc(px + 14 + h % 12, py + TILE - 12, 10, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 0.6; c.fillStyle = '#ffaa00';
        c.beginPath(); c.arc(px + 14 + h % 12, py + TILE - 12, 3, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;
      }
      if (h % 4 === 0) _drawSkull(c, px + 16 + h % 8 - 4, py + TILE - 20, '#a08060');
    }
  },

  // ── Zone 7: Бездна (floors 19-20) ───────────────────────

  // Floor 19 — Бездна
  {
    name: '🌑 Бездна', bg: '#000000', mmFloor: '#1c0838',
    wallColor: '#0a0028', wallEdge: '#1c0050', wallHighlight: 0.27,
    floorA: '#060018', floorB: '#08001e', grout: '#030010',
    crackColor: '#9010ff', crackAlpha: 0.34,
    drawWallDecor(c, px, py, h) {
      if (h % 4 === 0) {
        _drawChain(c, px + 8 + h % 10, py + 2, 7, '#7020c0');
        _drawChain(c, px + 26 + h % 10, py + 5, 5, '#7020c0');
      }
      if (h % 5 === 0) {
        // Void eye
        const ex = px + 14 + h % 10, ey = py + TILE - 16;
        c.globalAlpha = 0.45; c.fillStyle = '#5010b0';
        c.beginPath(); c.arc(ex, ey, 9, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1; c.fillStyle = '#c020ff';
        c.beginPath(); c.arc(ex, ey, 5, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#f0a0ff';
        c.beginPath(); c.arc(ex, ey, 2, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#ffffff';
        c.beginPath(); c.arc(ex - 1, ey - 1, 0.8, 0, Math.PI * 2); c.fill();
      }
    }
  },

  // Floor 20 — Сердце тьмы
  {
    name: '👁 Сердце тьмы', bg: '#000000', mmFloor: '#120030',
    wallColor: '#060026', wallEdge: '#120044', wallHighlight: 0.32,
    floorA: '#020016', floorB: '#04001e', grout: '#010008',
    crackColor: '#b020ff', crackAlpha: 0.40,
    drawWallDecor(c, px, py, h) {
      if (h % 3 === 0) {
        _drawChain(c, px + 6 + h % 8, py + 0, 8, '#6010a8');
        _drawChain(c, px + 26 + h % 8, py + 4, 6, '#6010a8');
        if (h % 6 === 0) _drawSkull(c, px + 18, py + TILE - 6, '#d090f0');
      }
      if (h % 5 === 0) {
        // Void pentagram rune
        c.strokeStyle = '#9020ff'; c.lineWidth = 1.5; c.globalAlpha = 0.65;
        const rx = px + 18, ry = py + TILE - 20, r = 10;
        c.beginPath();
        for (let i = 0; i < 5; i++) {
          const a1 = (i * 2 * Math.PI / 5) - Math.PI / 2;
          const a2 = ((i + 2) * 2 * Math.PI / 5) - Math.PI / 2;
          c.moveTo(rx + Math.cos(a1) * r, ry + Math.sin(a1) * r);
          c.lineTo(rx + Math.cos(a2) * r, ry + Math.sin(a2) * r);
        }
        c.stroke(); c.globalAlpha = 0.20; c.fillStyle = '#9020ff';
        c.beginPath(); c.arc(rx, ry, r + 2, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;
      }
    }
  },
];

function getTheme(lvl) {
  return THEMES[Math.max(0, Math.min(lvl - 1, 19))];
}
