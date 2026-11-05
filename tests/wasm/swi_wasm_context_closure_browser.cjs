'use strict';
// Real engines and actors; coordinator barriers select publication/closure order.
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto');
const {chromium}=require('playwright');
const root=path.resolve(process.env.LIBRARY_RUNTIME_ROOT||path.join(__dirname,'../..'));
const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const rows=[],output=process.env.LIBRARY_REPORT;
function save(){if(output)fs.writeFileSync(output,JSON.stringify({suite:'browser-context-closure-0.1',adapter_sha256:sha(__filename),package_manifest_sha256:sha(path.join(root,'manifest.json')),runtime_files_sha256:Object.fromEntries(['web/vendor/swi-wasm-node.js','web/swi_wasm_actor_worker.js'].map(f=>[f,sha(path.join(root,f))])),results:rows,counts:{pass:rows.filter(r=>r.status==='pass').length,fail:rows.filter(r=>r.status==='fail').length}},null,2)+'\n');}
function deadline(p,ms,label){let t;return Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(Error(label+' deadline')),ms);})]).finally(()=>clearTimeout(t));}
const server=http.createServer((req,res)=>{
 const name=new URL(req.url,'http://localhost').pathname;
 if(name==='/__closure.html'){res.setHeader('Content-Type','text/html');res.end('<meta charset="utf-8"><script src="/swi_wasm_actor_worker.js"></script><script src="/vendor/swi-wasm-node.js"></script>');return;}
 const file=path.resolve(root,'web','.'+name);
 if(!file.startsWith(path.join(root,'web')+path.sep)){res.writeHead(403);res.end();return;}
 fs.readFile(file,(e,data)=>{if(e){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.wasm')?'application/wasm':'text/plain');res.end(data);});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const watchdog=setTimeout(()=>{browser.close();setTimeout(()=>process.exit(2),3000).unref();},120000);
 try{for(const mode of ['worker','main'])for(const id of (process.env.CLOSURE_CASES||'BC-001,BC-002,BC-003,BC-004,BC-005,BC-006,BC-007,BC-008').split(',')){
  const row={candidate:'swi-wasm-'+mode,id};const page=await browser.newPage();
  try{
   await page.route('https://n3.elfenbenstornet.se/closure-source.pl',route=>route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'text/plain',body:'ready_marker(ok).'}));
   await page.goto('http://127.0.0.1:'+server.address().port+'/__closure.html');
   row.observation=await deadline(page.evaluate(async({mode,id})=>{
    const checks=[],nodes=[];
    const check=(v,label)=>{if(!v)throw Error(label);checks.push(label);};
    const create=async mode=>{const n=SwiWasmNode.create({mode,workerUrl:new URL('/swi_wasm_actor_worker.js',location.href).href,engineUrl:new URL('/swipl-bundle.js',location.href).href,prologBaseUrl:new URL('/wasm/',location.href).href,sharedDatabaseUrl:null});nodes.push(n);await n.open();return n;};
    const n=await create(mode);
    const run=async(goal,node=n)=>{const a=await node.query('('+goal+'),ClosureCheck=passed',{limit:1});check(a.type==='success'&&a.more===false&&a.data.length===1&&a.data[0].ClosureCheck==='passed','query '+goal+' '+JSON.stringify(a));return a;};
    const close=()=>{check(typeof n.closeSwiWasmClientContext==='function','host can close name and promise scopes independently of actors');n.closeSwiWasmClientContext();};
    try{
     if(id==='BC-008'){
      let entered,release;const at=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
      const load=n.loadSwiWasmUriSource.bind(n);
      n.loadSwiWasmUriSource=async uri=>{const source=await load(uri);entered();await gate;return source;};
      const before=Object.keys(n.swiWasmActorWorkers);
      const pending=n.query("toplevel_spawn(P,[name(source_wait),session(true),link(false),src_uri('https://n3.elfenbenstornet.se/closure-source.pl')])").then(answer=>({answer}),error=>({error:String(error)}));
      await at;check(Object.keys(n.swiWasmNameReservations||{}).length===1,'source fetch retains a reservation');
      close();release();const result=await pending;
      check(!result.answer||result.answer.type!=='success','late source completion cannot publish');
      check(Object.keys(n.swiWasmActorWorkers).filter(p=>!before.includes(p)).every(p=>!n.swiWasmActorPidLive(p)),'late source completion leaves no unowned child');
      check(Object.keys(n.swiWasmNameReservations||{}).length===0,'late source completion leaves no reservation');
      await run('whereis(source_wait,undefined)');
     }else if(id==='BC-001'){
      await run('self(S),spawn(receive({probe->catch((self(Me),register(late_child,Me)),E,true),S!survived(E)}),P,[link(false)]),register(before_close,P),register_service(kept_service,P),assertz(survivor(P))');
      const ctx=n.getSwiWasmPromiseContext();let cancelled=false,complete;
      const ref=ctx.create(()=>({promise:new Promise(r=>{complete=r;}),cancel:()=>{cancelled=true;}}));
      close();close();
      check(cancelled&&!ctx.items[ref],'promise cancellation and idempotent closure');complete('success([late],false).');await Promise.resolve();check(!ctx.items[ref],'late completion stays retired');
      await run('whereis(before_close,undefined),survivor(P),whereis_service(kept_service,P),catch(register(late_parent,P),error(permission_error(register,actor_name,late_parent),_),Denied=true),Denied==true,P!probe,receive({survived(error(permission_error(register,actor_name,late_child),_))->true},[timeout(2),on_timeout(throw(no_survivor))])');
      let rejected=false;try{ctx.create(()=>({promise:Promise.resolve('late')}));}catch(_){rejected=true;}check(rejected,'closed promise admission');
     }else if(id==='BC-007'){
      await run("toplevel_spawn(P,[name(committed),session(true),link(false),src_text('value(alive).')]),assertz(committed_pid(P))");
      close();
      await run('committed_pid(P),whereis(committed,undefined),toplevel_call_synch(P,value(V),success(P,[alive],false),[template(V),timeout(2)]),toplevel_halt(P)');
      check(Object.keys(n.swiWasmNameReservations||{}).length===0,'committed name has no pending rollback ownership');
     }else if(id==='BC-005'){
      const other=await create('worker');
      await run('spawn(receive({stop->true}),P,[link(false)]),register(shared,P),assertz(saved(P))');
      await run('whereis(shared,undefined),spawn(receive({stop->true}),P,[link(false)]),register(shared,P),assertz(saved(P))',other);
      close();await run('whereis(shared,undefined)');await run('saved(P),whereis(shared,P),P!stop',other);
      check(!other.swiWasmClientContextClosed,'other runtime context stays open');
     }else{
      let entered,release;
      const at=new Promise(r=>{entered=r;});const gate=new Promise(r=>{release=r;});
      const method=id==='BC-004'?'commitSwiWasmName':'publishSwiWasmName';
      const original=n[method].bind(n);let args;
      n[method]=function(...xs){args=xs;const result=id==='BC-003'?original(...xs):undefined;entered();return gate.then(()=>id==='BC-003'?result:original(...xs));};
      // Keep the actor alive; a ready real Worker exists before publication.
      const pending=n.query("toplevel_spawn(P,[name(preparing),session(true),link(false),src_text('ready_marker(ok).')])").then(answer=>({answer}),error=>({error:String(error)}));
      await at;
      check(Object.keys(n.swiWasmNameReservations).length===1,'one pending reservation at barrier');
      check(n.whereisSwiWasmActorName('actor','preparing')==='undefined','pending alias invisible');
      const children=Object.keys(n.swiWasmActorWorkers).filter(p=>p!==String(n.swiWasm2ShellPid));
      check(children.some(p=>n.swiWasmActorPidLive(p)),'prepared child is alive before closure');
      if(id==='BC-006'){
       n.dispose();
       check(n.swiWasmClientContextClosed===true&&Object.keys(n.swiWasmNameReservations||{}).length===0,'dispose retires admission and reservations before returning');
      }else close();
      release();const result=await pending;
      check(!result.answer||result.answer.type!=='success','late creation cannot report successful publication');
      check(n.whereisSwiWasmActorName('actor','preparing')==='undefined','late alias remains absent');
      check(Object.keys(n.swiWasmNameReservations||{}).length===0,'pending reservations retired '+JSON.stringify({closed:n.swiWasmClientContextClosed,reservations:n.swiWasmNameReservations}));
      check(Object.keys(n.swiWasmStartups||{}).length===0,'startup rollback ownership retired');
      check(children.every(p=>!n.swiWasmActorPidLive(p)),'failed attempt reclaims its prepared child');
      if(id!=='BC-006'){
       check(n.reserveSwiWasmName(mode==='main'?'main':n.swiWasm2ShellPid,'late-token','late')!=='reserved','late reservation denied');
       check(n.commitSwiWasmName(...args)!==true,'stale commit denied');
       await run('whereis(preparing,undefined)');
      }
     }
     return checks;
    }finally{nodes.forEach(x=>x.dispose());}
   },{mode,id}),15000,mode+' '+id);
   row.status='pass';
  }catch(e){row.status='fail';row.detail=String(e.stack||e);}finally{await page.close();}
  rows.push(row);save();console.log(row.candidate,id,row.status,row.detail||'');
 }}finally{clearTimeout(watchdog);await browser.close();await new Promise(r=>server.close(r));}
 process.exitCode=rows.some(r=>r.status!=='pass')?1:0;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
