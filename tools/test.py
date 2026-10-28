#!/usr/bin/env python3
"""Test the packaged runtime. Native schema/wire comparison is explicit and optional."""
from pathlib import Path
import argparse,json,os,shutil,signal,subprocess,tempfile,time,sys
sys.dont_write_bytecode=True
from package_runtime import verify

def run(label,command,env,root,out):
    start=time.monotonic()
    with (out/(label+'.log')).open('w') as log:
        p=subprocess.Popen(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:code=p.wait(timeout=900)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid,signal.SIGTERM)
            try:p.wait(timeout=2)
            except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
            code=124
    print(label,code,flush=True)
    return dict(label=label,command=command,exit_code=code,seconds=round(time.monotonic()-start,3))

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--package',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--report',type=Path,required=True);p.add_argument('--native-root',type=Path);p.add_argument('--swipl',default=os.environ.get('SWIPL'));p.add_argument('--javascript-only',action='store_true');p.add_argument('--host-module',type=Path);a=p.parse_args()
    root=a.package.resolve();manifest=verify(root);a.report.mkdir(parents=True,exist_ok=False)
    env=dict(os.environ);env.pop('TRINITY_PINNED_SWI_ROOT',None);env.pop('SWI_WASM_TEST_HOST',None)
    if a.host_module:env['SWI_WASM_TEST_HOST']=str(a.host_module.resolve())
    if a.native_root:
        native=a.native_root.resolve();head=subprocess.check_output(['git','-C',str(native),'rev-parse','HEAD'],text=True).strip()
        if head!=manifest['schema']['revision']:raise ValueError('test native checkout differs from package schema pin')
        env['TRINITY_PINNED_SWI_ROOT']=str(native)
    if a.swipl:env['SWIPL']=a.swipl
    node=shutil.which('node');assert node,'Node.js is required'
    rows=[]
    with tempfile.TemporaryDirectory(prefix='wasm-runtime-tests-') as temporary:
        wasm=Path(temporary)/'wasm';shutil.copytree(root/'web/wasm',wasm);shutil.copy2(root/'tests/fixtures/wasm/shared_db.pl',wasm/'shared_db.pl');env['WP_WASM_SOURCE_DIR']=str(wasm)
        plans=[('worker-mailbox',[node,'tests/wasm/swi_wasm_actor_worker_smoke.js']),('standalone',[node,'tests/wasm/swi_wasm_standalone.js']),('semantic-contracts',[node,'tests/wasm/swi_wasm_contracts.js'])]
        if not a.javascript_only:
            plans.insert(0,('schema-equivalence',[sys.executable,'tools/check_statechart_wasm_equivalence.py','--wasm-dir',str(root/'web/wasm')]+(['--native-root',str(a.native_root.resolve())] if a.native_root else [])))
            if a.swipl:plans.insert(0,('statechart-unit',[a.swipl,'-f','none','-q','-p','browser_prolog='+str(wasm),'-s','tests/test_statechart_wasm.pl','-g','swi_wasm_statechart_tests:run','-t','halt']))
        for label,command in plans:
            rows.append(run(label,command,env,root,a.report))
            (a.report/'results.json').write_text(json.dumps(dict(source=manifest['source'],native_integration=bool(a.native_root),host_integration=bool(env.get('SWI_WASM_TEST_HOST')),runs=rows),indent=2)+'\n')
    verify(root)
    return int(any(row['exit_code'] for row in rows))
if __name__=='__main__':sys.exit(main())
