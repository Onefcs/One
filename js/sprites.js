const SPRITE_DEF = {
  mage: {
    base: 'images/Mage/',
    anims: {
      'front-idle':   { folder:'Front - Idle',      prefix:'Front - Idle_',      n:16, fps:7,  loop:true  },
      'back-idle':    { folder:'Back - Idle',        prefix:'Back - Idle_',       n:16, fps:7,  loop:true  },
      'left-idle':    { folder:'Left - Idle',        prefix:'Left - Idle_',       n:16, fps:7,  loop:true  },
      'right-idle':   { folder:'Right - Idle',       prefix:'Right - Idle_',      n:16, fps:7,  loop:true  },
      'front-run':    { folder:'Front - Running',    prefix:'Front - Running_',   n:12, fps:12, loop:true  },
      'back-run':     { folder:'Back - Running',     prefix:'Back - Running_',    n:12, fps:12, loop:true  },
      'left-run':     { folder:'Left - Running',     prefix:'Left - Running_',    n:12, fps:12, loop:true  },
      'right-run':    { folder:'Right - Running',    prefix:'Right - Running_',   n:12, fps:12, loop:true  },
      'front-attack': { folder:'Front - Attacking',  prefix:'Front - Attacking_', n:10, fps:14, loop:false },
      'back-attack':  { folder:'Back - Attacking',   prefix:'Back - Attacking_',  n:10, fps:14, loop:false },
      'left-attack':  { folder:'Left - Attacking',   prefix:'Left - Attacking_',  n:10, fps:14, loop:false },
      'right-attack': { folder:'Right - Attacking',  prefix:'Right - Attacking_', n:10, fps:14, loop:false },
      'front-hurt':   { folder:'Front - Hurt',       prefix:'Front - Hurt_',      n:10, fps:14, loop:false },
      'back-hurt':    { folder:'Back - Hurt',        prefix:'Back - Hurt_',       n:10, fps:14, loop:false },
      'left-hurt':    { folder:'Left - Hurt',        prefix:'Left - Hurt_',       n:10, fps:14, loop:false },
      'right-hurt':   { folder:'Right - Hurt',       prefix:'Right - Hurt_',      n:10, fps:14, loop:false },
      'die':          { folder:'Dying',              prefix:'Dying_',             n:10, fps:8,  loop:false },
    }
  }
};

const spriteCache = {};

function loadSprites(charType, onDone) {
  const def = SPRITE_DEF[charType];
  if (!def) { onDone(); return; }
  if (spriteCache[charType]) { onDone(); return; }
  spriteCache[charType] = {};
  const keys = Object.keys(def.anims);
  let total = 0, done = 0;
  function tick() { if (++done >= total) onDone(); }
  keys.forEach(key => {
    const a = def.anims[key];
    spriteCache[charType][key] = [];
    for (let i = 0; i < a.n; i++) {
      total++;
      const img = new Image();
      img.src = `${def.base}${encodeURIComponent(a.folder)}/${encodeURIComponent(a.prefix + String(i).padStart(3, '0'))}.png`;
      img.onload = img.onerror = tick;
      spriteCache[charType][key].push(img);
    }
  });
  if (total === 0) onDone();
}

function getSpriteAnimKey(p) {
  if (state === 'dead') return 'die';
  const dir = p.facing || 'front';
  if (p.hurtTimer > 0.08)  return `${dir}-hurt`;
  if (p.atkAnimTimer > 0)  return `${dir}-attack`;
  const inp = inputDir();
  if (inp.len > 0.05)      return `${dir}-run`;
  return `${dir}-idle`;
}

function drawSprite(p) {
  const cache = spriteCache[p.type];
  if (!cache) return false;
  const key = getSpriteAnimKey(p);
  const frames = cache[key];
  if (!frames || frames.length === 0) return false;
  const fi = Math.min(Math.floor(p.animFrame), frames.length - 1);
  const img = frames[fi];
  if (!img || !img.complete || img.naturalWidth === 0) return false;
  const sz = 80;
  ctx.fillStyle = 'rgba(0,0,0,.3)';
  ctx.beginPath(); ctx.ellipse(p.x, p.y + 18, 13, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.drawImage(img, p.x - sz / 2, p.y - sz * 0.62, sz, sz);
  return true;
}
