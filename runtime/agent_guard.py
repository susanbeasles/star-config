#!/usr/bin/python3 -I
"""Host-owned check controller. Never execute checkout code in the controller."""

import base64
import hashlib
import json
import logging
import os
import re
import resource
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

ROOT = Path("/opt/agent-guard")
SOCKET = ROOT / "control.sock"
POLICY = ROOT / "policy.json"
DOCKER = "/usr/bin/docker"
MAX_BYTES = 256 * 1024 * 1024
MAX_DEPTH = 64
MAX_PROPOSALS = 128
RUNTIME_UID = 65532
MAX_ARGUMENT = 4096
PUSH_ARGUMENTS = 2
MAX_FILES = 20000
MAX_REQUEST = 65536
MAX_OUTPUT = 512 * 1024
PHASES = {"pre-commit", "pre-push", "post-edit"}
SKIP = {".git", "node_modules", ".venv", ".ssh", ".aws", ".config", "secrets"}
GIT_PATHS = {"HEAD", "index", "objects", "refs", "packed-refs", "shallow"}
ENV = {"PATH": "/usr/bin:/bin", "HOME": "/var/empty"}


def protected(path, directory=False):
    """Validate each component, including the parent, without following links."""
    current = Path("/")
    for part in Path(path).parts[1:]:
        current /= part
        info = current.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise ValueError("Unsafe host installation")
    if directory and not current.is_dir():
        raise ValueError("Expected protected host directory")
    return current


def command(args, *, data=None, timeout=30, env=None):
    if args[: len(docker())] != docker():
        raise ValueError("Only the fixed protected Docker client is permitted")
    # Fixed executable/prefix; callers validate image IDs and pass operands without a shell.
    return subprocess.run(  # noqa: S603 - fixed protected executable, validated argv operands
        args,
        input=data,
        capture_output=True,
        timeout=timeout,
        check=True,
        env=env or ENV,
    ).stdout


def docker(*args):
    return [
        DOCKER,
        "--host",
        "unix:///run/docker.sock",
        "--config",
        str(ROOT / "docker"),
        *args,
    ]


def validate_engine():
    info = json.loads(command(docker("info", "--format={{json .}}")))
    if info.get("CgroupVersion") != "2" or "name=seccomp,profile=builtin" not in info.get(
        "SecurityOptions", []
    ):
        raise ValueError("Docker requires cgroup v2 and the built-in seccomp profile")


def excluded(name):
    return (
        name in SKIP
        or name.startswith((".env", "id_"))
        or name.endswith((".pem", ".key", ".p12", ".pfx"))
    )


class SnapshotCopy:
    def __init__(self, git):
        self.git = git
        self.count = 0
        self.size = 0
        self.hashes = {}

    def names(self, fd, depth):
        if depth > MAX_DEPTH:
            raise ValueError("Snapshot directory depth exceeded")
        names = []
        with os.scandir(fd) as entries:
            for entry in entries:
                if len(names) + self.count >= MAX_FILES:
                    raise ValueError("Snapshot file limit exceeded")
                names.append(entry.name)
        return sorted(names)

    def file(self, fd, name, target, relative, info):
        child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            opened = os.fstat(child)
            if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                raise ValueError("Snapshot input changed type")
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise ValueError("Snapshot input changed identity")
            digest = hashlib.sha256()
            with (target / name).open("xb") as output:
                while True:
                    data = os.read(child, 65536)
                    if not data:
                        break
                    self.size += len(data)
                    if self.size > MAX_BYTES:
                        raise ValueError("Snapshot byte limit exceeded")
                    digest.update(data)
                    output.write(data)
            os.chmod(target / name, 0o755 if opened.st_mode & 0o111 else 0o644)
            self.hashes[relative] = digest.hexdigest()
        finally:
            os.close(child)

    def walk(self, fd, target, prefix="", depth=0):
        for name in self.names(fd, depth):
            if self.git and not prefix and name not in GIT_PATHS:
                continue
            if not self.git and excluded(name):
                continue
            if self.git and prefix == "objects/info/":
                continue
            self.count += 1
            relative = prefix + name
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    (target / name).mkdir(mode=0o700)
                    self.walk(child, target / name, relative + "/", depth + 1)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                self.file(fd, name, target, relative, info)
            else:
                raise ValueError("Snapshot refuses links and special files")


def copy_tree(source, destination, *, git=False):
    """Descriptor-relative bounded copy. Reject links, devices and hard links."""
    copier = SnapshotCopy(git)
    fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        copier.walk(fd, destination)
    finally:
        os.close(fd)
    return copier.hashes


def snapshot(source, destination, *, metadata=None):
    hashes = copy_tree(source, destination)
    git_dir = Path(source) / ".git"
    if git_dir.exists() or git_dir.is_symlink():
        (destination / ".git").mkdir(mode=0o700)
        copied_git = copy_tree(git_dir, destination / ".git", git=True)
        if metadata is not None:
            metadata.update(copied_git)
        (destination / ".git/config").write_text(
            "[core]\nrepositoryformatversion=0\nbare=false\nhooksPath=/dev/null\nfsmonitor=false\n"
        )
    return hashes


def own_snapshot(root):
    # The containing job directory stays root-only; the sandbox sees only /work.
    for directory, _directories, files in os.walk(root, followlinks=False):
        os.chown(directory, 65532, 65532, follow_symlinks=False)
        os.chmod(directory, 0o700)
        for name in files:
            os.chown(Path(directory) / name, 65532, 65532, follow_symlinks=False)


def sanitize_event(text, source):
    event = json.loads(text)
    if not isinstance(event, dict) or not isinstance(event.get("tool_input"), dict):
        raise TypeError("Expected an edit event object")
    supplied = event.get("tool_input", {}).get("file_path")
    if not isinstance(supplied, str):
        raise TypeError("Post-edit event requires a file path")
    full = Path(supplied) if os.path.isabs(supplied) else Path(source) / supplied
    normalized = os.path.normpath(full)
    if not normalized.startswith(str(source) + "/"):
        raise ValueError("Post-edit file is outside the registered checkout")
    relative = normalized.removeprefix(str(source) + "/")
    return json.dumps({"tool_input": {"file_path": "/work/" + relative}}).encode()


@dataclass(frozen=True)
class RunSpec:
    image: str
    work: Path
    name: str


def runtime_args(spec, phase, args):
    image, work, name = spec.image, spec.work, spec.name
    result = docker(
        "run",
        "--pull=never",
        "--log-driver=none",
        "--label=io.star-config.agent-guard=true",
        "--name",
        name,
        "-i",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user=65532:65532",
        "--pids-limit=128",
        "--memory=4g",
        "--cpus=2",
        "--ulimit",
        "nofile=512:512",
        "--ulimit",
        "fsize=52428800:52428800",
        "--network",
        "none",
        "--ipc=none",
        "--cgroupns=private",
        "--init",
        "--mount",
        f"type=bind,src={work},dst=/work",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=512m,mode=1777",  # noqa: S108 - private container tmpfs, not a host path
        "--workdir=/work",
        "--env=CI=true",
        "--env=STAR_CONFIG_STRICT=1",
        "--env=HOME=/tmp/home",
        "--env=GIT_CONFIG_NOSYSTEM=1",
        "--env=GIT_CONFIG_GLOBAL=/dev/null",
    )
    result.extend(["--entrypoint=/bin/sh", image])
    workload = "agent-hook" if phase == "post-edit" else phase
    script = (
        "set -eu; mkdir -p /tmp/home; "
        "if [ -d /opt/star-config/node_modules ]; then "
        "ln -s /opt/star-config/node_modules /work/node_modules; fi; "
        "if [ -d /opt/star-config/.venv ]; then "
        "ln -s /opt/star-config/.venv /work/.venv; fi; "
        'exec /work/.star/run "$@"'
    )
    return [*result, "-c", script, "agent-guard", workload, *args]


def run_container(args, data, name, output, timeout=1200):
    """Bound output on disk and always remove the job, including on timeout."""
    process = None
    try:
        with output.open("xb") as stream:
            process = subprocess.Popen(  # noqa: S603 - private fixed launcher; checkout commands run only in Docker
                [
                    "/usr/bin/python3",
                    "-I",
                    str(Path(__file__).absolute()),
                    "launch",
                    *args,
                ],
                stdin=subprocess.PIPE,
                stdout=stream,
                stderr=stream,
                env=ENV,
                start_new_session=True,
            )
            try:
                process.communicate(data, timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
                return 124
            return process.returncode if process.returncode >= 0 else 1
    finally:
        try:
            command(docker("rm", "--force", name), timeout=30)
        except (OSError, subprocess.SubprocessError):
            if process is not None and process.poll() is None:
                process.kill()
            # A failed cleanup is an error, never a successful check.
            if process is not None and process.returncode == 0:
                raise RuntimeError("Container cleanup failed") from None
        if process is not None:
            process.wait(timeout=30)


def proposal(work, baseline, state, name):
    inspected = state / "inspected"
    inspected.mkdir(mode=0o700)
    after = copy_tree(work, inspected)
    changes = []
    changed_bytes = 0
    for path in sorted(baseline.keys() | after.keys()):
        if baseline.get(path) == after.get(path):
            continue
        data = (inspected / path).read_bytes() if path in after else None
        changed_bytes += len(data) if data is not None else 0
        if changed_bytes > 16 * 1024 * 1024:
            raise ValueError("Formatting proposal byte limit exceeded")
        changes.append(
            {
                "path": path,
                "before_sha256": baseline.get(path),
                "after_sha256": after.get(path),
                "content_base64": base64.b64encode(data).decode() if data is not None else None,
            }
        )
    if changes:
        retained = 0
        entries = 0
        with os.scandir(ROOT / "proposals") as proposals:
            for entry in proposals:
                entries += 1
                if entries >= MAX_PROPOSALS:
                    raise ValueError("Review or remove retained proposals before continuing")
                info = entry.stat(follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError("Unsafe proposal store")
                retained += info.st_size
        content = json.dumps({"version": 1, "changes": changes}) + "\n"
        if retained + len(content.encode()) > 256 * 1024 * 1024:
            raise ValueError("Proposal store byte limit exceeded")
        file = ROOT / "proposals" / (name + ".json")
        with file.open("x") as stream:
            stream.write(content)
        file.chmod(0o600)
        return True
    return False


def validate_project(project):
    if (
        not isinstance(project.get("uid"), int)
        or project["uid"] <= 0
        or project["uid"] == RUNTIME_UID
    ):
        raise ValueError("A non-root worker UID is required")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", project.get("image", "")):
        raise ValueError("Runtime image must be a local immutable image ID")
    supplied = project.get("path", "")
    if not os.path.isabs(supplied) or "," in supplied or "\n" in supplied:
        raise ValueError("Invalid registered checkout")
    current = Path("/")
    for part in Path(supplied).parts[1:]:
        current /= part
        if not stat.S_ISDIR(current.lstat().st_mode):
            raise ValueError("Registered checkout must not contain symlinks")
    if current.lstat().st_uid != project["uid"]:
        raise ValueError("Registered checkout must belong to the non-root worker")
    metadata = (current / ".git").lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != project["uid"]:
        raise ValueError("A standalone worker-owned Git directory is required")
    if supplied == "/home" or supplied.startswith(("/home/", "/root/", "/run/user/")):
        raise ValueError("Registered workspaces must be outside protected home directories")


def request_inputs(request):
    if not isinstance(request, dict):
        raise TypeError("Expected an object request")
    if request.keys() - {"cwd", "phase", "args", "stdin"}:
        raise ValueError("Request cannot override host execution policy")
    if not isinstance(request.get("stdin", ""), str):
        raise TypeError("Hook stdin must be text")
    phase = request.get("phase")
    if phase not in PHASES:
        raise ValueError("Unsupported check phase")
    args = request.get("args", [])
    if not isinstance(args, list) or any(
        not isinstance(a, str) or len(a) > MAX_ARGUMENT or re.search(r"[\x00-\x1f]", a)
        for a in args
    ):
        raise ValueError("Invalid hook arguments")
    if len(args) > (PUSH_ARGUMENTS if phase == "pre-push" else 0):
        raise ValueError("Unexpected hook arguments")
    if (
        phase == "pre-push"
        and len(args) == PUSH_ARGUMENTS
        and re.match(r"https?://[^/]*@", args[1])
    ):
        raise ValueError("Token-bearing remote URLs are not accepted")
    return phase, args


def handle(request, uid, policy):
    if not isinstance(request, dict):
        raise TypeError("Expected an object request")
    project = next(
        (p for p in policy["projects"] if p["uid"] == uid and p["path"] == request.get("cwd")), None
    )
    if project is None:
        raise ValueError("Caller or checkout is not registered")
    validate_project(project)
    phase, args = request_inputs(request)
    # No runtime pull, dependency acquisition or checkout-selected image is permitted.
    image = (
        command(docker("image", "inspect", "--format={{.Id}}", project["image"])).decode().strip()
    )
    if image != project["image"]:
        raise ValueError("Runtime image identity changed")
    name = "agent-guard-" + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="job-", dir=ROOT / "jobs") as temp:
        state = Path(temp)
        work = state / "work"
        work.mkdir(mode=0o700)
        git_before = {}
        baseline = snapshot(project["path"], work, metadata=git_before)
        own_snapshot(work)
        data = request.get("stdin", "").encode()
        if phase == "post-edit":
            data = sanitize_event(request.get("stdin", ""), project["path"])
        output = state / "output"
        status = run_container(
            runtime_args(RunSpec(image, work, name), phase, args),
            data,
            name,
            output,
        )
        text = output.read_bytes()[:MAX_OUTPUT].decode(errors="replace")
        live = state / "live"
        live.mkdir(mode=0o700)
        git_after = {}
        current = snapshot(project["path"], live, metadata=git_after)
        if current != baseline or git_after != git_before:
            return {
                "status": 1,
                "output": (
                    "Checkout or Git metadata changed during checks; "
                    "rerun against the current baseline.\n"
                ),
            }
        if proposal(work, baseline, state, name):
            return {
                "status": status or 3,
                "output": text,
                "proposal": name,
                "message": (
                    "Changes require separate review and staging; live checkout is unchanged."
                ),
            }
        return {"status": status, "output": text}


def receive(connection):
    data = bytearray()
    while not data.endswith(b"\n"):
        block = connection.recv(min(4096, MAX_REQUEST + 1 - len(data)))
        if not block:
            raise ValueError("Incomplete request")
        data.extend(block)
        if len(data) > MAX_REQUEST:
            raise ValueError("Request limit exceeded")
    return json.loads(data)


def clean_stale_jobs():
    stale = (
        command(docker("ps", "-aq", "--filter", "label=io.star-config.agent-guard=true"))
        .decode()
        .split()
    )
    for container in stale:
        if not re.fullmatch(r"[0-9a-f]{12,64}", container):
            raise ValueError("Unexpected stale container identity")
        command(docker("rm", "--force", container))
    if not shutil.rmtree.avoids_symlink_attacks:
        raise ValueError("Host requires descriptor-safe recursive cleanup")
    for job in (ROOT / "jobs").iterdir():
        if not re.fullmatch(r"job-[a-z0-9_]+", job.name) or not stat.S_ISDIR(job.lstat().st_mode):
            raise ValueError("Unexpected stale job entry")
        shutil.rmtree(job)


def respond(connection, policy):
    connection.settimeout(5)
    _, uid, _ = struct.unpack(
        "3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    )
    started = time.monotonic()
    request = {}
    try:
        request = receive(connection)
        response = handle(request, uid, policy)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError):
        response = {
            "status": 1,
            "output": "agent-guard refused the request or the runtime failed.\n",
        }
        request = {}
    phase = request.get("phase") if isinstance(request, dict) else None
    logging.getLogger("agent-guard").info(
        json.dumps(
            {
                "event": "agent-guard.check",
                "phase": phase if phase in PHASES else "invalid",
                "status": response["status"],
                "duration_ms": int((time.monotonic() - started) * 1000),
            }
        )
    )
    try:
        connection.sendall((json.dumps(response) + "\n").encode())
    except OSError:
        return


def stop(_signal, _frame):
    raise SystemExit(0)


def serve():
    if os.getuid() != 0:
        raise ValueError("Controller requires a protected host service account")
    protected(ROOT, True)
    protected(POLICY)
    policy = json.loads(POLICY.read_text())
    validate_engine()
    clean_stale_jobs()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    for project in policy["projects"]:
        validate_project(project)
    if SOCKET.exists() or SOCKET.is_symlink():
        raise ValueError("Refusing to replace an existing control socket")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(SOCKET))
        os.chown(SOCKET, 0, policy["socket_gid"])
        # IPC needs group write for the registered worker; peer UID is checked separately.
        # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions  # noqa: ERA001
        os.chmod(SOCKET, 0o660)
        server.listen(8)
        try:
            while True:
                connection, _ = server.accept()
                with connection:
                    respond(connection, policy)
        finally:
            SOCKET.unlink(missing_ok=True)


if __name__ == "__main__":
    if sys.argv[1:3] == ["launch", DOCKER]:
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT, MAX_OUTPUT))
        os.execve(DOCKER, sys.argv[2:], ENV)  # noqa: S606 - intentional fixed Docker exec, no shell or PATH lookup
    if sys.argv[1:] != ["serve"]:
        raise SystemExit("Usage: agent_guard.py serve")
    serve()
