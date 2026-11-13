'use strict';
// A main-thread session can own its named chart and additional worker charts.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});const rows=[];
 try{for(const mode of ['main','worker']){
  const page=await browser.newPage();
  try{
   await page.goto(process.env.RUNTIME_URL+'vendor/swi-wasm-minimal.html');
   const result=await page.evaluate(async mode=>{
    const n=SwiWasmNode.create({mode,workerUrl:new URL('../swi_wasm_actor_worker.js',location.href).href,engineUrl:new URL('../swipl-bundle.js',location.href).href,prologBaseUrl:new URL('../wasm/',location.href).href,sharedDatabaseUrl:null});
    const xml='<statechart version="0.2" initial="idle"><state id="idle"><go on="finish" to="done"/></state><final id="done"/></statechart>';
    const query=async goal=>{const r=await n.query(goal,'[limit(1),once(true)]');if(r.type!=='success')throw Error(goal+': '+JSON.stringify(r));return r.data[0]||{};};
    try{
     await n.open();const first=await query('statechart_spawn(A,[src_text('+JSON.stringify(xml)+'),trace(false)])');
     const second=await query('statechart_spawn(B,[src_text('+JSON.stringify(xml)+'),trace(false)])');
     const halted=await query('statechart_halt('+second.B+',Reply,2)');
     const third=await query('statechart_spawn(C,[src_text('+JSON.stringify(xml)+'),trace(false)])');
     await query(third.C+' ! finish');await new Promise(r=>setTimeout(r,250));
     const completed=await query('statechart_halt('+third.C+',Reply,2)');
     const named=await query('statechart_halt('+first.A+',Reply,2)');
     await query('true');return {first:first.A,worker:second.B,halted:halted.Reply,completed:completed.Reply,named:named.Reply};
    }finally{n.dispose();}
   },mode);
   assert.notEqual(result.first,result.worker);for(const key of ['halted','completed','named'])assert(['stopped','killed','true'].includes(result[key]),JSON.stringify(result));rows.push({mode,result:'pass',observation:result});console.log(mode,'chart halt pass');
  }finally{await page.close();}
 }}finally{await browser.close();if(process.env.CHART_HALT_REPORT)fs.writeFileSync(process.env.CHART_HALT_REPORT,JSON.stringify(rows,null,2)+'\n');}
})().catch(e=>{console.error(e);process.exitCode=1;});
