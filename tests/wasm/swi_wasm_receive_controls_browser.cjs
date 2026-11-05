'use strict';
// All deadlines run in this Node process, outside the CPU-bound renderer.
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto');
const {chromium}=require('playwright');
const runtime=path.resolve(process.env.LIBRARY_RUNTIME_ROOT||path.join(__dirname,'../..'));
const manifest=process.env.LIBRARY_MANIFEST||path.join(runtime,'tests/fixtures/receive-control.json');
const raw=fs.readFileSync(manifest),pack=JSON.parse(raw),rows=[],entries=new Map(),owned=new Set();
const output=process.env.LIBRARY_REPORT;
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function deadline(p,ms,label){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' deadline')),ms);})]).finally(()=>clearTimeout(timer));}
const runtimeFiles=Object.fromEntries(['web/vendor/swi-wasm-node.js','web/swi_wasm_actor_worker.js','web/swipl-bundle.js'].map(f=>[f,sha(path.join(runtime,f))]));
function save(){if(output)fs.writeFileSync(output,JSON.stringify({suite:pack.suite,scope:'Real guard controls after held RPC entry; same-actor recovery for abort/time limit. Main abort runs directly; configured PTCP limits and termination run in worker children under either coordinator.',manifest_sha256:sha(manifest),adapter_sha256:sha(__filename),runtime_files_sha256:runtimeFiles,results:rows,counts:{pass:rows.filter(r=>r.status==='pass').length,fail:rows.filter(r=>r.status==='fail').length}},null,2)+'\n');}
const server=http.createServer((req,res)=>{
 const parsed=new URL(req.url,'http://localhost');
 if(parsed.pathname.startsWith('/entry/')){
  const key=parsed.pathname.replace(/\/call$/,'');
  const item=entries.get(key)||{count:0,finished:false,requests:[]};
  item.count++;item.requests.push(Object.fromEntries(parsed.searchParams));entries.set(key,item);
  const body='success([v],false).\n';
  item.release=()=>{item.released=true;const text=item.body||body;res.writeHead(200,{'Content-Length':Buffer.byteLength(text)});res.end(text);};res.on('finish',()=>{item.finished=true;});return;
 }
 if(parsed.pathname==='/__countall.html'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<meta charset="utf-8"><script src="/swi_wasm_actor_worker.js"></script><script src="/vendor/swi-wasm-node.js"></script>');return;}
 const file=path.resolve(runtime,'web','.'+parsed.pathname);
 if(!file.startsWith(path.join(runtime,'web')+path.sep)){res.writeHead(403);res.end();return;}
 fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.wasm')?'application/wasm':'text/plain');res.end(data);});
});
function prologAtom(s){return "'"+s.replace(/\\/g,'\\\\').replace(/'/g,"''")+"'";}

let base;
async function open(mode,source){
 const owner=await chromium.launchServer({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,timeout:15000});owned.add(owner);
 const browser=await chromium.connect(owner.wsEndpoint());
 const page=await browser.newPage();
 await page.goto(base+'/__countall.html');
 await page.evaluate(async({mode,source})=>{
  window.libraryNode=SwiWasmNode.create({mode,workerUrl:new URL('/swi_wasm_actor_worker.js',location.href).href,engineUrl:new URL('/swipl-bundle.js',location.href).href,prologBaseUrl:new URL('/wasm/',location.href).href,sharedDatabaseUrl:null});
  await libraryNode.open({source:source||''});
 },{mode,source});
 return {owner,browser,page};
}
async function kill(session,timeout){
 const started=performance.now(),process=session.owner.process();
 await deadline(session.owner.kill(),timeout,'browser termination');owned.delete(session.owner);
 return {confirmed:process.exitCode!==null||process.signalCode!==null,duration_ms:performance.now()-started,exit_code:process.exitCode,signal:process.signalCode};
}
async function ask(session,goal){
 const answer=await deadline(session.page.evaluate(goal=>libraryNode.query('('+goal+'),ControlCheck=passed',{limit:1}),goal),5000,'actor answer');
 if(answer.type!=='success'||answer.more!==false||answer.data.length!==1||answer.data[0].ControlCheck!=='passed')throw Error(JSON.stringify(answer));
 return answer;
}
async function held(key){
 const until=performance.now()+5000;
 while(!entries.has(key)){if(performance.now()>=until)throw Error('guard entry deadline');await delay(5);}
 const item=entries.get(key);if(item.count!==1||item.released)throw Error('missing unique held entry');return item;
}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 const watchdog=setTimeout(()=>{console.error('External guard browser watchdog expired');for(const owner of owned)owner.kill().catch(()=>{});setTimeout(()=>process.exit(2),4000).unref();},120000);
 try{
  for(const mode of ['worker','main'])for(const c of pack.cases){
   const row={candidate:'swi-wasm-'+mode,id:c.id,title:c.title},observed={};let session;
   const key='/entry/'+mode+'-'+c.id;
   try{
    session=await deadline(open(mode,c.source),20000,'browser startup');
    const extra=c.source?',src_text('+prologAtom(c.source)+')':'';
    const rawProbe=c.source?pack.probe_goal.replace('GuardBinding=dirty,','GuardBinding=dirty,guard_private_marker(ok),'):pack.probe_goal;
    const rawOrdinary=c.source?pack.ordinary_goal.replace('GuardBinding=dirty,','GuardBinding=dirty,guard_private_marker(ok),').replace('GuardRecovered=passed','guard_private_body(ok),GuardRecovered=passed'):pack.ordinary_goal;
    const recovery=c.source?'guard_private_body(ok),('+pack.recovery_goal+')':pack.recovery_goal;
    const probe='LibraryEntryURI='+prologAtom(base+key)+',('+rawProbe+')';
    let query,target;
    if(c.control==='abort'||c.control==='ordinary_error'){
     const goal=c.control==='abort'?probe:'LibraryEntryURI='+prologAtom(base+key)+',('+rawOrdinary+'),ControlCheck=passed';
     query=session.page.evaluate(goal=>libraryNode.query(goal,{limit:1}),goal);query.catch(()=>{});
     observed.guard_target=mode+'-primary-session';
    }else if(c.control==='time_limit'){
     observed.setup=await ask(session,'toplevel_spawn(Target,[session(true),time_limit('+c.time_limit+')'+extra+']),toplevel_call(Target,('+probe+'),[template(true)])');
     target=observed.setup.data[0].Target;observed.guard_target='worker-child-toplevel';
    }else{
     observed.setup=await ask(session,'spawn(('+probe+'),Target,[monitor(true)'+extra+'])');
     target=observed.setup.data[0].Target;observed.guard_target='worker-child-actor';
    }
    const gate=await held(key);observed.entry_count=gate.count;observed.peer_held_at_control=!gate.released;
    if(c.control==='abort'){
     await session.page.evaluate(()=>libraryNode.abort());
     observed.control_response=await deadline(query,5000,'abort');
     if(observed.control_response.type!=='abort')throw Error(JSON.stringify(observed.control_response));
     observed.recovery=await ask(session,recovery);
    }else if(c.control==='time_limit'){
     observed.control_and_recovery=await ask(session,'receive({error('+target+',error(resource_error(time),_))->true},[timeout(3),on_timeout(throw(missing_time_error))]),toplevel_call('+target+',('+recovery+'),[template(recovered)]),receive({success('+target+',[recovered],false)->true},[timeout(3),on_timeout(throw(missing_recovery))]),toplevel_halt('+target+',true)');
     observed.formal_error_checked='error(resource_error(time),_)';
    }else if(c.control==='terminate'){
     observed.control_response=await ask(session,'exit('+target+',guard_terminated),receive({down('+target+','+target+',guard_terminated)->true},[timeout(3),on_timeout(throw(missing_termination))])');
    }else{
     gate.body='error(guard_ordinary).\n';gate.release();
     observed.ordinary_response=await deadline(query,5000,'ordinary guard');
     const a=observed.ordinary_response;if(a.type!=='success'||a.more!==false||a.data[0].ControlCheck!=='passed')throw Error(JSON.stringify(a));
    }
    if(c.control!=='ordinary_error'&&gate.released)throw Error('peer released before control and recovery');
    observed.health=await ask(session,'true');
    await deadline(session.owner.close(),3000,'browser close');owned.delete(session.owner);session=null;observed.close_confirmed=true;
    row.status='pass';
   }catch(error){row.status='fail';row.detail=String(error.stack||error);}
   finally{
    const gate=entries.get(key);if(gate&&!gate.released)gate.release();
    for(const owner of [...owned]){await deadline(owner.kill(),3000,'cleanup').catch(()=>{});owned.delete(owner);}
   }
   row.observation=observed;rows.push(row);save();console.log(row.candidate,c.id,row.status);
  }
 }finally{clearTimeout(watchdog);for(const owner of owned)await owner.kill();await new Promise(r=>server.close(r));}
 process.exitCode=rows.some(r=>r.status==='fail')?1:0;
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
