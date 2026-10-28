#!/usr/bin/env python3
"""Serve only the packaged static browser assets, optionally beneath a URL prefix."""
from pathlib import Path
from functools import partial
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlsplit
import argparse,sys
sys.dont_write_bytecode=True
from package_runtime import verify
class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        prefix=self.server.mount
        if prefix and not urlsplit(self.path).path.startswith(prefix+'/'):
            self.send_error(404);return
        if prefix:self.path=self.path[len(prefix):]
        super().do_GET()
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--package',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--port',type=int,default=0);p.add_argument('--prefix',default='');a=p.parse_args();root=a.package.resolve();verify(root)
    prefix=a.prefix.rstrip('/');assert not prefix or prefix.startswith('/')
    server=ThreadingHTTPServer(('127.0.0.1',a.port),partial(Handler,directory=str(root/'web')));server.mount=prefix
    print(f'http://localhost:{server.server_port}{prefix}/vendor/swi-wasm-minimal.html',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
if __name__=='__main__':main()
