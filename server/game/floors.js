const { generateHub, generateArm } = require('./dungeon');

// Every location the player can stand in is its own floor id + its own
// generator, replacing the single generateOpenWorld() mega-grid. Only the
// hub + 4 leveling arms are split out so far — the special zones (boss
// arena, 3v3, race10, fear, guildWar, farmZone) still live bundled inside
// generateHub() (see dungeon.js) until they get their own floor ids in a
// later pass.
const FLOOR_IDS = { hub: 1, left: 2, top: 3, bottom: 4, right: 5 };

// armIdx (1-4) is the enemy-level/species-curve identity FLOOR_ENEMIES/
// ARM_OFFSETS already index by (shared/definitions.js) — kept distinct from
// the floor id so nothing there needs to change.
const FLOOR_REGISTRY = [
  { id: FLOOR_IDS.hub,    key: 'hub',    generate: () => generateHub() },
  { id: FLOOR_IDS.left,   key: 'left',   generate: () => generateArm('left', 1) },
  { id: FLOOR_IDS.top,    key: 'top',    generate: () => generateArm('top', 2) },
  { id: FLOOR_IDS.bottom, key: 'bottom', generate: () => generateArm('bottom', 3) },
  { id: FLOOR_IDS.right,  key: 'right',  generate: () => generateArm('right', 4) },
];

const _byId = new Map(FLOOR_REGISTRY.map(f => [f.id, f]));
const _byKey = new Map(FLOOR_REGISTRY.map(f => [f.key, f]));

function floorEntry(floorId) { return _byId.get(floorId); }
function floorEntryForKey(key) { return _byKey.get(key); }

module.exports = { FLOOR_IDS, FLOOR_REGISTRY, floorEntry, floorEntryForKey };
