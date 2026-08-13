const {
  generateHub, generateArm, generateGuildWar, generateFarmZone, generateArena, generatePvpArena,
  generateRace10, generateFear,
} = require('./dungeon');

// Every location the player can stand in is its own floor id + its own
// generator, replacing the single generateOpenWorld() mega-grid. The hub,
// the 4 leveling arms and every special zone (Guild War, Фарм-зона, the boss
// arena/Death Battle venue, the 3v3 arena, Кровавая Башня and Страх) are
// each their own floor now.
const FLOOR_IDS = {
  hub: 1, left: 2, top: 3, bottom: 4, right: 5,
  guildWar: 6, farmZone: 7, arena: 8, pvpArena: 9, race10: 10, fear: 11,
};

// armIdx (1-4) is the enemy-level/species-curve identity FLOOR_ENEMIES/
// ARM_OFFSETS already index by (shared/definitions.js) — kept distinct from
// the floor id so nothing there needs to change.
const FLOOR_REGISTRY = [
  { id: FLOOR_IDS.hub,      key: 'hub',      generate: () => generateHub() },
  { id: FLOOR_IDS.left,     key: 'left',     generate: () => generateArm('left', 1) },
  { id: FLOOR_IDS.top,      key: 'top',      generate: () => generateArm('top', 2) },
  { id: FLOOR_IDS.bottom,   key: 'bottom',   generate: () => generateArm('bottom', 3) },
  { id: FLOOR_IDS.right,    key: 'right',    generate: () => generateArm('right', 4) },
  { id: FLOOR_IDS.guildWar, key: 'guildWar', generate: () => generateGuildWar() },
  { id: FLOOR_IDS.farmZone, key: 'farmZone', generate: () => generateFarmZone() },
  { id: FLOOR_IDS.arena,    key: 'arena',    generate: () => generateArena() },
  { id: FLOOR_IDS.pvpArena, key: 'pvpArena', generate: () => generatePvpArena() },
  { id: FLOOR_IDS.race10,   key: 'race10',   generate: () => generateRace10() },
  { id: FLOOR_IDS.fear,     key: 'fear',     generate: () => generateFear() },
];

const _byId = new Map(FLOOR_REGISTRY.map(f => [f.id, f]));
const _byKey = new Map(FLOOR_REGISTRY.map(f => [f.key, f]));

function floorEntry(floorId) { return _byId.get(floorId); }
function floorEntryForKey(key) { return _byKey.get(key); }

module.exports = { FLOOR_IDS, FLOOR_REGISTRY, floorEntry, floorEntryForKey };
