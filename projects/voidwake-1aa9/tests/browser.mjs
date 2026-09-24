import { chromium, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { CARDS } from '../src/content.ts'
import { newGame, reducer, score } from '../src/game.ts'
import { chooseAction } from './pilot.mjs'

const prefix='/agent-experiments/projects/voidwake-1aa9/'
const root=resolve('dist'),artifacts=resolve('tests/artifacts')
await mkdir(artifacts,{recursive:true})
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2'}
const server=createServer(async(req,res)=>{
 try{
  const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname)
  if(!path.startsWith(prefix)){res.writeHead(404);res.end();return}
  const file=resolve(root,path.slice(prefix.length)||'index.html')
  if(!file.startsWith(root+'/')){res.writeHead(403);res.end();return}
  res.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream'});res.end(await readFile(file))
 }catch{res.writeHead(404);res.end()}
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const url=`http://127.0.0.1:${server.address().port}${prefix}`
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})})
const page=await browser.newPage({viewport:{width:1536,height:1000},reducedMotion:'reduce'})
const errors=[],failed=[]
page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)failed.push(`${r.status()} ${r.url()}`)})
const saveKey='voidwake-1aa9-save-v1'
const read=async()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),saveKey)
async function settled(expected){await page.waitForFunction(({key,state})=>localStorage.getItem(key)===JSON.stringify(state),{key:saveKey,state:expected})}
async function load(g){await page.evaluate(({key,state})=>localStorage.setItem(key,JSON.stringify(state)),{key:saveKey,state:g});await page.reload();await settled(g)}
async function noOverflow(label){const sizes=await page.evaluate(()=>({page:document.documentElement.scrollWidth,width:innerWidth}));expect(sizes.page,`${label} overflows`).toBeLessThanOrEqual(sizes.width)}
const shots={}
try{
 await page.goto(url);await page.evaluate(()=>document.fonts.ready);await expect(page).toHaveTitle('Voidwake — The Last Signal')
 await settled(newGame());await noOverflow('desktop map');await page.screenshot({path:`${artifacts}/map-desktop.png`,fullPage:true})
 await page.getByRole('button',{name:'The Tollkeeper, Sector guardian'}).click();await expect(page.getByRole('button',{name:'No direct route'})).toBeDisabled()
 await page.getByRole('button',{name:'Pale Anchorage, Salvage field, reachable'}).click();await page.getByRole('button',{name:'Engage jump drive'}).click()
 const salvaged=reducer(newGame(),{type:'jump',id:'1-0'});await settled(salvaged);await page.reload();await settled(salvaged)
 await page.getByRole('button',{name:'How to play'}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0)
 await page.getByRole('button',{name:'Ship & crew'}).click();await expect(page.getByRole('heading',{name:'A ship. A crew. A chance.'})).toBeVisible()
 await page.getByRole('button',{name:'Inspect 11 combat systems'}).click();await expect(page.locator('dialog .game-card')).toHaveCount(11);await page.keyboard.press('Escape')
 await page.getByRole('button',{name:'Captain’s log',exact:true}).click();await expect(page.getByRole('heading',{name:'Every light leaves a trace.'})).toBeVisible()
 await page.getByRole('button',{name:'New voyage',exact:true}).click();await page.getByLabel('Voyage seed').fill('BROWSER');await page.getByRole('button',{name:'Launch new voyage'}).click();await settled(newGame('BROWSER'))
 // Complete a real campaign using UI controls only. Each action must match the pure engine.
 let g=await read(),steps=0
 while(!['won','lost'].includes(g.phase)&&steps++<300){
  shots[g.phase]??=structuredClone(g)
  const a=chooseAction(g),expected=reducer(g,a)
  if(a.type==='jump'){
   const n=g.nodes.find(n=>n.id===a.id);await page.getByRole('button',{name:new RegExp(`^${n.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')},`)}).click();await page.getByRole('button',{name:'Engage jump drive'}).click()
  }else if(a.type==='play'){
   const cards=page.locator('.hand-cards button.game-card');await cards.nth(a.index).click()
  }else if(a.type==='crew'){
   await page.getByRole('button',{name:new RegExp(a.id==='mara'?'Ghost maneuver':a.id==='ada'?'Emergency weld':'Precision shot')}).click()
  }else if(a.type==='endTurn')await page.keyboard.press('e')
  else if(a.type==='choice')await page.locator('.event-choices button').nth(a.index).click()
  else if(a.type==='claim')await page.locator('.reward-cards>div').nth(g.reward.cards.indexOf(a.key)).getByRole('button').click()
  else if(a.type==='buy'){
   const name=a.item==='repair'?'Hull repair':a.item==='fuel'?'Refuel':a.item[0].toUpperCase()+a.item.slice(1)
   await page.locator('.service').filter({has:page.getByRole('heading',{name:new RegExp(`^${name}`)})}).getByRole('button').click()
  }else if(a.type==='upgradeCard'){
   const details=page.locator('.refit-deck');if(!await details.evaluate(e=>e.open))await details.locator('summary').click()
   await page.locator('.refit-list>div').nth(g.deck.findIndex(c=>c.uid===a.uid)).getByRole('button',{name:'Enhance · 25'}).click()
  }else if(a.type==='leave')await page.getByRole('button',{name:'Undock'}).click()
  else if(a.type==='sos')await page.getByRole('button',{name:/Emergency refuel/}).click()
  await settled(expected);g=await read();await noOverflow(g.phase)
 }
 expect(g.phase).toBe('won');expect(g.sector).toBe(2);shots.won=g
 await expect(page.getByRole('heading',{name:'You were never alone.'})).toBeVisible();expect(await page.evaluate(()=>Number(localStorage.getItem('voidwake-best')))).toBe(score(g))
 // Screenshots and responsive checks for every encounter phase, using genuine reached states.
 for(const [phase,state] of Object.entries(shots)){
  await load(state);await page.setViewportSize({width:1536,height:1000});await noOverflow(`${phase} desktop`);await page.screenshot({path:`${artifacts}/${phase}-desktop.png`,fullPage:true})
  await page.setViewportSize({width:390,height:844});await noOverflow(`${phase} mobile`);await page.screenshot({path:`${artifacts}/${phase}-mobile.png`,fullPage:true})
 }
 // Numeric card shortcut, disabled cards, persistence in the middle of battle.
 let battle=reducer(newGame(),{type:'jump',id:'1-1'});await load(battle)
 const index=battle.battle.hand.findIndex(c=>CARDS[c.key].cost<=battle.battle.energy)
 await page.keyboard.press(String(index+1));battle=reducer(battle,{type:'play',index});await settled(battle);await page.reload();await settled(battle)
 await page.getByRole('button',{name:'How to play'}).click();await page.getByRole('button',{name:'Enable sound'}).click();await expect(page.getByRole('button',{name:'Mute sound'})).toBeVisible()
 await page.getByRole('button',{name:'New voyage',exact:true}).click();await expect(page.getByRole('button',{name:'Launch new voyage'})).toBeVisible();await page.getByRole('button',{name:/The Kestrel/}).click();await page.getByLabel('Voyage seed').fill('MOBILE');await page.getByRole('button',{name:'Launch new voyage'}).click();await settled(newGame('MOBILE','kestrel'))
 await page.setViewportSize({width:360,height:800});await noOverflow('smallest supported map')
 await page.getByRole('button',{name:'How to play'}).click();await noOverflow('smallest modal');await page.keyboard.press('Escape')
 await page.evaluate(key=>localStorage.setItem(key,'{"version":1}'),saveKey);await page.reload();await settled(newGame())
 // A failing storage backend still allows play and clearly reports the limitation.
 const blocked=await browser.newPage({viewport:{width:1280,height:900}})
 await blocked.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('Blocked','SecurityError')}})
 await blocked.goto(url);await expect(blocked.getByText('Storage unavailable · keep this tab open')).toBeVisible()
 await blocked.getByRole('button',{name:'Cinder Drift, Hostile contact, reachable'}).click();await blocked.getByRole('button',{name:'Engage jump drive'}).click();await expect(blocked.getByRole('heading',{name:'Battle stations'})).toBeVisible();await blocked.close()
 expect(errors).toEqual([]);expect(failed).toEqual([])
 console.log(JSON.stringify({result:'passed',campaignActions:steps,phases:Object.keys(shots),productionSubpath:prefix,consoleErrors:errors,failedRequests:failed,screenshots:artifacts},null,2))
}finally{await browser.close();await new Promise(r=>server.close(r))}
