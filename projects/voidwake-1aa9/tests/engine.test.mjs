import test from 'node:test'
import assert from 'node:assert/strict'
import { CARDS, EVENTS } from '../src/content.ts'
import { newGame, reducer, parseSave, reachable, passiveShield, currentIntent, score, generateMap } from '../src/game.ts'
import {chooseAction} from './pilot.mjs'
const combat=()=>reducer(newGame(),{type:'jump',id:'1-1'})
const withHand=(keys)=>{const g=combat();g.battle.hand=keys.map((key,i)=>({key,uid:100+i,rank:0}));g.battle.draw=[];g.battle.discard=[];return g}

test('seed normalization is reproducible and every route reaches a guardian',()=>{
 assert.deepEqual(newGame(' orpheus '),newGame('ORPHEUS'))
 for(let seed=0;seed<120;seed++)for(let sector=0;sector<3;sector++){
  const g=newGame(String(seed));g.sector=sector;g.nodes=generateMap(g)
  assert.equal(g.nodes.length,17)
  for(const n of g.nodes){assert.equal(n.kind==='boss',n.links.length===0);for(const id of n.links)assert.equal(g.nodes.find(v=>v.id===id).col,n.col+1)}
  let frontier=['start'];for(let col=0;col<6;col++)frontier=[...new Set(frontier.flatMap(id=>g.nodes.find(n=>n.id===id).links))]
  assert.deepEqual(frontier,['boss'])
 }
})
test('illegal travel, purchases, and phase changes preserve the voyage',()=>{
 const g=newGame();assert.equal(reducer(g,{type:'jump',id:'boss'}),g)
 assert.equal(reducer(g,{type:'buy',item:'reactor'}),g)
 assert.equal(reducer(g,{type:'endTurn'}),g)
 const noFuel={...g,fuel:0};assert.equal(reducer(noFuel,{type:'jump',id:'1-0'}),noFuel)
})
test('salvage, fuel recovery, and map actions never mutate the prior state',()=>{
 const g=newGame(),before=JSON.stringify(g),n=reducer(g,{type:'jump',id:'1-0'})
 assert.equal(JSON.stringify(g),before);assert.equal(n.fuel,11);assert.ok(n.credits>g.credits);assert.equal(n.current,'1-0');assert.ok(n.nodes[1].cleared)
 const stuck={...g,fuel:0,credits:0,hull:1},rescued=reducer(stuck,{type:'sos'});assert.equal(rescued.fuel,2);assert.equal(rescued.hull,1)
 assert.equal(reducer({...g,fuel:0},{type:'sos'}).credits,65)
})
test('weapons consume energy; unaffordable cards have no effect',()=>{
 const g=withHand(['pulse','torpedo']);const n=reducer(g,{type:'play',index:0})
 assert.equal(n.battle.energy,2);assert.equal(n.battle.enemy.hull,g.battle.enemy.hull-8);assert.equal(n.battle.hand.length,1);assert.equal(n.battle.discard.length,1)
 n.battle.energy=0;assert.deepEqual(reducer(n,{type:'play',index:0}),n)
})
test('torpedoes ignore shields; normal weapons consume them',()=>{
 const g=withHand(['torpedo']);g.battle.enemy.shield=50
 const n=reducer(g,{type:'play',index:0});assert.equal(n.battle.enemy.shield,50);assert.equal(n.battle.enemy.hull,g.battle.enemy.hull-19)
 const p=withHand(['pulse']);p.battle.enemy.shield=5;const q=reducer(p,{type:'play',index:0});assert.equal(q.battle.enemy.shield,0);assert.equal(q.battle.enemy.hull,p.battle.enemy.hull-3)
})
test('defense blocks damage, turns refill energy and reset shields',()=>{
 const g=withHand(['barrier']);g.battle.enemy.pattern=[{kind:'attack',value:14}];const n=reducer(reducer(g,{type:'play',index:0}),{type:'endTurn'})
 assert.equal(n.hull,g.hull);assert.equal(n.battle.shield,passiveShield(g));assert.equal(n.battle.energy,3);assert.equal(n.battle.turn,2)
})
test('crew abilities are mutually exclusive and reset next battle',()=>{
 const g=combat();g.battle.enemy.pattern=[{kind:'attack',value:100}]
 const n=reducer(g,{type:'crew',id:'mara'});assert.ok(n.battle.crewUsed);assert.equal(reducer(n,{type:'crew',id:'ren'}),n)
 const safe=reducer(n,{type:'endTurn'});assert.equal(safe.hull,g.hull);assert.equal(safe.battle.evade,0)
})
test('exhausted cards do not return when the draw pile reshuffles',()=>{
 const g=withHand(['repair','pulse']);g.hull=60
 const n=reducer(g,{type:'play',index:0});assert.equal(n.hull,65);assert.equal(n.battle.exhaust[0].key,'repair')
 const next=reducer(n,{type:'endTurn'});assert.deepEqual(next.battle.hand.map(c=>c.key),['pulse'])
})
test('burn resolves before intent and wins without a final enemy hit',()=>{
 const g=withHand(['flare']);g.battle.enemy.hull=5;g.battle.enemy.pattern=[{kind:'attack',value:200}]
 const n=reducer(reducer(g,{type:'play',index:0}),{type:'endTurn'})
 assert.equal(n.phase,'reward');assert.equal(n.hull,90);assert.equal(n.stats.battles,1)
})
test('vulnerability and upgrades increase damage; repeated hits count correctly',()=>{
 const g=withHand(['broadside']);g.battle.enemy.hull=100;g.battle.enemy.maxHull=100;g.battle.enemy.vulnerable=2;g.upgrades.weapons=1
 const n=reducer(g,{type:'play',index:0});assert.equal(n.battle.enemy.hull,68);assert.equal(n.stats.damage,32)
})
test('every card and enhancement has a legal, finite resolution',()=>{
 for(const key of Object.keys(CARDS))for(const rank of [0,1]){
  const g=withHand([key]);g.battle.hand[0].rank=rank;g.battle.energy=10;g.battle.enemy.hull=200;g.battle.enemy.maxHull=200;g.hull=40
  const n=reducer(g,{type:'play',index:0});assert.equal(n.stats.cardsPlayed,1,key);assert.ok(Number.isFinite(n.hull));assert.ok(Number.isFinite(n.battle.enemy.hull));assert.ok(n.battle.energy>=0)
 }
})
test('shop upgrade caps, stock, enhancements, and deck minimum are enforced',()=>{
 let g=newGame();g.phase='station';g.shop=['lance'];g.credits=1000
 g=reducer(g,{type:'buy',item:'lance'});assert.equal(g.deck.at(-1).key,'lance');assert.equal(g.credits,950)
 assert.equal(reducer(g,{type:'buy',item:'lance'}),g)
 for(let i=0;i<2;i++)g=reducer(g,{type:'buy',item:'reactor'})
 assert.equal(g.upgrades.reactor,2);assert.equal(reducer(g,{type:'buy',item:'reactor'}),g)
 const uid=g.deck[0].uid;g=reducer(g,{type:'upgradeCard',uid});assert.equal(g.deck[0].rank,1);assert.equal(reducer(g,{type:'upgradeCard',uid}),g)
 g.deck=g.deck.slice(0,5);assert.equal(reducer(g,{type:'removeCard',uid}),g)
})
test('event affordability prevents negative resources; every event has an escape',()=>{
 for(let event=0;event<EVENTS.length;event++){
  const g=newGame();g.phase='event';g.event=event;g.credits=0;g.fuel=0;g.hull=1
  const results=EVENTS[event].choices.map((_,index)=>reducer(g,{type:'choice',index}))
  assert.ok(results.some(n=>n.phase==='map'),`event ${event} stranded the player`)
  for(const n of results){assert.ok(n.hull>0);assert.ok(n.fuel>=0);assert.ok(n.credits>=0)}
 }
})
test('death and final victory are terminal; guardian gates restore resources',()=>{
 let g=combat();g.hull=1;g.battle.shield=0;g.battle.enemy.pattern=[{kind:'attack',value:50}]
 g=reducer(g,{type:'endTurn'});assert.equal(g.phase,'lost');assert.equal(g.hull,0);assert.equal(reducer(g,{type:'crew',id:'ada'}),g)
 const bossReward=()=>{const g=combat();g.current='boss';g.nodes.find(n=>n.id==='boss').visited=true;g.battle.enemy.hull=1;return reducer(g,{type:'crew',id:'ren'})}
 const first=bossReward(),next=reducer(first,{type:'claim',key:null});assert.equal(next.sector,1);assert.equal(next.current,'start');assert.equal(next.fuel,first.fuel+6);assert.equal(next.battle,null)
 const last=bossReward();last.sector=2;const won=reducer(last,{type:'claim',key:last.reward.cards[0]});assert.equal(won.phase,'won');assert.ok(score(won)>=1500);assert.equal(reducer(won,{type:'jump',id:'1-1'}),won)
})
test('save validation rejects corrupted structures and resumes valid battles exactly',()=>{
 const g=combat();assert.deepEqual(parseSave(JSON.stringify(g)),g)
 for(const raw of [null,'{','null','{}',JSON.stringify({...g,version:2}),JSON.stringify({...g,hull:-1}),JSON.stringify({...g,battle:{}}),JSON.stringify({...g,deck:[{key:'bad'}]}),JSON.stringify({...g,nodes:[]})])assert.equal(parseSave(raw),null)
 const a=reducer(g,{type:'endTurn'}),b=reducer(parseSave(JSON.stringify(g)),{type:'endTurn'});assert.deepEqual(a,b)
})
test('36 complete simulated campaigns stay valid and all ships can win',()=>{
 const wins={wayfarer:0,kestrel:0,bulwark:0};let actions=0
 for(const ship of Object.keys(wins))for(let i=0;i<12;i++){
  let g=newGame(`PILOT-${i}`,ship,i%2?'captain':'explorer'),steps=0
  while(!['won','lost'].includes(g.phase)&&steps++<800){
   const action=chooseAction(g);assert.ok(action);const before=g;g=reducer(g,action);assert.notEqual(g,before,JSON.stringify(action));assert.ok(parseSave(JSON.stringify(g)),`${ship} ${i}: invalid save in ${g.phase}`)
   if(g.phase==='combat'){
    const all=[...g.battle.hand,...g.battle.draw,...g.battle.discard,...g.battle.exhaust];assert.equal(all.length,g.deck.length);assert.equal(new Set(all.map(c=>c.uid)).size,g.deck.length);assert.ok(currentIntent(g))
   }
   actions++
  }
  assert.ok(steps<800,'campaign did not terminate');assert.ok(['won','lost'].includes(g.phase));if(g.phase==='won')wins[ship]++
 }
 for(const count of Object.values(wins))assert.ok(count>0)
 console.log('Campaign simulation:',JSON.stringify({wins,actions}))
})
