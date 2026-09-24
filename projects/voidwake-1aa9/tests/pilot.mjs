import { CARDS, EVENTS } from '../src/content.ts'
import { currentIntent, reachable, reducer, upgradeCost } from '../src/game.ts'

// A deliberately simple pilot exercises real legal actions without modifying game state.
export function chooseAction(g) {
  if (g.phase === 'map') {
    if (g.fuel === 0) return {type:'sos'}
    const weight={boss:1,relay:9,station:g.credits>=45?10:3,salvage:g.fuel<5?12:6,event:5,battle:3,elite:2}
    const nodes=g.nodes.filter(n=>reachable(g).includes(n.id)).sort((a,b)=>weight[b.kind]-weight[a.kind])
    return {type:'jump',id:nodes[0].id}
  }
  if (g.phase === 'event') {
    const choices=EVENTS[g.event].choices.map((c,index)=>({c,index})).filter(({c})=>g.credits+(c.credits??0)>=0&&g.fuel+(c.fuel??0)>=0&&g.hull+(c.hull??0)>0)
    const value=c=>(c.relic?40:0)+(c.card?15:0)+(c.hull??0)*2+(c.credits??0)*.4+(c.fuel??0)*5+(c.reputation??0)*3
    return {type:'choice',index:choices.sort((a,b)=>value(b.c)-value(a.c))[0].index}
  }
  if (g.phase === 'station') {
    if(g.hull<g.maxHull-20&&g.credits>=20) return {type:'buy',item:'repair'}
    for(const item of ['reactor','weapons','shields']) if(g.upgrades[item]<(item==='reactor'?2:3)&&g.credits>=upgradeCost(g,item))return{type:'buy',item}
    if(g.fuel<4&&g.credits>=15)return{type:'buy',item:'fuel'}
    const c=g.deck.find(c=>!c.rank&&['torpedo','pulse','railgun','siphon'].includes(c.key))
    if(c&&g.credits>=25)return{type:'upgradeCard',uid:c.uid}
    return{type:'leave'}
  }
  if(g.phase==='reward') {
    const rank=['railgun','siphon','broadside','echo','torpedo','lance','overclock','flare','barrage','vent','salvo','cloak','drone','fortify','scan']
    return{type:'claim',key:[...g.reward.cards].sort((a,b)=>rank.indexOf(a)-rank.indexOf(b))[0]}
  }
  if(g.phase==='combat') {
    const b=g.battle, intent=currentIntent(g), damage=['attack','drain'].includes(intent.kind)?intent.value:0
    if(!b.crewUsed) {
      if(b.enemy.hull<=15)return{type:'crew',id:'ren'}
      if(damage-b.shield>12)return{type:'crew',id:'mara'}
      if(g.hull<=g.maxHull-10)return{type:'crew',id:'ada'}
    }
    let best=null,bestScore=-Infinity
    for(let index=0;index<b.hand.length;index++){
      const c=b.hand[index];if(CARDS[c.key].cost>b.energy)continue
      const next=reducer(g,{type:'play',index});if(next.phase==='lost')continue
      if(next.phase==='reward')return{type:'play',index}
      const n=next.battle
      const blocked=Math.min(damage,n.evade?damage:n.shield)-Math.min(damage,b.evade?damage:b.shield)
      const gain=(b.enemy.hull-n.enemy.hull)*1.1+(next.hull-g.hull)*1.7+blocked*1.5+(n.hand.length-b.hand.length+1)*3+(n.energy-b.energy)*4+(n.enemy.burn-b.enemy.burn)*1.9+(n.enemy.vulnerable-b.enemy.vulnerable)*3
      if(gain>bestScore){bestScore=gain;best={type:'play',index}}
    }
    return best&&bestScore>0?best:{type:'endTurn'}
  }
  return null
}
