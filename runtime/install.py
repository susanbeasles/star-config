#!/usr/bin/python3 -I
"""Explicit administrator installation; never called by checkout setup or sync."""

import argparse
import importlib.util
import json
import os
import pwd
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path("/opt/agent-guard")
SERVICE = Path("/etc/systemd/system/agent-guard.service")


def regular(file):
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("Installer source must be a regular unlinked file")
    return file.read_bytes()


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--uid", required=True, type=int)
    parser.add_argument("--image", required=True)
    parser.add_argument(
        "--no-service",
        action="store_true",
        help="Qualification only; caller manages controller lifetime",
    )
    return parser.parse_args()


def load_guard(source):
    current = Path("/")
    for part in source.parts[1:]:
        current /= part
        info = current.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or not stat.S_ISDIR(info.st_mode):
            raise ValueError(
                "Stage the reviewed installer in a protected administrator-owned directory"
            )
    regular(source / "agent_guard.py")
    spec = importlib.util.spec_from_file_location("agent_guard_install", source / "agent_guard.py")
    guard = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = guard
    spec.loader.exec_module(guard)
    return guard


def require_no_docker_access(worker):
    # A short single-threaded child asks the kernel, including ACLs, as the actual worker.
    child = os.fork()
    if child == 0:
        try:
            os.setgroups(os.getgrouplist(worker.pw_name, worker.pw_gid))
            os.setgid(worker.pw_gid)
            os.setuid(worker.pw_uid)
            os._exit(0 if os.access("/run/docker.sock", os.W_OK) else 1)
        except OSError:
            os._exit(2)
    _, status = os.waitpid(child, 0)
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 1:
        raise ValueError("Worker must not have direct Docker socket access")


def validate_installation(args, guard):
    guard.protected("/opt", True)
    guard.protected("/usr/bin/docker")
    guard.protected("/run", True)
    socket_info = Path("/run/docker.sock").lstat()
    if not stat.S_ISSOCK(socket_info.st_mode) or socket_info.st_uid != 0:
        raise ValueError("Docker must be controlled by the host administrator")
    worker = pwd.getpwuid(args.uid)
    if 0 in os.getgrouplist(worker.pw_name, worker.pw_gid):
        raise ValueError("Worker must not belong to the root group")
    require_no_docker_access(worker)
    project = {
        "path": os.path.abspath(args.project),
        "uid": args.uid,
        "image": args.image,
    }
    guard.validate_project(project)
    for target in (ROOT, SERVICE):
        if target.exists() or target.is_symlink():
            raise ValueError("Refusing to replace an existing host installation")
    guard.protected(SERVICE.parent, True)
    guard.validate_engine()
    image = (
        guard.command(guard.docker("image", "inspect", "--format={{.Id}}", args.image))
        .decode()
        .strip()
    )
    if image != args.image:
        raise ValueError("Runtime image identity changed")
    return project, worker


def write_installation(args, source, project, worker):
    runtime_source = regular(source / "agent_guard.py")
    client_source = regular(source / "client.py")
    service_source = regular(source / "agent-guard.service")
    ROOT.mkdir(mode=0o755)
    for relative in ("bin", "git-hooks"):
        (ROOT / relative).mkdir(mode=0o755)
    for relative in ("lib", "jobs", "proposals", "docker"):
        (ROOT / relative).mkdir(mode=0o700)
    for destination, content, mode in (
        (ROOT / "lib/agent_guard.py", runtime_source, 0o700),
        (ROOT / "bin/agent-guard", client_source, 0o755),
        (SERVICE, service_source, 0o644),
    ):
        with destination.open("xb") as stream:
            stream.write(content)
        destination.chmod(mode)
    for phase in ("pre-commit", "pre-push"):
        hook = ROOT / "git-hooks" / phase
        hook.write_text(
            "#!/bin/sh\nexec /opt/agent-guard/bin/agent-guard check " + phase + ' "$@"\n'
        )
        hook.chmod(0o755)
    policy = {
        "version": 1,
        "socket_gid": worker.pw_gid,
        "projects": [project],
    }
    (ROOT / "policy.json").write_text(json.dumps(policy) + "\n")
    (ROOT / "policy.json").chmod(0o600)


def main():
    args = parse_args()
    if os.getuid() != 0 or args.uid <= 0:
        raise ValueError("Installation requires an administrator and a non-root worker UID")
    source = Path(__file__).absolute().parent
    guard = load_guard(source)
    project, worker = validate_installation(args, guard)
    write_installation(args, source, project, worker)
    if not args.no_service:
        subprocess.run(["/usr/bin/systemctl", "daemon-reload"], check=True, env=guard.ENV)
        subprocess.run(
            ["/usr/bin/systemctl", "enable", "--now", "agent-guard.service"],
            check=True,
            env=guard.ENV,
        )


if __name__ == "__main__":
    main()
