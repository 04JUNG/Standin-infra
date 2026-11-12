import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("publisher", Path(__file__).with_name("publish-scene-release.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / "efs"
        self.target.mkdir()
        self.archive = self.root / "bundle.tar.gz"
        self.manifest = json.dumps({"release_id": "release-1", "approved": True}).encode()
        self.sha = hashlib.sha256(self.manifest).hexdigest()

    def bundle(self, members):
        with tarfile.open(self.archive, "w:gz") as tar:
            for name, data, kind in members:
                item = tarfile.TarInfo(name)
                if kind:
                    item.type = kind
                    item.linkname = "../../outside"
                    tar.addfile(item)
                else:
                    item.size = len(data)
                    tar.addfile(item, io.BytesIO(data))

    def verify(self, manifest, sha):
        # Production uses the worker's full verify_release, not this small fixture.
        if publisher.digest(manifest) != sha or not json.loads(manifest.read_text())["approved"]:
            raise ValueError("approval/hash gate")

    def test_publish_then_idempotent_without_replacement(self):
        self.bundle([("release.json", self.manifest, None), ("library/a.bvh", b"pose", None)])
        self.assertEqual(publisher.publish(self.archive, self.target, "release-1", self.sha, self.verify), "published")
        before = (self.target / "release-1/release.json").stat().st_mtime_ns
        self.assertEqual(publisher.publish(self.archive, self.target, "release-1", self.sha, self.verify), "already_published")
        self.assertEqual((self.target / "release-1/release.json").stat().st_mtime_ns, before)

    def test_archive_attacks_never_escape_or_publish(self):
        for name, kind in [("../outside", None), ("/absolute", None), ("x\\..\\outside", None),
                           ("link", tarfile.SYMTYPE), ("link", tarfile.LNKTYPE), ("pipe", tarfile.FIFOTYPE)]:
            with self.subTest(name=name, kind=kind):
                self.bundle([("release.json", self.manifest, None), (name, b"bad", kind)])
                with self.assertRaises(ValueError):
                    publisher.publish(self.archive, self.target, "release-1", self.sha, self.verify)
                self.assertEqual(list(self.target.iterdir()), [])
                self.assertFalse((self.root / "outside").exists())

    def test_duplicate_archive_member_rejected(self):
        self.bundle([("release.json", self.manifest, None), ("release.json", self.manifest, None)])
        with self.assertRaises(ValueError):
            publisher.publish(self.archive, self.target, "release-1", self.sha, self.verify)

    def test_failed_hash_approval_or_identity_is_not_published(self):
        for data, sha in [(self.manifest, "a" * 64),
                          (json.dumps({"release_id": "release-1", "approved": False}).encode(), None),
                          (json.dumps({"release_id": "other", "approved": True}).encode(), None)]:
            with self.subTest(data=data):
                self.bundle([("release.json", data, None)])
                with self.assertRaises(ValueError):
                    publisher.publish(self.archive, self.target, "release-1",
                                      sha or hashlib.sha256(data).hexdigest(), self.verify)
                self.assertEqual(list(self.target.iterdir()), [])

    def test_existing_different_release_never_overwritten(self):
        final = self.target / "release-1"
        final.mkdir()
        (final / "release.json").write_bytes(b"old release")
        self.bundle([("release.json", self.manifest, None)])
        with self.assertRaises(ValueError):
            publisher.publish(self.archive, self.target, "release-1", self.sha, self.verify)
        self.assertEqual((final / "release.json").read_bytes(), b"old release")


if __name__ == "__main__":
    unittest.main()
