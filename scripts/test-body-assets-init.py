import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('body_init', Path(__file__).with_name('body-assets-init.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.key = 'body-models/releases/test-v1/manifest.json'
        self.data = {'body-catalog.json': b'{}', 'body-models.json': b'{}', 'characters.json': b'{}', 'fbx/test.fbx': b'fbx-bytes'}
        self.manifest = dict(schema='body-assets.v1', version='test-v1', files=[
            dict(path=p, size=len(d), sha256=hashlib.sha256(d).hexdigest(), roles=r)
            for p,d,r in [('body-catalog.json',b'{}',['inference']), ('body-models.json',b'{}',['bff']), ('characters.json',b'{}',['converter']), ('fbx/test.fbx',b'fbx-bytes',['converter','inference'])]])
        self.addCleanup(self.temp.cleanup)

    def run_install(self, role='inference'):
        raw = json.dumps(self.manifest).encode()
        env = dict(BODY_ASSETS_ROLE=role, BODY_ASSETS_MANIFEST_KEY=self.key, BODY_ASSETS_MANIFEST_SHA256=hashlib.sha256(raw).hexdigest(), BODY_ASSETS_ROOT=str(self.root/role))
        def fetch(key, limit):
            return raw if key == self.key else self.data[key.removeprefix('body-models/releases/test-v1/')]
        return module.install(fetch, env)

    def test_all_roles_install_only_their_files(self):
        for role in ['inference','converter','bff']:
            receipt=self.run_install(role)
            self.assertEqual(receipt['files'], 1 if role=='bff' else 2)
            self.assertEqual((self.root/role/'fbx/test.fbx').exists(),role!='bff')
            self.assertTrue((self.root/role/'.body-assets-ready.json').exists())

    def test_corrupted_bytes_do_not_publish_ready_or_catalog(self):
        self.data['fbx/test.fbx']=b'bad-bytes'
        with self.assertRaises(ValueError):self.run_install()
        self.assertFalse((self.root/'inference'/'body-catalog.json').exists())
        self.assertFalse((self.root/'inference'/'.body-assets-ready.json').exists())

    def test_rejects_path_escape_and_duplicate(self):
        for path in ['../outside.fbx','body-catalog.json']:
            self.manifest['files'][-1]['path']=path
            with self.assertRaises(ValueError):self.run_install()
        self.assertFalse((self.root/'outside.fbx').exists())

    def test_role_catalog_is_required(self):
        self.manifest['files'][0]['roles']=['converter']
        with self.assertRaises(ValueError):self.run_install()

    def test_manifest_is_pinned(self):
        env=dict(BODY_ASSETS_ROLE='bff',BODY_ASSETS_MANIFEST_KEY=self.key,BODY_ASSETS_MANIFEST_SHA256='0'*64,BODY_ASSETS_ROOT=str(self.root))
        with self.assertRaises(ValueError):module.install(lambda key,limit:b'{}',env)

if __name__=='__main__':unittest.main()
