#!/usr/bin/env python3
"""Build/verify a deterministic browser runtime package; no checkout mutation."""
from pathlib import Path
import argparse,gzip,hashlib,json,os,shutil,subprocess,tarfile
ROOT=Path(__file__).resolve().parents[1]
SCHEMA='prolog/web_prolog/wasm/sxml_schema.pl'

def git(root,*args):
    return subprocess.check_output(['git','-C',str(root),*args],text=True,stderr=subprocess.PIPE).strip()

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def native_input(native=None):
    pin=json.loads((ROOT/'dependencies/native-schema.json').read_text())
    vendored=ROOT/'third_party/sxml_schema.pl'
    if digest(vendored)!=pin['schema_sha256']:raise ValueError('vendored schema differs from pinned upstream input')
    if native:
        if git(native,'rev-parse','HEAD')!=pin['revision']:raise ValueError('native schema dependency revision mismatch')
        expected=subprocess.check_output(['git','-C',str(native),'show',pin['revision']+':'+SCHEMA])
        if (native/SCHEMA).read_bytes()!=expected or expected!=vendored.read_bytes():raise ValueError('native schema differs from pinned input')
    return {'repository':pin['repository'],'revision':pin['revision'],'path':SCHEMA,'sha256':pin['schema_sha256']}

def verify(root,expected_manifest=None):
    raw=(root/'manifest.json').read_bytes()
    if expected_manifest and hashlib.sha256(raw).hexdigest()!=expected_manifest:raise ValueError('browser manifest differs from dependency pin')
    m=json.loads(raw)
    if m.get('format')!=1:raise ValueError('unknown browser package format')
    expected=set(m['files'])|{'manifest.json'}
    actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
    if actual!=expected:raise ValueError('browser package file inventory differs')
    for rel,sha in m['files'].items():
        path=root/rel
        if Path(rel).is_absolute() or '..' in Path(rel).parts or path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):raise ValueError('escaping browser package path: '+rel)
        if digest(path)!=sha:raise ValueError('browser package input differs: '+rel)
    return m

def build(output,native=None,allow_dirty=False):
    if output.exists():raise ValueError('output must not exist')
    revision=git(ROOT,'rev-parse','HEAD');dirty=bool(git(ROOT,'status','--porcelain','--untracked-files=all'))
    if dirty and not allow_dirty:raise ValueError('runtime source is dirty; commit first or explicitly use --allow-dirty for development')
    schema=native_input(native);engine=json.loads((ROOT/'dependencies/swi-wasm.json').read_text())
    if digest(ROOT/engine['bundle'])!=engine['bundle_sha256']:raise ValueError('engine bundle checksum mismatch')
    output.mkdir(parents=True)
    selected=['README.md','LICENSE','EXTRACTION.json','package.json','dependencies/swi-wasm.json','dependencies/swi-prolog-node.json','dependencies/native-schema.json','web/vendor/swi-wasm-node.js','web/vendor/swi-wasm-minimal.html','web/swi_wasm_actor_worker.js','web/swipl-bundle.js']
    for folder in ['docs','tests','third_party']:
        selected.extend(p.relative_to(ROOT).as_posix() for p in (ROOT/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix not in {'.pyc','.qlf'})
    selected+=['tools/package_runtime.py','tools/test.py','tools/check_statechart_wasm_equivalence.py','tools/serve.py']
    tracked=set(git(ROOT,'ls-files').splitlines())
    for rel in selected:
        if not dirty and rel not in tracked:continue
        if (ROOT/rel).is_symlink() or not (ROOT/rel).resolve().is_relative_to(ROOT):raise ValueError('escaping source input: '+rel)
        dest=output/rel;dest.parent.mkdir(parents=True,exist_ok=True)
        data=(ROOT/rel).read_bytes() if dirty else subprocess.check_output(['git','-C',str(ROOT),'show',revision+':'+rel])
        dest.write_bytes(data)
    wasm=output/'web/wasm';wasm.mkdir()
    for name in ['statechart_wasm.pl','statechart_wasm_exec.pl','statechart_wasm_model.pl','statechart_wasm_runtime.pl']:
        rel='prolog/web_prolog/wasm/'+name
        data=(ROOT/rel).read_bytes() if dirty else subprocess.check_output(['git','-C',str(ROOT),'show',revision+':'+rel])
        (wasm/name).write_bytes(data)
    shutil.copy2(ROOT/'third_party/sxml_schema.pl',wasm/'sxml_schema.pl')
    (wasm/'shared_db.pl').write_text('% Empty by default. The application supplies its own shared database.\n')
    m=dict(format=1,name='swi-wasm-node',version=json.loads((ROOT/'package.json').read_text())['version'],source={'repository':'https://github.com/torbjornlager/swi-wasm-node.git','revision':revision,'dirty':dirty},engine=engine,schema=schema,files={})
    for p in sorted(output.rglob('*')):
        if p.is_file():m['files'][p.relative_to(output).as_posix()]=digest(p)
    (output/'manifest.json').write_text(json.dumps(m,sort_keys=True,indent=2)+'\n')
    verify(output)
    return m

def archive(root,path):
    if path.exists():raise ValueError('archive must not exist')
    with path.open('wb') as target,gzip.GzipFile(filename='',fileobj=target,mode='wb',mtime=0) as stream,tarfile.open(fileobj=stream,mode='w') as tar:
        for p in sorted(root.rglob('*')):
            if not p.is_file():continue
            info=tar.gettarinfo(str(p),arcname='swi-wasm-node/'+p.relative_to(root).as_posix());info.uid=info.gid=info.mtime=0;info.uname=info.gname='';info.mode=0o644
            with p.open('rb') as f:tar.addfile(info,f)

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--native-root',type=Path);parser.add_argument('--output',type=Path);parser.add_argument('--allow-dirty',action='store_true');parser.add_argument('--archive',type=Path);parser.add_argument('--verify',type=Path);a=parser.parse_args()
    try:
        if a.verify:m=verify(a.verify.resolve())
        else:
            if not a.output:raise ValueError('--output is required')
            m=build(a.output.resolve(),a.native_root.resolve() if a.native_root else None,a.allow_dirty)
            if a.archive:archive(a.output.resolve(),a.archive.resolve())
        print(json.dumps({'revision':m['source']['revision'],'dirty':m['source']['dirty'],'files':len(m['files'])},indent=2))
    except (OSError,ValueError,KeyError,subprocess.CalledProcessError) as e:parser.exit(2,'browser package: '+str(e)+'\n')
if __name__=='__main__':main()
