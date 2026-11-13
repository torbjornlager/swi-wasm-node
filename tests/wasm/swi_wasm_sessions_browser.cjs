// Common high-level session contract, exercised in a real browser in both modes.
'use strict';
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
  try {
    for (const mode of ['worker','main']) {
      const page = await browser.newPage();
      const errors = []; page.on('pageerror',e=>errors.push(String(e)));
      await page.goto((process.env.RUNTIME_URL || 'http://localhost:8096/')+'vendor/swi-wasm-minimal.html');
      await page.waitForFunction(()=>typeof SwiWasmNode==='object');
      const checks = await page.evaluate(async mode => {
        const checks=[];
        function require(test,label) { if(!test)throw new Error(mode+': '+label);checks.push(label); }
        const wait=ms=>new Promise(r=>setTimeout(r,ms));
        const events=[];
        const create=extra=>SwiWasmNode.create(Object.assign({mode,
          workerUrl:new URL('../swi_wasm_actor_worker.js',location.href).href,
          engineUrl:new URL('../swipl-bundle.js',location.href).href,
          prologBaseUrl:new URL('../wasm/',location.href).href,sharedDatabaseUrl:null,
          onEvent:e=>events.push(e),onInput:()=> 'hello.'
        },extra));
        let invalidMode=false;try{create({mode:'invalid'})}catch(e){invalidMode=true}require(invalidMode,'invalid mode rejected');
        let n, readyAnswer;
        n=create({onEvent:e=>{events.push(e);if(mode==='main'&&e.type==='ready')readyAnswer=n.query('value(X)');}});window.apiNode=n;
        let early=false;try{await n.query('true')}catch(e){early=/Open a session/.test(e.message)}require(early,'query requires open');
        const first=n.open({source:':- dynamic value/1.\nvalue(original).'});
        require(n.open()===first,'open is idempotent');await first;
        require(n.isSwiWasm2Mode===(mode==='worker'),'execution model selected');
        if(mode==='main')require((await readyAnswer).data[0].X==='original','ready event follows source and session initialization');
        if(mode==='main') {
          const second=create();let blocked=false;
          try{await second.open()}catch(e){blocked=/already open/.test(e.message)}finally{second.dispose()}
          require(blocked,'one main session per page');
          require((await n.query('current_module(dom)')).type==='success','DOM library preloaded');
          require((await n.query("E := document[getElementById(#status)], append_html(E, span([id='session-dom-probe'],'DOM'))")).type==='success','native DOM access');
          require(document.getElementById('session-dom-probe').textContent==='DOM','DOM modified');
          const independent=create({mode:'worker'});await independent.open({source:'other_value(separate).'});
          require((await independent.query('other_value(X)')).data[0].X==='separate','Worker session coexists with main');independent.dispose();
        }
        require((await n.query('self(S),spawn(receive({ping(From)->From!pong}),P),P!ping(S),receive({pong->true})')).type==='success','actor messaging');
        require((await n.query(`statechart_spawn(P,[trace(true),src_text('<statechart version="0.2" initial="s"><state id="s"/></statechart>')]),exit(P,kill)`)).type==='success','statechart lifecycle');
        let a=await n.query('member(X,[a,b,c])');
        require(a.type==='success'&&a.data.map(r=>r.X).join(',')==='a,b,c'&&!a.more,'default collects all answers');
        a=await n.query('member(X,[a,b,c])',{limit:2});
        require(a.data.map(r=>r.X).join(',')==='a,b'&&a.more,'limited first page');
        let concurrent=false;try{await n.query('true')}catch(e){concurrent=true}require(concurrent,'query rejected during continuation');
        a=await n.next();require(a.data[0].X==='c'&&!a.more,'next final page');
        a=await n.query('member(X,[a,b,c])','[limit(1),offset(1),once(true)]');
        require(a.data[0].X==='b'&&!a.more,'text options offset and once');
        await n.query('retractall(effect(_))');
        a=await n.query('member(X,[a,b,c]),assertz(effect(X))',{limit:1});await n.stop();
        require((await n.query('findall(X,effect(X),Xs)')).data[0].Xs==='[a]','Stop preserves lazy side effects');
        a=await n.query('member(X,[a,b,c]),assertz(effect(X))',{limit:1,once:true});
        require(a.data[0].X==='a'&&!a.more,'once discards continuation');
        await n.query('retractall(value(_)),assertz(value(edited))');await n.open();
        require((await n.query('value(X)')).data[0].X==='edited','source loaded once; edits persist');
        for(const [goal,expected] of [["X='mary jane'","'mary jane'"],['X is 6*7','42'],['X="hé😀"',"[h,'é','😀']"],['X=[a,b]','[a,b]']]) {
          a=await n.query(goal);require(a.data[0].X===expected,'common binding presentation '+goal);
        }
        a=await n.query('(member(X,[a,b]);throw(partial_probe))',{limit:3});
        require(a.type==='success'&&a.data.length===2&&a.more,'partial page before exception');
        a=await n.next();require(a.type==='error'&&/partial_probe/.test(a.data),'Next delivers deferred exception');
        require((await n.query('true')).type==='success','recover after exception');
        for (const goal of ["A='.'(a,[])", "A='[]'", "A=f()", "throw(error(test('.'(a,[])),_))", "A=nested([ok,'.'(a,[])])"]) {
          a=await n.query(goal);
          require(a.type==='error'&&/representation_error\(portable_term\)/.test(a.details||a.data), 'portable binding rejected '+goal);
          a=await n.query('A=[a],B=[],P=pair(X,X,Y),X\\==Y');
          require(a.type==='success'&&a.data[0].A==='[a]'&&a.data[0].B==='[]', 'valid lists and sharing after rejection');
        }
        a=await n.query("(A=ok;A='.'(a,[]))",{limit:1});
        require(a.type==='success'&&a.more,'valid page before nonportable answer');
        a=await n.next();
        require(a.type==='error'&&/portable_term/.test(a.details||a.data),'nonportable next page rejected');
        require((await n.query('true')).type==='success','session usable after nonportable next page');
        a=await n.query('dif(X,a)');require(a.type==='error'&&/constraints/.test(a.data),'attributed answers rejected');
        a=await n.query('(X=ok;dif(X,a))',{limit:3});require(a.type==='error'&&/constraints/.test(a.data),'constraint error discards the whole page');
        a=await n.query('writeln(flush_probe),fail');require(a.type==='failure','failure envelope');
        require(events.some(e=>e.type==='output'&&e.data.includes('flush_probe')),'output survives failure');
        a=await n.query('read(X)');require(a.data[0].X==='hello','onInput callback');
        const query=n.query('receive({never->true})');await wait(50);
        let simultaneous=false;try{await n.query('true')}catch(e){simultaneous=true}require(simultaneous,'concurrent query rejected');
        await n.abort();a=await query;require(a.type==='abort','Abort reaches pending query');
        require((await n.query('true')).type==='success','recover after Abort');
        const syntax=n.query('broken(');try{a=await syntax;require(a.type==='error','syntax error envelope')}catch(e){require(mode==='worker','Worker syntax error kills shell')}
        await n.open();require((await n.query('true')).type==='success','recover or reopen after syntax error');
        require(events.some(e=>e.type==='answer'),'answer events');
        const pending=n.query('receive({never->true})');await wait(30);n.dispose();
        let disposed=false;try{await pending}catch(e){disposed=/disposed/.test(e.message)}require(disposed,'dispose rejects pending query');
        let unusable=false;try{n.query('true')}catch(e){unusable=true}require(unusable,'disposed session unusable');
        // Input without a callback is registered before the prompt event, so a
        // synchronous node.input() in that event cannot miss its waiter.
        let manual;
        manual=create({onInput:undefined,onEvent:e=>{if(e.type==='prompt')manual.input('manual.')}});
        await manual.open();a=await manual.query('read(X)');require(a.data[0].X==='manual','manual input after dispose/recreate');manual.dispose();
        if(mode==='main') {
          let finishInput;
          const late=create({onInput:()=>new Promise(r=>{finishInput=r})});await late.open();
          const waiting=late.query('read(X)');while(!finishInput)await wait(5);
          await late.abort();require((await waiting).type==='abort','Abort cancels input wait');
          finishInput('stale.');await wait(10);
          require((await late.query('true')).type==='success','late input cannot kill next query');late.dispose();
          const starting=create();const opening=starting.open();starting.dispose();
          let cancelled=false;try{await opening}catch(e){cancelled=/disposed/.test(e.message)}require(cancelled,'dispose during open');
          const failing=create({sharedDatabaseUrl:new URL('missing-shared.pl',location.href).href});
          let failed=false;try{await failing.open()}catch(e){failed=/404/.test(e.message)}finally{failing.dispose()}require(failed,'startup failure releases ownership');
          const replacement=create();await replacement.open();require((await replacement.query('true')).type==='success','fresh main session after startup failure');replacement.dispose();
        }
        return checks;
      },mode);
      if(mode==='main') {
        await page.locator('#compatibility').click();
        await page.waitForFunction(()=>document.getElementById('status').textContent==='Compatibility check: PASS');
      }
      assert.deepEqual(errors,[]);console.log(mode+': '+checks.length+' session checks passed');
      await page.close();
    }
    await require("./swi_wasm_promise_browser.cjs")(browser,process.env.RUNTIME_URL || "http://localhost:8096/");
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
