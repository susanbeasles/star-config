# Protected check runtime

This package supplies the host controller, unprivileged callbacks, immutable check
image, and protected Git callbacks that `star-config hooks` requires.
Installation is an explicit administrator operation. Project setup never installs
or starts a privileged service.

The Linux host requires Docker Engine 28 or newer, cgroup v2, its built-in seccomp
profile, systemd, and Python 3.11 or newer. Register a non-root worker that cannot
access the Docker socket. The controller uses peer credentials from a protected
Unix socket and an administrator-owned project/image policy. Root workers are
rejected. An existing installation is never overwritten.
Use a dedicated worker UID; UID 65532
is reserved for isolated workloads and cannot be registered as a host worker.

The image contains Node 24, exact npm dependencies, reviewed native tool versions,
and Python test tooling. The Node image uses a content digest;
Mise acquisitions verify committed vendor SHA-256 values before
execution. Image builds acquire dependencies. Checks never pull an image or install
replacement tools.

Each check uses a bounded, descriptor-relative copy. Symlinks, hard links, devices,
credential files, external Git object pointers, host Git configuration, and hooks
are refused or excluded. The container receives sanitized Git/index metadata,
no Docker socket or host home, no inherited host environment, no capabilities,
a read-only root, a non-root UID, the built-in seccomp profile, and memory/CPU/PID,
output and execution-time limits. Ordinary checks have no network. The live source
and Git metadata must still match the initial baseline when the check completes.

The runner preserves Git remote arguments and ref-update stdin. Token-bearing
HTTPS remote URLs are refused. Post-edit paths are rebased into the snapshot and
exit status 2 is preserved. Formatting produces root-protected proposals under
`/opt/agent-guard/proposals`; success becomes status 3 until the proposed changes
are separately reviewed, applied against matching baseline hashes, and staged.
The controller never applies or stages live files.

The controller writes structured event, phase, status, and duration records to the
service journal. It never records request bodies, source, paths, credentials, or
untrusted tool output. Containers are forcibly removed after checks and timeouts;
controller restart also removes its labeled stale containers and job copies.

## Qualified deployment bundle

The `runtime commissioning` workflow builds this image and tests actual Git
commits/pushes, Gitleaks, lint-staged, native checks, boundary attacks, authorization,
formatting proposals and post-edit status. It refuses existing host installations
and removes its temporary resources afterward. Successful main-branch runs publish
`qualified-agent-runtime`, containing the image, exact image ID, installer and SHA256SUMS. Download that artifact from the successful run for the desired
verified main commit; no local image build is required.

On the designated Linux host, review the bundle, verify SHA256SUMS, then stage it
in a root-owned directory outside worker write access. A normal standalone Git
checkout must already exist and belong to the registered worker. Register the
worker, project and immutable image ID:

```sh
cd /opt/star-config-runtime-install
sha256sum --check SHA256SUMS
zstd -dc runtime-image.tar.zst | sudo docker image load
sudo python3 -I install.py \
  --project /srv/agent-workspaces/project \
  --uid 20001 \
  --image "$(cat runtime-image.id)"
```

The project and UID above are examples, not automatic registrations.
The installer validates the worker, protected source and parents, engine socket,
and image ID before writing host executables. It installs and
starts `agent-guard.service`. Run `star-config hooks` as the worker afterward. The service's
home protection means registered workspaces must be outside `/home` and `/root`.

This implements the check boundary. Host-managed agent configuration must
still disable project hook autoloading and mediate all other agent execution;
installing Git callbacks does not enforce that broader client policy. A worker
with host root or Docker access defeats the boundary. Linux containers share the
host kernel; this is not a VM isolation claim. Keep the kernel and Docker patched
and do not use this host to store unrelated credentials or sensitive workloads.
