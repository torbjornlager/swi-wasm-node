'use strict';
// Run the same manifest through the public session API in real Chrome engines.
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto');
const {chromium}=require('playwright');
const root=path.resolve(process.env.LIBRARY_RUNTIME_ROOT||path.join(__dirname,'../..'));
const manifest=process.env.LIBRARY_MANIFEST||path.join(root,'tests/fixtures/selective-receive.json');
const raw=fs.readFileSync(manifest),pack=JSON.parse(raw),rows=[];
const output=process.env.LIBRARY_REPORT;
function within(p,ms){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('actor case deadline')),ms);})]).finally(()=>clearTimeout(timer));}
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
 const watchdog=setTimeout(()=>{console.error('Actor browser watchdog expired');process.exitCode=2;browser.close();setTimeout(()=>process.exit(2),5000).unref();},120000);
 try{
  for(const mode of ['worker','main'])for(const c of pack.cases){
   const row={candidate:'swi-wasm-'+mode,id:c.id,title:c.title};
   const page=await browser.newPage();
   try{
    await page.goto('http://127.0.0.1:'+server.address().port+'/__library.html');
    await within(page.evaluate(async({mode,source})=>{window.libraryNode=SwiWasmNode.create({mode,workerUrl:new URL('/swi_wasm_actor_worker.js',location.href).href,engineUrl:new URL('/swipl-bundle.js',location.href).href,prologBaseUrl:new URL('/wasm/',location.href).href,sharedDatabaseUrl:null});await libraryNode.open({source});},{mode,source:(pack.source||'')+'\n'+(c.source||'')}),20000);
    row.observation=await within(page.evaluate(goal=>libraryNode.query('('+goal+'),LibraryCheck=passed',{limit:1}),c.goal),8000);
    const a=row.observation;
    if(a.type!=='success'||a.more!==false||a.data.length!==1||a.data[0].LibraryCheck!=='passed')throw Error(JSON.stringify(a));
    row.status='pass';
   }catch(error){row.status='fail';row.detail=String(error.stack||error);}
   finally{await page.close();}
   rows.push(row);save();console.log(row.candidate,c.id,row.status);
  }
 }finally{clearTimeout(watchdog);await browser.close();await new Promise(r=>server.close(r));}
 process.exitCode=rows.some(r=>r.status==='fail')?1:0;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
