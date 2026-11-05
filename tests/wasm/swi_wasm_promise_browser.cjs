// Real browser engines and HTTP transport; the fixture is an ordinary local node.
'use strict';
const http=require('node:http');
module.exports=async function promiseContexts(browser,base) {
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost'),goal=url.searchParams.get('goal')||'';
    const reply=()=>{res.writeHead(200,{'Content-Type':'text/plain','Access-Control-Allow-Origin':'*'});
      res.end(goal.includes('remote_failure')?'failure.':goal.includes('remote_exception')?'error(boom).':goal.includes('shared_variables')?'success([v(A,A)],false).':'success([v(ok)],false).');};
    if(goal.includes('pending'))setTimeout(reply,400);else reply();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    for(const mode of ['worker','main']) {
      const page=await browser.newPage();
      try {
        await page.goto(base+'vendor/swi-wasm-minimal.html');
        await page.waitForFunction(()=>typeof SwiWasmNode==='object');
        const checks=await page.evaluate(async ({mode,uri})=>{
          const checks=[],nodes=[];
          const create=async mode=>{const node=SwiWasmNode.create({mode,
            workerUrl:new URL('../swi_wasm_actor_worker.js',location.href).href,
            engineUrl:new URL('../swipl-bundle.js',location.href).href,
            prologBaseUrl:new URL('../wasm/',location.href).href,sharedDatabaseUrl:null});
            nodes.push(node);await node.open();return node;};
          const require=(ok,label)=>{if(!ok)throw Error(mode+': '+label);checks.push(label);};
          const n=await create(mode);
          const context=n.getSwiWasmPromiseContext();
          const run=async (goal,label,node=n)=>{const a=await node.query(goal);require(a.type==='success',label+(a.type==='success'?'':' '+JSON.stringify(a)));};
          const make=goal=>"promise('"+uri+"',"+goal+",R,[template(v(ok))]),";
          const missing="catch(yield(R,_),error(existence_error(promise,R),_),Missing=true),Missing==true";
          const result="receive({result(A)->true},[timeout(3),on_timeout(throw(no_result))]),A==success([v(ok)],false)";
          try {
            await run(make('pending')+"self(S),spawn((yield(R,A),send(S,result(A))),_,[link(false)]),"+result,'parent creates, child collects pending answer');
            await run("self(S),spawn(("+make('pending')+"send(S,created(R))),C,[monitor(true)]),receive({created(R)->true}),receive({down(C,C,true)->true}),yield(R,success([v(ok)],false))",'creator Worker exits before parent collection');
            await run("self(S),spawn(("+make('true')+"send(S,created(R))),_,[link(false)]),receive({created(R)->true}),spawn((yield(R,A),send(S,result(A))),_,[link(false)]),"+result,'siblings share a ready promise');
            await run(make('pending')+"spawn(promise_cleanup(R),C,[monitor(true)]),receive({down(C,C,true)->true}),"+missing,'child disposes parent reference');
            await run(make('pending')+"yield(R,T,[timeout(0)]),T==timeout,yield(R,success([v(ok)],false))",'timeout releases claim without consuming promise');
            await run(make('pending')+"setup_call_cleanup(true,true,promise_cleanup(R)),"+missing,'promise_cleanup works inside Prolog cleanup');
            await run(make('pending')+"self(S),spawn((send(S,collecting),yield(R,_)),C,[link(false)]),receive({collecting->true}),sleep(0.05),catch(yield(R,_),error(permission_error(collect,promise,R),_),Busy=true),Busy==true,exit(C,kill),yield(R,success([v(ok)],false))",'competing collector denied; killing collector releases claim');
            await run(make('pending')+"self(S),spawn((send(S,collecting),catch(yield(R,_),error(existence_error(promise,R),_),send(S,disposed))),_,[link(false)]),receive({collecting->true}),sleep(0.05),promise_cleanup(R),receive({disposed->true},[timeout(2),on_timeout(throw(no_disposal))])",'disposal wakes a cross-engine waiter');
            await run(make('true')+"self(S),spawn((yield(R,wrong)->send(S,unexpected);send(S,mismatched)),_,[link(false)]),receive({mismatched->true}),"+missing,'output mismatch consumes selected result');
            await run(make('shared_variables')+"yield(R,success([v(A,B)],false)),A==B,var(A)",'answer variable sharing survives transport');
            await run(make('remote_failure')+"yield(R,failure)",'remote failure is a promise answer');
            await run(make('remote_exception')+"yield(R,error(boom))",'remote exception is a promise answer');
            // Retain context-owned state across an interrupted shell query.
            const a=await n.query(make('pending')+'assertz(saved_promise(R)),yield(R,_)');
            // This first query also establishes ordinary successful collection.
            require(a.type==='success','ordinary collection before interruption control');
            const pending=n.query(make('pending')+'retractall(saved_promise(_)),assertz(saved_promise(R)),yield(R,_)');
            await new Promise(r=>setTimeout(r,50));await n.abort();
            require((await pending).type==='abort','collector interruption returns Abort');
            await run('saved_promise(R),yield(R,success([v(ok)],false))','replacement query collects interrupted query promise');
            const withChild=n.query(make('pending')+"self(S),spawn((yield(R,A),send(S,result(A))),_,[link(false)]),receive({never->true})");
            await new Promise(r=>setTimeout(r,70));await n.abort();require((await withChild).type==='abort','parent abort while child collects');
            await run(result,'parent interruption preserves another actor collection');
            if(mode==='worker') {
              const saved=await n.query(make('pending')+'true'),ref=saved.data[0].R;
              try {await n.query('broken(');} catch (_) {}
              await n.open();await run('yield('+ref+',success([v(ok)],false))','replacement shell inherits retained client context');
            }
            const expiring=await n.query(make('pending')+'true'),expiredRef=expiring.data[0].R;
            const entry=context.items[expiredRef],cancel=entry.cancel;let cancelled=false;
            entry.cancel=()=>{cancelled=true;cancel();};entry.deadline=Date.now()-1;
            await run('R='+expiredRef+','+missing,'expiry checked by cross-engine access despite delayed timer');
            require(cancelled&&!context.items[expiredRef],'expiry cancels pending context transport');
            await new Promise(r=>setTimeout(r,450));require(!context.items[expiredRef],'late HTTP completion cannot revive expired entry');
            // Two runtime instances are two client contexts, even on one page.
            const other=await create('worker');
            const original=n.makeBrowserPromiseRef.bind(n);n.makeBrowserPromiseRef=()=> '2345678901';
            await run(make('true')+'assertz(foreign_probe(R))','context A creates forced numeric reference');n.makeBrowserPromiseRef=original;
            await run('R=2345678901,'+missing,'foreign context cannot collect',other);
            await run('promise_cleanup(2345678901)','foreign context cleanup is harmless',other);
            const otherMint=other.makeBrowserPromiseRef.bind(other);other.makeBrowserPromiseRef=()=> '2345678901';
            await run(make('remote_failure')+'R=2345678901,yield(R,failure)','same numeric reference in another context designates only its own answer',other);other.makeBrowserPromiseRef=otherMint;
            await run('foreign_probe(R),yield(R,success([v(ok)],false))','foreign cleanup leaves owner answer intact');
            // Context closure cancels transport and wakes pending collectors.
            const ref=context.create(()=>({promise:new Promise(()=>{}),cancel:()=>{window.contextCancelled=true;}}));
            const token=context.claim(ref,'closing-probe'),wait=context.wait(ref,token,-1);
            await run("self(S),spawn(receive({ping->send(S,alive)}),P,[link(false)]),assertz(context_survivor(P))","actor survives context closure control");
            n.closeSwiWasmPromiseContext();require(await wait==='missing_promise'&&window.contextCancelled&&Object.keys(context.items).length===0,'context closure retires entries, wakes waiters and cancels transport');
            await run('context_survivor(P),send(P,ping),receive({alive->true},[timeout(2),on_timeout(throw(no_survivor))])','closing promise context does not terminate surviving actors');
            let denied=false;try{context.create(()=>({promise:Promise.resolve('late')}));}catch(e){denied=/context closed/.test(e.message);}
            require(denied,'closed context refuses new promise admission');
            n.dispose();
          } finally {nodes.forEach(node=>node.dispose());}
          return checks;
        },{mode,uri:'http://127.0.0.1:'+server.address().port});
        for(const check of checks)console.log('  ok   promise browser '+mode+': '+check);
      } finally {await page.close();}
    }
  } finally {await new Promise(r=>server.close(r));}
};
