#!/usr/bin/env python3
"""Make archive/npm carriers from maturin's final binary, without recompilation."""
import argparse
import hashlib
import json
import re
import struct
import sys
from pathlib import Path
import shutil
import subprocess
import tarfile
import zipfile


TARGET_ARCHES = {
    "x86_64-unknown-linux-gnu": "x86_64",
    "aarch64-unknown-linux-gnu": "aarch64",
    "x86_64-apple-darwin": "x86_64",
    "aarch64-apple-darwin": "arm64",
    "x86_64-pc-windows-msvc": "amd64",
}


class StagingError(ValueError):
    def __init__(self, message: str, action: str):
        super().__init__(message)
        self.action = action


class Arguments(argparse.ArgumentParser):
    def error(self, message):
        super().error(message + "; ACTION: pass a target from release.yml, its built wheel, an output directory and the Cargo version tag")


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def stage(target: str, wheel: Path, out: Path, tag: str) -> Path:
    if target not in TARGET_ARCHES:
        raise StagingError("unsupported release target", "choose a target declared by release.yml")
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", tag):
        raise StagingError("release tag must be vX.Y.Z", "pass v followed by the Cargo.toml package version")
    version = tag.removeprefix("v")
    with zipfile.ZipFile(wheel) as archive:
        binaries = [p for p in archive.namelist() if p.endswith(".data/scripts/onepipeline-api") or p.endswith(".data/scripts/onepipeline-api.exe")]
        if len(binaries) != 1:
            raise StagingError(f"wheel must contain one CLI binary: {binaries}", "rebuild the bin-binding wheel with maturin for this target")
        binary = archive.read(binaries[0])
        if target.endswith("apple-darwin"):
            expected_cpu = 0x01000007 if target.startswith("x86_64") else 0x0100000C
            if binary[:4] != b"\xcf\xfa\xed\xfe" or struct.unpack("<I", binary[4:8])[0] != expected_cpu:
                raise StagingError("wheel binary does not have the declared Darwin architecture", "rebuild the wheel with maturin --target set to this Darwin target")
        elif "linux" in target:
            expected_machine = 62 if target.startswith("x86_64") else 183
            if binary[:6] != b"\x7fELF\x02\x01" or struct.unpack("<H", binary[18:20])[0] != expected_machine:
                raise StagingError("wheel binary does not have the declared Linux architecture", "choose the wheel built for this Linux target")
        metadata = archive.read(next(p for p in archive.namelist() if p.endswith('.dist-info/METADATA'))).decode()
        if "Name: onepipeline-api-cli\n" not in metadata:
            raise StagingError("wheel name differs from the release", "restore pyproject.toml project.name and rebuild with maturin")
        recorded_version = next(line.removeprefix("Version: ") for line in metadata.splitlines() if line.startswith("Version: "))
        if recorded_version != version:
            # maturin owns the PEP 440 spelling. Compare with its ecosystem's
            # standard parser rather than rewrite prerelease wheel metadata.
            from packaging.version import Version
            if Version(recorded_version) != Version(version):
                raise StagingError("wheel version differs from the release", "build the wheel from this tag and pass its Cargo version")
        wheel_tags = archive.read(next(p for p in archive.namelist() if p.endswith('.dist-info/WHEEL'))).decode()
        expected_arch = TARGET_ARCHES[target]
        if expected_arch not in wheel_tags:
            raise StagingError(f"wheel has no {expected_arch} platform tag", "choose the wheel produced for the requested target")
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
            raise StagingError('archive changed binary bytes', 'inspect the archive assembly; it must copy the final wheel binary without altering bytes')
    (assets / f'{stem}.sha256').write_text(f'{sha(archive_path.read_bytes())}  {archive_path.name}\n')
    npm_out = (out / 'npm').resolve()
    package = run('node', 'scripts/npm-build.mjs', 'platform', '--target', target, '--binary', str(executable), '--version', version, '--expect-sha256', sha(binary), '--out', str(npm_out))
    npm_artifacts = (out / 'npm-artifacts').resolve()
    npm_artifacts.mkdir(exist_ok=True)
    packed_info = json.loads(run('npm', 'pack', '--json', '--pack-destination', str(npm_artifacts), cwd=package))
    expected_filename = f'{Path(package).name}-{version}.tgz'
    if not (isinstance(packed_info, list) and len(packed_info) == 1
            and isinstance(packed_info[0], dict)
            and packed_info[0].get('name') == Path(package).name
            and packed_info[0].get('version') == version
            and packed_info[0].get('filename') == expected_filename):
        raise StagingError('npm pack returned invalid package metadata', 'inspect npm pack --json output; it must describe exactly the staged platform package and release version')
    packed = packed_info[0]['filename']
    with tarfile.open(npm_artifacts / packed) as archive:
        if sha(archive.extractfile(f'package/bin/{name}').read()) != sha(binary):
            raise StagingError('npm changed binary bytes', 'inspect npm-build.mjs and the packed payload; use the extracted wheel binary unchanged')
    wheels = out / 'wheels'
    wheels.mkdir(exist_ok=True)
    shutil.copyfile(wheel, wheels / wheel.name)
    record = {'target': target, 'version': version, 'wheelVersion': recorded_version, 'binarySha256': sha(binary), 'archive': archive_path.name, 'wheel': wheel.name, 'npm': packed, 'archiveBinarySha256': sha(binary), 'wheelBinarySha256': sha(binary), 'npmBinarySha256': sha(binary)}
    (root / 'reuse.json').write_text(json.dumps(record, indent=2) + '\n')
    return executable


if __name__ == '__main__':
    parser = Arguments(description=__doc__)
    parser.add_argument('--target', required=True, choices=TARGET_ARCHES)
    parser.add_argument('--wheel', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    try:
        print(stage(args.target, args.wheel, args.out, args.tag))
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile, struct.error, StopIteration) as error:
        print(f"release-package: {error}", file=sys.stderr)
        print(f"ACTION: {getattr(error, 'action', 'check the wheel and output paths, then rebuild the requested target with maturin --features bundled-ui from this tag')}", file=sys.stderr)
        raise SystemExit(1) from None
