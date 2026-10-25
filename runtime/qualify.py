#!/usr/bin/python3 -I
"""Destructive qualification ONLY in a fresh GitHub-hosted Linux runner."""

import base64
import hashlib
import json
import os
import pwd
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/opt/agent-guard")
STAGE = Path("/opt/star-config-runtime-install")
FIXTURE = Path("/srv/agent-guard-qualification")
SERVICE = Path("/etc/systemd/system/agent-guard.service")
PROPOSAL_STATUS = 3
POST_EDIT_STATUS = 2
UID = 20001
SOURCE = Path(__file__).absolute().parent.parent
ENV = {
    "PATH": "/usr/bin:/bin",
    "HOME": "/nonexistent",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
}


def run(args, *, cwd=None, data=None, user=False, **options):
    if options.keys() - {"env", "success"}:
        raise ValueError("Unexpected qualification execution option")
    if user:
        args = [
            "/usr/bin/setpriv",
            f"--reuid={UID}",
            f"--regid={pwd.getpwuid(UID).pw_gid}",
            "--clear-groups",
            *args,
        ]
    result = subprocess.run(  # noqa: S603 - fixed test commands and argv, never shell input
        args,
        cwd=cwd,
        input=data,
        capture_output=True,
        env=options.get("env", ENV),
        timeout=1200,
        check=False,
    )
    if options.get("success", True) and result.returncode:
        raise AssertionError(
            "Qualification command failed: "
            + args[0]
            + "\n"
            + result.stdout.decode(errors="replace")[-4000:]
            + result.stderr.decode(errors="replace")[-4000:]
        )
    return result


def write(file, content, executable=False):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content)
    file.chmod(0o755 if executable else 0o644)
    os.chown(file, UID, UID)
    current = file.parent
    while current != FIXTURE.parent:
        os.chown(current, UID, UID)
        current = current.parent


def callback(project, phase, *, text="", success=True):
    command = [str(ROOT / "bin/agent-guard"), "check", phase]
    return run(command, cwd=project, data=text.encode(), user=True, success=success)


class QualificationState:
    def __init__(self, image):
        self.image = image
        self.project = FIXTURE / "checkout"
        self.remote = FIXTURE / "remote.git"
        self.process = None
        self.created_user = False
        self.owned = False


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def prepare_fixture(state):
    run(
        [
            "/usr/sbin/useradd",
            "--system",
            "--uid",
            str(UID),
            "--user-group",
            "--no-create-home",
            "--home-dir",
            "/nonexistent",
            "--shell",
            "/usr/sbin/nologin",
            "star-runtime-qualification",
        ]
    )
    state.created_user = True
    FIXTURE.mkdir(mode=0o755)
    state.project.mkdir(mode=0o755)
    os.chown(state.project, UID, UID)
    script = run(
        [
            "/usr/bin/docker",
            "run",
            "--rm",
            "--pull=never",
            "--network=none",
            "--read-only",
            "--entrypoint=node",
            state.image,
            "--input-type=module",
            "-e",
            'import {launcher} from "/opt/star-config/src/templates/devenv.js";'
            "process.stdout.write(launcher())",
        ]
    ).stdout.decode()
    write(state.project / ".star/run", script, True)
    write(state.project / "fixture.sh", "#!/bin/sh\nprintf '%s\\n' synthetic\n", True)
    write(
        state.project / "test/fixture.bats",
        (
            '#!/usr/bin/env bats\n@test "synthetic check" {\n'
            '\trun ./fixture.sh\n\t[ "$status" -eq 0 ]\n}\n'
        ),
    )
    run(["/usr/bin/git", "init", "-q", "-b", "main"], cwd=state.project, user=True)
    for key, value in [
        ("user.name", "Synthetic fixture"),
        ("user.email", "fixture@example.invalid"),
    ]:
        run(["/usr/bin/git", "config", key, value], cwd=state.project, user=True)
    run(["/usr/bin/git", "add", "."], cwd=state.project, user=True)
    run(
        ["/usr/bin/git", "commit", "-q", "-m", "Synthetic baseline"],
        cwd=state.project,
        user=True,
    )
    state.remote.mkdir(mode=0o755)
    os.chown(state.remote, UID, UID)
    run(["/usr/bin/git", "init", "-q", "--bare", str(state.remote)], user=True)
    run(
        ["/usr/bin/git", "remote", "add", "origin", str(state.remote)],
        cwd=state.project,
        user=True,
    )
    run(["/usr/bin/git", "push", "-q", "origin", "main"], cwd=state.project, user=True)


def install_controller(state):
    STAGE.mkdir(mode=0o700)
    for name in (
        "agent_guard.py",
        "client.py",
        "install.py",
        "agent-guard.service",
    ):
        source = SOURCE / "runtime" / name
        if not stat.S_ISREG(source.lstat().st_mode):
            raise RuntimeError("Qualification installer input must not be a link")
        shutil.copyfile(source, STAGE / name)
        (STAGE / name).chmod(0o700 if name.endswith(".py") else 0o600)
    state.owned = True
    run(
        [
            "/usr/bin/python3",
            "-I",
            str(STAGE / "install.py"),
            "--project",
            str(state.project),
            "--uid",
            str(UID),
            "--image",
            state.image,
            "--no-service",
        ]
    )
    with (STAGE / "controller.log").open("xb") as log:
        state.process = subprocess.Popen(  # noqa: S603 - only the fixed protected installed controller
            ["/usr/bin/python3", "-I", str(ROOT / "lib/agent_guard.py"), "serve"],
            env=ENV,
            stdout=log,
            stderr=log,
        )
    for _ in range(100):
        if state.process.poll() is not None:
            raise AssertionError(
                "Controller did not start: " + (STAGE / "controller.log").read_text()[-4000:]
            )
        if (ROOT / "control.sock").exists():
            break
        time.sleep(0.1)
    else:
        raise AssertionError("Controller readiness deadline exceeded")
    run(
        ["/usr/bin/git", "config", "core.hooksPath", str(ROOT / "git-hooks")],
        cwd=state.project,
        user=True,
    )


def qualify_git(state):
    # Real strict checks, including real Gitleaks and lint-staged, through a real commit.
    write(
        state.project / "fixture.sh",
        "#!/bin/sh\nprintf '%s\\n' synthetic-updated\n",
        True,
    )
    run(["/usr/bin/git", "add", "."], cwd=state.project, user=True)
    commit = run(
        ["/usr/bin/git", "commit", "-q", "-m", "Qualified check"],
        cwd=state.project,
        user=True,
        success=False,
    )
    if commit.returncode:
        proposals = list((ROOT / "proposals").glob("*.json"))
        if not proposals:
            raise AssertionError(
                "Real pre-commit failed without a formatting proposal: "
                + commit.stdout.decode()[-4000:]
                + commit.stderr.decode()[-4000:]
            )
            # Explicit synthetic operator review/application; never part of controller execution.
        for proposal in proposals:
            for change in json.loads(proposal.read_text())["changes"]:
                path = Path(change["path"])
                if path.is_absolute() or ".." in path.parts or path.parts[0] == ".git":
                    raise AssertionError("Unsafe proposed path")
                target = state.project / path
                before = (
                    hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
                )
                require(before == change["before_sha256"], "Qualification invariant failed")
                require(change["content_base64"] is not None, "Qualification invariant failed")
                target.write_bytes(base64.b64decode(change["content_base64"]))
                os.chown(target, UID, UID)
        run(["/usr/bin/git", "add", "."], cwd=state.project, user=True)
        run(
            ["/usr/bin/git", "commit", "-q", "-m", "Qualified check"],
            cwd=state.project,
            user=True,
        )
    run(["/usr/bin/git", "push", "-q", "origin", "main"], cwd=state.project, user=True)


def qualify_boundary(state):
    # Untrusted callbacks cannot write host files, see Docker/control sockets, or use the network.
    probe = """#!/bin/sh
    set -eu
    [ "$(id -u)" = 65532 ]
    [ ! -e /opt/agent-guard/policy.json ]
    [ ! -S /run/docker.sock ]
    if touch /etc/agent-guard-escape 2>/dev/null; then exit 1; fi
    node -e '
const net=require("node:net");
const s=net.connect(443,"1.1.1.1");
s.setTimeout(500);
s.on("connect",()=>process.exit(1));
s.on("error",()=>process.exit(0));
s.on("timeout",()=>process.exit(0));
'
    printf '%s\\n' boundary-qualified
    """
    write(state.project / ".star/run", probe, True)
    require(
        b"boundary-qualified" in callback(state.project, "pre-push").stdout,
        "Qualification invariant failed",
    )
    require(not Path("/etc/agent-guard-escape").exists(), "Qualification invariant failed")
    require(
        run(
            [str(ROOT / "bin/agent-guard"), "check", "pre-push"], cwd=state.project, success=False
        ).returncode
        != 0,
        "Qualification invariant failed",
    )
    other = FIXTURE / "unregistered"
    other.mkdir()
    os.chown(other, UID, UID)
    require(
        callback(other, "pre-push", success=False).returncode != 0, "Qualification invariant failed"
    )

    write(state.project / ".star/run", "#!/bin/sh\nprintf formatted > fixture.sh\n", True)
    before = (state.project / "fixture.sh").read_bytes()
    require(
        callback(state.project, "pre-commit", success=False).returncode == PROPOSAL_STATUS,
        "Qualification invariant failed",
    )
    require((state.project / "fixture.sh").read_bytes() == before, "Qualification invariant failed")
    write(state.project / ".star/run", "#!/bin/sh\ncat\nexit 2\n", True)
    result = callback(
        state.project,
        "post-edit",
        text=json.dumps({"tool_input": {"file_path": str(state.project / "fixture.sh")}}),
        success=False,
    )
    require(
        result.returncode == POST_EDIT_STATUS and b"/work/fixture.sh" in result.stdout,
        "Qualification invariant failed",
    )
    write(state.project / ".star/run", "#!/bin/sh\nexit 42\n", True)
    before = run(["/usr/bin/git", "rev-parse", "HEAD"], cwd=state.project, user=True).stdout
    require(
        run(
            ["/usr/bin/git", "commit", "--allow-empty", "-m", "Rejected"],
            cwd=state.project,
            user=True,
            success=False,
        ).returncode
        != 0,
        "Qualification invariant failed",
    )
    require(
        run(["/usr/bin/git", "rev-parse", "HEAD"], cwd=state.project, user=True).stdout == before,
        "Qualification invariant failed",
    )


def cleanup(state):
    if state.process is not None:
        state.process.terminate()
        try:
            state.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            state.process.kill()
            state.process.wait(timeout=10)
    if state.owned:
        shutil.rmtree(ROOT, ignore_errors=True)
        SERVICE.unlink(missing_ok=True)
    shutil.rmtree(STAGE, ignore_errors=True)
    shutil.rmtree(FIXTURE, ignore_errors=True)
    if state.created_user:
        run(["/usr/sbin/userdel", "star-runtime-qualification"], success=False)


def main():
    if (
        os.getuid() != 0
        or os.environ.get("GITHUB_ACTIONS") != "true"
        or os.environ.get("STAR_CONFIG_TEST_HOST_FIXTURE") != "1"
    ):
        raise RuntimeError("Qualification requires explicit opt-in on a fresh GitHub runner")
    for path in (ROOT, STAGE, FIXTURE, SERVICE):
        if path.exists() or path.is_symlink():
            raise RuntimeError("Qualification refuses existing installations and fixtures")
    state = QualificationState(os.environ["STAR_RUNTIME_IMAGE_ID"])
    try:
        prepare_fixture(state)
        install_controller(state)
        qualify_git(state)
        qualify_boundary(state)
        sys.stdout.write(
            json.dumps(
                {
                    "strict_git_checks": "passed",
                    "container_boundary": "passed",
                    "caller_authorization": "passed",
                    "proposal_isolation": "passed",
                    "post_edit_exit_status": "passed",
                }
            )
            + "\n"
        )
    except Exception:
        log = STAGE / "controller.log"
        if log.exists():
            sys.stderr.write("Qualification controller log:\n" + log.read_text()[-4000:])
        raise
    finally:
        cleanup(state)


if __name__ == "__main__":
    main()
