#!/bin/sh
# star-config installer — https://github.com/susanbeasles/star-config
#
#   curl -fsSL https://install.susanb.dev | sh
#   curl -fsSL https://install.susanb.dev | sh -s -- --version 0.2.0 --dir /usr/local/bin
#
# Downloads the single-file binary for this OS/arch from GitHub Releases, verifies its
# SHA-256 against the release's SHA256SUMS, and (when the GitHub CLI is available) verifies
# the build-provenance attestation. Refuses to install on any mismatch.
set -eu

REPO="${STAR_CONFIG_REPO:-susanbeasles/star-config}"
VERSION="${STAR_CONFIG_VERSION:-latest}"
DIR="${STAR_CONFIG_DIR:-$HOME/.local/bin}"

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="$2"
      shift 2
      ;;
    --dir)
      DIR="$2"
      shift 2
      ;;
    -h | --help)
      echo "usage: install.sh [--version X.Y.Z] [--dir PATH]"
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "star-config: $*" >&2; }
die() {
  say "error: $*"
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

bin="star-config-${os}-${arch}"
[ "$os" = windows ] && bin="${bin}.exe"
asset="${bin}.gz"
command -v gzip >/dev/null 2>&1 || die "need gzip"

if [ -n "${STAR_CONFIG_BASE_URL:-}" ]; then
  base="${STAR_CONFIG_BASE_URL%/}" # internal mirror (must be https)
elif [ "$VERSION" = latest ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/v${VERSION#v}"
fi
case "$base" in https://*) ;; *) die "refusing non-https download base: ${base}" ;; esac

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q --https-only -O "$2" "$1"; }
else
  die "need curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "need sha256sum or shasum to verify the download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading ${asset} (${VERSION})"
fetch "${base}/${asset}" "${tmp}/${asset}" || die "download failed: ${base}/${asset}"
fetch "${base}/SHA256SUMS" "${tmp}/SHA256SUMS" || die "download failed: SHA256SUMS"

expected="$(awk -v f="$asset" '$2 == f || $2 == "*"f { print $1 }' "${tmp}/SHA256SUMS")"
[ -n "$expected" ] || die "no checksum for ${asset} in SHA256SUMS"
actual="$(sha256 "${tmp}/${asset}")"
[ "$expected" = "$actual" ] || die "checksum mismatch for ${asset} (expected ${expected}, got ${actual})"
say "checksum OK"

if [ "${STAR_CONFIG_SKIP_ATTESTATION:-0}" = 1 ]; then
  say "attestation check skipped (STAR_CONFIG_SKIP_ATTESTATION=1)"
elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh attestation verify "${tmp}/${asset}" --repo "$REPO" >/dev/null 2>&1 \
    || die "build provenance attestation failed for ${asset}"
  say "build provenance attestation OK"
elif [ "${STAR_CONFIG_REQUIRE_ATTESTATION:-0}" = 1 ]; then
  die "STAR_CONFIG_REQUIRE_ATTESTATION=1 needs an authenticated GitHub CLI (gh auth login)"
else
  say "tip: install + log in to the GitHub CLI to also verify build provenance"
fi

mkdir -p "$DIR"
target="${DIR}/star-config"
[ "$os" = windows ] && target="${target}.exe"
gzip -dc "${tmp}/${asset}" >"${tmp}/${bin}"
mv "${tmp}/${bin}" "$target"
chmod 0755 "$target"
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$target" 2>/dev/null || true

say "installed $("$target" --version) → ${target}"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) say "add ${DIR} to your PATH, e.g.: echo 'export PATH=\"${DIR}:\$PATH\"' >> ~/.profile" ;;
esac
say "next: cd your-repo && star-config setup"
