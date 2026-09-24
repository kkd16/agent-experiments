export type CardKey = 'pulse' | 'barrier' | 'torpedo' | 'scan' | 'repair' | 'railgun' | 'overclock' | 'broadside' | 'drone' | 'cloak' | 'siphon' | 'flare' | 'barrage' | 'fortify' | 'salvo' | 'vent' | 'lance' | 'echo'
export type CardType = 'weapon' | 'defense' | 'system'
export interface CardDefinition { name: string; type: CardType; cost: number; text: string; enhanced: string; rarity: 'standard' | 'uncommon' | 'rare'; icon: string }
export const CARDS: Record<CardKey, CardDefinition> = {
  pulse: { name: 'Pulse cannon', type: 'weapon', cost: 1, text: 'Deal 8 damage.', enhanced: 'Deal 12 damage.', rarity: 'standard', icon: 'crosshair' },
  barrier: { name: 'Deflector', type: 'defense', cost: 1, text: 'Gain 10 shield.', enhanced: 'Gain 15 shield.', rarity: 'standard', icon: 'shield' },
  torpedo: { name: 'Void torpedo', type: 'weapon', cost: 2, text: 'Deal 19 damage. Ignores shields.', enhanced: 'Deal 27 damage. Ignores shields.', rarity: 'uncommon', icon: 'rocket' },
  scan: { name: 'Deep scan', type: 'system', cost: 0, text: 'Draw 2 cards. Exhaust.', enhanced: 'Draw 3 cards. Exhaust.', rarity: 'standard', icon: 'radar' },
  repair: { name: 'Field repair', type: 'system', cost: 1, text: 'Restore 5 hull. Exhaust.', enhanced: 'Restore 9 hull. Exhaust.', rarity: 'standard', icon: 'wrench' },
  railgun: { name: 'Rail driver', type: 'weapon', cost: 1, text: 'Deal 11 damage. Apply 2 vulnerable.', enhanced: 'Deal 16 damage. Apply 3 vulnerable.', rarity: 'uncommon', icon: 'crosshair' },
  overclock: { name: 'Overclock', type: 'system', cost: 0, text: 'Gain 2 energy. Lose 3 hull. Exhaust.', enhanced: 'Gain 2 energy. Exhaust.', rarity: 'uncommon', icon: 'bolt' },
  broadside: { name: 'Broadside', type: 'weapon', cost: 2, text: 'Deal 9 damage twice.', enhanced: 'Deal 13 damage twice.', rarity: 'uncommon', icon: 'target' },
  drone: { name: 'Defense drone', type: 'defense', cost: 1, text: 'Gain 7 shield. Deal 5 damage.', enhanced: 'Gain 11 shield. Deal 8 damage.', rarity: 'standard', icon: 'hex' },
  cloak: { name: 'Phase cloak', type: 'defense', cost: 2, text: 'Evade the next attack. Draw 1 card.', enhanced: 'Evade the next 2 attacks. Draw 1 card.', rarity: 'rare', icon: 'eye' },
  siphon: { name: 'Flux siphon', type: 'weapon', cost: 1, text: 'Deal 7 damage. Restore 3 hull.', enhanced: 'Deal 11 damage. Restore 5 hull.', rarity: 'uncommon', icon: 'orbit' },
  flare: { name: 'Solar flare', type: 'weapon', cost: 1, text: 'Apply 6 burn. Burn deals hull damage each turn.', enhanced: 'Apply 10 burn. Burn deals hull damage each turn.', rarity: 'uncommon', icon: 'sun' },
  barrage: { name: 'Meteor swarm', type: 'weapon', cost: 3, text: 'Deal 8 damage four times.', enhanced: 'Deal 11 damage four times.', rarity: 'rare', icon: 'target' },
  fortify: { name: 'Bastion field', type: 'defense', cost: 2, text: 'Gain 24 shield.', enhanced: 'Gain 34 shield.', rarity: 'uncommon', icon: 'shield' },
  salvo: { name: 'Quickshot', type: 'weapon', cost: 0, text: 'Deal 5 damage. Exhaust.', enhanced: 'Deal 9 damage. Exhaust.', rarity: 'standard', icon: 'bolt' },
  vent: { name: 'Capacitor', type: 'system', cost: 1, text: 'Gain 6 shield. Draw 2 cards.', enhanced: 'Gain 10 shield. Draw 3 cards.', rarity: 'uncommon', icon: 'layers' },
  lance: { name: 'Singularity lance', type: 'weapon', cost: 2, text: 'Deal 16 damage. +4 for each other weapon in hand.', enhanced: 'Deal 22 damage. +6 for each other weapon in hand.', rarity: 'rare', icon: 'rocket' },
  echo: { name: 'Echo reactor', type: 'system', cost: 1, text: 'Gain 1 energy and draw 3 cards. Exhaust.', enhanced: 'Gain 2 energy and draw 4 cards. Exhaust.', rarity: 'rare', icon: 'orbit' },
}

export type ShipKey = 'wayfarer' | 'kestrel' | 'bulwark'
export const SHIPS: Record<ShipKey, { name: string; class: string; hull: number; shield: number; weapon: number; description: string; color: string }> = {
  wayfarer: { name: 'The Wayfarer', class: 'EXPLORATION FRIGATE', hull: 90, shield: 4, weapon: 0, description: 'A dependable long-range vessel. Balanced defenses, a repair bay, and room for one more impossible journey.', color: '#8bc6c5' },
  kestrel: { name: 'The Kestrel', class: 'STRIKE CORVETTE', hull: 70, shield: 2, weapon: 2, description: 'Light armor. Heavy guns. Every weapon deals 2 extra damage, and a rail driver replaces your repair kit.', color: '#f0ac73' },
  bulwark: { name: 'The Bulwark', class: 'ESCORT CRUISER', hull: 115, shield: 7, weapon: 0, description: 'Built to outlast the dark. Reinforced hull, 7 passive shield, and a bastion field in the starting deck.', color: '#b8a6d9' },
}
export type NodeKind = 'start' | 'battle' | 'elite' | 'salvage' | 'event' | 'station' | 'relay' | 'boss'
export const NODE_INFO: Record<NodeKind, { label: string; icon: string; color: string; description: string }> = {
  start: { label: 'Arrival point', icon: 'ship', color: '#8bc6c5', description: 'The last familiar light is already behind you. Set a course, Captain.' },
  battle: { label: 'Hostile contact', icon: 'crosshair', color: '#da8d7f', description: 'An armed vessel is tracking your signature. Prepare your combat systems.' },
  elite: { label: 'Elite patrol', icon: 'target', color: '#e09a60', description: 'A dangerous adversary guards valuable technology. High risk, exceptional salvage.' },
  salvage: { label: 'Salvage field', icon: 'layers', color: '#94b4a4', description: 'A silent graveyard of old ships. Recover credits, fuel, and a little history.' },
  event: { label: 'Unknown signal', icon: 'signal', color: '#b0a0d5', description: 'Something is transmitting from the dark. Someone might still be listening.' },
  station: { label: 'Trading station', icon: 'hex', color: '#8ab6cf', description: 'Dock for hull repairs, fuel, new systems, and permanent ship upgrades.' },
  relay: { label: 'Ancient relay', icon: 'orbit', color: '#d5bd82', description: 'A dormant signal relay holds a fragment of the way home, and an ancient artifact.' },
  boss: { label: 'Sector guardian', icon: 'crown', color: '#f0ac73', description: 'The only passage onward is held by a powerful guardian. All routes converge here.' },
}
export const SECTORS = [
  { name: 'The Orpheus Reach', subtitle: 'Somewhere beyond the last charted star.', code: 'ORPHEUS', boss: 'The Tollkeeper', faction: 'REVENANT BLOCKADE', flavor: 'A freighter-sized hull turns across the jump gate. Its running lights spell out a single word: PAY.' },
  { name: 'The Glass Expanse', subtitle: 'Where dying stars remember their light.', code: 'GLASS', boss: 'Choir of Glass', faction: 'ECHO COLLECTIVE', flavor: 'A thousand mirrored drones speak with one voice. They have been waiting for your signal.' },
  { name: 'The Silent Meridian', subtitle: 'At the edge of everything, a voice.', code: 'MERIDIAN', boss: 'The Last Witness', faction: 'MERIDIAN SENTINEL', flavor: 'The sentinel unfolds around the origin of the signal. Behind it, a whole civilization sleeps.' },
]
export const NODE_NAMES = [
  ['Pale Anchorage', 'Cinder Drift', 'Echo Seven', 'The Rust Belt', 'Holloway Port', 'Sable Crossing', 'Lost Frequency', 'Kepler Wrecks', 'Watchpost IX', 'The Quiet Array', 'Copper Harbor', 'Widow’s Light', 'Broken Halo', 'Argent Station', 'Memory Well'],
  ['Mirror Shoals', 'Velvet Ruin', 'Lacuna Point', 'The Shatter', 'Opal Exchange', 'White Noise', 'Ghost Orchard', 'Crystal Wake', 'Grave of Suns', 'Penumbral Array', 'Prism Harbor', 'Singing Dust', 'Ivory Rift', 'Astral Bazaar', 'Vesper’s Echo'],
  ['Far Lantern', 'The Still Sea', 'Afterimage', 'Last Resupply', 'Dawnless Reach', 'Ashen Choir', 'Missing Years', 'The Long Sleep', 'Ember Watch', 'First Memory', 'Solace Port', 'The Unwritten', 'Eventide', 'Homeward Star', 'Origin Point'],
]
export const RELICS = [
  { id: 'capacitor', name: 'Precursor capacitor', icon: 'bolt', text: 'Start each combat with 1 additional energy.' },
  { id: 'nanites', name: 'Mending nanites', icon: 'wrench', text: 'Restore 6 hull after every victory.' },
  { id: 'lens', name: 'Prismatic lens', icon: 'eye', text: 'All weapons deal 2 extra damage.' },
  { id: 'plating', name: 'Memory alloy', icon: 'shield', text: 'Gain 4 additional shield every turn.' },
  { id: 'antenna', name: 'Ghost antenna', icon: 'signal', text: 'Draw 1 additional card at the start of every turn.' },
  { id: 'compass', name: 'Foldspace compass', icon: 'orbit', text: 'Every third jump costs no fuel.' },
]
export const CREW = [
  { id: 'mara', name: 'Mara Voss', role: 'PILOT', initials: 'MV', color: '#8bc6c5', ability: 'Ghost maneuver', text: 'Evade the next enemy attack.', quote: '“There is always a way through.”' },
  { id: 'ada', name: 'Ada-9', role: 'ENGINEER', initials: 'A9', color: '#b8a6d9', ability: 'Emergency weld', text: 'Restore 10 hull.', quote: '“Unlikely is not impossible.”' },
  { id: 'ren', name: 'Ren Okoro', role: 'GUNNER', initials: 'RO', color: '#f0ac73', ability: 'Precision shot', text: 'Deal 15 damage, ignoring shields.', quote: '“Give me one clean angle.”' },
]

export interface EventChoice { title: string; text: string; credits?: number; fuel?: number; hull?: number; maxHull?: number; relic?: boolean; card?: CardKey; reputation?: number }
export interface StoryEvent { title: string; eyebrow: string; text: string; choices: EventChoice[] }
export const EVENTS: StoryEvent[] = [
  { title: 'The little things', eyebrow: 'DISTRESS CALL · CIVILIAN TRANSPORT', text: 'A family of seven has been drifting for nine days. Their youngest asks over the comms whether your ship has windows. It does. They have nothing to trade but a hand-drawn star map.', choices: [
    { title: 'Share your fuel', text: 'Spend 2 fuel. Gain a Ghost Antenna and 2 trust.', fuel: -2, relic: true, reputation: 2 },
    { title: 'Patch their reactor', text: 'Spend 25 credits. Restore 8 hull and gain 2 trust.', credits: -25, hull: 8, reputation: 2 },
    { title: 'Send their coordinates', text: 'A rescue beacon is the least you can offer. Gain 1 trust.', reputation: 1 },
  ] },
  { title: 'An echo of tomorrow', eyebrow: 'TEMPORAL ANOMALY · UNREGISTERED', text: 'You intercept a message in your own voice. It lists the names of your crew, then a sequence of numbers. Ada thinks it is a blueprint. Mara thinks you should keep moving.', choices: [
    { title: 'Build the impossible', text: 'Spend 20 credits. Add Echo Reactor to your deck.', credits: -20, card: 'echo' },
    { title: 'Follow the coordinates', text: 'Lose 10 hull in the rift. Recover an artifact.', hull: -10, relic: true },
    { title: 'Erase the message', text: 'Some things can stay unwritten. Gain 20 credits.', credits: 20 },
  ] },
  { title: 'The garden in the dark', eyebrow: 'DERELICT · BIOLOGICAL SIGNATURE', text: 'Inside a fractured research station, a garden has outgrown its gravity. Silver leaves reach toward a miniature sun. A maintenance drone offers a cutting, and patiently holds out an invoice.', choices: [
    { title: 'Buy a living fragment', text: 'Spend 30 credits. Increase maximum hull by 12 and repair 12.', credits: -30, maxHull: 12, hull: 12 },
    { title: 'Harvest the power cells', text: 'Gain 3 fuel. Lose 1 trust.', fuel: 3, reputation: -1 },
    { title: 'Leave it growing', text: 'The drone waves goodbye. Restore 5 hull and gain 1 trust.', hull: 5, reputation: 1 },
  ] },
  { title: 'A fair exchange', eyebrow: 'ENCRYPTED HAIL · INDEPENDENT TRADER', text: '“No questions. No receipts.” The trader’s ship looks less like a vessel and more like a very determined collection of spare parts. Their weapons inventory, however, is impeccable.', choices: [
    { title: 'Buy the singularity lance', text: 'Spend 40 credits. Add a rare weapon to your deck.', credits: -40, card: 'lance' },
    { title: 'Trade a fuel cell', text: 'Spend 1 fuel. Gain 30 credits.', fuel: -1, credits: 30 },
    { title: 'Ask about the signal', text: 'They know a shortcut. Gain 1 fuel.', fuel: 1 },
  ] },
  { title: 'Nobody left behind', eyebrow: 'LIFE POD · FAILING ORBIT', text: 'The pod carries a Revenant insignia. The person inside is barely breathing. Ren goes quiet when he recognizes the uniform. Then he opens the airlock anyway.', choices: [
    { title: 'Bring them aboard', text: 'Spend 15 credits on medicine. Gain 3 trust and Field Repair.', credits: -15, reputation: 3, card: 'repair' },
    { title: 'Extract their flight recorder', text: 'Gain 35 credits. Lose 2 trust.', credits: 35, reputation: -2 },
    { title: 'Stabilize the orbit', text: 'Spend 1 fuel. Gain 1 trust and 15 credits.', fuel: -1, reputation: 1, credits: 15 },
  ] },
  { title: 'The station that remembers', eyebrow: 'ARCHIVE · PRECURSOR ORIGIN', text: 'The terminal recognizes you, though you have never been here. On screen, a fleet of tiny lights goes dark one by one. One light remains. It has the same transponder code as your ship.', choices: [
    { title: 'Download the old defenses', text: 'Add Phase Cloak to your deck.', card: 'cloak' },
    { title: 'Recover the reserve cells', text: 'Gain 2 fuel and 20 credits.', fuel: 2, credits: 20 },
    { title: 'Listen to the last recording', text: 'Gain an artifact. Lose 8 hull as the station collapses.', relic: true, hull: -8 },
  ] },
]
