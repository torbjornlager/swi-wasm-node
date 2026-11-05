'use strict';
// Run the same manifest through the public session API in real Chrome engines.
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto');
const {chromium}=require('playwright');
const root=path.resolve(process.env.LIBRARY_RUNTIME_ROOT||path.join(__dirname,'../..'));
const manifest=process.env.LIBRARY_MANIFEST||path.join(root,'tests/fixtures/standard-library.json');
const raw=fs.readFileSync(manifest),pack=JSON.parse(raw),rows=[];
const output=process.env.LIBRARY_REPORT;
const digest=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const runtimeFiles=Object.fromEntries(['web/vendor/swi-wasm-node.js','web/swi_wasm_actor_worker.js','web/swipl-bundle.js'].map(f=>[f,digest(path.join(root,f))]));
function save(){if(output)fs.writeFileSync(output,JSON.stringify({suite:pack.suite,manifest_sha256:crypto.createHash('sha256').update(raw).digest('hex'),runtime_files_sha256:runtimeFiles,package_manifest_sha256:fs.existsSync(path.join(root,'manifest.json'))?digest(path.join(root,'manifest.json')):null,results:rows,counts:{pass:rows.filter(r=>r.status==='pass').length,fail:rows.filter(r=>r.status==='fail').length}},null,2)+'\n');}
const server=http.createServer((req,res)=>{
 let name=new URL(req.url,'http://localhost').pathname;
 if(name==='/__library.html'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<meta charset="utf-8"><script src="/swi_wasm_actor_worker.js"></script><script src="/vendor/swi-wasm-node.js"></script>');return;}
 const file=path.resolve(root,'web','.'+name);
 if(!file.startsWith(path.join(root,'web')+path.sep)){res.writeHead(403);res.end();return;}
 fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.wasm')?'application/wasm':'text/plain');res.end(data);});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  for(const mode of ['worker','main']){
   const page=await browser.newPage();
   try{
    await page.goto('http://127.0.0.1:'+server.address().port+'/__library.html');
    await page.evaluate(async({mode,source})=>{window.libraryNode=SwiWasmNode.create({mode,workerUrl:new URL('/swi_wasm_actor_worker.js',location.href).href,engineUrl:new URL('/swipl-bundle.js',location.href).href,prologBaseUrl:new URL('/wasm/',location.href).href,sharedDatabaseUrl:null});await libraryNode.open({source});},{mode,source:pack.source});
    for(const c of pack.cases){
     const row={candidate:'swi-wasm-'+mode,id:c.id,title:c.title};
     try{
      row.observation=await page.evaluate(async goal=>await libraryNode.query('('+goal+'),LibraryCheck=passed',{limit:1}),c.goal);
      if(row.observation.type!=='success'||row.observation.more!==false||row.observation.data.length!==1)throw Error(JSON.stringify(row.observation));
      row.status='pass';
     }catch(e){row.status='fail';row.detail=String(e.message||e);}
     rows.push(row);save();console.log(row.candidate,c.id,row.status);
    }
    const child={candidate:'swi-wasm-'+mode,id:'LIBRARY-CHILD',title:'Spawned actor receives required library and copied private callback'};
    try{
     child.observation=await page.evaluate(async()=>await libraryNode.query("self(S),spawn((maplist(lib_args7,[a1],[a2],[a3],[a4],[a5],[a6],[a7]),countall(member(_,[a,b]),2),send(S,library_child_passed)),P,[src_predicates([lib_args7/7]),monitor(true)]),receive({library_child_passed->true},[timeout(3),on_timeout(throw(library_child_missing))]),receive({down(P,_,true)->true},[timeout(3),on_timeout(throw(library_child_down_missing))])",{limit:1}));
     if(child.observation.type!=='success')throw Error(JSON.stringify(child.observation));child.status='pass';
    }catch(e){child.status='fail';child.detail=String(e.message||e);}
    rows.push(child);save();console.log(child.candidate,child.id,child.status);
   }finally{await page.evaluate(()=>libraryNode.dispose()).catch(()=>{});await page.close();}
  }
 }finally{await browser.close();await new Promise(r=>server.close(r));}
 process.exitCode=rows.some(r=>r.status==='fail')?1:0;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
