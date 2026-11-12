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
            return raw if key == self.key else self.data[key.removeprefix(self.key.rsplit('/', 1)[0] + '/')]
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

    def test_shape_assets_are_verified_and_role_filtered(self):
        entries = [('shape-bakes.json', ['converter']), ('sources/body.blend', ['converter']), ('sources/body.py', ['converter']), ('runtime/body.ssr', ['bff'])]
        for path, roles in entries:
            data = path.encode()
            self.data[path] = data
            self.manifest['files'].append(dict(path=path, size=len(data), sha256=hashlib.sha256(data).hexdigest(), roles=roles))
        self.run_install('converter')
        self.run_install('bff')
        self.assertTrue((self.root/'converter'/'sources/body.blend').exists())
        self.assertTrue((self.root/'bff'/'runtime/body.ssr').exists())
        self.assertFalse((self.root/'bff'/'sources/body.blend').exists())
        self.data['runtime/body.ssr'] = b'corrupt-runtime'
        with self.assertRaises(ValueError): self.run_install('bff')

    def test_nested_preset_release_is_pinned_and_path_safe(self):
        self.key = 'body-models/releases/test-v1/presets-0897cb6c18fd/manifest.json'
        self.assertEqual(self.run_install('bff')['files'], 1)
        for suffix in ['../escape', 'presets-not-a-digest', 'presets-0897cb6c18fd/extra']:
            self.key = 'body-models/releases/test-v1/' + suffix + '/manifest.json'
            with self.assertRaisesRegex(ValueError, 'invalid pinned body manifest'):
                self.run_install('bff')

    def test_reviewed_converter_bundle_has_a_bounded_total(self):
        # Metadata only: reject oversized releases before any payload is fetched.
        for n in range(4):
            self.manifest['files'].append(dict(path=f'fbx/large-{n}.fbx', size=200*1024*1024,
                sha256='0'*64, roles=['converter']))
        with self.assertRaisesRegex(ValueError, 'body release size exceeded'):
            self.run_install('converter')

    def test_manifest_is_pinned(self):
        env=dict(BODY_ASSETS_ROLE='bff',BODY_ASSETS_MANIFEST_KEY=self.key,BODY_ASSETS_MANIFEST_SHA256='0'*64,BODY_ASSETS_ROOT=str(self.root))
        with self.assertRaises(ValueError):module.install(lambda key,limit:b'{}',env)

    def test_prepared_budget_is_bounded_and_converter_only(self):
        files = [dict(path=f'fbx/base-{n}.fbx', size=256*1024*1024, roles=['converter']) for n in range(3)]
        files += [dict(path='fbx/prepared-'+'a'*64+'.fbx', size=10*1024*1024, roles=['converter']),
                  dict(path='qa/prepared-'+'a'*64+'.json', size=100, roles=['converter'])]
        self.assertEqual(module.check_budget(files, module.PREPARED_PROFILE), 960*1024*1024)
        with self.assertRaises(ValueError): module.check_budget(files)
        for role in ['inference','bff']:
            with self.assertRaises(ValueError): module.check_budget(files, module.PREPARED_PROFILE, role)
        with self.assertRaises(ValueError): module.check_budget(files, 'unbounded')
        files[0]['size'] += 1
        with self.assertRaises(ValueError): module.check_budget(files, module.PREPARED_PROFILE)

    def test_prepared_budget_requires_small_paired_hash_named_files(self):
        fbx=dict(path='fbx/prepared-'+'a'*64+'.fbx', size=10, roles=['converter'])
        qa=dict(path='qa/prepared-'+'a'*64+'.json', size=10, roles=['converter'])
        for files in [[fbx], [qa], [fbx,dict(qa,size=256*1024+1)],
                      [dict(fbx,size=64*1024*1024+1),qa], [dict(fbx,roles=['bff']),qa]]:
            with self.assertRaises(ValueError): module.check_budget(files,module.PREPARED_PROFILE)

    def test_prepared_corruption_leaves_old_install_and_rollback_restores_catalog(self):
        self.run_install('converter')
        old=(self.root/'converter/characters.json').read_bytes()
        self.data['characters.json']=b'corrupt'
        with self.assertRaises(ValueError):self.run_install('converter')
        self.assertEqual((self.root/'converter/characters.json').read_bytes(),old)
        self.data['characters.json']=b'{}'
        self.run_install('converter')
        self.assertEqual((self.root/'converter/characters.json').read_bytes(),old)

if __name__=='__main__':unittest.main()
