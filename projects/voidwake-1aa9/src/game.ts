import { CARDS, SHIPS, NODE_NAMES, EVENTS, RELICS, SECTORS } from './content.ts'
import type { CardKey, ShipKey, NodeKind } from './content.ts'

export interface Card { uid: number; key: CardKey; rank: number }
export interface MapNode { id: string; col: number; row: number; x: number; y: number; kind: NodeKind; name: string; links: string[]; visited: boolean; cleared: boolean }
export interface Enemy { name: string; faction: string; hull: number; maxHull: number; shield: number; burn: number; vulnerable: number; power: number; pattern: Intent[] }
export interface Intent { kind: 'attack' | 'guard' | 'charge' | 'drain' | 'repair'; value: number }
export interface Battle { enemy: Enemy; turn: number; energy: number; maxEnergy: number; shield: number; evade: number; draw: Card[]; hand: Card[]; discard: Card[]; exhaust: Card[]; crewUsed: boolean; log: string[] }
export interface Reward { credits: number; cards: CardKey[]; relic?: string; boss: boolean }
export interface Stats { jumps: number; battles: number; damage: number; cardsPlayed: number; rescued: number; creditsEarned: number }
export type Upgrade = 'weapons' | 'shields' | 'reactor'
export interface Game {
  version: 1; seed: string; rng: number; serial: number; ship: ShipKey; difficulty: 'explorer' | 'captain';
  phase: 'map' | 'combat' | 'event' | 'station' | 'reward' | 'won' | 'lost'; sector: number;
  hull: number; maxHull: number; credits: number; fuel: number; reputation: number;
  deck: Card[]; relics: string[]; upgrades: Record<Upgrade, number>; nodes: MapNode[]; current: string;
  battle: Battle | null; reward: Reward | null; event: number; shop: CardKey[]; bought: string[];
  stats: Stats; journal: { text: string; day: number; tone: string }[]; notice: string;
}
export type Action = { type: 'jump'; id: string } | { type: 'play'; index: number } | { type: 'endTurn' } | { type: 'crew'; id: string } | { type: 'choice'; index: number } | { type: 'claim'; key: CardKey | null } | { type: 'buy'; item: string } | { type: 'leave' } | { type: 'sos' } | { type: 'upgradeCard'; uid: number } | { type: 'removeCard'; uid: number }
const hash = (text: string) => [...text].reduce((n, c) => Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261)
function random(g: Game) { g.rng = (Math.imul(g.rng, 1664525) + 1013904223) >>> 0; return g.rng / 4294967296 }
function pick<T>(g: Game, items: readonly T[]): T { return items[Math.floor(random(g) * items.length)] }
function shuffle<T>(g: Game, items: T[]): T[] { const out = [...items]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random(g) * (i + 1)); [out[i], out[j]] = [out[j], out[i]] } return out }
function log(g: Game, text: string, tone = 'info') { g.journal.unshift({ text, day: g.stats.jumps + 1, tone }); g.journal = g.journal.slice(0, 80); g.notice = text }
function card(g: Game, key: CardKey): Card { return { uid: ++g.serial, key, rank: 0 } }
function heal(g: Game, amount: number) { g.hull = Math.min(g.maxHull, g.hull + amount) }
function addRelic(g: Game, preferred?: string): string | undefined { const available = RELICS.filter(r => !g.relics.includes(r.id)); if (!available.length) { g.credits += 35; return undefined } const found = available.find(r => r.id === preferred) ?? pick(g, available); g.relics.push(found.id); return found.id }
export function jumpCost(g: Game) { return g.relics.includes('compass') && (g.stats.jumps + 1) % 3 === 0 ? 0 : 1 }
export function reachable(g: Game) { return g.nodes.find(n => n.id === g.current)?.links ?? [] }
export function currentIntent(g: Game): Intent | null { const b = g.battle; if (!b) return null; const intent = b.enemy.pattern[(b.turn - 1) % b.enemy.pattern.length]; return { ...intent, value: intent.value + (intent.kind === 'attack' || intent.kind === 'drain' ? b.enemy.power : 0) } }
export function passiveShield(g: Game) { return SHIPS[g.ship].shield + g.upgrades.shields * 3 + (g.relics.includes('plating') ? 4 : 0) }
export function weaponBonus(g: Game) { return SHIPS[g.ship].weapon + g.upgrades.weapons * 2 + (g.relics.includes('lens') ? 2 : 0) }
export function upgradeCost(g: Game, upgrade: Upgrade) { return 45 + g.upgrades[upgrade] * 35 }
export function generateMap(g: Game): MapNode[] {
  const nodes: MapNode[] = [{ id: 'start', col: 0, row: 1, x: 7, y: 50, kind: 'start', name: 'Arrival beacon', links: [], visited: true, cleared: true }]
  const pool: NodeKind[] = ['battle', 'battle', 'salvage', 'event', 'event', 'station', 'elite', 'relay']
  for (let col = 1; col <= 5; col++) for (let row = 0; row < 3; row++) {
    let kind = pick(g, pool)
    if (col === 1) kind = (['salvage', 'battle', 'event'] as const)[row]
    if (col === 3 && row === 1) kind = 'station'
    if (col === 4 && row === 0) kind = 'relay'
    nodes.push({ id: `${col}-${row}`, col, row, x: 7 + col * 14, y: 23 + row * 27 + (random(g) - 0.5) * 12, kind, name: NODE_NAMES[g.sector][(col - 1) * 3 + row], links: [], visited: false, cleared: false })
  }
  nodes.push({ id: 'boss', col: 6, row: 1, x: 93, y: 50, kind: 'boss', name: SECTORS[g.sector].boss, links: [], visited: false, cleared: false })
  for (const node of nodes) node.links = nodes.filter(next => next.col === node.col + 1 && (node.col === 0 || next.kind === 'boss' || Math.abs(next.row - node.row) <= 1)).map(next => next.id)
  return nodes
}
export function newGame(seed = 'ORPHEUS', ship: ShipKey = 'wayfarer', difficulty: Game['difficulty'] = 'explorer'): Game {
  seed = seed.trim().slice(0, 24).toUpperCase() || 'ORPHEUS'
  const g: Game = { version: 1, seed: seed.trim().slice(0, 24).toUpperCase() || 'ORPHEUS', rng: hash(seed || 'ORPHEUS'), serial: 0, ship, difficulty, phase: 'map', sector: 0, hull: SHIPS[ship].hull, maxHull: SHIPS[ship].hull, credits: 90, fuel: 10, reputation: 0, deck: [], relics: [], upgrades: { weapons: 0, shields: 0, reactor: 0 }, nodes: [], current: 'start', battle: null, reward: null, event: 0, shop: [], bought: [], stats: { jumps: 0, battles: 0, damage: 0, cardsPlayed: 0, rescued: 0, creditsEarned: 0 }, journal: [], notice: '' }
  const starter: CardKey[] = ['pulse', 'pulse', 'pulse', 'pulse', 'barrier', 'barrier', 'barrier', 'torpedo', 'scan', ship === 'kestrel' ? 'railgun' : 'repair', ship === 'bulwark' ? 'fortify' : 'drone']
  g.deck = starter.map(key => card(g, key)); g.nodes = generateMap(g)
  log(g, 'A signal from beyond the Meridian. Three sectors. One way forward.'); return g
}
function draw(g: Game, amount: number) { const b = g.battle!; for (let i = 0; i < amount && b.hand.length < 10; i++) { if (!b.draw.length) { b.draw = shuffle(g, b.discard); b.discard = [] } const c = b.draw.pop(); if (c) b.hand.push(c) } }
function combatLog(g: Game, text: string) { const b = g.battle!; b.log.unshift(text); b.log = b.log.slice(0, 16) }
function hitEnemy(g: Game, amount: number, piercing = false, weapon = true) {
  const b = g.battle!; const e = b.enemy
  let damage = amount + (weapon ? weaponBonus(g) : 0)
  if (e.vulnerable > 0) damage = Math.floor(damage * 1.5)
  const absorbed = piercing ? 0 : Math.min(e.shield, damage); e.shield -= absorbed; damage -= absorbed
  const actual = Math.min(e.hull, damage); e.hull = Math.max(0, e.hull - damage); g.stats.damage += actual
  combatLog(g, `${e.name} takes ${damage} damage${absorbed ? ` (${absorbed} shielded)` : ''}.`)
}
function hitPlayer(g: Game, amount: number) {
  const b = g.battle!
  if (b.evade > 0) { b.evade--; combatLog(g, 'Ghost maneuver: incoming attack evaded.'); return }
  const absorbed = Math.min(b.shield, amount); b.shield -= absorbed; g.hull = Math.max(0, g.hull - (amount - absorbed)); combatLog(g, `Incoming ${amount} damage. ${absorbed} absorbed by shields.`)
}
function makeEnemy(g: Game, kind: NodeKind): Enemy {
  const elite = kind === 'elite', boss = kind === 'boss'; const scale = g.difficulty === 'explorer' ? 0.85 : 1
  const names = ['Revenant skirmisher', 'Carrion drone', 'Hollow corsair', 'Echo interceptor']
  const hp = Math.round(((boss ? 85 : elite ? 65 : 39) + g.sector * (boss ? 30 : 15)) * scale)
  const damage = Math.round(((boss ? 16 : elite ? 13 : 10) + g.sector * 4) * scale)
  const name = boss ? SECTORS[g.sector].boss : elite ? ['Revenant warden', 'Glass executioner', 'Meridian hunter'][g.sector] : pick(g, names)
  const pattern: Intent[] = boss ? [{ kind: 'attack', value: damage }, { kind: 'guard', value: 12 + g.sector * 4 }, { kind: 'attack', value: damage + 6 }, { kind: 'charge', value: 3 }, { kind: 'drain', value: damage + 3 }] : pick(g, [
    [{ kind: 'attack', value: damage }, { kind: 'guard', value: 9 }, { kind: 'attack', value: damage + 5 }],
    [{ kind: 'guard', value: 7 }, { kind: 'attack', value: damage + 3 }, { kind: 'charge', value: 2 }, { kind: 'attack', value: damage }],
    [{ kind: 'attack', value: damage - 2 }, { kind: 'drain', value: damage }, { kind: 'repair', value: 6 }, { kind: 'attack', value: damage + 6 }],
  ] as Intent[][])
  return { name, faction: boss ? SECTORS[g.sector].faction : elite ? 'ELITE PATROL' : 'HOSTILE CONTACT', hull: hp, maxHull: hp, shield: elite || boss ? 6 : 0, burn: 0, vulnerable: 0, power: 0, pattern }
}
function startBattle(g: Game, kind: NodeKind) {
  const energy = 3 + g.upgrades.reactor
  g.battle = { enemy: makeEnemy(g, kind), turn: 1, energy: energy + (g.relics.includes('capacitor') ? 1 : 0), maxEnergy: energy, shield: passiveShield(g), evade: 0, draw: shuffle(g, g.deck), hand: [], discard: [], exhaust: [], crewUsed: false, log: ['Weapons online. The crew awaits your orders.'] }
  g.phase = 'combat'; draw(g, g.relics.includes('antenna') ? 6 : 5); log(g, `${g.battle.enemy.name} intercepts your course.`, 'danger')
}
function lose(g: Game) { g.hull = 0; g.phase = 'lost'; log(g, 'The last light on the bridge goes dark.', 'danger') }
function victory(g: Game) {
  const node = g.nodes.find(n => n.id === g.current)!
  node.cleared = true; g.stats.battles++; const credits = (node.kind === 'boss' ? 60 : node.kind === 'elite' ? 45 : 25) + g.sector * 10
  g.credits += credits; g.stats.creditsEarned += credits
  if (g.relics.includes('nanites')) heal(g, 6)
  if (g.difficulty === 'explorer') heal(g, 3)
  const keys = Object.keys(CARDS) as CardKey[]
  const offers = shuffle(g, keys.filter(k => !['pulse', 'barrier', 'repair'].includes(k))).slice(0, 3)
  const relic = node.kind === 'boss' || node.kind === 'elite' ? addRelic(g) : undefined
  g.reward = { credits, cards: offers, relic, boss: node.kind === 'boss' }; g.phase = 'reward'; log(g, `${g.battle!.enemy.name} neutralized. Recovered ${credits} credits.`, 'success')
}
function checkBattle(g: Game) { if (g.hull <= 0) lose(g); else if (g.battle!.enemy.hull <= 0) victory(g) }
function playCard(g: Game, index: number) {
  const b = g.battle!, c = b.hand[index]; if (!c || CARDS[c.key].cost > b.energy) return
  b.hand.splice(index, 1); b.energy -= CARDS[c.key].cost; const up = c.rank > 0
  g.stats.cardsPlayed++; combatLog(g, `${CARDS[c.key].name}${up ? '+' : ''} activated.`)
  const hit = (n: number) => hitEnemy(g, n)
  switch (c.key) {
    case 'pulse': hit(up ? 12 : 8); break
    case 'barrier': b.shield += up ? 15 : 10; break
    case 'torpedo': hitEnemy(g, up ? 27 : 19, true); break
    case 'scan': draw(g, up ? 3 : 2); break
    case 'repair': heal(g, up ? 9 : 5); break
    case 'railgun': hit(up ? 16 : 11); b.enemy.vulnerable += up ? 3 : 2; break
    case 'overclock': b.energy += 2; if (!up) g.hull = Math.max(0, g.hull - 3); break
    case 'broadside': hit(up ? 13 : 9); hit(up ? 13 : 9); break
    case 'drone': b.shield += up ? 11 : 7; hit(up ? 8 : 5); break
    case 'cloak': b.evade += up ? 2 : 1; draw(g, 1); break
    case 'siphon': hit(up ? 11 : 7); heal(g, up ? 5 : 3); break
    case 'flare': b.enemy.burn += up ? 10 : 6; break
    case 'barrage': for (let i = 0; i < 4; i++) hit(up ? 11 : 8); break
    case 'fortify': b.shield += up ? 34 : 24; break
    case 'salvo': hit(up ? 9 : 5); break
    case 'vent': b.shield += up ? 10 : 6; draw(g, up ? 3 : 2); break
    case 'lance': hit((up ? 22 : 16) + b.hand.filter(c => CARDS[c.key].type === 'weapon').length * (up ? 6 : 4)); break
    case 'echo': b.energy += up ? 2 : 1; draw(g, up ? 4 : 3); break
  }
  if (['scan', 'repair', 'overclock', 'salvo', 'echo'].includes(c.key)) b.exhaust.push(c); else b.discard.push(c)
  checkBattle(g)
}
function endTurn(g: Game) {
  const b = g.battle!, e = b.enemy, intent = currentIntent(g)!
  if (e.burn) { const damage = Math.min(e.hull, e.burn); e.hull -= damage; g.stats.damage += damage; combatLog(g, `Solar burn deals ${damage} hull damage.`); e.burn = Math.max(0, e.burn - 2) }
  if (e.hull <= 0) { victory(g); return }
  switch (intent.kind) {
    case 'attack': hitPlayer(g, intent.value); break
    case 'guard': e.shield += intent.value; combatLog(g, `Enemy reinforces ${intent.value} shield.`); break
    case 'charge': e.power += intent.value; combatLog(g, `Enemy weapons gain ${intent.value} power.`); break
    case 'drain': hitPlayer(g, intent.value); e.shield += 4; break
    case 'repair': e.hull = Math.min(e.maxHull, e.hull + intent.value); combatLog(g, `Enemy repairs ${intent.value} hull.`); break
  }
  if (g.hull <= 0) { lose(g); return }
  e.vulnerable = Math.max(0, e.vulnerable - 1); b.turn++; b.energy = b.maxEnergy; b.shield = passiveShield(g)
  b.discard.push(...b.hand); b.hand = []; draw(g, g.relics.includes('antenna') ? 6 : 5)
}
export function choiceAvailable(g: Game, index: number) { const c = EVENTS[g.event]?.choices[index]; return !!c && g.credits + (c.credits ?? 0) >= 0 && g.fuel + (c.fuel ?? 0) >= 0 && g.hull + (c.hull ?? 0) > 0 }
export function reducer(state: Game, action: Action): Game {
  const g = structuredClone(state)
  if (g.phase === 'won' || g.phase === 'lost') return state
  if (action.type === 'jump' && g.phase === 'map') {
    const node = g.nodes.find(n => n.id === action.id); if (!node || !reachable(g).includes(node.id) || g.fuel < jumpCost(g)) return state
    g.fuel -= jumpCost(g); g.stats.jumps++; g.current = node.id; node.visited = true
    if (['battle', 'elite', 'boss'].includes(node.kind)) startBattle(g, node.kind)
    else if (node.kind === 'station') { g.phase = 'station'; g.shop = shuffle(g, (Object.keys(CARDS) as CardKey[]).filter(k => CARDS[k].rarity !== 'standard')).slice(0, 4); g.bought = []; node.cleared = true; log(g, `Docked at ${node.name}. The air tastes almost like home.`) }
    else if (node.kind === 'event') { g.phase = 'event'; g.event = Math.floor(random(g) * EVENTS.length); log(g, `An unfamiliar transmission from ${node.name}.`) }
    else if (node.kind === 'relay') { const relic = addRelic(g); node.cleared = true; heal(g, 5); log(g, `Relay synchronized. ${relic ? `Recovered ${RELICS.find(r => r.id === relic)!.name}.` : 'Recovered 35 credits.'} Restored 5 hull.`, 'success') }
    else { const credits = 22 + Math.floor(random(g) * 19); g.credits += credits; g.stats.creditsEarned += credits; g.fuel += 2; heal(g, 4); node.cleared = true; log(g, `Salvaged ${credits} credits and 2 fuel. Restored 4 hull.`, 'success') }
  } else if (action.type === 'play' && g.phase === 'combat') playCard(g, action.index)
  else if (action.type === 'endTurn' && g.phase === 'combat') endTurn(g)
  else if (action.type === 'crew' && g.phase === 'combat') {
    if (g.battle!.crewUsed || !['mara', 'ada', 'ren'].includes(action.id)) return state
    g.battle!.crewUsed = true
    if (action.id === 'mara') { g.battle!.evade++; combatLog(g, 'Mara: ghost maneuver ready. Next attack will miss.') }
    if (action.id === 'ada') { heal(g, 10); combatLog(g, 'Ada-9: emergency weld restores 10 hull.') }
    if (action.id === 'ren') hitEnemy(g, 15, true, false)
    checkBattle(g)
  } else if (action.type === 'choice' && g.phase === 'event') {
    if (!choiceAvailable(g, action.index)) return state
    const c = EVENTS[g.event].choices[action.index]; g.credits += c.credits ?? 0; g.fuel += c.fuel ?? 0; g.maxHull += c.maxHull ?? 0; heal(g, c.hull ?? 0); g.reputation += c.reputation ?? 0
    if (c.relic) addRelic(g, g.event === 0 ? 'antenna' : undefined)
    if (c.card) g.deck.push(card(g, c.card))
    if ((c.reputation ?? 0) > 0) g.stats.rescued++
    g.nodes.find(n => n.id === g.current)!.cleared = true; g.phase = 'map'; log(g, `${EVENTS[g.event].title}: ${c.title}. ${c.text}`, 'success')
  } else if (action.type === 'claim' && g.phase === 'reward') {
    if (action.key && !g.reward!.cards.includes(action.key)) return state
    if (action.key) { g.deck.push(card(g, action.key)); log(g, `${CARDS[action.key].name} installed in your combat deck.`, 'success') }
    const boss = g.reward!.boss; g.reward = null; g.battle = null
    if (boss && g.sector === 2) { g.phase = 'won'; log(g, 'The signal was never a distress call. It was an invitation. You answer.', 'success') }
    else if (boss) { g.sector++; g.nodes = generateMap(g); g.current = 'start'; g.fuel += 6; heal(g, 25); g.phase = 'map'; log(g, `Entered ${SECTORS[g.sector].name}. Gate transit restores 25 hull and 6 fuel.`, 'success') }
    else g.phase = 'map'
  } else if (action.type === 'buy' && g.phase === 'station') {
    if (action.item === 'repair' && g.credits >= 20 && g.hull < g.maxHull) { g.credits -= 20; heal(g, 30); log(g, 'Repair crew restored 30 hull.', 'success') }
    else if (action.item === 'fuel' && g.credits >= 15) { g.credits -= 15; g.fuel += 3; log(g, 'Loaded 3 fuel cells.', 'success') }
    else if (['weapons', 'shields', 'reactor'].includes(action.item)) {
      const u = action.item as Upgrade, cost = upgradeCost(g, u), limit = u === 'reactor' ? 2 : 3
      if (g.credits < cost || g.upgrades[u] >= limit) return state
      g.credits -= cost; g.upgrades[u]++; log(g, `${u[0].toUpperCase() + u.slice(1)} upgraded to level ${g.upgrades[u]}.`, 'success')
    } else if (g.shop.includes(action.item as CardKey) && !g.bought.includes(action.item)) {
      const key = action.item as CardKey, cost = CARDS[key].rarity === 'rare' ? 50 : 30
      if (g.credits < cost) return state
      g.credits -= cost; g.deck.push(card(g, key)); g.bought.push(key); log(g, `${CARDS[key].name} acquired.`, 'success')
    } else return state
  } else if (action.type === 'upgradeCard' && g.phase === 'station') {
    const c = g.deck.find(c => c.uid === action.uid); if (!c || c.rank || g.credits < 25) return state
    g.credits -= 25; c.rank = 1; log(g, `${CARDS[c.key].name} enhanced.`, 'success')
  } else if (action.type === 'removeCard' && g.phase === 'station') {
    if (g.credits < 20 || g.deck.length <= 5 || !g.deck.some(c => c.uid === action.uid)) return state
    g.credits -= 20; g.deck = g.deck.filter(c => c.uid !== action.uid); log(g, 'Combat system decommissioned. A leaner deck cycles faster.')
  } else if (action.type === 'leave' && g.phase === 'station') { g.phase = 'map'; log(g, 'Undocked. The stars are waiting.') }
  else if (action.type === 'sos' && g.phase === 'map' && g.fuel === 0) {
    g.fuel = 2
    if (g.credits >= 25) { g.credits -= 25; log(g, 'A passing hauler sells you 2 emergency fuel cells for 25 credits.') }
    else { g.hull = Math.max(1, g.hull - 12); log(g, 'Converted hull plating into 2 emergency fuel cells. Lost up to 12 hull.', 'danger') }
  } else return state
  return g
}

export function score(g: Game) { return g.stats.battles * 100 + g.sector * 250 + g.relics.length * 80 + g.stats.jumps * 25 + Math.max(0, g.reputation) * 40 + (g.phase === 'won' ? 1000 + g.hull * 5 : 0) }
export function achievements(g: Game) { return [
  { name: 'First contact', text: 'Win your first battle', done: g.stats.battles > 0, icon: 'crosshair' },
  { name: 'Collector of echoes', text: 'Recover 3 artifacts', done: g.relics.length >= 3, icon: 'orbit' },
  { name: 'A little humanity', text: 'Earn 5 crew trust', done: g.reputation >= 5, icon: 'heart' },
  { name: 'Beyond the Reach', text: 'Reach the second sector', done: g.sector >= 1, icon: 'map' },
  { name: 'Weapons hot', text: 'Deal 500 total damage', done: g.stats.damage >= 500, icon: 'bolt' },
  { name: 'The last signal', text: 'Complete the voyage', done: g.phase === 'won', icon: 'signal' },
] }

// Saves are checked before use; a malformed or future-version save starts a fresh voyage.
export function parseSave(raw: string | null): Game | null {
  try {
    if (!raw || raw.length > 200_000) return null
    const g = JSON.parse(raw) as Game
    const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    const validCard = (c: Card) => c && Object.hasOwn(CARDS, c.key) && finite(c.uid) && [0, 1].includes(c.rank)
    if (g.version !== 1 || !Object.hasOwn(SHIPS, g.ship) || !['explorer', 'captain'].includes(g.difficulty) || !['map', 'combat', 'event', 'station', 'reward', 'won', 'lost'].includes(g.phase)) return null
    if (!Number.isInteger(g.sector) || g.sector < 0 || g.sector > 2 || !finite(g.hull) || !finite(g.maxHull) || g.maxHull < 1 || g.hull > g.maxHull || !finite(g.fuel) || !finite(g.credits) || !finite(g.rng) || !finite(g.serial) || typeof g.seed !== 'string') return null
    if (!Array.isArray(g.deck) || g.deck.length < 5 || !g.deck.every(validCard) || !Array.isArray(g.nodes) || g.nodes.length !== 17 || !g.nodes.some(n => n.id === g.current)) return null
    if (!g.nodes.every(n => n && typeof n.id === 'string' && typeof n.name === 'string' && finite(n.x) && finite(n.y) && finite(n.col) && finite(n.row) && ['start','battle','elite','salvage','event','station','relay','boss'].includes(n.kind) && Array.isArray(n.links) && n.links.every(id => g.nodes.some(other => other.id === id)))) return null
    if (!Array.isArray(g.relics) || !g.relics.every(id => RELICS.some(r => r.id === id)) || !g.upgrades || !['weapons','shields','reactor'].every(k => finite(g.upgrades[k as Upgrade])) || !Number.isFinite(g.reputation)) return null
    if (!g.stats || !['jumps','battles','damage','cardsPlayed','rescued','creditsEarned'].every(k => finite(g.stats[k as keyof Stats])) || !Array.isArray(g.journal) || !g.journal.every(e => typeof e.text === 'string' && finite(e.day) && typeof e.tone === 'string') || typeof g.notice !== 'string') return null
    if (!Array.isArray(g.shop) || !g.shop.every(k => Object.hasOwn(CARDS, k)) || !Array.isArray(g.bought) || !g.bought.every(k => typeof k === 'string') || !Number.isInteger(g.event) || !EVENTS[g.event]) return null
    if (g.phase === 'combat' || g.phase === 'reward') {
      const b = g.battle
      if (!b || !finite(b.turn) || b.turn < 1 || !finite(b.energy) || !finite(b.maxEnergy) || !finite(b.shield) || !finite(b.evade) || ![b.draw,b.hand,b.discard,b.exhaust].every(a => Array.isArray(a) && a.every(validCard)) || !Array.isArray(b.log) || !b.log.every(s => typeof s === 'string')) return null
      const e = b.enemy
      if (!e || typeof e.name !== 'string' || typeof e.faction !== 'string' || !['hull','maxHull','shield','burn','vulnerable','power'].every(k => finite(e[k as keyof Enemy])) || !Array.isArray(e.pattern) || !e.pattern.length || !e.pattern.every(i => ['attack','guard','charge','drain','repair'].includes(i.kind) && finite(i.value))) return null
    }
    if (g.phase === 'reward' && (!g.reward || !Array.isArray(g.reward.cards) || !g.reward.cards.every(k => Object.hasOwn(CARDS, k)) || !finite(g.reward.credits) || (g.reward.relic !== undefined && !RELICS.some(r => r.id === g.reward!.relic)))) return null
    return g
  } catch { return null }
}
