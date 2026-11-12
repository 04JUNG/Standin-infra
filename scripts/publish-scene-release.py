"""Explicit one-off publication of an approved, hash-pinned release to EFS.

Runs in the same image as the worker. No download or publication is performed by
the worker itself. Existing release directories are never replaced.
"""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import tempfile
import uuid

MAX_BYTES = 16 * 1024**3
MAX_MEMBERS = 100_000


def digest(file):
    result = hashlib.sha256()
    with Path(file).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def extract_regular_files(archive, destination):
    """Reject links, traversal, duplicate paths and resource-exhausting archives."""
    destination = Path(destination)
    seen = set()
    size = 0
    with tarfile.open(archive, "r:gz") as source:
        for count, member in enumerate(source, 1):
            name = PurePosixPath(member.name)
            if count > MAX_MEMBERS:
                raise ValueError("release archive has too many members")
            if name == PurePosixPath(".") and member.isdir():
                continue
            if (name.is_absolute() or ".." in name.parts
                    or "\\" in member.name or name in seen
                    or not (member.isfile() or member.isdir())):
                raise ValueError("invalid release archive member")
            seen.add(name)
            size += member.size
            if member.size < 0 or size > MAX_BYTES:
                raise ValueError("release archive is too large")
            target = destination.joinpath(*name.parts)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
            if member.isdir():
                target.mkdir(exist_ok=True, mode=0o750)
            else:
                reader = source.extractfile(member)
                if reader is None:
                    raise ValueError("release file is missing")
                with reader, target.open("xb") as output:
                    shutil.copyfileobj(reader, output, 1024 * 1024)
                target.chmod(0o640)


def publish(archive, root, release_id, expected_manifest, verify):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", release_id):
        raise ValueError("invalid release identity")
    root = Path(root)
    target = root / release_id

    def check(directory):
        manifest = directory / "release.json"
        verify(manifest, expected_manifest)
        if json.loads(manifest.read_text())["release_id"] != release_id:
            raise ValueError("release identity mismatch")

    if target.exists():
        check(target)
        return "already_published"
    pending = root / (".incoming-" + uuid.uuid4().hex)
    pending.mkdir(mode=0o750)
    try:
        extract_regular_files(archive, pending)
        check(pending)
        # A published directory is nonempty, so rename cannot replace it.
        try:
            pending.rename(target)
        except OSError:
            if not target.exists():
                raise
            check(target)
        return "published"
    finally:
        if pending.exists():
            shutil.rmtree(pending)


def main():
    import boto3
    from src.scene_refinement.assets import verify_release

    os.umask(0o027)
    expected_bundle = os.environ["SCENE_RELEASE_BUNDLE_SHA256"]
    expected_manifest = os.environ["SCENE_ASSET_MANIFEST_SHA256"]
    if not all(re.fullmatch(r"[0-9a-f]{64}", value)
               for value in (expected_bundle, expected_manifest)):
        raise ValueError("release hashes are required")
    with tempfile.TemporaryDirectory() as scratch:
        archive = Path(scratch) / "release.tar.gz"
        client = boto3.client("s3")
        bucket, key = os.environ["SCENE_RELEASE_BUCKET"], os.environ["SCENE_RELEASE_KEY"]
        metadata = client.head_object(Bucket=bucket, Key=key)
        if metadata["ContentLength"] > MAX_BYTES:
            raise ValueError("release bundle is too large")
        version = metadata.get("VersionId")
        client.download_file(bucket, key, str(archive),
                             ExtraArgs={"VersionId": version} if version else {})
        if digest(archive) != expected_bundle:
            raise ValueError("release bundle hash mismatch")
        result = publish(archive, "/scene-assets", os.environ["SCENE_RELEASE_ID"],
                         expected_manifest, verify_release)
        print("Scene release: " + result)


if __name__ == "__main__":
    main()
