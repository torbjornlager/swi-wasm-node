import json,hashlib,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import package_runtime as package
class Packages(unittest.TestCase):
    def fixture(self,root):
        (root/'file.js').write_text('runtime\n');m={'format':1,'files':{'file.js':package.digest(root/'file.js')}}
        (root/'manifest.json').write_text(json.dumps(m));return m
    def test_drift_missing_extra_and_manifest_pin(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);self.fixture(root);pin=package.digest(root/'manifest.json');package.verify(root,pin)
            (root/'file.js').write_text('changed')
            with self.assertRaisesRegex(ValueError,'differs'):package.verify(root,pin)
            (root/'file.js').unlink()
            with self.assertRaisesRegex(ValueError,'inventory'):package.verify(root,pin)
            self.fixture(root);(root/'extra.js').write_text('unexpected')
            with self.assertRaisesRegex(ValueError,'inventory'):package.verify(root,pin)
            (root/'extra.js').unlink()
            with self.assertRaisesRegex(ValueError,'manifest'):package.verify(root,'0'*64)
    def test_symlink_and_path_escape_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t)/'package';root.mkdir();other=Path(t)/'outside';other.write_text('runtime\n');self.fixture(root)
            (root/'file.js').unlink();(root/'file.js').symlink_to(other)
            with self.assertRaisesRegex(ValueError,'escaping'):package.verify(root)
    def test_archive_is_byte_reproducible(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t)/'package';root.mkdir();self.fixture(root)
            a=Path(t)/'a.tgz';b=Path(t)/'b.tgz';package.archive(root,a);package.archive(root,b)
            self.assertEqual(a.read_bytes(),b.read_bytes())
    def test_vendored_native_input_matches_recorded_pin(self):
        self.assertEqual(package.native_input()['sha256'],package.digest(package.ROOT/'third_party/sxml_schema.pl'))
if __name__=='__main__':unittest.main()
