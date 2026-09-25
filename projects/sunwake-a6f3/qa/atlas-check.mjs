// Serve a production build with pnpm preview --port 4179.
import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {chromium,expect} from '@playwright/test'
const base=process.env.SUNWAKE_URL??'http://127.0.0.1:4179'
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH})
const errors=[],failures=[]
let scenariosRun=0
await mkdir('qa/artifacts',{recursive:true})
async function scenario(name,viewport,fn,mobile=false){
  if(process.env.SUNWAKE_CHECK&&!name.includes(process.env.SUNWAKE_CHECK))return
  scenariosRun++
  const context=await browser.newContext({viewport,deviceScaleFactor:1,isMobile:mobile,hasTouch:mobile})
  const page=await context.newPage();page.setDefaultTimeout(7000)
  page.on('pageerror',e=>errors.push(`${name}: ${e.message}`))
  page.on('console',m=>{if(m.type()==='error')errors.push(`${name}: ${m.text()}`)})
  try {
    await page.clock.install({time:new Date('2026-09-24T12:00:00Z')})
    await page.goto(base,{waitUntil:'networkidle'})
    await page.clock.pauseAt(new Date('2026-09-24T12:01:00Z'))
    await fn(page)
    console.log(`PASS ${name}`)
  }catch(e){failures.push(`${name}: ${e.stack}`);console.error(`FAIL ${name}: ${e.message}`);await page.screenshot({path:`qa/artifacts/${name}-failure.png`,fullPage:true})}
  finally{await context.close()}
}
const save=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('sunwake.progress.v1')))
const openAtlas=async page=>{await page.getByRole('button',{name:'Open the Sun Atlas',exact:true}).click();await expect(page.getByRole('dialog',{name:'The Sun Atlas',exact:true})).toBeVisible()}
const depart=async page=>{await page.getByRole('button',{name:'Fly this expedition',exact:true}).click();await page.clock.runFor(100);await expect(page.locator('.flight-stage')).toHaveClass(/phase-running/)}
try{
  await scenario('atlas-arrival-progression-retry', {width:1440,height:1000}, async page=>{
    await openAtlas(page)
    await expect(page.locator('.atlas-node')).toHaveCount(6)
    await expect(page.locator('.atlas-node.locked')).toHaveCount(5)
    await page.screenshot({path:'qa/artifacts/atlas-desktop.png',fullPage:true})
    await depart(page)
    await page.clock.runFor(11000)
    await page.screenshot({path:'qa/artifacts/atlas-flight.png',fullPage:true})
    await page.clock.runFor(8000)
    await expect(page.locator('.expedition-result')).toBeVisible()
    await expect(page.locator('.results-card h2')).toHaveText('Beacon reached.')
    const progress=await save(page)
    assert.equal(progress.expeditions['first-post'].medals,1)
    assert.equal(progress.totalRuns,1)
    assert.equal(progress.best,0);assert.equal(progress.bestScore,0);assert.deepEqual(progress.completed,[])
    assert.equal(progress.bank,progress.history[0].sparks+40)
    assert.equal(await page.evaluate(()=>localStorage.getItem('sunwake.ghosts.v2')),null)
    await page.clock.runFor(300)
    assert.deepEqual(await save(page),progress)
    await page.screenshot({path:'qa/artifacts/atlas-results.png',fullPage:true})
    await page.getByRole('button',{name:'Next expedition',exact:true}).click()
    await page.clock.runFor(900)
    await expect(page.locator('.expedition-tag')).toHaveText('Rose express')
    await page.keyboard.press('KeyP')
    await page.getByRole('button',{name:'Restart this route'}).click()
    await page.clock.runFor(150)
    await expect(page.locator('.expedition-tag')).toHaveText('Rose express')
    assert.ok(Number((await page.locator('.distance-readout > strong').innerText()).replace(/\D/g,''))<20)
    await page.keyboard.press('KeyP');await page.getByRole('button',{name:'End this flight',exact:true}).click();await page.clock.runFor(100)
    assert.equal((await save(page)).expeditions['rose-express'].medals,0)
    await page.reload({waitUntil:'networkidle'});await openAtlas(page)
    await expect(page.locator('.atlas-node.locked')).toHaveCount(4)
  })

  for(const width of [320,390])await scenario(`atlas-mobile-${width}`,{width,height:844},async page=>{
    await page.goto(`${base}/#/expedition/1/glass-crossing`,{waitUntil:'networkidle'})
    await expect(page.getByRole('dialog',{name:'The Sun Atlas'})).toBeVisible()
    await expect(page.locator('.atlas-detail h3')).toHaveText('Glass crossing')
    await expect(page.locator('.atlas-departure .button')).toBeDisabled()
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
    await page.locator('.atlas-node').first().click()
    await page.screenshot({path:`qa/artifacts/atlas-mobile-${width}.png`,fullPage:true})
    await depart(page)
    await page.clock.runFor(19000)
    await expect(page.locator('.results-card h2')).toHaveText('Beacon reached.')
    const dimensions=await page.locator('.results-card').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight}))
    assert.ok(dimensions.scroll<=dimensions.height+2,`Portrait results should fit ${JSON.stringify(dimensions)}`)
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Unavailable')}}}))
    await page.getByRole('button',{name:'Copy course link',exact:true}).click()
    await expect(page.locator('.share-field input')).toHaveValue(/#\/expedition\/1\/first-post$/)
    await page.keyboard.press('Escape')
    await page.screenshot({path:`qa/artifacts/atlas-mobile-${width}-result.png`,fullPage:true})
    await page.getByRole('button',{name:'Back to shore',exact:true}).click()
    await expect(page.getByRole('button',{name:'Let’s fly',exact:true})).toBeVisible()
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  },true)

  await scenario('atlas-unlocks-and-cosmetics',{width:1280,height:980},async page=>{
    await page.evaluate(()=>{
      const expeditions=Object.fromEntries(['first-post','rose-express','glass-crossing','lantern-run','updraft-alley','last-beacon'].map(id=>[id,{medals:3,bestTime:30,attempts:1}]))
      localStorage.setItem('sunwake.progress.v1',JSON.stringify({version:1,bank:61,best:2345,bestScore:12345,owned:['sol','manta'],selected:'manta',completed:['first-light'],expeditions}))
    })
    await page.reload({waitUntil:'networkidle'});await page.clock.runFor(100)
    await page.getByTitle('Open the hangar',{exact:true}).click()
    const kestrel=page.locator('.ship-card').filter({has:page.getByRole('heading',{name:'Kestrel',exact:true})})
    await kestrel.getByRole('button',{name:'Select skiff',exact:true}).click()
    await page.getByRole('button',{name:'Aurora Choose wake',exact:true}).click()
    await expect(page.getByRole('button',{name:'Stardust 18 seals',exact:true})).toBeDisabled()
    await page.screenshot({path:'qa/artifacts/atlas-hangar.png',fullPage:true})
    const data=await save(page)
    assert.equal(data.selected,'kestrel');assert.equal(data.trail,'aurora');assert.equal(data.bank,61);assert.equal(data.best,2345)
    await page.keyboard.press('Escape')
    await page.getByRole('button',{name:'Let’s fly',exact:true}).click();await page.clock.runFor(1500)
    await page.screenshot({path:'qa/artifacts/atlas-kestrel.png',fullPage:true})
    await page.reload({waitUntil:'networkidle'})
    assert.equal((await save(page)).trail,'aurora')
  })

  await scenario('controller-lifecycle-and-input-isolation',{width:1280,height:980},async page=>{
    await page.evaluate(()=>{
      window.testButtons=[];window.testConnected=true
      Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>window.testConnected?[{index:0,connected:true,mapping:'standard',buttons:Array.from({length:16},(_,i)=>({pressed:window.testButtons.includes(i),value:window.testButtons.includes(i)?1:0}))}]:[]})
    })
    const buttons=async value=>{await page.evaluate(v=>{window.testButtons=v},value);await page.clock.runFor(150)}
    await buttons([0])
    await expect(page.locator('.flight-stage')).toHaveClass(/phase-running/)
    await expect(page.locator('.controller-connected')).toBeVisible()
    await page.keyboard.down('Space');await buttons([])
    await expect(page.locator('.flight-coach i')).toHaveText('DIVING')
    await page.keyboard.up('Space');await page.clock.runFor(150)
    await expect(page.locator('.flight-coach i')).toHaveCount(0)
    await buttons([9]);await expect(page.locator('.pause-card')).toBeVisible()
    await page.clock.runFor(700);await expect(page.locator('.pause-card')).toBeVisible()
    await buttons([]);await buttons([9]);await expect(page.locator('.flight-stage')).toHaveClass(/phase-running/)
    await buttons([])
    await page.evaluate(()=>{window.testConnected=false});await page.clock.runFor(150)
    await expect(page.locator('.pause-card')).toBeVisible()
    await page.keyboard.press('KeyR');await page.clock.runFor(150)
    await expect(page.locator('.flight-stage')).toHaveClass(/phase-running/)
    await page.keyboard.press('KeyP');await page.getByRole('button',{name:'End this flight',exact:true}).click();await page.clock.runFor(100)
    await page.evaluate(()=>{window.testConnected=true});await buttons([0])
    await expect(page.locator('.flight-stage')).toHaveClass(/phase-running/)
  })

  await scenario('atlas-gold-seals-and-wake-unlock',{width:390,height:844},async page=>{
    await page.goto(`${base}/#/expedition/1/first-post`,{waitUntil:'networkidle'})
    await page.getByRole('button',{name:'Fly this expedition',exact:true}).click()
    for(let i=0;i<50;i++){
      if(await page.locator('.results-card').count())break
      if(await page.locator('.burst-button.charged').count()){await page.keyboard.down('Shift');await page.clock.runFor(16);await page.keyboard.up('Shift')}
      await page.keyboard.down('Space');await page.clock.runFor(130);await page.keyboard.up('Space');await page.clock.runFor(520)
    }
    await expect(page.locator('.expedition-result')).toBeVisible()
    const result=await save(page)
    assert.equal(result.expeditions['first-post'].medals,7)
    assert.equal(result.bank,result.history[0].sparks+120)
    await expect(page.locator('.unlock-announcement')).toContainText('Seafoam wake')
    const dimensions=await page.locator('.results-card').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight}))
    assert.ok(dimensions.scroll<=dimensions.height+2,'All seals and the unlock should fit on a phone')
    await page.screenshot({path:'qa/artifacts/atlas-gold-verified.png',fullPage:true})
    await page.locator('.unlock-announcement').click()
    await page.getByRole('button',{name:'Seafoam Choose wake',exact:true}).click()
    assert.equal((await save(page)).trail,'seafoam')
  },true)

  await scenario('atlas-landscape-finish',{width:844,height:390},async page=>{
    await page.getByRole('button',{name:'Toggle fullscreen',exact:true}).click()
    // A modal remains usable while the stage occupies fullscreen.
    await page.getByRole('button',{name:'Six expeditions await'}).click()
    await depart(page);await page.clock.runFor(19000)
    await expect(page.locator('.expedition-result')).toBeVisible()
    const size=await page.locator('.results-card').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight}))
    assert.ok(size.scroll<=size.height+2,`Landscape results should fit ${JSON.stringify(size)}`)
    await page.screenshot({path:'qa/artifacts/atlas-landscape-result.png'})
  },true)
} finally {await browser.close()}
if(errors.length)failures.push(...errors)
if(!scenariosRun)failures.push('No atlas scenarios matched SUNWAKE_CHECK')
if(failures.length){console.error(failures.join('\n\n'));process.exitCode=1}else console.log(`${scenariosRun} atlas browser checks passed; clean consoles.`)
