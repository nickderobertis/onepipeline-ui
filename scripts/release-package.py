#!/usr/bin/env python3
"""Make archive/npm carriers from maturin's final binary, without recompilation.

Every release target is compiled once, by maturin, and this takes the binary out
of that wheel and packs it, byte for byte, into the GitHub Release archive and the
npm platform package beside the wheel itself. scripts/release.mjs's `build` phase
runs it for each target its platform job releases. The npm package also carries
the binary's CycloneDX SBOM, which that phase generates for the target and this
holds the packed tarball to, byte for byte.
"""
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
    "aarch64-apple-darwin": "arm64",
    "x86_64-pc-windows-msvc": "amd64",
}


class StagingError(ValueError):
    def __init__(self, message: str, action: str):
        super().__init__(message)
        self.action = action


class Arguments(argparse.ArgumentParser):
    def error(self, message):
        super().error(message + "; ACTION: pass a target from scripts/release.mjs, its built wheel, an output directory, the Cargo version tag and the target's CycloneDX SBOM")


def run(command, *args, **kwargs):
    # On Windows npm is npm.cmd, which only a resolved path reaches.
    return subprocess.check_output([shutil.which(command) or command, *args], text=True, **kwargs).strip()


def sha(data):
    return hashlib.sha256(data).hexdigest()


# Where the npm platform package carries the SBOM: scripts/sbom.mjs's PACKAGED_SBOM.
PACKAGED_SBOM = 'sboms/onepipeline-api.cyclonedx.json'


def stage(target: str, wheel: Path, out: Path, tag: str, sbom: Path) -> Path:
    if target not in TARGET_ARCHES:
        raise StagingError("unsupported release target", "choose a target declared in scripts/release.mjs")
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", tag):
        raise StagingError("release tag must be vX.Y.Z", "pass v followed by the Cargo.toml package version")
    version = tag.removeprefix("v")
    with zipfile.ZipFile(wheel) as archive:
        binaries = [p for p in archive.namelist() if p.endswith(".data/scripts/onepipeline-api") or p.endswith(".data/scripts/onepipeline-api.exe")]
        if len(binaries) != 1:
            raise StagingError(f"wheel must contain one CLI binary: {binaries}", "rebuild the bin-binding wheel with maturin for this target")
        binary = archive.read(binaries[0])
        if target.endswith("apple-darwin"):
            expected_cpu = 0x0100000C  # arm64: Apple Silicon is the one Darwin release
            if binary[:4] != b"\xcf\xfa\xed\xfe" or struct.unpack("<I", binary[4:8])[0] != expected_cpu:
                raise StagingError("wheel binary does not have the declared Darwin architecture", "rebuild the wheel with maturin --target set to this Darwin target")
        elif "linux" in target:
            # ELF e_machine: 62 is x86-64, 183 is AArch64.
            expected_machine = 62 if target.startswith("x86_64") else 183
            if binary[:6] != b"\x7fELF\x02\x01" or struct.unpack("<H", binary[18:20])[0] != expected_machine:
                raise StagingError("wheel binary does not have the declared Linux architecture", "choose the wheel built for this Linux target")
        else:
            # PE: the MZ stub points at the PE header, whose machine is AMD64.
            offset = struct.unpack("<I", binary[0x3C:0x40])[0] if len(binary) >= 0x40 and binary[:2] == b"MZ" else 0
            if not offset or len(binary) < offset + 6 or binary[offset:offset + 4] != b"PE\0\0" or struct.unpack("<H", binary[offset + 4:offset + 6])[0] != 0x8664:
                raise StagingError("wheel binary does not have the declared Windows architecture", "choose the wheel built for this Windows target")
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
    # The shapes v0.37.0 published: a .tar.gz with a two-space checksum line,
    # and for Windows a .zip with sha256sum's binary-mode `*` line.
    members = [name, 'README.md', 'LICENSE', 'CHANGELOG.md']
    if target.endswith('msvc'):
        archive_path = assets / f'{stem}.zip'
        with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as archive:
            for filename in members:
                archive.write(root / filename, arcname=filename)
        with zipfile.ZipFile(archive_path) as archive:
            archived = archive.read(name)
        separator = ' *'
    else:
        archive_path = assets / f'{stem}.tar.gz'
        with tarfile.open(archive_path, 'w:gz') as archive:
            for filename in members:
                archive.add(root / filename, arcname=filename)
        with tarfile.open(archive_path) as archive:
            archived = archive.extractfile(name).read()
        separator = '  '
    if sha(archived) != sha(binary):
        raise StagingError('archive changed binary bytes', 'inspect the archive assembly; it must copy the final wheel binary without altering bytes')
    (assets / f'{stem}.sha256').write_text(f'{sha(archive_path.read_bytes())}{separator}{archive_path.name}\n', newline='\n')
    npm_out = (out / 'npm').resolve()
    package = run('node', 'scripts/npm-build.mjs', 'platform', '--target', target, '--binary', str(executable), '--version', version, '--expect-sha256', sha(binary), '--sbom', str(sbom.resolve()), '--out', str(npm_out))
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
        sboms = [member.name for member in archive.getmembers() if member.isfile() and member.name.startswith('package/sboms/')]
        if sboms != [f'package/{PACKAGED_SBOM}'] or archive.extractfile(sboms[0]).read() != sbom.read_bytes():
            raise StagingError(f'{packed} does not carry exactly the SBOM it was given at {PACKAGED_SBOM}: {sboms}', 'inspect npm-build.mjs and the packed payload; the package must ship the generated SBOM unchanged and nothing else under sboms/')
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
    parser.add_argument('--sbom', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(stage(args.target, args.wheel, args.out, args.tag, args.sbom))
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile, struct.error, StopIteration) as error:
        print(f"release-package: {error}", file=sys.stderr)
        print(f"ACTION: {getattr(error, 'action', 'check the wheel and output paths, then rebuild the requested target with maturin --features bundled-ui from this tag')}", file=sys.stderr)
        raise SystemExit(1) from None
