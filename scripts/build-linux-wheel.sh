#!/usr/bin/env bash
# Build the `onepipeline-api-cli` wheel for one Linux target inside the
# manylinux image the release publishes it from.
#
# This is the one definition of a Linux wheel build: the release's `build-linux`
# and `build-linux-arm64` jobs reach it through `just release-linux build` and
# `just release-linux-arm64 build` (scripts/release.mjs), and ci.yml's `wheel`
# job through `just wheel-linux`, so a pull request builds under
# the image, prerequisites and maturin invocation a release does. The release
# packs the archive and the npm package from this wheel's binary too, so all
# three carry its glibc 2.17 floor. v0.16.0 is why: every required check passed
# on the change that linked onetaskgraph's HTTP stores, and the first place their
# vendored OpenSSL met this image was the release, which then published no wheel.
#
# The prerequisites: `openssl-sys` is built with its vendored feature (the
# engine's linked onetaskgraph stores reach `reqwest` with native TLS vendored),
# which compiles OpenSSL from source, and OpenSSL 3's `Configure` loads Perl
# modules the image's CentOS 7 Perl leaves out.
#
# The binary embeds the browser view (`--features bundled-ui`, see build.rs), so
# `just build` must have written apps/dag-ui/dist first; the container only
# reads it.
#
# The build runs as root in the container, because installing those modules
# does; what it writes into the checkout is handed back to the invoking user on
# the way out, pass or fail. A target whose architecture is not the host's runs
# under whatever emulation Docker has — the release's legs are native.
#
# Usage:
#   build-linux-wheel.sh --target TRIPLE [--out DIR]
#
# DIR is relative to the repository root, which is what the container mounts,
# and must resolve inside it. Exit 0: the wheel is in DIR. Exit 2: the arguments
# were refused. Exit 1: the build or its environment failed, named on stderr.
set -euo pipefail

usage="run 'build-linux-wheel.sh --target x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu [--out DIR]'"

fail_usage() {
  echo "$1" >&2
  echo "ACTION: $usage" >&2
  exit 2
}

fail() {
  echo "$1" >&2
  echo "ACTION: $2" >&2
  exit 1
}

target=""
out="dist"
while [ $# -gt 0 ]; do
  case "$1" in
    --target | --out)
      [ $# -ge 2 ] || fail_usage "$1 needs a value"
      if [ "$1" = --target ]; then target="$2"; else out="$2"; fi
      shift 2
      ;;
    *) fail_usage "unknown argument: $1" ;;
  esac
done

# The Linux targets scripts/release.mjs releases; tests/e2e/linux_wheel.rs fails
# when the two sets differ.
# Each carries the SHA-256 static.rust-lang.org publishes for rustup-init
# $rustup_version on that architecture, so the installer the container runs is
# the one pinned here and not whatever the download returned.
rustup_version="1.29.1"
case "$target" in
  x86_64-unknown-linux-gnu)
    arch=x86_64 platform=linux/amd64
    rustup_sha256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
    ;;
  aarch64-unknown-linux-gnu)
    arch=aarch64 platform=linux/arm64
    rustup_sha256=15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433
    ;;
  "") fail_usage "--target is required" ;;
  *) fail_usage "no manylinux build is defined for $target" ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)" \
  || fail "cannot resolve the repository root from ${BASH_SOURCE[0]}" \
    "run this from a checkout whose directories are readable"
# Resolved through any symlink, because the container sees only the checkout: a
# path that leaves it would be written somewhere the host never looks.
case "$out" in
  /*) fail_usage "--out $out is absolute; name a directory relative to the repository root" ;;
esac
out_abs="$(realpath -m -- "$root/$out")" \
  || fail_usage "--out $out does not resolve to a path under $root"
case "$out_abs" in
  "$root"/?*) ;;
  *) fail_usage "--out $out resolves to $out_abs, outside the repository at $root" ;;
esac
out_rel="${out_abs#"$root"/}"

command -v docker >/dev/null \
  || fail "docker not found: the wheel is built inside the release's manylinux image" \
    "install Docker, then re-run"

# Exactly one exact release, which is how rust-toolchain.toml pins it; anything
# else would reach rustup as whatever the line happened to hold.
channel="$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$root/rust-toolchain.toml")" \
  || fail "cannot read $root/rust-toolchain.toml" \
    "restore rust-toolchain.toml at the repository root, readable by $(id -un)"
[[ "$channel" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail "rust-toolchain.toml's channel is '$channel', not one exact release" \
    "restore its single [toolchain] channel = \"<major>.<minor>.<patch>\" line"

# Checked here rather than left to build.rs, which would refuse the same way
# only after the image had installed a toolchain and compiled every dependency.
[ -f "$root/apps/dag-ui/dist/index.html" ] \
  || fail "the browser view is not built at $root/apps/dag-ui/dist, and the wheel's binary embeds it" \
    "run 'just build', then re-run"

# The image maturin-action's `manylinux: auto` selected for this target, and the
# maturin the justfile pins for every release build — tests/e2e/linux_wheel.rs
# holds this to its `maturin-version`.
image="quay.io/pypa/manylinux2014_$arch"
maturin_version="1.14.1"

# Both are created here rather than in the container, which would create any
# missing parent as root.
cargo_target="target/wheel-$target"
mkdir -p -- "$out_abs" "$root/$cargo_target" \
  || fail "could not create $out_abs and $root/$cargo_target (mkdir's reason is above)" \
    "remove whatever file stands on either path, or make its parent writable by $(id -un)"

# One build of a target at a time. `ci-test-linux` runs `wheel-smoke` beside the
# release journeys, which build the same target through this script, and two
# containers compiling into one target directory replace each other's binary
# while maturin reads it: `test-linux` failed on main and every pull request
# with maturin unable to open the `onepipeline-api` cargo had just finished.
# Held on a file beside the directory rather than in it, which the container
# chowns, and by the descriptor `docker` inherits, so it is released when the
# build exits.
command -v flock >/dev/null \
  || fail "flock not found: concurrent builds of $target share $cargo_target and are serialized by it" \
    "install util-linux's flock, then re-run"
lock="$root/$cargo_target.lock"
exec {lock_fd}>"$lock" \
  || fail "could not open $lock to serialize builds of $target" \
    "remove whatever stands on $lock, or make $root/target writable by $(id -un)"
flock "$lock_fd" \
  || fail "could not lock $lock (flock's reason is above)" \
    "check that $root/target is on a filesystem that supports flock, then re-run"

# Runs in the container, from the checkout's root, and names nothing outside
# the image's PATH and the checkout. The EXIT trap hands the build's files back
# whatever the build did, and a hand-back that fails fails the run: a checkout
# left with root-owned files breaks the next build on this host.
read -r -d '' inside <<'SCRIPT' || true
step="" action=""
at() { step="$1" action="$2"; }
give_back() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "the build stopped $step" >&2
    echo "ACTION: $action" >&2
  fi
  if ! chown -R "$HOST_OWNER" "$CARGO_TARGET_DIR" "$OUT"; then
    echo "could not return $CARGO_TARGET_DIR and $OUT to $HOST_OWNER" >&2
    echo "ACTION: chown -R $HOST_OWNER them from a root container, as this build does, before building here again" >&2
    [ "$status" -ne 0 ] || status=1
  fi
  exit "$status"
}
trap give_back EXIT
# The image's CentOS 7 repositories point at vault.centos.org, which answers
# their repomd.xml and refuses (403) every primary.sqlite.bz2 it names, so yum
# reads the same 7.9.2009 tree from kernel.org's copy of the vault instead.
# The aarch64 image names the vault's `altarch` tree where the x86_64 one names
# `centos`, and kernel.org mirrors both under the same layout.
# Only where it fetches from changes: every package is still held to the
# image's CentOS 7 signing key (gpgcheck=1 stays on each repository).
at "pointing yum at the CentOS 7 vault mirror" \
  "check that the image still names vault.centos.org in /etc/yum.repos.d, then re-run"
sed -i -E \
  -e 's#https://vault\.centos\.org/centos/(7|\$releasever)/#https://archive.kernel.org/centos-vault/7.9.2009/#' \
  -e 's#https://vault\.centos\.org/altarch/(7|\$releasever)/#https://archive.kernel.org/centos-vault/altarch/7.9.2009/#' \
  /etc/yum.repos.d/*.repo
at "installing OpenSSL's Perl prerequisites with yum" \
  "check that https://archive.kernel.org/centos-vault/ serves the os, updates, extras and sclo/<arch>/rh repositories for 7.9.2009 (under altarch/ for aarch64), then re-run"
yum install -y -q perl-IPC-Cmd perl-Time-Piece
at "installing rustup $RUSTUP_VERSION" \
  "check that static.rust-lang.org serves rustup $RUSTUP_VERSION for $TARGET with the SHA-256 this script pins, then re-run"
curl --proto "=https" --tlsv1.2 -sSf -o "$HOME/rustup-init" \
  "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/$TARGET/rustup-init"
echo "$RUSTUP_SHA256  $HOME/rustup-init" | sha256sum -c --quiet -
chmod +x "$HOME/rustup-init"
"$HOME/rustup-init" -y -q --profile minimal --default-toolchain none
export PATH="$HOME/.cargo/bin:$PATH" RUSTUP_TOOLCHAIN="$CHANNEL"
at "installing Rust $CHANNEL for $TARGET" \
  "check that $CHANNEL, rust-toolchain.toml's channel, is a published release, then re-run"
rustup toolchain install "$CHANNEL" --profile minimal --target "$TARGET"
at "installing maturin $MATURIN_VERSION" "check that PyPI serves maturin $MATURIN_VERSION, then re-run"
python3.12 -m pip install -q "maturin==$MATURIN_VERSION"
at "compiling the wheel" \
  "fix the compile error above; 'just wheel-linux $TARGET' reproduces it in this image"
python3.12 -m maturin build --release --locked --features bundled-ui \
  --target "$TARGET" --compatibility manylinux2014 --out "$OUT"
SCRIPT

# The container's CPU weight. At Docker's default it competes as one equal
# cgroup with everything its caller runs, and in `ci-test-linux` it is the head
# of the longest chain beside five other tasks compiling on a cold target; 4096
# shares (cpu.weight 303) favours it there (docs/linux-cold-cache-timing.md).
# Weight only divides CPU that two groups both want, so a release job's build,
# which has the runner to itself, is unchanged.
cpu_shares=4096

docker run --rm --platform "$platform" --cpu-shares "$cpu_shares" \
  -v "$root":/io:ro -v "$root/$cargo_target":"/io/$cargo_target" -v "$out_abs":"/io/$out_rel" -w /io \
  -e TARGET="$target" -e OUT="$out_rel" -e CHANNEL="$channel" -e MATURIN_VERSION="$maturin_version" \
  -e RUSTUP_VERSION="$rustup_version" -e RUSTUP_SHA256="$rustup_sha256" \
  -e HOST_OWNER="$(id -u):$(id -g)" \
  -e CARGO_TARGET_DIR="$cargo_target" \
  -e RUSTFLAGS="-D warnings" \
  "$image" bash -euo pipefail -c "$inside" \
  || fail "the $target wheel did not build in $image (docker exited $?)" \
    "follow the ACTION above; with none, docker itself failed: check 'docker info' answers and 'docker pull $image' succeeds, then re-run"

echo "built the $target wheel into $out_rel/"
