#!/usr/bin/env python3
"""Make archive/npm carriers from maturin's final binary, without recompilation."""
import argparse
import hashlib
import json
import re
import struct
from pathlib import Path
import shutil
import subprocess
import tarfile
import zipfile


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def stage(target, wheel, out, tag):
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", tag):
        raise ValueError("release tag must be vX.Y.Z")
    version = tag.removeprefix("v")
    with zipfile.ZipFile(wheel) as archive:
        binaries = [p for p in archive.namelist() if p.endswith(".data/scripts/onepipeline-api") or p.endswith(".data/scripts/onepipeline-api.exe")]
        if len(binaries) != 1:
            raise ValueError(f"wheel must contain one CLI binary: {binaries}")
        binary = archive.read(binaries[0])
        if target.endswith("apple-darwin"):
            expected_cpu = 0x01000007 if target.startswith("x86_64") else 0x0100000C
            if binary[:4] != b"\xcf\xfa\xed\xfe" or struct.unpack("<I", binary[4:8])[0] != expected_cpu:
                raise ValueError("wheel binary does not have the declared Darwin architecture")
        elif "linux" in target:
            expected_machine = 62 if target.startswith("x86_64") else 183
            if binary[:6] != b"\x7fELF\x02\x01" or struct.unpack("<H", binary[18:20])[0] != expected_machine:
                raise ValueError("wheel binary does not have the declared Linux architecture")
        metadata = archive.read(next(p for p in archive.namelist() if p.endswith('.dist-info/METADATA'))).decode()
        if "Name: onepipeline-api-cli\n" not in metadata:
            raise ValueError("wheel name differs from the release")
        recorded_version = next(line.removeprefix("Version: ") for line in metadata.splitlines() if line.startswith("Version: "))
        if recorded_version != version:
            # maturin owns the PEP 440 spelling. Compare with its ecosystem's
            # standard parser rather than rewrite prerelease wheel metadata.
            from packaging.version import Version
            if Version(recorded_version) != Version(version):
                raise ValueError("wheel version differs from the release")
        wheel_tags = archive.read(next(p for p in archive.namelist() if p.endswith('.dist-info/WHEEL'))).decode()
        expected_arch = {'x86_64-apple-darwin': 'x86_64', 'aarch64-apple-darwin': 'arm64', 'x86_64-unknown-linux-gnu': 'x86_64', 'aarch64-unknown-linux-gnu': 'aarch64', 'x86_64-pc-windows-msvc': 'amd64'}[target]
        if expected_arch not in wheel_tags:
            raise ValueError(f"wheel has no {expected_arch} platform tag")
    root = out / target
    root.mkdir(parents=True, exist_ok=True)
    name = 'onepipeline-api.exe' if target.endswith('msvc') else 'onepipeline-api'
    executable = root / name
    executable.write_bytes(binary)
    executable.chmod(0o755)
    for document in ['README.md', 'LICENSE', 'CHANGELOG.md']:
        shutil.copyfile(document, root / document)
    stem = f"onepipeline-api-{tag}-{target}"
    assets = out / 'assets'
    assets.mkdir(exist_ok=True)
    archive_path = assets / f'{stem}.tar.gz'
    with tarfile.open(archive_path, 'w:gz') as archive:
        for filename in [name, 'README.md', 'LICENSE', 'CHANGELOG.md']:
            archive.add(root / filename, arcname=filename)
    with tarfile.open(archive_path) as archive:
        if sha(archive.extractfile(name).read()) != sha(binary):
            raise ValueError('archive changed binary bytes')
    (assets / f'{stem}.sha256').write_text(f'{sha(archive_path.read_bytes())}  {archive_path.name}\n')
    npm_out = (out / 'npm').resolve()
    package = run('node', 'scripts/npm-build.mjs', 'platform', '--target', target, '--binary', str(executable), '--version', version, '--expect-sha256', sha(binary), '--out', str(npm_out))
    npm_artifacts = (out / 'npm-artifacts').resolve()
    npm_artifacts.mkdir(exist_ok=True)
    packed = json.loads(run('npm', 'pack', '--json', '--pack-destination', str(npm_artifacts), cwd=package))[0]['filename']
    with tarfile.open(npm_artifacts / packed) as archive:
        if sha(archive.extractfile(f'package/bin/{name}').read()) != sha(binary):
            raise ValueError('npm changed binary bytes')
    wheels = out / 'wheels'
    wheels.mkdir(exist_ok=True)
    shutil.copyfile(wheel, wheels / wheel.name)
    record = {'target': target, 'version': version, 'wheelVersion': recorded_version, 'binarySha256': sha(binary), 'archive': archive_path.name, 'wheel': wheel.name, 'npm': packed, 'archiveBinarySha256': sha(binary), 'wheelBinarySha256': sha(binary), 'npmBinarySha256': sha(binary)}
    (root / 'reuse.json').write_text(json.dumps(record, indent=2) + '\n')
    return executable


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True)
    parser.add_argument('--wheel', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    print(stage(args.target, args.wheel, args.out, args.tag))
