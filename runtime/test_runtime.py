"""Security regressions independent of a Docker daemon or elevated privileges."""

import json
import os
import stat

import agent_guard as guard
import pytest


def test_snapshot_excludes_credentials_and_rejects_symlinks(tmp_path):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    (source / "code.js").write_text("synthetic source")
    (source / ".env.synthetic").write_text("not copied")
    (source / "secrets").mkdir()
    (source / "secrets/synthetic").write_text("not copied")
    assert guard.snapshot(source, destination) == {
        "code.js": guard.hashlib.sha256(b"synthetic source").hexdigest(),
    }
    assert sorted(p.name for p in destination.iterdir()) == ["code.js"]
    (source / "escape").symlink_to(tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(ValueError, match="refuses links"):
        guard.snapshot(source, other)


def test_snapshot_rejects_hard_links_and_special_files(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "original").write_text("synthetic")
    os.link(source / "original", source / "alias")
    destination = tmp_path / "destination"
    destination.mkdir()
    with pytest.raises(ValueError, match="refuses links"):
        guard.snapshot(source, destination)
    (source / "alias").unlink()
    os.mkfifo(source / "pipe")
    with pytest.raises(ValueError, match="refuses links"):
        guard.snapshot(source, destination)


def test_snapshot_rejects_a_file_replaced_after_stat(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    (source / "code").write_text("synthetic")
    sentinel = tmp_path / "sentinel"
    sentinel.write_text("outside")
    target = tmp_path / "target"
    target.mkdir()
    real_open = os.open

    def race(name, flags, *args, **kwargs):
        if name == "code":
            (source / "code").unlink()
            (source / "code").symlink_to(sentinel)
        return real_open(name, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", race)
    with pytest.raises(OSError, match="symbolic links"):
        guard.snapshot(source, target)
    assert sentinel.read_text() == "outside"


def test_git_snapshot_removes_config_hooks_and_external_object_stores(tmp_path):
    source = tmp_path / "source"
    git = source / ".git"
    (git / "objects/info").mkdir(parents=True)
    (git / "hooks").mkdir()
    (git / "config").write_text("[core]\nfsmonitor=untrusted\n")
    (git / "hooks/pre-commit").write_text("untrusted")
    (git / "objects/info/alternates").write_text("/outside/object-store")
    (git / "HEAD").write_text("ref: refs/heads/main\n")
    destination = tmp_path / "destination"
    destination.mkdir()
    guard.snapshot(source, destination)
    assert not (destination / ".git/hooks").exists()
    assert not (destination / ".git/objects/info/alternates").exists()
    assert "fsmonitor=false" in (destination / ".git/config").read_text()
    assert "untrusted" not in (destination / ".git/config").read_text()


@pytest.mark.parametrize(
    "name", [".env", ".env.production", "id_ed25519", "private.pem", "private.key"]
)
def test_sensitive_file_names_are_not_snapshot_inputs(name):
    assert guard.excluded(name)


def test_requests_cannot_select_another_checkout_or_worker(tmp_path):
    policy = {"projects": [{"uid": 20001, "path": str(tmp_path)}]}
    with pytest.raises(ValueError, match="not registered"):
        guard.handle({"cwd": str(tmp_path)}, 20002, policy)
    with pytest.raises(ValueError, match="not registered"):
        guard.handle({"cwd": "/another"}, 20001, policy)
    with pytest.raises(TypeError, match="object request"):
        guard.handle([], 20001, policy)


def test_post_edit_path_is_rebased_and_cannot_escape():
    assert json.loads(
        guard.sanitize_event(
            '{"tool_input":{"file_path":"/srv/project/src/code.js"}}',
            "/srv/project",
        )
    ) == {"tool_input": {"file_path": "/work/src/code.js"}}
    for name in ["/srv/project2/code", "../../outside", "/etc/passwd"]:
        with pytest.raises(ValueError, match="outside"):
            guard.sanitize_event(json.dumps({"tool_input": {"file_path": name}}), "/srv/project")


def test_formatter_creates_a_protected_proposal_without_writing_live_source(tmp_path, monkeypatch):
    root = tmp_path / "controller"
    (root / "proposals").mkdir(parents=True)
    monkeypatch.setattr(guard, "ROOT", root)
    source = tmp_path / "source"
    source.mkdir()
    (source / "code.js").write_text("original")
    work = tmp_path / "work"
    work.mkdir()
    baseline = guard.snapshot(source, work)
    (work / "code.js").write_text("formatted")
    state = tmp_path / "state"
    state.mkdir()
    assert guard.proposal(work, baseline, state, "synthetic")
    assert (source / "code.js").read_text() == "original"
    proposal = root / "proposals/synthetic.json"
    assert stat.S_IMODE(proposal.stat().st_mode) == 0o600
    assert json.loads(proposal.read_text())["changes"][0]["before_sha256"] == baseline["code.js"]


def test_checks_reject_a_live_baseline_changed_while_the_snapshot_runs(tmp_path, monkeypatch):
    root = tmp_path / "controller"
    (root / "jobs").mkdir(parents=True)
    (root / "proposals").mkdir()
    source = tmp_path / "project"
    source.mkdir()
    (source / "code.js").write_text("before")
    monkeypatch.setattr(guard, "ROOT", root)
    image = "sha256:" + "a" * 64
    monkeypatch.setattr(guard, "command", lambda *args, **kwargs: image.encode())
    monkeypatch.setattr(guard, "own_snapshot", lambda work: None)
    monkeypatch.setattr(guard, "validate_project", lambda project: None)

    def mutate(args, data, name, output):
        (source / "code.js").write_text("concurrent edit")
        output.write_text("synthetic check passed")
        return 0

    monkeypatch.setattr(guard, "run_container", mutate)
    result = guard.handle(
        {"cwd": str(source), "phase": "pre-push"},
        20001,
        {
            "projects": [
                {
                    "path": str(source),
                    "uid": 20001,
                    "image": image,
                }
            ],
        },
    )
    assert result["status"] == 1
    assert "baseline" in result["output"]
    assert (source / "code.js").read_text() == "concurrent edit"


def test_snapshot_directories_are_accessible_only_to_the_sandbox_owner(tmp_path, monkeypatch):
    root = tmp_path / "work"
    (root / "nested").mkdir(parents=True)
    (root / "nested/code.py").write_text("synthetic")
    monkeypatch.setattr(guard.os, "chown", lambda *args, **kwargs: None)
    guard.own_snapshot(root)
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    assert stat.S_IMODE((root / "nested").stat().st_mode) == 0o700


@pytest.mark.parametrize("field", ["token", "network", "image"])
def test_request_cannot_supply_runtime_policy(field):
    with pytest.raises(ValueError, match="host execution policy"):
        guard.request_inputs({"phase": "pre-commit", field: "untrusted"})


def test_container_network_is_always_disabled(tmp_path):
    spec = guard.RunSpec("sha256:" + "a" * 64, tmp_path, "synthetic")
    args = guard.runtime_args(spec, "pre-push", [])
    assert args[args.index("--network") + 1] == "none"
    assert "--pull=never" in args
