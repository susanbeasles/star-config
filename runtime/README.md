# Protected check runtime

This package supplies the host controller, unprivileged callbacks, immutable check
image, and scanner provisioning that `star-config hooks` and `sonar scan` require.
Installation is an explicit administrator operation. Project setup never installs
or starts a privileged service.

The Linux host requires Docker Engine 28 or newer, cgroup v2, its built-in seccomp
profile, systemd, and Python 3.11 or newer. Register a non-root worker that cannot
access the Docker socket. The controller uses peer credentials from a protected
Unix socket and an administrator-owned project/image policy. Root workers are
rejected. An existing installation is never overwritten.
Use a dedicated worker UID distinct from Sonar/database service users; UID 65532
is reserved for isolated workloads and cannot be registered as a host worker.

The image contains Node 24, exact npm dependencies, reviewed native tool versions,
and SonarScanner 8.2.0.6438. Node, SonarQube, and Postgres images use content digests;
Mise and scanner acquisitions verify committed vendor SHA-256 values before
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

Sonar's client sends its project-scoped token over the protected socket. The
controller forwards it over container stdin; it is absent from Docker command
arguments, persisted container configuration, and container logs. A fresh scanner
home/cache exists only in the job's tmpfs. Scanner configuration and the project
key come from the protected image/policy. Repository scanner properties are not
loaded. The scanner reaches only Sonar on an internal bridge with isolated gateway
mode and no external DNS forwarding; the database is on a separate network.

The controller writes structured event, phase, status, and duration records to the
service journal. It never records request bodies, source, paths, credentials, or
untrusted tool output. Containers are forcibly removed after checks and timeouts;
controller restart also removes its labeled stale containers and job copies.

## Qualified deployment bundle

The `runtime commissioning` workflow builds this image and tests actual Git
commits/pushes, Gitleaks, lint-staged, native checks, boundary attacks, authorization,
formatting proposals, post-edit status, and a real analysis against a fresh local
SonarQube. It refuses existing host installations. Its synthetic credentials are
revoked and its resources removed afterward. Successful main-branch runs publish
`qualified-agent-runtime`, containing the image, exact image ID, installer, compose
file and SHA256SUMS. Download that artifact from the successful run for the desired
verified main commit; no local image build is required.

On the designated Linux host, review the bundle, verify SHA256SUMS, then stage it
in a root-owned directory outside worker write access. A normal standalone Git
checkout must already exist and belong to the registered worker. Start Sonar with
the bundled compose file and an operator-managed `STAR_SONAR_DB_PASSWORD`, then
register the worker, project and resulting analysis network ID:

```sh
cd /opt/star-config-runtime-install
sha256sum --check SHA256SUMS
zstd -dc runtime-image.tar.zst | sudo docker image load
sudo python3 -I install.py \
  --project /srv/agent-workspaces/project \
  --uid 20001 \
  --image "$(cat runtime-image.id)" \
  --sonar-network "$(sudo docker network inspect --format '{{.Id}}' star-sonarqube_analysis)" \
  --sonar-key project
```

The project, UID and Sonar key above are examples, not automatic registrations.
The installer validates the worker, protected source and parents, engine socket,
image ID and isolated network before writing host executables. It installs and
starts `agent-guard.service`. Run `star-config hooks` as the worker afterward and
use a project analysis token when invoking `star-config sonar scan`. The service's
home protection means registered workspaces must be outside `/home` and `/root`.

This implements the check/scanner boundary. Host-managed agent configuration must
still disable project hook autoloading and mediate all other agent execution;
installing Git callbacks does not enforce that broader client policy. A worker
with host root or Docker access defeats the boundary. Linux containers share the
host kernel; this is not a VM isolation claim. Keep the kernel and Docker patched
and do not use this host to store unrelated credentials or sensitive workloads.
