// ═══════════════════════════════════════════════════════════════════════
//  LOCALIZATION — ru (source of truth) / en / uk / es / tr / pt (Brazil)
// ═══════════════════════════════════════════════════════════════════════
// Architecture: every data array (ITEM_DEF, QUEST_DEF, ENEMY_DEF, SKILL_DEF,
// CHAR_DEF, PASSIVE_CLASS_DEF, PASSIVE_COMMON_DEF, NPC_DEF, MERCHANT_SHOP,
// EQ_SLOTS, UPGRADE_DEF, CLAN_LEVELS, _RARITY_NAMES, _SLOT_NAMES) already has
// Russian text baked directly into its name/desc/title/label fields, and
// every UI call site just reads those fields (`ITEM_DEF.find(d => d.id ===
// x).name`). Rather than rewiring every one of those (100+) call sites,
// applyLocale() below MUTATES the fields in place when the language changes
// — every existing lookup then automatically shows the right language with
// zero call-site changes. _i18nSnapshot() captures a pristine copy of every
// RU field ONCE (before any mutation ever happens), so applyLocale() always
// derives a language's text from the untouched original, however many times
// the user switches back and forth — never from a possibly-already-mutated
// current value.
//
// Scope note: this pass covers game "content" (item/material/quest/skill/
// class/NPC/rarity names) and the static chrome wired up via data-i18n
// attributes (nav tabs, chat panel, death screen). It deliberately does NOT
// retranslate the live monster nameplate (target-frame health bar, drawn
// from server-computed e.name) — the server bakes a rank word + species
// name with no per-client language concept, and localizing it correctly
// needs either server changes or the client independently recomputing names
// from e.eid — a reasonable follow-up, not attempted here. Quest kill-
// tracking (which matches by these same RU species names client-side, see
// onEnemyKill in js/quests.js) is kept correct since QUEST_DEF's enemies[]
// arrays are retranslated in lockstep with ENEMY_DEF's names below.
// Dynamically-generated modal HTML deep inside js/ui.js (market rows, craft
// dialogs, etc.) isn't rewired either — untranslated UI chrome just falls
// back to displaying Russian, which never breaks anything.

const I18N_LANGS = [
  { code: 'ru', native: 'Русский',    flag: '🇷🇺' },
  { code: 'en', native: 'English',    flag: '🇬🇧' },
  { code: 'uk', native: 'Українська', flag: '🇺🇦' },
  { code: 'es', native: 'Español',    flag: '🇪🇸' },
  { code: 'tr', native: 'Türkçe',     flag: '🇹🇷' },
  { code: 'pt', native: 'Português',  flag: '🇧🇷' },
];
let currentLang = 'ru';

// ── UI chrome strings (static HTML wired via data-i18n / data-i18n-placeholder) ──
const I18N_UI = {
  navGame:      { ru: 'Игра',      en: 'Game',      uk: 'Гра',        es: 'Juego',       tr: 'Oyun',      pt: 'Jogo' },
  navChar:      { ru: 'Персонаж',  en: 'Character', uk: 'Персонаж',   es: 'Personaje',   tr: 'Karakter',  pt: 'Personagem' },
  navMap:       { ru: 'Карта',     en: 'Map',        uk: 'Карта',      es: 'Mapa',        tr: 'Harita',    pt: 'Mapa' },
  navQuests:    { ru: 'Квесты',    en: 'Quests',     uk: 'Квести',     es: 'Misiones',    tr: 'Görevler',  pt: 'Missões' },
  navClans:     { ru: 'Кланы',     en: 'Clans',      uk: 'Клани',      es: 'Clanes',      tr: 'Klanlar',   pt: 'Clãs' },
  navProfile:   { ru: 'Профиль',   en: 'Profile',    uk: 'Профіль',    es: 'Perfil',      tr: 'Profil',    pt: 'Perfil' },

  chatTabGlobal:{ ru: 'Общий', en: 'Global', uk: 'Загальний', es: 'General', tr: 'Genel',   pt: 'Geral' },
  chatTabClan:  { ru: 'Клан',  en: 'Clan',   uk: 'Клан',      es: 'Clan',    tr: 'Klan',    pt: 'Clã' },
  chatTabDm:    { ru: 'Беседа',en: 'Chat',   uk: 'Бесіда',    es: 'Chat',    tr: 'Sohbet',  pt: 'Conversa' },
  chatTitle:    { ru: 'Чат',   en: 'Chat',   uk: 'Чат',       es: 'Chat',    tr: 'Sohbet',  pt: 'Chat' },
  chatPlaceholder: { ru: 'Сообщение...', en: 'Message...', uk: 'Повідомлення...', es: 'Mensaje...', tr: 'Mesaj...', pt: 'Mensagem...' },
  chatPlaceholderClan: { ru: 'Сообщение клану...', en: 'Message to clan...', uk: 'Повідомлення клану...', es: 'Mensaje al clan...', tr: 'Klana mesaj...', pt: 'Mensagem ao clã...' },
  chatPlaceholderDmEmpty: { ru: '@ник сообщение...', en: '@nick message...', uk: '@нік повідомлення...', es: '@nick mensaje...', tr: '@kullanıcı mesaj...', pt: '@nick mensagem...' },
  chatPlaceholderDmActive: { ru: 'Сообщение @{u}...', en: 'Message @{u}...', uk: 'Повідомлення @{u}...', es: 'Mensaje a @{u}...', tr: '@{u} mesaj...', pt: 'Mensagem @{u}...' },
  chatDmNoPartner: { ru: 'Выберите беседу выше или отметьте @ник', en: 'Pick a conversation above or mention @nick', uk: 'Оберіть бесіду вище або відмітьте @нік', es: 'Elige una conversación arriba o menciona a @nick', tr: 'Yukarıdan bir sohbet seç ya da @kullanıcı etiketle', pt: 'Escolha uma conversa acima ou mencione @nick' },

  deathTitle:   { ru: 'ВЫ ПАЛИ', en: 'YOU DIED', uk: 'ВИ ЗАГИНУЛИ', es: 'HAS MUERTO', tr: 'ÖLDÜN', pt: 'VOCÊ MORREU' },
  deathRespawn: { ru: 'Возродиться (10% HP)', en: 'Respawn (10% HP)', uk: 'Відродитися (10% HP)', es: 'Reaparecer (10% HP)', tr: 'Yeniden Doğ (%10 HP)', pt: 'Reviver (10% HP)' },

  profileTabWallet:  { ru: 'Кошелёк', en: 'Wallet', uk: 'Гаманець', es: 'Billetera', tr: 'Cüzdan', pt: 'Carteira' },
  profileTabFriends: { ru: 'Друзья',  en: 'Friends', uk: 'Друзі',    es: 'Amigos',    tr: 'Arkadaşlar', pt: 'Amigos' },
  profileTabLang:    { ru: 'Язык',    en: 'Language', uk: 'Мова',    es: 'Idioma',    tr: 'Dil',    pt: 'Idioma' },
  langPickerTitle:   { ru: 'Язык игры', en: 'Game Language', uk: 'Мова гри', es: 'Idioma del juego', tr: 'Oyun Dili', pt: 'Idioma do Jogo' },
  langPickerHint:    { ru: 'Изменения применяются сразу', en: 'Changes apply immediately', uk: 'Зміни застосовуються одразу', es: 'Los cambios se aplican de inmediato', tr: 'Değişiklikler hemen uygulanır', pt: 'As alterações se aplicam imediatamente' },
};

function t(key) {
  const e = I18N_UI[key];
  if (!e) return key;
  return e[currentLang] || e.ru || key;
}
// Same as t() but substitutes {varName} placeholders from `vars`.
function tVars(key, vars) {
  let s = t(key);
  Object.keys(vars || {}).forEach(k => { s = s.split('{' + k + '}').join(vars[k]); });
  return s;
}

// Applies every [data-i18n] / [data-i18n-placeholder] element in the current
// DOM — covers the static chrome (nav tabs, chat panel, death screen,
// profile sub-tabs). Called on load and on every language switch.
function applyDomTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}

// ── Content dictionaries (keyed by the same ids the data already uses) ──

const I18N_CLASSES = {
  lev:         { en: 'Tank',        uk: 'Танк',         es: 'Tanque',              tr: 'Tank',            pt: 'Tanque' },
  deathknight: { en: 'Death Knight',uk: 'Лицар Смерті', es: 'Caballero de la Muerte', tr: 'Ölüm Şövalyesi', pt: 'Cavaleiro da Morte' },
  ranger:      { en: 'Ranger',      uk: 'Єгер',         es: 'Guardabosques',       tr: 'Avcı',            pt: 'Guardião' },
  mage:        { en: 'Mage',        uk: 'Маг',          es: 'Mago',                tr: 'Büyücü',          pt: 'Mago' },
  warlock:     { en: 'Healer',      uk: 'Цілитель',     es: 'Sanador',             tr: 'Şifacı',          pt: 'Curandeiro' },
};

// key: class -> skillKey -> {name, desc}
const I18N_SKILLS = {
  lev: {
    Q: { name: { en: 'Frost Strike',   uk: 'Крижаний удар', es: 'Golpe Helado',      tr: 'Buz Darbesi',     pt: 'Golpe Gélido' },
         desc: { en: '×2 damage to target + 3s stun', uk: '×2 урону по цілі + оглушення 3 сек', es: '×2 daño al objetivo + 3s de aturdimiento', tr: 'Hedefe ×2 hasar + 3sn sersemletme', pt: '×2 de dano no alvo + atordoamento de 3s' } },
    W: { name: { en: 'Blade Whirl',    uk: 'Вихор клинків', es: 'Torbellino de Hojas', tr: 'Bıçak Kasırgası', pt: 'Redemoinho de Lâminas' },
         desc: { en: 'AOE damage, radius 110', uk: 'АОЕ урон, радіус 110', es: 'Daño en área, radio 110', tr: 'Alan hasarı, yarıçap 110', pt: 'Dano em área, raio 110' } },
    E: { name: { en: 'Wrath of the Dead', uk: 'Гнів мерця', es: 'Ira del Muerto',    tr: 'Ölünün Gazabı',   pt: 'Fúria do Morto' },
         desc: { en: '+80% defense for 10s', uk: '+80% захисту на 10 сек', es: '+80% de defensa durante 10s', tr: '10sn boyunca +%80 savunma', pt: '+80% de defesa por 10s' } },
    R: { name: { en: 'Dash of Light',  uk: 'Ривок світла',  es: 'Arremetida de Luz', tr: 'Işık Atılımı',    pt: 'Investida da Luz' },
         desc: { en: 'Dashes to target dealing damage', uk: 'Ривок до цілі з уроном', es: 'Embiste hacia el objetivo infligiendo daño', tr: 'Hedefe atılıp hasar verir', pt: 'Avança até o alvo causando dano' } },
  },
  deathknight: {
    Q: { name: { en: 'Vampirism',      uk: 'Вампіризм',     es: 'Vampirismo',        tr: 'Vampirlik',       pt: 'Vampirismo' },
         desc: { en: 'Lifesteal 10% of damage dealt for 10s', uk: 'Вампіризм 10% від удару на 10 сек', es: 'Robo de vida 10% del daño infligido durante 10s', tr: '10sn boyunca verilen hasarın %10\'unu can olarak al', pt: 'Roubo de vida de 10% do dano causado por 10s' } },
    W: { name: { en: 'Blade Vortex',   uk: 'Вихор клинка',  es: 'Vórtice de Hoja',   tr: 'Bıçak Girdabı',   pt: 'Vórtice de Lâmina' },
         desc: { en: 'AOE damage, radius 110', uk: 'АОЕ урон, радіус 110', es: 'Daño en área, radio 110', tr: 'Alan hasarı, yarıçap 110', pt: 'Dano em área, raio 110' } },
    E: { name: { en: 'Rage',           uk: 'Лють',          es: 'Furia',             tr: 'Öfke',            pt: 'Fúria' },
         desc: { en: '+20% attack for 5s', uk: '+20% атаки на 5 сек', es: '+20% de ataque durante 5s', tr: '5sn boyunca +%20 saldırı', pt: '+20% de ataque por 5s' } },
    R: { name: { en: 'Roll',           uk: 'Кувирок',       es: 'Voltereta',         tr: 'Takla',           pt: 'Rolamento' },
         desc: { en: 'Dashes to target dealing damage', uk: 'Ривок до цілі з уроном', es: 'Embiste hacia el objetivo infligiendo daño', tr: 'Hedefe atılıp hasar verir', pt: 'Avança até o alvo causando dano' } },
  },
  ranger: {
    Q: { name: { en: 'Multi-Shot',     uk: 'Мультипостріл', es: 'Disparo Múltiple', tr: 'Çoklu Atış',      pt: 'Tiro Múltiplo' },
         desc: { en: '3 arrows at ±0.35 rad angle', uk: '3 стріли під кутом ±0.35 рад', es: '3 flechas en ángulo ±0.35 rad', tr: '±0.35 rad açıyla 3 ok', pt: '3 flechas em ângulo de ±0.35 rad' } },
    W: { name: { en: 'Combo Arrow',    uk: 'Комбо-стріла',  es: 'Flecha Combo',     tr: 'Kombo Ok',        pt: 'Flecha Combo' },
         desc: { en: '3 arrows ×1 damage', uk: '3 стріли ×1 урон', es: '3 flechas ×1 daño', tr: '3 ok ×1 hasar', pt: '3 flechas ×1 dano' } },
    E: { name: { en: 'Jump',           uk: 'Стрибок',       es: 'Salto',             tr: 'Zıplama',         pt: 'Salto' },
         desc: { en: 'Dash 80px', uk: 'Ривок 80px', es: 'Embestida 80px', tr: '80px atılım', pt: 'Investida de 80px' } },
    R: { name: { en: 'Attack Speed',   uk: 'Швидкість атаки', es: 'Velocidad de Ataque', tr: 'Saldırı Hızı', pt: 'Velocidade de Ataque' },
         desc: { en: '×1.5 attack speed for 5s', uk: '×1.5 швидкості атаки на 5 сек', es: '×1.5 velocidad de ataque durante 5s', tr: '5sn boyunca ×1.5 saldırı hızı', pt: '×1.5 de velocidade de ataque por 5s' } },
  },
  mage: {
    Q: { name: { en: 'Frost Orb',      uk: 'Крижана куля',  es: 'Orbe de Hielo',    tr: 'Buz Küresi',      pt: 'Orbe de Gelo' },
         desc: { en: 'Projectile ×2 damage', uk: 'Снаряд ×2 урону', es: 'Proyectil ×2 daño', tr: 'Mermi ×2 hasar', pt: 'Projétil ×2 de dano' } },
    W: { name: { en: 'Frost Nova',     uk: 'Крижана нова',  es: 'Nova de Hielo',    tr: 'Buz Nova',        pt: 'Nova de Gelo' },
         desc: { en: 'AOE damage 130 + 3s freeze', uk: 'АОЕ урон 130 + заморозка 3 сек', es: 'Daño en área 130 + congelación 3s', tr: 'Alan hasarı 130 + 3sn donma', pt: 'Dano em área 130 + congelamento de 3s' } },
    E: { name: { en: 'Barrier',        uk: 'Бар\'єр',       es: 'Barrera',          tr: 'Bariyer',         pt: 'Barreira' },
         desc: { en: '+50% defense for 3s', uk: '+50% захисту на 3 сек', es: '+50% de defensa durante 3s', tr: '3sn boyunca +%50 savunma', pt: '+50% de defesa por 3s' } },
    R: { name: { en: 'Teleport',       uk: 'Телепорт',      es: 'Teletransporte',   tr: 'Işınlanma',       pt: 'Teleporte' },
         desc: { en: 'Dash 180px in facing direction', uk: 'Ривок 180px за напрямком', es: 'Embestida 180px en la dirección', tr: 'Baktığı yöne 180px atılım', pt: 'Investida de 180px na direção' } },
  },
  warlock: {
    Q: { name: { en: 'Dark Heal',      uk: 'Темне зцілення', es: 'Curación Oscura', tr: 'Karanlık Şifa',   pt: 'Cura Sombria' },
         desc: { en: '+20% maxHP', uk: '+20% від макс. HP', es: '+20% de HP máx.', tr: '+%20 maksimum HP', pt: '+20% do HP máximo' } },
    W: { name: { en: 'Chains of Darkness', uk: 'Кайдани темряви', es: 'Cadenas de Oscuridad', tr: 'Karanlık Zincirleri', pt: 'Correntes das Trevas' },
         desc: { en: 'Roots target in place for 3s', uk: 'Утримує ціль на місці 3 сек', es: 'Inmoviliza al objetivo durante 3s', tr: 'Hedefi 3sn boyunca yerinde tutar', pt: 'Prende o alvo no lugar por 3s' } },
    E: { name: { en: 'Dark Shield',    uk: 'Темний щит',    es: 'Escudo Oscuro',    tr: 'Karanlık Kalkan', pt: 'Escudo Sombrio' },
         desc: { en: '+50% defense to self and party for 4s', uk: '+50% захисту собі й паті на 4 сек', es: '+50% de defensa a ti y al grupo durante 4s', tr: '4sn boyunca kendine ve gruba +%50 savunma', pt: '+50% de defesa para você e o grupo por 4s' } },
    R: { name: { en: 'Dark Prayer',    uk: 'Темна молитва', es: 'Oración Oscura',   tr: 'Karanlık Dua',    pt: 'Oração Sombria' },
         desc: { en: '+10% maxHP to self and +10% to party', uk: '+10% макс. HP собі та +10% паті', es: '+10% de HP máx. a ti y +10% al grupo', tr: 'Kendine +%10, grubuna +%10 maksimum HP', pt: '+10% do HP máximo para você e +10% para o grupo' } },
  },
};

// key: passive id -> {name, desc}
const I18N_PASSIVES = {
  tankatk:  { name: { en: 'Berserker Might',   uk: 'Міць берсерка',    es: 'Poder del Berserker', tr: 'Berserker Gücü',   pt: 'Poder do Berserker' },
              desc: { en: '+3% attack per level', uk: '+3% атаки за рівень', es: '+3% de ataque por nivel', tr: 'Seviye başına +%3 saldırı', pt: '+3% de ataque por nível' } },
  deftank:  { name: { en: 'Unbreakable',       uk: 'Незламність',      es: 'Inquebrantable',      tr: 'Yıkılmazlık',      pt: 'Inquebrável' },
              desc: { en: '+3% defense per level', uk: '+3% захисту за рівень', es: '+3% de defensa por nivel', tr: 'Seviye başına +%3 savunma', pt: '+3% de defesa por nível' } },
  dkatk:    { name: { en: 'Blood Pact',        uk: 'Кривавий пакт',    es: 'Pacto de Sangre',     tr: 'Kan Paktı',        pt: 'Pacto de Sangue' },
              desc: { en: '+3% attack per level', uk: '+3% атаки за рівень', es: '+3% de ataque por nivel', tr: 'Seviye başına +%3 saldırı', pt: '+3% de ataque por nível' } },
  dkdef:    { name: { en: 'Dark Carapace',     uk: 'Темний панцир',    es: 'Caparazón Oscuro',    tr: 'Karanlık Zırh',    pt: 'Carapaça Sombria' },
              desc: { en: '+3% defense per level', uk: '+3% захисту за рівень', es: '+3% de defensa por nivel', tr: 'Seviye başına +%3 savunma', pt: '+3% de defesa por nível' } },
  bowatk:   { name: { en: 'Keen Eye',          uk: 'Влучне око',       es: 'Ojo Certero',         tr: 'Keskin Göz',       pt: 'Olho Certeiro' },
              desc: { en: '+3% attack per level', uk: '+3% атаки за рівень', es: '+3% de ataque por nivel', tr: 'Seviye başına +%3 saldırı', pt: '+3% de ataque por nível' } },
  bowdef:   { name: { en: 'Tracker\'s Instinct', uk: 'Чуття слідопита', es: 'Instinto de Rastreador', tr: 'İzci İçgüdüsü', pt: 'Instinto de Rastreador' },
              desc: { en: '+3% defense per level', uk: '+3% захисту за рівень', es: '+3% de defensa por nivel', tr: 'Seviye başına +%3 savunma', pt: '+3% de defesa por nível' } },
  mageatk:  { name: { en: 'Mana Flow',         uk: 'Потік мани',       es: 'Flujo de Maná',       tr: 'Mana Akışı',       pt: 'Fluxo de Mana' },
              desc: { en: '+3% attack per level', uk: '+3% атаки за рівень', es: '+3% de ataque por nivel', tr: 'Seviye başına +%3 saldırı', pt: '+3% de ataque por nível' } },
  magedef:  { name: { en: 'Ice Shield',        uk: 'Крижаний щит',     es: 'Escudo de Hielo',     tr: 'Buz Kalkanı',      pt: 'Escudo de Gelo' },
              desc: { en: '+3% defense per level', uk: '+3% захисту за рівень', es: '+3% de defensa por nivel', tr: 'Seviye başına +%3 savunma', pt: '+3% de defesa por nível' } },
  healatk:  { name: { en: 'Dark Thirst',       uk: 'Темна спрага',     es: 'Sed Oscura',          tr: 'Karanlık Susuzluk',pt: 'Sede Sombria' },
              desc: { en: '+3% attack per level', uk: '+3% атаки за рівень', es: '+3% de ataque por nivel', tr: 'Seviye başına +%3 saldırı', pt: '+3% de ataque por nível' } },
  healdef:  { name: { en: 'Dark Ward',         uk: 'Оберіг тьми',      es: 'Amuleto Oscuro',      tr: 'Karanlık Muska',   pt: 'Amuleto Sombrio' },
              desc: { en: '+3% defense per level', uk: '+3% захисту за рівень', es: '+3% de defensa por nivel', tr: 'Seviye başına +%3 savunma', pt: '+3% de defesa por nível' } },
  allatkspeed: { name: { en: 'Swiftness',      uk: 'Стрімкість',       es: 'Celeridad',           tr: 'Çeviklik',         pt: 'Rapidez' },
              desc: { en: '+2% attack speed per level', uk: '+2% швидкості атаки за рівень', es: '+2% de velocidad de ataque por nivel', tr: 'Seviye başına +%2 saldırı hızı', pt: '+2% de velocidade de ataque por nível' } },
  allhp:    { name: { en: 'Vitality',          uk: 'Живучість',        es: 'Vitalidad',           tr: 'Dayanıklılık',     pt: 'Vitalidade' },
              desc: { en: '+3% max HP per level', uk: '+3% макс. здоров\'я за рівень', es: '+3% de HP máx. por nivel', tr: 'Seviye başına +%3 maksimum HP', pt: '+3% de HP máximo por nível' } },
  allcritdmg: { name: { en: 'Blood Frenzy',    uk: 'Кривава лють',     es: 'Frenesí Sangriento',  tr: 'Kan Çılgınlığı',   pt: 'Frenesi Sangrento' },
              desc: { en: '+4% crit power per level', uk: '+4% сили криту за рівень', es: '+4% de poder crítico por nivel', tr: 'Seviye başına +%4 kritik güç', pt: '+4% de poder crítico por nível' } },
  allspeed: { name: { en: 'Fleet Feet',        uk: 'Швидкі ноги',      es: 'Pies Ligeros',        tr: 'Hızlı Ayaklar',    pt: 'Pés Ligeiros' },
              desc: { en: '+2% movement speed per level', uk: '+2% швидкості руху за рівень', es: '+2% de velocidad de movimiento por nivel', tr: 'Seviye başına +%2 hareket hızı', pt: '+2% de velocidade de movimento por nível' } },
  allcdskill: { name: { en: 'Clear Mind',      uk: 'Ясний розум',      es: 'Mente Clara',         tr: 'Berrak Zihin',     pt: 'Mente Clara' },
              desc: { en: '-2% skill cooldown per level', uk: '-2% перезарядки навичок за рівень', es: '-2% de reutilización de habilidades por nivel', tr: 'Seviye başına -%2 yetenek bekleme süresi', pt: '-2% de recarga de habilidades por nível' } },
  allregen: { name: { en: 'Regeneration',      uk: 'Регенерація',      es: 'Regeneración',        tr: 'Yenilenme',        pt: 'Regeneração' },
              desc: { en: '+0.2 HP regen/sec per level', uk: '+0.2 реген. HP/сек за рівень', es: '+0.2 regen. HP/s por nivel', tr: 'Seviye başına +0.2 HP/sn yenilenme', pt: '+0.2 regen. HP/s por nível' } },
};

const I18N_NPCS = {
  merchant:  { name: { en: 'Merchant',  uk: 'Торговець', es: 'Comerciante', tr: 'Tüccar',   pt: 'Mercador' },
               desc: { en: 'Potions and consumables', uk: 'Зілля та витратні матеріали', es: 'Pociones y consumibles', tr: 'İksirler ve tüketim malzemeleri', pt: 'Poções e consumíveis' } },
  craftsman: { name: { en: 'Blacksmith', uk: 'Коваль',   es: 'Herrero',     tr: 'Demirci',  pt: 'Ferreiro' },
               desc: { en: 'Craft items', uk: 'Крафт предметів', es: 'Fabricar objetos', tr: 'Eşya üretimi', pt: 'Fabricação de itens' } },
  storage:   { name: { en: 'Storage',    uk: 'Сховище',  es: 'Almacén',     tr: 'Depo',     pt: 'Armazém' },
               desc: { en: 'Store items (200 slots)', uk: 'Зберігання предметів (200 комірок)', es: 'Guardar objetos (200 espacios)', tr: 'Eşya saklama (200 slot)', pt: 'Guardar itens (200 espaços)' } },
};

const I18N_RARITY = {
  common:    { en: 'Common',    uk: 'Звичайний',  es: 'Común',     tr: 'Sıradan',   pt: 'Comum' },
  uncommon:  { en: 'Uncommon',  uk: 'Незвичайний',es: 'Poco Común',tr: 'Nadir Değil', pt: 'Incomum' },
  rare:      { en: 'Rare',      uk: 'Рідкісний',  es: 'Raro',      tr: 'Nadir',     pt: 'Raro' },
  epic:      { en: 'Epic',      uk: 'Епічний',    es: 'Épico',     tr: 'Efsanevi Öncesi', pt: 'Épico' },
  legendary: { en: 'Legendary', uk: 'Легендарний',es: 'Legendario',tr: 'Efsanevi',  pt: 'Lendário' },
};

const I18N_SLOTS = {
  weapon:  { en: 'Weapon',   uk: 'Зброя',    es: 'Arma',        tr: 'Silah',     pt: 'Arma' },
  helmet:  { en: 'Helmet',   uk: 'Шолом',    es: 'Casco',       tr: 'Miğfer',    pt: 'Elmo' },
  body:    { en: 'Armor',    uk: 'Броня',    es: 'Armadura',    tr: 'Zırh',      pt: 'Armadura' },
  gloves:  { en: 'Gloves',   uk: 'Рукавиці', es: 'Guantes',     tr: 'Eldiven',   pt: 'Luvas' },
  boots:   { en: 'Boots',    uk: 'Чоботи',   es: 'Botas',       tr: 'Botlar',    pt: 'Botas' },
  ring:    { en: 'Ring',     uk: 'Каблучка', es: 'Anillo',      tr: 'Yüzük',     pt: 'Anel' },
  belt:    { en: 'Belt',     uk: 'Пояс',     es: 'Cinturón',    tr: 'Kemer',     pt: 'Cinto' },
  use:     { en: 'Consumable', uk: 'Витратний матеріал', es: 'Consumible', tr: 'Sarf Malzemesi', pt: 'Consumível' },
  material:{ en: 'Material', uk: 'Матеріал', es: 'Material',    tr: 'Malzeme',   pt: 'Material' },
  recipe:  { en: 'Recipe',   uk: 'Рецепт',   es: 'Receta',      tr: 'Tarif',     pt: 'Receita' },
  buff_potion: { en: 'Buff Potion', uk: 'Зілля посилення', es: 'Poción de Mejora', tr: 'Güçlendirme İksiri', pt: 'Poção de Bônus' },
  box:     { en: 'Box',      uk: 'Бокс',     es: 'Caja',        tr: 'Kutu',      pt: 'Caixa' },
};

// Equipment slot picker labels (js/definitions.js EQ_SLOTS) — same words as
// I18N_SLOTS above but a couple are deliberately shorter there (Russian
// "Перчи"/"Боты" are themselves abbreviations of "Перчатки"/"Ботинки") so
// this is kept as its own table rather than reusing I18N_SLOTS verbatim.
const I18N_EQ_SLOT_LABELS = {
  weapon:  { en: 'Weapon',  uk: 'Зброя',    es: 'Arma',     tr: 'Silah',   pt: 'Arma' },
  helmet:  { en: 'Helmet',  uk: 'Шолом',    es: 'Casco',    tr: 'Miğfer',  pt: 'Elmo' },
  body:    { en: 'Body',    uk: 'Тіло',     es: 'Cuerpo',   tr: 'Gövde',   pt: 'Corpo' },
  gloves:  { en: 'Gloves',  uk: 'Рукавиці', es: 'Guantes',  tr: 'Eldiven', pt: 'Luvas' },
  boots:   { en: 'Boots',   uk: 'Чоботи',   es: 'Botas',    tr: 'Botlar',  pt: 'Botas' },
  ring:    { en: 'Ring',    uk: 'Каблучка', es: 'Anillo',   tr: 'Yüzük',   pt: 'Anel' },
  belt:    { en: 'Belt',    uk: 'Пояс',     es: 'Cinturón', tr: 'Kemer',   pt: 'Cinto' },
};

const I18N_UPGRADES = {
  atk:        { label: { en: 'Attack',       uk: 'Атака',           es: 'Ataque',           tr: 'Saldırı',          pt: 'Ataque' },
                desc:  { en: '+1 ATK', uk: '+1 АТК', es: '+1 ATQ', tr: '+1 SLD', pt: '+1 ATQ' } },
  def:        { label: { en: 'Defense',      uk: 'Захист',          es: 'Defensa',          tr: 'Savunma',          pt: 'Defesa' },
                desc:  { en: '+1 DEF', uk: '+1 ЗАХ', es: '+1 DEF', tr: '+1 SAV', pt: '+1 DEF' } },
  hp:         { label: { en: 'Health',       uk: 'Здоров\'я',       es: 'Salud',            tr: 'Can',              pt: 'Vida' },
                desc:  { en: '+10 MaxHP', uk: '+10 Макс.HP', es: '+10 HP Máx.', tr: '+10 Maks.HP', pt: '+10 HP Máx.' } },
  atkSpeed:   { label: { en: 'Attack Spd.',  uk: 'Швид. атаки',     es: 'Vel. Ataque',      tr: 'Sld. Hızı',        pt: 'Vel. Ataque' },
                desc:  { en: '+0.05 hits/s', uk: '+0.05 удар/с', es: '+0.05 golpes/s', tr: '+0.05 vuruş/s', pt: '+0.05 golpes/s' } },
  critChance: { label: { en: 'Crit Chance',  uk: 'Шанс криту',      es: 'Prob. Crítico',    tr: 'Kritik Şansı',     pt: 'Chance Crítico' },
                desc:  { en: '+1%', uk: '+1%', es: '+1%', tr: '+%1', pt: '+1%' } },
  critPower:  { label: { en: 'Crit Power',   uk: 'Сила криту',      es: 'Poder Crítico',    tr: 'Kritik Gücü',      pt: 'Poder Crítico' },
                desc:  { en: '+3%', uk: '+3%', es: '+3%', tr: '+%3', pt: '+3%' } },
  hpRegen:    { label: { en: 'HP Regen',     uk: 'Реген HP',        es: 'Regen. HP',        tr: 'HP Yenilenme',     pt: 'Regen. HP' },
                desc:  { en: '+0.1/sec', uk: '+0.1/сек', es: '+0.1/s', tr: '+0.1/sn', pt: '+0.1/s' } },
};

const I18N_CLAN_LEVELS = {
  1:  { en: 'Newly Formed', uk: 'Новоутворений', es: 'Recién Formado',   tr: 'Yeni Kurulmuş',   pt: 'Recém-formado' },
  2:  { en: 'Coordinated',  uk: 'Злагоджений',   es: 'Coordinado',       tr: 'Koordineli',      pt: 'Coordenado' },
  3:  { en: 'United',       uk: 'Згуртований',   es: 'Unido',            tr: 'Kenetlenmiş',     pt: 'Unido' },
  4:  { en: 'Experienced',  uk: 'Досвідчений',   es: 'Experimentado',    tr: 'Deneyimli',       pt: 'Experiente' },
  5:  { en: 'Renowned',     uk: 'Іменитий',      es: 'Renombrado',       tr: 'Ünlü',            pt: 'Renomado' },
  6:  { en: 'Famed',        uk: 'Прославлений',  es: 'Afamado',          tr: 'Meşhur',          pt: 'Afamado' },
  7:  { en: 'Legendary',    uk: 'Легендарний',   es: 'Legendario',       tr: 'Efsanevi',        pt: 'Lendário' },
  8:  { en: 'Great',        uk: 'Великий',       es: 'Grandioso',        tr: 'Büyük',           pt: 'Grandioso' },
  9:  { en: 'Invincible',   uk: 'Непереможний',  es: 'Invencible',       tr: 'Yenilmez',        pt: 'Invencível' },
  10: { en: 'Immortal',     uk: 'Безсмертний',   es: 'Inmortal',         tr: 'Ölümsüz',         pt: 'Imortal' },
};

// key: item id -> {en, uk, es, tr, pt}
const I18N_ITEMS = {
  sw1: { en: 'Rusty Sword',   uk: 'Іржавий меч',   es: 'Espada Oxidada',   tr: 'Paslı Kılıç',    pt: 'Espada Enferrujada' },
  sw2: { en: 'Steel Sword',   uk: 'Сталевий меч',  es: 'Espada de Acero',  tr: 'Çelik Kılıç',    pt: 'Espada de Aço' },
  sw3: { en: 'Dragon Sword',  uk: 'Меч дракона',   es: 'Espada de Dragón', tr: 'Ejderha Kılıcı', pt: 'Espada do Dragão' },
  sw4: { en: 'Shadow Sword',  uk: 'Меч тіней',     es: 'Espada de Sombras', tr: 'Gölge Kılıcı',  pt: 'Espada das Sombras' },
  sw5: { en: 'Hero\'s Sword', uk: 'Меч героя',     es: 'Espada del Héroe', tr: 'Kahraman Kılıcı',pt: 'Espada do Herói' },
  tw1: { en: 'Rusty Axe',     uk: 'Іржавий сокира',es: 'Hacha Oxidada',    tr: 'Paslı Balta',    pt: 'Machado Enferrujado' },
  tw2: { en: 'Steel Axe',     uk: 'Сталева сокира',es: 'Hacha de Acero',   tr: 'Çelik Balta',    pt: 'Machado de Aço' },
  tw3: { en: 'Dragon Axe',    uk: 'Сокира дракона',es: 'Hacha de Dragón',  tr: 'Ejderha Baltası',pt: 'Machado do Dragão' },
  tw4: { en: 'Shadow Axe',    uk: 'Сокира тіней',  es: 'Hacha de Sombras', tr: 'Gölge Baltası',  pt: 'Machado das Sombras' },
  tw5: { en: 'Hero\'s Axe',   uk: 'Сокира героя',  es: 'Hacha del Héroe',  tr: 'Kahraman Baltası',pt: 'Machado do Herói' },
  bw1: { en: 'Wooden Bow',    uk: 'Дерев\'яний лук', es: 'Arco de Madera', tr: 'Ahşap Yay',      pt: 'Arco de Madeira' },
  bw2: { en: 'Silver Bow',    uk: 'Срібний лук',   es: 'Arco de Plata',    tr: 'Gümüş Yay',      pt: 'Arco de Prata' },
  bw3: { en: 'Hunter\'s Bow', uk: 'Лук мисливця',  es: 'Arco del Cazador', tr: 'Avcı Yayı',      pt: 'Arco do Caçador' },
  bw4: { en: 'Moon Bow',      uk: 'Місячний лук',  es: 'Arco Lunar',       tr: 'Ay Yayı',        pt: 'Arco Lunar' },
  bw5: { en: 'Hero\'s Bow',   uk: 'Лук героя',     es: 'Arco del Héroe',   tr: 'Kahraman Yayı',  pt: 'Arco do Herói' },
  st1: { en: 'Novice Staff',  uk: 'Посох новачка', es: 'Bastón de Novato', tr: 'Acemi Asası',    pt: 'Cajado de Novato' },
  st2: { en: 'Fighter\'s Staff', uk: 'Посох бійця', es: 'Bastón del Luchador', tr: 'Savaşçı Asası', pt: 'Cajado do Lutador' },
  st3: { en: 'Hunter\'s Staff', uk: 'Посох мисливця', es: 'Bastón del Cazador', tr: 'Avcı Asası', pt: 'Cajado do Caçador' },
  st4: { en: 'Hero\'s Staff', uk: 'Посох Героя',   es: 'Bastón del Héroe', tr: 'Kahraman Asası', pt: 'Cajado do Herói' },
  st5: { en: 'Legend\'s Staff', uk: 'Посох Легенди', es: 'Bastón de la Leyenda', tr: 'Efsane Asası', pt: 'Cajado da Lenda' },
  hm1: { en: 'Leather Helmet', uk: 'Шкіряний шолом', es: 'Casco de Cuero', tr: 'Deri Miğfer',    pt: 'Elmo de Couro' },
  hm2: { en: 'Iron Helmet',    uk: 'Залізний шолом', es: 'Casco de Hierro', tr: 'Demir Miğfer',  pt: 'Elmo de Ferro' },
  hm3: { en: 'Platinum Helmet',uk: 'Платиновий шолом', es: 'Casco de Platino', tr: 'Platin Miğfer', pt: 'Elmo de Platina' },
  hm4: { en: 'Hero\'s Crown', uk: 'Корона героя',  es: 'Corona del Héroe', tr: 'Kahraman Tacı',  pt: 'Coroa do Herói' },
  hm5: { en: 'Legend\'s Helmet', uk: 'Шолом легенди', es: 'Casco de la Leyenda', tr: 'Efsane Miğferi', pt: 'Elmo da Lenda' },
  ar1: { en: 'Leather Armor',  uk: 'Шкіряна броня', es: 'Armadura de Cuero', tr: 'Deri Zırh',    pt: 'Armadura de Couro' },
  ar2: { en: 'Iron Armor',     uk: 'Залізна броня', es: 'Armadura de Hierro', tr: 'Demir Zırh',  pt: 'Armadura de Ferro' },
  ar3: { en: 'Platinum Armor', uk: 'Платинова броня', es: 'Armadura de Platino', tr: 'Platin Zırh', pt: 'Armadura de Platina' },
  ar4: { en: 'Hero\'s Armor', uk: 'Обладунок героя', es: 'Armadura del Héroe', tr: 'Kahraman Zırhı', pt: 'Armadura do Herói' },
  ar5: { en: 'Legend\'s Armor', uk: 'Обладунок легенди', es: 'Armadura de la Leyenda', tr: 'Efsane Zırhı', pt: 'Armadura da Lenda' },
  gl1: { en: 'Leather Gloves', uk: 'Шкіряні рукавиці', es: 'Guantes de Cuero', tr: 'Deri Eldiven', pt: 'Luvas de Couro' },
  gl2: { en: 'Iron Gloves',    uk: 'Залізні рукавиці', es: 'Guantes de Hierro', tr: 'Demir Eldiven', pt: 'Luvas de Ferro' },
  gl3: { en: 'Platinum Gloves', uk: 'Платинові рукавиці', es: 'Guantes de Platino', tr: 'Platin Eldiven', pt: 'Luvas de Platina' },
  gl4: { en: 'Hero\'s Gloves', uk: 'Рукавиці героя', es: 'Guantes del Héroe', tr: 'Kahraman Eldiveni', pt: 'Luvas do Herói' },
  gl5: { en: 'Legend\'s Gloves', uk: 'Рукавиці легенди', es: 'Guantes de la Leyenda', tr: 'Efsane Eldiveni', pt: 'Luvas da Lenda' },
  bt1: { en: 'Leather Boots', uk: 'Шкіряні чоботи', es: 'Botas de Cuero',  tr: 'Deri Botlar',    pt: 'Botas de Couro' },
  bt2: { en: 'Iron Boots',    uk: 'Залізні чоботи', es: 'Botas de Hierro', tr: 'Demir Botlar',   pt: 'Botas de Ferro' },
  bt3: { en: 'Platinum Boots', uk: 'Платинові чоботи', es: 'Botas de Platino', tr: 'Platin Botlar', pt: 'Botas de Platina' },
  bt4: { en: 'Hero\'s Boots', uk: 'Чоботи героя',   es: 'Botas del Héroe', tr: 'Kahraman Botları', pt: 'Botas do Herói' },
  bt5: { en: 'Legend\'s Boots', uk: 'Чоботи легенди', es: 'Botas de la Leyenda', tr: 'Efsane Botları', pt: 'Botas da Lenda' },
  rn1: { en: 'Ring of Power',  uk: 'Каблучка сили', es: 'Anillo de Poder', tr: 'Güç Yüzüğü',     pt: 'Anel de Poder' },
  rn2: { en: 'Ring of Protection', uk: 'Каблучка захисту', es: 'Anillo de Protección', tr: 'Koruma Yüzüğü', pt: 'Anel de Proteção' },
  rn3: { en: 'Ring of Blood',  uk: 'Каблучка крові', es: 'Anillo de Sangre', tr: 'Kan Yüzüğü',    pt: 'Anel de Sangue' },
  rn4: { en: 'Hero\'s Ring',   uk: 'Каблучка героя', es: 'Anillo del Héroe', tr: 'Kahraman Yüzüğü', pt: 'Anel do Herói' },
  rn5: { en: 'Legend\'s Ring', uk: 'Каблучка легенди', es: 'Anillo de la Leyenda', tr: 'Efsane Yüzüğü', pt: 'Anel da Lenda' },
  nd1: { en: 'Belt of Power',  uk: 'Пояс сили',     es: 'Cinturón de Poder', tr: 'Güç Kemeri',   pt: 'Cinto de Poder' },
  nd2: { en: 'Belt of Health', uk: 'Пояс здоров\'я', es: 'Cinturón de Salud', tr: 'Can Kemeri',   pt: 'Cinto de Vida' },
  nd3: { en: 'Belt of Darkness', uk: 'Пояс тьми',   es: 'Cinturón de Oscuridad', tr: 'Karanlık Kemeri', pt: 'Cinto das Trevas' },
  nd4: { en: 'Hero\'s Belt',   uk: 'Пояс героя',    es: 'Cinturón del Héroe', tr: 'Kahraman Kemeri', pt: 'Cinto do Herói' },
  nd5: { en: 'Legend\'s Belt', uk: 'Пояс легенди',  es: 'Cinturón de la Leyenda', tr: 'Efsane Kemeri', pt: 'Cinto da Lenda' },
  pt1: { en: 'Small Potion',   uk: 'Мале зілля',    es: 'Poción Pequeña',  tr: 'Küçük İksir',    pt: 'Poção Pequena' },
  pt2: { en: 'Large Potion',   uk: 'Велике зілля',  es: 'Poción Grande',   tr: 'Büyük İksir',    pt: 'Poção Grande' },
  bp_hp:       { en: 'HP Potion',          uk: 'Зілля здоров\'я', es: 'Poción de Salud',   tr: 'Can İksiri',      pt: 'Poção de Vida' },
  bp_exp:      { en: 'XP Potion',          uk: 'Зілля досвіду',   es: 'Poción de Experiencia', tr: 'Tecrübe İksiri', pt: 'Poção de Experiência' },
  bp_gold:     { en: 'Gold Potion',        uk: 'Зілля золота',    es: 'Poción de Oro',     tr: 'Altın İksiri',    pt: 'Poção de Ouro' },
  bp_regen:    { en: 'Regen Potion',       uk: 'Зілля регенерації', es: 'Poción de Regeneración', tr: 'Yenilenme İksiri', pt: 'Poção de Regeneração' },
  bp_atkspeed: { en: 'Speed Potion',       uk: 'Зілля швидкості', es: 'Poción de Velocidad', tr: 'Hız İksiri',    pt: 'Poção de Velocidade' },
  bp_atk:      { en: 'Attack Potion',      uk: 'Зілля атаки',     es: 'Poción de Ataque',  tr: 'Saldırı İksiri',  pt: 'Poção de Ataque' },
};

// key: material/recipe/book id -> {en, uk, es, tr, pt}
const I18N_MATS = {
  recu: { en: 'Uncommon Recipe',  uk: 'Незвичайний рецепт', es: 'Receta Poco Común', tr: 'Nadir Olmayan Tarif', pt: 'Receita Incomum' },
  recr: { en: 'Rare Recipe',      uk: 'Рідкісний рецепт',   es: 'Receta Rara',       tr: 'Nadir Tarif',        pt: 'Receita Rara' },
  rece: { en: 'Epic Recipe',      uk: 'Епічний рецепт',     es: 'Receta Épica',      tr: 'Efsanevi Tarif',     pt: 'Receita Épica' },
  recl: { en: 'Legendary Recipe', uk: 'Легендарний рецепт', es: 'Receta Legendaria', tr: 'Efsane Tarif',       pt: 'Receita Lendária' },
  norm_stone:   { en: 'Stone of Normal Enchant', uk: 'Камінь звичайного гартування', es: 'Piedra de Encantamiento Normal', tr: 'Normal Büyü Taşı', pt: 'Pedra de Encantamento Normal' },
  bless_stone:  { en: 'Stone of Safe Enchant',   uk: 'Камінь безпечного гартування', es: 'Piedra de Encantamiento Seguro', tr: 'Güvenli Büyü Taşı', pt: 'Pedra de Encantamento Seguro' },
  key_uncommon: { en: 'Uncommon Key', uk: 'Незвичайний ключ', es: 'Llave Poco Común', tr: 'Nadir Olmayan Anahtar', pt: 'Chave Incomum' },
  key_rare:     { en: 'Rare Key',      uk: 'Рідкісний ключ',   es: 'Llave Rara',       tr: 'Nadir Anahtar',        pt: 'Chave Rara' },
  book_lev_Q: { en: 'Book: Frost Strike',  uk: 'Книга: Крижаний удар', es: 'Libro: Golpe Helado', tr: 'Kitap: Buz Darbesi', pt: 'Livro: Golpe Gélido' },
  book_lev_W: { en: 'Book: Blade Whirl',   uk: 'Книга: Вихор клинків', es: 'Libro: Torbellino de Hojas', tr: 'Kitap: Bıçak Kasırgası', pt: 'Livro: Redemoinho de Lâminas' },
  book_lev_E: { en: 'Book: Wrath of the Dead', uk: 'Книга: Гнів мерця', es: 'Libro: Ira del Muerto', tr: 'Kitap: Ölünün Gazabı', pt: 'Livro: Fúria do Morto' },
  book_lev_R: { en: 'Book: Dash of Light', uk: 'Книга: Ривок світла', es: 'Libro: Arremetida de Luz', tr: 'Kitap: Işık Atılımı', pt: 'Livro: Investida da Luz' },
  book_deathknight_Q: { en: 'Book: Vampirism',    uk: 'Книга: Вампіризм', es: 'Libro: Vampirismo', tr: 'Kitap: Vampirlik', pt: 'Livro: Vampirismo' },
  book_deathknight_W: { en: 'Book: Blade Vortex',  uk: 'Книга: Вихор клинка', es: 'Libro: Vórtice de Hoja', tr: 'Kitap: Bıçak Girdabı', pt: 'Livro: Vórtice de Lâmina' },
  book_deathknight_E: { en: 'Book: Rage',          uk: 'Книга: Лють', es: 'Libro: Furia', tr: 'Kitap: Öfke', pt: 'Livro: Fúria' },
  book_deathknight_R: { en: 'Book: Roll',          uk: 'Книга: Кувирок', es: 'Libro: Voltereta', tr: 'Kitap: Takla', pt: 'Livro: Rolamento' },
  book_ranger_Q: { en: 'Book: Multi-Shot',   uk: 'Книга: Мультипостріл', es: 'Libro: Disparo Múltiple', tr: 'Kitap: Çoklu Atış', pt: 'Livro: Tiro Múltiplo' },
  book_ranger_W: { en: 'Book: Combo Arrow',  uk: 'Книга: Комбо-стріла', es: 'Libro: Flecha Combo', tr: 'Kitap: Kombo Ok', pt: 'Livro: Flecha Combo' },
  book_ranger_E: { en: 'Book: Jump',         uk: 'Книга: Стрибок', es: 'Libro: Salto', tr: 'Kitap: Zıplama', pt: 'Livro: Salto' },
  book_ranger_R: { en: 'Book: Attack Speed', uk: 'Книга: Швидкість атаки', es: 'Libro: Velocidad de Ataque', tr: 'Kitap: Saldırı Hızı', pt: 'Livro: Velocidade de Ataque' },
  book_mage_Q: { en: 'Book: Frost Orb',  uk: 'Книга: Крижана куля', es: 'Libro: Orbe de Hielo', tr: 'Kitap: Buz Küresi', pt: 'Livro: Orbe de Gelo' },
  book_mage_W: { en: 'Book: Frost Nova', uk: 'Книга: Крижана нова', es: 'Libro: Nova de Hielo', tr: 'Kitap: Buz Nova', pt: 'Livro: Nova de Gelo' },
  book_mage_E: { en: 'Book: Barrier',    uk: 'Книга: Бар\'єр', es: 'Libro: Barrera', tr: 'Kitap: Bariyer', pt: 'Livro: Barreira' },
  book_mage_R: { en: 'Book: Teleport',   uk: 'Книга: Телепорт', es: 'Libro: Teletransporte', tr: 'Kitap: Işınlanma', pt: 'Livro: Teleporte' },
  book_warlock_Q: { en: 'Book: Dark Heal',   uk: 'Книга: Темне зцілення', es: 'Libro: Curación Oscura', tr: 'Kitap: Karanlık Şifa', pt: 'Livro: Cura Sombria' },
  book_warlock_W: { en: 'Book: Chains of Darkness', uk: 'Книга: Кайдани темряви', es: 'Libro: Cadenas de Oscuridad', tr: 'Kitap: Karanlık Zincirleri', pt: 'Livro: Correntes das Trevas' },
  book_warlock_E: { en: 'Book: Dark Shield', uk: 'Книга: Темний щит', es: 'Libro: Escudo Oscuro', tr: 'Kitap: Karanlık Kalkan', pt: 'Livro: Escudo Sombrio' },
  book_warlock_R: { en: 'Book: Dark Prayer', uk: 'Книга: Темна молитва', es: 'Libro: Oración Oscura', tr: 'Kitap: Karanlık Dua', pt: 'Livro: Oração Sombria' },
  book_pas_tankatk: { en: 'Book: Berserker Might', uk: 'Книга: Міць берсерка', es: 'Libro: Poder del Berserker', tr: 'Kitap: Berserker Gücü', pt: 'Livro: Poder do Berserker' },
  book_pas_deftank: { en: 'Book: Unbreakable',     uk: 'Книга: Незламність', es: 'Libro: Inquebrantable', tr: 'Kitap: Yıkılmazlık', pt: 'Livro: Inquebrável' },
  book_pas_dkatk:   { en: 'Book: Blood Pact',      uk: 'Книга: Кривавий пакт', es: 'Libro: Pacto de Sangre', tr: 'Kitap: Kan Paktı', pt: 'Livro: Pacto de Sangue' },
  book_pas_dkdef:   { en: 'Book: Dark Carapace',   uk: 'Книга: Темний панцир', es: 'Libro: Caparazón Oscuro', tr: 'Kitap: Karanlık Zırh', pt: 'Livro: Carapaça Sombria' },
  book_pas_bowatk:  { en: 'Book: Keen Eye',        uk: 'Книга: Влучне око', es: 'Libro: Ojo Certero', tr: 'Kitap: Keskin Göz', pt: 'Livro: Olho Certeiro' },
  book_pas_bowdef:  { en: 'Book: Tracker\'s Instinct', uk: 'Книга: Чуття слідопита', es: 'Libro: Instinto de Rastreador', tr: 'Kitap: İzci İçgüdüsü', pt: 'Livro: Instinto de Rastreador' },
  book_pas_mageatk: { en: 'Book: Mana Flow',       uk: 'Книга: Потік мани', es: 'Libro: Flujo de Maná', tr: 'Kitap: Mana Akışı', pt: 'Livro: Fluxo de Mana' },
  book_pas_magedef: { en: 'Book: Ice Shield',      uk: 'Книга: Крижаний щит', es: 'Libro: Escudo de Hielo', tr: 'Kitap: Buz Kalkanı', pt: 'Livro: Escudo de Gelo' },
  book_pas_healatk: { en: 'Book: Dark Thirst',     uk: 'Книга: Темна спрага', es: 'Libro: Sed Oscura', tr: 'Kitap: Karanlık Susuzluk', pt: 'Livro: Sede Sombria' },
  book_pas_healdef: { en: 'Book: Dark Ward',       uk: 'Книга: Оберіг тьми', es: 'Libro: Amuleto Oscuro', tr: 'Kitap: Karanlık Muska', pt: 'Livro: Amuleto Sombrio' },
  book_pas_allatkspeed: { en: 'Book: Swiftness',   uk: 'Книга: Стрімкість', es: 'Libro: Celeridad', tr: 'Kitap: Çeviklik', pt: 'Livro: Rapidez' },
  book_pas_allhp:       { en: 'Book: Vitality',    uk: 'Книга: Живучість', es: 'Libro: Vitalidad', tr: 'Kitap: Dayanıklılık', pt: 'Livro: Vitalidade' },
  book_pas_allcritdmg:  { en: 'Book: Blood Frenzy',uk: 'Книга: Кривава лють', es: 'Libro: Frenesí Sangriento', tr: 'Kitap: Kan Çılgınlığı', pt: 'Livro: Frenesi Sangrento' },
  book_pas_allspeed:    { en: 'Book: Fleet Feet',  uk: 'Книга: Швидкі ноги', es: 'Libro: Pies Ligeros', tr: 'Kitap: Hızlı Ayaklar', pt: 'Livro: Pés Ligeiros' },
  book_pas_allcdskill:  { en: 'Book: Clear Mind',  uk: 'Книга: Ясний розум', es: 'Libro: Mente Clara', tr: 'Kitap: Berrak Zihin', pt: 'Livro: Mente Clara' },
  book_pas_allregen:    { en: 'Book: Regeneration',uk: 'Книга: Регенерація', es: 'Libro: Regeneración', tr: 'Kitap: Yenilenme', pt: 'Livro: Regeneração' },
};

const I18N_BOXES = {
  box_uncommon: { en: 'Uncommon Box', uk: 'Незвичайний бокс', es: 'Caja Poco Común', tr: 'Nadir Olmayan Kutu', pt: 'Caixa Incomum' },
  box_rare:     { en: 'Rare Box',     uk: 'Рідкісний бокс',   es: 'Caja Rara',       tr: 'Nadir Kutu',        pt: 'Caixa Rara' },
};

// key: enemy eid -> {en, uk, es, tr, pt} — base species+rank name (e.g.
// "rat_guard" = "Крыса страж"). Used both if the target-frame follow-up ever
// lands, and right now to translate quest text that embeds these names.
const I18N_ENEMIES = {
  rat_guard:      { en: 'Rat Guard',       uk: 'Щур-вартовий',   es: 'Rata Guardiana',  tr: 'Fare Muhafız',   pt: 'Rato Guardião' },
  rat_warrior:    { en: 'Rat Warrior',     uk: 'Щур-воїн',       es: 'Rata Guerrera',   tr: 'Fare Savaşçı',   pt: 'Rato Guerreiro' },
  slime_guard:    { en: 'Slime Guard',     uk: 'Слиз-вартовий',  es: 'Limo Guardián',   tr: 'Slime Muhafız',  pt: 'Lodo Guardião' },
  slime_warrior:  { en: 'Slime Warrior',   uk: 'Слиз-воїн',      es: 'Limo Guerrero',   tr: 'Slime Savaşçı',  pt: 'Lodo Guerreiro' },
  imp_guard:      { en: 'Imp Guard',       uk: 'Біс-вартовий',   es: 'Diablillo Guardián', tr: 'İblis Muhafız', pt: 'Diabrete Guardião' },
  imp_warrior:    { en: 'Imp Warrior',     uk: 'Біс-воїн',       es: 'Diablillo Guerrero', tr: 'İblis Savaşçı', pt: 'Diabrete Guerreiro' },
  imp_boss:       { en: 'Imp Boss',        uk: 'Бос бісів',      es: 'Jefe Diablillo',  tr: 'İblis Patronu',  pt: 'Chefe Diabrete' },
  zombie_guard:   { en: 'Zombie Guard',    uk: 'Зомбі-вартовий', es: 'Zombi Guardián',  tr: 'Zombi Muhafız',  pt: 'Zumbi Guardião' },
  zombie_warrior: { en: 'Zombie Warrior',  uk: 'Зомбі-воїн',     es: 'Zombi Guerrero',  tr: 'Zombi Savaşçı',  pt: 'Zumbi Guerreiro' },
  lizardman_guard:   { en: 'Lizardman Guard',   uk: 'Ящір-вартовий', es: 'Hombre Lagarto Guardián', tr: 'Kertenkele Muhafız', pt: 'Homem-Lagarto Guardião' },
  lizardman_warrior: { en: 'Lizardman Warrior', uk: 'Ящір-воїн',    es: 'Hombre Lagarto Guerrero', tr: 'Kertenkele Savaşçı', pt: 'Homem-Lagarto Guerreiro' },
  orc_guard:      { en: 'Orc Guard',       uk: 'Орк-вартовий',   es: 'Orco Guardián',   tr: 'Ork Muhafız',    pt: 'Orc Guardião' },
  orc_warrior:    { en: 'Orc Warrior',     uk: 'Орк-воїн',       es: 'Orco Guerrero',   tr: 'Ork Savaşçı',    pt: 'Orc Guerreiro' },
  orc_boss:       { en: 'Orc Boss',        uk: 'Бос орків',      es: 'Jefe Orco',       tr: 'Ork Patronu',    pt: 'Chefe Orc' },
  plant_guard:    { en: 'Vine Guard',      uk: 'Лоза-вартовий',  es: 'Enredadera Guardiana', tr: 'Asma Muhafız', pt: 'Trepadeira Guardiã' },
  plant_warrior:  { en: 'Vine Warrior',    uk: 'Лоза-воїн',      es: 'Enredadera Guerrera', tr: 'Asma Savaşçı', pt: 'Trepadeira Guerreira' },
  vampire_guard:  { en: 'Vampire Guard',   uk: 'Вампір-вартовий', es: 'Vampiro Guardián', tr: 'Vampir Muhafız', pt: 'Vampiro Guardião' },
  vampire_warrior:{ en: 'Vampire Warrior', uk: 'Вампір-воїн',    es: 'Vampiro Guerrero', tr: 'Vampir Savaşçı', pt: 'Vampiro Guerreiro' },
  beholder_guard: { en: 'Beholder Guard',  uk: 'Глазир-вартовий', es: 'Observador Guardián', tr: 'Gözcü Muhafız', pt: 'Observador Guardião' },
  beholder_warrior: { en: 'Beholder Warrior', uk: 'Глазир-воїн', es: 'Observador Guerrero', tr: 'Gözcü Savaşçı', pt: 'Observador Guerreiro' },
  beholder_boss:  { en: 'Beholder Boss',   uk: 'Бос глазирів',   es: 'Jefe Observador', tr: 'Gözcü Patronu',  pt: 'Chefe Observador' },
  ent_guard:      { en: 'Ent Guard',       uk: 'Древень-вартовий', es: 'Ent Guardián',  tr: 'Ent Muhafız',    pt: 'Ent Guardião' },
  ent_warrior:    { en: 'Ent Warrior',     uk: 'Древень-воїн',   es: 'Ent Guerrero',    tr: 'Ent Savaşçı',    pt: 'Ent Guerreiro' },
  demon_guard:    { en: 'Demon Guard',     uk: 'Демон-вартовий', es: 'Demonio Guardián', tr: 'Şeytan Muhafız', pt: 'Demônio Guardião' },
  demon_warrior:  { en: 'Demon Warrior',   uk: 'Демон-воїн',     es: 'Demonio Guerrero', tr: 'Şeytan Savaşçı', pt: 'Demônio Guerreiro' },
  demon_boss:     { en: 'Demon Boss',      uk: 'Бос демонів',    es: 'Jefe Demonio',    tr: 'Şeytan Patronu', pt: 'Chefe Demônio' },
};
// Reverse index built lazily (RU base name -> eid) so quest desc translation
// can look up an enemy's localized name starting only from the RU string
// baked into QUEST_DEF.enemies[].
let _ruEnemyNameToEid = null;
function _enemyEidForRuName(ruName) {
  if (!_ruEnemyNameToEid) {
    // Must read the PRISTINE RU name (_i18nOrigName, set by _i18nSnapshot
    // before any mutation), not the live .name field — by the time this is
    // first called (from applyLocale, after ENEMY_DEF has already been
    // rewritten to the target language earlier in the same call), .name no
    // longer holds Russian text and this lookup would always miss.
    _ruEnemyNameToEid = {};
    (typeof ENEMY_DEF !== 'undefined' ? ENEMY_DEF : []).forEach(d => { _ruEnemyNameToEid[d._i18nOrigName || d.name] = d.eid; });
  }
  return _ruEnemyNameToEid[ruName] || null;
}
function _tEnemyBaseName(ruName, lang) {
  const eid = _enemyEidForRuName(ruName);
  const e = eid && I18N_ENEMIES[eid];
  return (e && e[lang]) || ruName;
}

// ── Quest titles (60) — key: quest id ──
const I18N_QUEST_TITLES = {
  f1q1:  { en: 'First Blood',        uk: 'Перша кров',        es: 'Primera Sangre',      tr: 'İlk Kan',           pt: 'Primeiro Sangue' },
  f1q2:  { en: 'The Guard Falls',    uk: 'Вартовий впаде',     es: 'Cae el Guardián',     tr: 'Muhafız Düşecek',  pt: 'O Guardião Cai' },
  f1q3:  { en: 'Trading',           uk: 'Торгівля',            es: 'Comercio',            tr: 'Ticaret',           pt: 'Comércio' },
  f1q4:  { en: 'Hunter',            uk: 'Мисливець',           es: 'Cazador',             tr: 'Avcı',              pt: 'Caçador' },
  f1q5:  { en: 'Punisher',          uk: 'Каратель',            es: 'Castigador',          tr: 'Cezalandırıcı',    pt: 'Punidor' },
  f1q6:  { en: 'Seasoned Fighter',  uk: 'Досвідчений боєць',   es: 'Luchador Experto',    tr: 'Deneyimli Savaşçı', pt: 'Lutador Experiente' },
  f1q7:  { en: 'Slime Hunter',      uk: 'Ловець слизу',        es: 'Cazador de Limo',     tr: 'Slime Avcısı',      pt: 'Caçador de Lodo' },
  f1q8:  { en: 'Scourge of Imps',   uk: 'Гроза бісів',         es: 'Azote de Diablillos', tr: 'İblis Belası',      pt: 'Flagelo dos Diabretes' },
  f1q10: { en: 'Veteran',          uk: 'Ветеран',             es: 'Veterano',            tr: 'Gazi',              pt: 'Veterano' },
  f1q11: { en: 'Conqueror',        uk: 'Підкорювач',          es: 'Conquistador',        tr: 'Fatih',             pt: 'Conquistador' },
  f1q12: { en: 'Butcher',          uk: 'М\'ясник',            es: 'Carnicero',           tr: 'Kasap',             pt: 'Açougueiro' },
  f1q13: { en: 'Berserker',        uk: 'Берсерк',             es: 'Berserker',           tr: 'Berserker',         pt: 'Berserker' },
  f1q14: { en: 'To the Clan!',     uk: 'До клану!',           es: '¡Al Clan!',           tr: 'Klana Katıl!',      pt: 'Para o Clã!' },
  f1q9:  { en: 'Imp Banisher',     uk: 'Виганяч бісів',       es: 'Expulsor de Diablillos', tr: 'İblis Kovucu',   pt: 'Banidor de Diabretes' },
  f1q15: { en: 'Next Level',       uk: 'Наступний рівень',    es: 'Siguiente Nivel',     tr: 'Sıradaki Seviye',   pt: 'Próximo Nível' },

  f2q1:  { en: 'First Blood II',       uk: 'Перша кров II',       es: 'Primera Sangre II',     tr: 'İlk Kan II',          pt: 'Primeiro Sangue II' },
  f2q2:  { en: 'The Guard Falls II',   uk: 'Вартовий впаде II',   es: 'Cae el Guardián II',    tr: 'Muhafız Düşecek II', pt: 'O Guardião Cai II' },
  f2q3:  { en: 'Trading II',           uk: 'Торгівля II',          es: 'Comercio II',           tr: 'Ticaret II',          pt: 'Comércio II' },
  f2q4:  { en: 'Hunter II',            uk: 'Мисливець II',         es: 'Cazador II',            tr: 'Avcı II',             pt: 'Caçador II' },
  f2q5:  { en: 'Punisher II',          uk: 'Каратель II',          es: 'Castigador II',         tr: 'Cezalandırıcı II',   pt: 'Punidor II' },
  f2q6:  { en: 'Seasoned Fighter II',  uk: 'Досвідчений боєць II', es: 'Luchador Experto II',   tr: 'Deneyimli Savaşçı II', pt: 'Lutador Experiente II' },
  f2q7:  { en: 'Lizardman Hunter',     uk: 'Мисливець на ящерів',  es: 'Cazador de Hombres Lagarto', tr: 'Kertenkele Avcısı', pt: 'Caçador de Homens-Lagarto' },
  f2q8:  { en: 'Fury of the Orcs',     uk: 'Лють орків',           es: 'Furia de los Orcos',    tr: 'Ork Öfkesi',          pt: 'Fúria dos Orcs' },
  f2q10: { en: 'Veteran II',           uk: 'Ветеран II',           es: 'Veterano II',           tr: 'Gazi II',             pt: 'Veterano II' },
  f2q11: { en: 'Conqueror II',         uk: 'Підкорювач II',        es: 'Conquistador II',       tr: 'Fatih II',            pt: 'Conquistador II' },
  f2q12: { en: 'Butcher II',           uk: 'М\'ясник II',          es: 'Carnicero II',          tr: 'Kasap II',            pt: 'Açougueiro II' },
  f2q13: { en: 'Berserker II',         uk: 'Берсерк II',           es: 'Berserker II',          tr: 'Berserker II',        pt: 'Berserker II' },
  f2q14: { en: 'Honored Member',       uk: 'Почесний член',        es: 'Miembro Honorario',     tr: 'Onursal Üye',         pt: 'Membro Honorário' },
  f2q9:  { en: 'Boss Slayer II',       uk: 'Вбивця босів II',      es: 'Cazador de Jefes II',   tr: 'Patron Avcısı II',    pt: 'Matador de Chefes II' },
  f2q15: { en: 'Into the Dark',        uk: 'У глиб темряви',       es: 'Hacia la Oscuridad',    tr: 'Karanlığın Derinliklerine', pt: 'Rumo às Trevas' },

  f3q1:  { en: 'First Blood III',      uk: 'Перша кров III',       es: 'Primera Sangre III',    tr: 'İlk Kan III',         pt: 'Primeiro Sangue III' },
  f3q2:  { en: 'The Guard Falls III',  uk: 'Вартовий впаде III',   es: 'Cae el Guardián III',   tr: 'Muhafız Düşecek III', pt: 'O Guardião Cai III' },
  f3q3:  { en: 'Trading III',          uk: 'Торгівля III',         es: 'Comercio III',          tr: 'Ticaret III',         pt: 'Comércio III' },
  f3q4:  { en: 'Hunter III',           uk: 'Мисливець III',        es: 'Cazador III',           tr: 'Avcı III',            pt: 'Caçador III' },
  f3q5:  { en: 'Punisher III',         uk: 'Каратель III',         es: 'Castigador III',        tr: 'Cezalandırıcı III',   pt: 'Punidor III' },
  f3q6:  { en: 'Seasoned Fighter III', uk: 'Досвідчений боєць III',es: 'Luchador Experto III',  tr: 'Deneyimli Savaşçı III', pt: 'Lutador Experiente III' },
  f3q7:  { en: 'Vampire Hunter',       uk: 'Мисливець на вампірів',es: 'Cazador de Vampiros',   tr: 'Vampir Avcısı',       pt: 'Caçador de Vampiros' },
  f3q8:  { en: 'Gaze of the Abyss',    uk: 'Погляд безодні',       es: 'Mirada del Abismo',     tr: 'Uçurumun Bakışı',     pt: 'Olhar do Abismo' },
  f3q10: { en: 'Veteran III',          uk: 'Ветеран III',          es: 'Veterano III',          tr: 'Gazi III',            pt: 'Veterano III' },
  f3q11: { en: 'Conqueror III',        uk: 'Підкорювач III',       es: 'Conquistador III',      tr: 'Fatih III',           pt: 'Conquistador III' },
  f3q12: { en: 'Butcher III',          uk: 'М\'ясник III',         es: 'Carnicero III',         tr: 'Kasap III',           pt: 'Açougueiro III' },
  f3q13: { en: 'Berserker III',        uk: 'Берсерк III',          es: 'Berserker III',         tr: 'Berserker III',       pt: 'Berserker III' },
  f3q14: { en: 'Pillar of the Clan',   uk: 'Стовп клану',          es: 'Pilar del Clan',        tr: 'Klanın Direği',       pt: 'Pilar do Clã' },
  f3q9:  { en: 'Boss Slayer III',      uk: 'Вбивця босів III',     es: 'Cazador de Jefes III',  tr: 'Patron Avcısı III',   pt: 'Matador de Chefes III' },
  f3q15: { en: 'To the Edge of the World', uk: 'На край світу',    es: 'Al Fin del Mundo',      tr: 'Dünyanın Ucuna',      pt: 'Até o Fim do Mundo' },

  f4q1:  { en: 'First Blood IV',       uk: 'Перша кров IV',        es: 'Primera Sangre IV',     tr: 'İlk Kan IV',          pt: 'Primeiro Sangue IV' },
  f4q2:  { en: 'The Guard Falls IV',   uk: 'Вартовий впаде IV',    es: 'Cae el Guardián IV',    tr: 'Muhafız Düşecek IV',  pt: 'O Guardião Cai IV' },
  f4q3:  { en: 'Trading IV',           uk: 'Торгівля IV',          es: 'Comercio IV',           tr: 'Ticaret IV',          pt: 'Comércio IV' },
  f4q4:  { en: 'Hunter IV',            uk: 'Мисливець IV',         es: 'Cazador IV',            tr: 'Avcı IV',             pt: 'Caçador IV' },
  f4q5:  { en: 'Punisher IV',          uk: 'Каратель IV',          es: 'Castigador IV',         tr: 'Cezalandırıcı IV',    pt: 'Punidor IV' },
  f4q6:  { en: 'Seasoned Fighter IV',  uk: 'Досвідчений боєць IV', es: 'Luchador Experto IV',   tr: 'Deneyimli Savaşçı IV', pt: 'Lutador Experiente IV' },
  f4q7:  { en: 'Demon Banisher',       uk: 'Виганяч демонів',      es: 'Expulsor de Demonios',  tr: 'Şeytan Kovucu',       pt: 'Banidor de Demônios' },
  f4q8:  { en: 'Flame of the Abyss',   uk: 'Полум\'я безодні',     es: 'Llama del Abismo',      tr: 'Uçurumun Alevi',      pt: 'Chama do Abismo' },
  f4q10: { en: 'Veteran IV',           uk: 'Ветеран IV',           es: 'Veterano IV',           tr: 'Gazi IV',             pt: 'Veterano IV' },
  f4q11: { en: 'Conqueror IV',         uk: 'Підкорювач IV',        es: 'Conquistador IV',       tr: 'Fatih IV',            pt: 'Conquistador IV' },
  f4q12: { en: 'Butcher IV',           uk: 'М\'ясник IV',          es: 'Carnicero IV',          tr: 'Kasap IV',            pt: 'Açougueiro IV' },
  f4q13: { en: 'Berserker IV',         uk: 'Берсерк IV',           es: 'Berserker IV',          tr: 'Berserker IV',        pt: 'Berserker IV' },
  f4q14: { en: 'Legend of the Clan',   uk: 'Легенда клану',        es: 'Leyenda del Clan',      tr: 'Klanın Efsanesi',     pt: 'Lenda do Clã' },
  f4q9:  { en: 'Boss Slayer IV',       uk: 'Вбивця босів IV',      es: 'Cazador de Jefes IV',   tr: 'Patron Avcısı IV',    pt: 'Matador de Chefes IV' },
  f4q15: { en: 'Lord of the Dungeon',  uk: 'Володар підземелля',   es: 'Señor de la Mazmorra',  tr: 'Zindanın Efendisi',   pt: 'Senhor da Masmorra' },
};

// ── Quest description templates (data-driven, covers all 60 quests) ──
// uk values are genitive case ("до верхнього коридору") since every
// template below places them after "до" (to/toward), which in Ukrainian
// (like Russian) governs the genitive — nominative here would be a
// grammar error even though the other four languages don't decline nouns
// this way.
const _CORRIDOR_NAME = {
  2: { en: 'top corridor',    uk: 'верхнього коридору', es: 'corredor superior', tr: 'üst koridor',  pt: 'corredor superior' },
  3: { en: 'bottom corridor', uk: 'нижнього коридору',  es: 'corredor inferior', tr: 'alt koridor',  pt: 'corredor inferior' },
  4: { en: 'right corridor',  uk: 'правого коридору',   es: 'corredor derecho',  tr: 'sağ koridor',  pt: 'corredor direito' },
};
const I18N_QUEST_TPL = {
  en: {
    kill: (n, enemy) => `Kill ${n} ${enemy}`,
    buyPotion: (n) => `Buy ${n} potions`,
    level: (lvl) => `Reach level ${lvl}`,
    joinClan: () => 'Join a clan',
    promoteClan: () => 'Get promoted in your clan',
    gotoFloor: (floor) => `Reach the ${_CORRIDOR_NAME[floor].en}`,
    dungeonClear: (floor) => `Reach the end of the ${_CORRIDOR_NAME[floor].en}`,
  },
  uk: {
    kill: (n, enemy) => `Вбий ${n} ${enemy}`,
    buyPotion: (n) => `Купи ${n} зіль`,
    level: (lvl) => `Досягни ${lvl} рівня`,
    joinClan: () => 'Вступи до клану',
    promoteClan: () => 'Підвищ ранг у клані',
    gotoFloor: (floor) => `Дійди до ${_CORRIDOR_NAME[floor].uk}`,
    dungeonClear: (floor) => `Дійди до кінця ${_CORRIDOR_NAME[floor].uk}`,
  },
  es: {
    kill: (n, enemy) => `Mata a ${n} ${enemy}`,
    buyPotion: (n) => `Compra ${n} pociones`,
    level: (lvl) => `Alcanza el nivel ${lvl}`,
    joinClan: () => 'Únete a un clan',
    promoteClan: () => 'Sube de rango en tu clan',
    gotoFloor: (floor) => `Llega al ${_CORRIDOR_NAME[floor].es}`,
    dungeonClear: (floor) => `Llega al final del ${_CORRIDOR_NAME[floor].es}`,
  },
  tr: {
    kill: (n, enemy) => `${n} ${enemy} öldür`,
    buyPotion: (n) => `${n} iksir satın al`,
    level: (lvl) => `${lvl}. seviyeye ulaş`,
    joinClan: () => 'Bir klana katıl',
    promoteClan: () => 'Klanında rütbe atla',
    gotoFloor: (floor) => `${_CORRIDOR_NAME[floor].tr}'a ulaş`,
    dungeonClear: (floor) => `${_CORRIDOR_NAME[floor].tr}'un sonuna ulaş`,
  },
  pt: {
    kill: (n, enemy) => `Mate ${n} ${enemy}`,
    buyPotion: (n) => `Compre ${n} poções`,
    level: (lvl) => `Alcance o nível ${lvl}`,
    joinClan: () => 'Entre em um clã',
    promoteClan: () => 'Suba de patente no seu clã',
    gotoFloor: (floor) => `Chegue ao ${_CORRIDOR_NAME[floor].pt}`,
    dungeonClear: (floor) => `Chegue ao fim do ${_CORRIDOR_NAME[floor].pt}`,
  },
};
function _questDescFor(q, lang) {
  const tpl = I18N_QUEST_TPL[lang];
  if (!tpl) return q._i18nOrigDesc || q.desc;
  switch (q.type) {
    case 'kill': {
      const enemyRu = (q.enemies && q.enemies[0]) || '';
      return tpl.kill(q.count, _tEnemyBaseName(enemyRu, lang));
    }
    case 'buy_potion': return tpl.buyPotion(q.count);
    case 'level': return tpl.level(q.level);
    case 'join_guild': return (q._i18nOrigDesc || q.desc).indexOf('Вступи') === 0 ? tpl.joinClan() : tpl.promoteClan();
    case 'goto_floor': return tpl.gotoFloor(q.targetFloor);
    case 'dungeon_clear': return tpl.dungeonClear(q.floor);
    default: return q._i18nOrigDesc || q.desc;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Snapshot + apply
// ═══════════════════════════════════════════════════════════════════════
let _i18nSnapshotDone = false;
function _i18nSnapshot() {
  if (_i18nSnapshotDone) return;
  _i18nSnapshotDone = true;
  if (typeof ITEM_DEF !== 'undefined') ITEM_DEF.forEach(d => { d._i18nOrigName = d.name; });
  if (typeof CRAFT_MATS !== 'undefined') CRAFT_MATS.forEach(d => { d._i18nOrigName = d.name; });
  if (typeof BOX_DEF !== 'undefined') BOX_DEF.forEach(d => { d._i18nOrigName = d.name; });
  if (typeof ENEMY_DEF !== 'undefined') ENEMY_DEF.forEach(d => { d._i18nOrigName = d.name; });
  if (typeof QUEST_DEF !== 'undefined') QUEST_DEF.forEach(q => {
    q._i18nOrigTitle = q.title;
    q._i18nOrigDesc = q.desc;
    if (q.enemies) q._i18nOrigEnemies = [...q.enemies];
  });
  if (typeof CHAR_DEF !== 'undefined') Object.keys(CHAR_DEF).forEach(k => { CHAR_DEF[k]._i18nOrigName = CHAR_DEF[k].name; });
  if (typeof SKILL_DEF !== 'undefined') Object.keys(SKILL_DEF).forEach(cls => {
    SKILL_DEF[cls].forEach(s => { s._i18nOrigName = s.name; s._i18nOrigDesc = s.desc; });
  });
  if (typeof PASSIVE_CLASS_DEF !== 'undefined') Object.keys(PASSIVE_CLASS_DEF).forEach(cls => {
    PASSIVE_CLASS_DEF[cls].forEach(p => { p._i18nOrigName = p.name; p._i18nOrigDesc = p.desc; });
  });
  if (typeof PASSIVE_COMMON_DEF !== 'undefined') PASSIVE_COMMON_DEF.forEach(p => { p._i18nOrigName = p.name; p._i18nOrigDesc = p.desc; });
  if (typeof NPC_DEF !== 'undefined') NPC_DEF.forEach(n => { n._i18nOrigName = n.name; n._i18nOrigDesc = n.desc; });
  if (typeof MERCHANT_SHOP !== 'undefined') MERCHANT_SHOP.forEach(m => { m._i18nOrigName = m.name; });
  if (typeof EQ_SLOTS !== 'undefined') EQ_SLOTS.forEach(s => { s._i18nOrigLabel = s.label; });
  if (typeof UPGRADE_DEF !== 'undefined') Object.keys(UPGRADE_DEF).forEach(k => {
    UPGRADE_DEF[k]._i18nOrigLabel = UPGRADE_DEF[k].label; UPGRADE_DEF[k]._i18nOrigDesc = UPGRADE_DEF[k].desc;
  });
  if (typeof CLAN_LEVELS !== 'undefined') CLAN_LEVELS.forEach(l => { l._i18nOrigLabel = l.label; });
  if (typeof _RARITY_NAMES !== 'undefined') { window._i18nOrigRarityNames = { ..._RARITY_NAMES }; }
  if (typeof _SLOT_NAMES !== 'undefined') { window._i18nOrigSlotNames = { ..._SLOT_NAMES }; }
}

// Rewrites every data array's display fields in place for `lang` — every
// existing `.find(...).name`-style lookup across the whole app then just
// shows the right language automatically. Always derives from the pristine
// RU snapshot (_i18nSnapshot), never from whatever the fields currently
// hold, so switching languages back and forth is always correct.
function applyLocale(lang) {
  _i18nSnapshot();
  currentLang = lang;
  const isRu = lang === 'ru';
  const pick = (dict, key, fallback) => (!isRu && dict[key] && dict[key][lang]) || fallback;
  const pickField = (dict, key, field, fallback) => (!isRu && dict[key] && dict[key][field] && dict[key][field][lang]) || fallback;

  if (typeof ITEM_DEF !== 'undefined') ITEM_DEF.forEach(d => { d.name = pick(I18N_ITEMS, d.id, d._i18nOrigName); });
  if (typeof CRAFT_MATS !== 'undefined') CRAFT_MATS.forEach(d => { d.name = pick(I18N_MATS, d.id, d._i18nOrigName); });
  if (typeof BOX_DEF !== 'undefined') BOX_DEF.forEach(d => { d.name = pick(I18N_BOXES, d.id, d._i18nOrigName); });
  if (typeof ENEMY_DEF !== 'undefined') ENEMY_DEF.forEach(d => { d.name = pick(I18N_ENEMIES, d.eid, d._i18nOrigName); });

  if (typeof QUEST_DEF !== 'undefined') QUEST_DEF.forEach(q => {
    q.title = pick(I18N_QUEST_TITLES, q.id, q._i18nOrigTitle);
    q.desc = isRu ? q._i18nOrigDesc : _questDescFor({ ...q, desc: q._i18nOrigDesc, enemies: q._i18nOrigEnemies || q.enemies }, lang);
    if (q._i18nOrigEnemies) {
      q.enemies = isRu ? [...q._i18nOrigEnemies] : q._i18nOrigEnemies.map(e => _tEnemyBaseName(e, lang));
    }
  });

  if (typeof CHAR_DEF !== 'undefined') Object.keys(CHAR_DEF).forEach(k => { CHAR_DEF[k].name = pick(I18N_CLASSES, k, CHAR_DEF[k]._i18nOrigName); });

  if (typeof SKILL_DEF !== 'undefined') Object.keys(SKILL_DEF).forEach(cls => {
    SKILL_DEF[cls].forEach(s => {
      const src = I18N_SKILLS[cls] && I18N_SKILLS[cls][s.key];
      s.name = pickField({ x: src }, 'x', 'name', s._i18nOrigName);
      s.desc = pickField({ x: src }, 'x', 'desc', s._i18nOrigDesc);
    });
  });

  if (typeof PASSIVE_CLASS_DEF !== 'undefined') Object.keys(PASSIVE_CLASS_DEF).forEach(cls => {
    PASSIVE_CLASS_DEF[cls].forEach(p => {
      p.name = pickField(I18N_PASSIVES, p.id, 'name', p._i18nOrigName);
      p.desc = pickField(I18N_PASSIVES, p.id, 'desc', p._i18nOrigDesc);
    });
  });
  if (typeof PASSIVE_COMMON_DEF !== 'undefined') PASSIVE_COMMON_DEF.forEach(p => {
    p.name = pickField(I18N_PASSIVES, p.id, 'name', p._i18nOrigName);
    p.desc = pickField(I18N_PASSIVES, p.id, 'desc', p._i18nOrigDesc);
  });

  if (typeof NPC_DEF !== 'undefined') NPC_DEF.forEach(n => {
    n.name = pickField(I18N_NPCS, n.id, 'name', n._i18nOrigName);
    n.desc = pickField(I18N_NPCS, n.id, 'desc', n._i18nOrigDesc);
  });
  if (typeof MERCHANT_SHOP !== 'undefined') MERCHANT_SHOP.forEach(m => { m.name = pick(I18N_ITEMS, m.itemId, m._i18nOrigName); });

  if (typeof EQ_SLOTS !== 'undefined') EQ_SLOTS.forEach(s => { s.label = pick(I18N_EQ_SLOT_LABELS, s.slot, s._i18nOrigLabel); });
  if (typeof UPGRADE_DEF !== 'undefined') Object.keys(UPGRADE_DEF).forEach(k => {
    UPGRADE_DEF[k].label = pickField(I18N_UPGRADES, k, 'label', UPGRADE_DEF[k]._i18nOrigLabel);
    UPGRADE_DEF[k].desc = pickField(I18N_UPGRADES, k, 'desc', UPGRADE_DEF[k]._i18nOrigDesc);
  });
  if (typeof CLAN_LEVELS !== 'undefined') CLAN_LEVELS.forEach(l => { l.label = pick(I18N_CLAN_LEVELS, l.lvl, l._i18nOrigLabel); });

  if (typeof _RARITY_NAMES !== 'undefined' && window._i18nOrigRarityNames) {
    Object.keys(window._i18nOrigRarityNames).forEach(k => { _RARITY_NAMES[k] = pick(I18N_RARITY, k, window._i18nOrigRarityNames[k]); });
  }
  if (typeof _SLOT_NAMES !== 'undefined' && window._i18nOrigSlotNames) {
    Object.keys(window._i18nOrigSlotNames).forEach(k => { _SLOT_NAMES[k] = pick(I18N_SLOTS, k, window._i18nOrigSlotNames[k]); });
  }

  applyDomTranslations();
  // Re-render whatever's currently visible so the switch shows up immediately.
  if (typeof updateInvUI === 'function') updateInvUI();
  if (typeof updateProfileUI === 'function') updateProfileUI();
  if (typeof updateQuestUI === 'function') updateQuestUI();
  if (typeof renderVipPanel === 'function' && typeof window._vipData !== 'undefined') { try { renderVipPanel(); } catch (_) {} }
  if (typeof _renderLangPicker === 'function') _renderLangPicker();
}

// Persisted via localStorage immediately (works even before login) and
// mirrored into the server save blob (js/network.js's _buildSaveStats/
// restoreFromSave) so it follows the account across devices too.
function setLang(code) {
  if (!I18N_LANGS.some(l => l.code === code)) return;
  applyLocale(code);
  try { localStorage.setItem('lang', code); } catch (_) {}
  if (typeof netSaveProgress === 'function') netSaveProgress();
}

function _loadSavedLang() {
  try {
    const saved = localStorage.getItem('lang');
    if (saved && I18N_LANGS.some(l => l.code === saved)) return saved;
  } catch (_) {}
  return 'ru';
}

// Called once on startup (js/network.js) before the first UI render.
function initLocale() {
  applyLocale(_loadSavedLang());
}
