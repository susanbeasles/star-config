#!/usr/bin/python3 -I
"""Destructive qualification ONLY in a fresh GitHub-hosted Linux runner."""

import base64
import contextlib
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path("/opt/agent-guard")
SONAR = Path("/opt/star-config/sonar")
STAGE = Path("/opt/star-config-runtime-install")
FIXTURE = Path("/srv/agent-guard-qualification")
SERVICE = Path("/etc/systemd/system/agent-guard.service")
PROPOSAL_STATUS = 3
POST_EDIT_STATUS = 2
UID = 20001
KEY = "star-config-runtime-qualification"
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
        args = ["/usr/bin/setpriv", f"--reuid={UID}", f"--regid={UID}", "--clear-groups", *args]
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
            + result.stderr.decode(errors="replace")[-4000:]
        )
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError("Local qualification API redirects are refused")


def api(path, password, *, data=None):
    credentials = base64.b64encode(("admin:" + password).encode()).decode()
    request = urllib.request.Request(
        "http://127.0.0.1:9000" + path,
        data=urllib.parse.urlencode(data).encode() if data is not None else None,
        headers={"Authorization": "Basic " + credentials},
    )
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(request, timeout=20) as response:
        body = response.read()
        return json.loads(body) if body else {}


def write(file, content, executable=False):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content)
    file.chmod(0o755 if executable else 0o644)
    os.chown(file, UID, UID)
    current = file.parent
    while current != FIXTURE.parent:
        os.chown(current, UID, UID)
        current = current.parent


def callback(project, phase, *, text="", success=True, token=None):
    env = dict(ENV)
    if token:
        env["SONAR_TOKEN"] = token
    command = (
        [str(SONAR / "bin/sonar-scanner")]
        if phase == "sonar"
        else [str(ROOT / "bin/agent-guard"), "check", phase]
    )
    return run(command, cwd=project, data=text.encode(), user=True, env=env, success=success)


class QualificationState:
    def __init__(self, image):
        self.image = image
        self.project = FIXTURE / "checkout"
        self.remote = FIXTURE / "remote.git"
        self.compose_env = dict(ENV, STAR_SONAR_DB_PASSWORD=uuid.uuid4().hex)
        self.compose = [
            "/usr/bin/docker",
            "compose",
            "-p",
            "star-runtime-qualification",
            "-f",
            str(SOURCE / "configs/sonarqube-compose.yml"),
        ]
        self.process = None
        self.created_user = False
        self.owned = False
        self.compose_started = False
        self.password = uuid.uuid4().hex
        self.token_name = "qualification-" + uuid.uuid4().hex
        self.changed_password = False


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
    os.chown(FIXTURE, UID, UID)
    os.chown(state.project, UID, UID)
    script = '#!/bin/sh\nexec node /opt/star-config/bin/star-config.js "$@"\n'
    write(state.project / ".star/run", script, True)
    write(state.project / "fixture.sh", "#!/bin/sh\nprintf '%s\\n' synthetic\n", True)
    write(
        state.project / "test/fixture.bats",
        (
            '#!/usr/bin/env bats\n@test "synthetic check" {\n'
            '  run ./fixture.sh\n  [ "$status" -eq 0 ]\n}\n'
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
    run(["/usr/bin/git", "init", "-q", "--bare", str(state.remote)], user=True)
    run(
        ["/usr/bin/git", "remote", "add", "origin", str(state.remote)],
        cwd=state.project,
        user=True,
    )
    run(["/usr/bin/git", "push", "-q", "origin", "main"], cwd=state.project, user=True)


def install_controller(state):
    # These resources are exclusive to this opt-in qualification job.
    state.compose_started = True
    run([*state.compose, "up", "-d", "--wait", "--wait-timeout", "600"], env=state.compose_env)
    network = (
        run(
            [
                "/usr/bin/docker",
                "network",
                "inspect",
                "--format={{.Id}}",
                "star-runtime-qualification_analysis",
            ]
        )
        .stdout.decode()
        .strip()
    )
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
            "--sonar-network",
            network,
            "--sonar-key",
            KEY,
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


def qualify_sonar(state):
    # A real local server and project-scoped token, not a mocked scanner process.
    api(
        "/api/users/change_password",
        "admin",
        data={"login": "admin", "previousPassword": "admin", "password": state.password},
    )
    state.changed_password = True
    api(
        "/api/projects/create",
        state.password,
        data={"project": KEY, "name": "Synthetic qualification"},
    )
    token = api(
        "/api/user_tokens/generate",
        state.password,
        data={
            "name": state.token_name,
            "type": "PROJECT_ANALYSIS_TOKEN",
            "projectKey": KEY,
        },
    )["token"]
    write(state.project / "probe.js", "export const add = (a, b) => a + b;\n")
    write(
        state.project / "sonar-project.properties",
        "sonar.host.url=https://attacker.invalid\nsonar.projectKey=unapproved\nsonar.nodejs.executable=/untrusted\n",
    )
    result = callback(state.project, "sonar", token=token, success=False)
    output = result.stdout.replace(token.encode(), b"[REDACTED]")
    if result.returncode:
        raise AssertionError(
            "Real scanner qualification failed:\n" + output.decode(errors="replace")[-6000:]
        )
    require(
        token.encode() not in result.stdout and b"ANALYSIS SUCCESSFUL" in result.stdout,
        "Qualification invariant failed",
    )
    for _ in range(60):
        if api("/api/project_analyses/search?project=" + KEY, state.password).get("analyses"):
            break
        time.sleep(2)
    else:
        raise AssertionError("Server did not complete the submitted analysis")
    require(
        not run(
            ["/usr/bin/docker", "ps", "-aq", "--filter", "label=io.star-config.agent-guard=true"]
        ).stdout.strip(),
        "Qualification invariant failed",
    )


def cleanup(state):
    if state.changed_password:
        with contextlib.suppress(OSError, ValueError):
            api("/api/user_tokens/revoke", state.password, data={"name": state.token_name})
    if state.process is not None:
        state.process.terminate()
        try:
            state.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            state.process.kill()
            state.process.wait(timeout=10)
    if state.owned:
        shutil.rmtree(ROOT, ignore_errors=True)
        shutil.rmtree(SONAR, ignore_errors=True)
        SERVICE.unlink(missing_ok=True)
    if state.compose_started:
        run(
            [*state.compose, "down", "--volumes", "--remove-orphans"],
            env=state.compose_env,
            success=False,
        )
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
    for path in (ROOT, SONAR, STAGE, FIXTURE, SERVICE):
        if path.exists() or path.is_symlink():
            raise RuntimeError("Qualification refuses existing installations and fixtures")
    state = QualificationState(os.environ["STAR_RUNTIME_IMAGE_ID"])
    try:
        prepare_fixture(state)
        install_controller(state)
        qualify_git(state)
        qualify_boundary(state)
        qualify_sonar(state)
        sys.stdout.write(
            json.dumps(
                {
                    "strict_git_checks": "passed",
                    "container_boundary": "passed",
                    "caller_authorization": "passed",
                    "proposal_isolation": "passed",
                    "post_edit_exit_status": "passed",
                    "real_sonar_analysis": "passed",
                }
            )
            + "\n"
        )
    finally:
        cleanup(state)


if __name__ == "__main__":
    main()
