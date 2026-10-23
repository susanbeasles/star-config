#!/usr/bin/python3 -I
"""Build-time acquisition only: verify pinned vendor bytes before extraction."""

import argparse
import hashlib
import os
import shutil
import stat
import tempfile
import urllib.request
import zipfile
from pathlib import Path

MAX_ENTRIES = 30000

VERSION = "8.2.0.6438"
# SonarSource/sonarqube-scan-action: sonar-scanner-version, retrieved 2026-10-22.
ARTIFACTS = {
    "amd64": (
        "linux-x64",
        "83257bf97a475d626b8ba2b214aeeb37334ca84db1b3e3be5105783e4facb053",
    ),
    "arm64": (
        "linux-aarch64",
        "3add94b481f1d541897b8d667f4c0e86bc7855bd3eaeb1a7c9ee5f162b909e6e",
    ),
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError("Scanner download redirects require separate review")


def extract(archive, destination, prefix):
    entries = archive.infolist()
    if len(entries) > MAX_ENTRIES or sum(e.file_size for e in entries) > 1024 * 1024 * 1024:
        raise ValueError("Scanner archive exceeds extraction limits")
    for entry in entries:
        name = entry.filename
        if not name.startswith(prefix + "/") or "\\" in name:
            raise ValueError("Unexpected scanner archive layout")
        parts = name.split("/")[1:]
        if any(p in {".", ".."} for p in parts) or any(p.startswith("/") for p in parts):
            raise ValueError("Unsafe scanner archive path")
        mode = entry.external_attr >> 16
        if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}):
            raise ValueError("Scanner archive contains a link or special file")
        target = destination.joinpath(*parts)
        if entry.is_dir():
            target.mkdir(mode=0o755, parents=True, exist_ok=True)
        else:
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            with archive.open(entry) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output, 65536)
            target.chmod(0o755 if mode & 0o111 else 0o644)


def install(destination, arch):
    platform, expected = ARTIFACTS[arch]
    prefix = f"sonar-scanner-{VERSION}-{platform}"
    url = f"https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/{prefix}.zip"
    if destination.exists() or destination.is_symlink():
        raise ValueError("Refusing to replace an existing scanner")
    with tempfile.TemporaryDirectory(prefix="star-scanner-") as temporary:
        download = Path(temporary) / "scanner.zip"
        digest = hashlib.sha256()
        total = 0
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(url, timeout=60) as source, download.open("xb") as output:
            while True:
                block = source.read(65536)
                if not block:
                    break
                total += len(block)
                if total > 256 * 1024 * 1024:
                    raise ValueError("Scanner download exceeds byte limit")
                digest.update(block)
                output.write(block)
        if digest.hexdigest() != expected:
            raise ValueError("Scanner SHA-256 mismatch; no executable was installed")
        destination.mkdir(mode=0o755)
        try:
            with zipfile.ZipFile(download) as archive:
                extract(archive, destination, prefix)
        except Exception:
            shutil.rmtree(destination)
            raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", required=True, choices=ARTIFACTS)
    parser.add_argument("--destination", required=True, type=Path)
    options = parser.parse_args()
    if os.getuid() != 0:
        raise SystemExit("Scanner image provisioning requires the image builder")
    install(options.destination, options.arch)
