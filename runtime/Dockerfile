FROM node:24-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a
ARG TARGETARCH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV MISE_DATA_DIR=/opt/mise MISE_CONFIG_DIR=/opt/mise-config MISE_CACHE_DIR=/tmp/mise-cache \
    MISE_TRUSTED_CONFIG_PATHS=/work PATH=/opt/mise/shims:/usr/local/bin:/usr/bin:/bin
WORKDIR /opt/star-config
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY mise.toml ./
RUN set -euo pipefail; \
    case "$TARGETARCH" in \
      amd64) platform=x64; digest=fe6dd17e68e09682b31d2e7bb7bb755d22636ac1af5d94621e300f2ca9e9fe8a ;; \
      arm64) platform=arm64; digest=e90904144ba4377c5fbe385f429830282c68f3b4f9c690bf6c5a2ae9b74a809b ;; \
      *) exit 1 ;; \
    esac; \
    curl --fail --location --proto '=https' --proto-redir '=https' \
      "https://github.com/jdx/mise/releases/download/v2026.10.17/mise-v2026.10.17-linux-$platform" \
      --output /usr/local/bin/mise; \
    printf '%s  /usr/local/bin/mise\n' "$digest" | sha256sum --check --strict -; \
    chmod 0755 /usr/local/bin/mise; \
    mkdir -p /opt/mise-config; \
    cp mise.toml /opt/mise-config/config.toml; \
    mise trust /opt/star-config/mise.toml; \
    mise install --yes; \
    uv venv /opt/star-config/.venv; \
    uv pip install --python /opt/star-config/.venv/bin/python pytest==9.1.1
COPY bin ./bin
COPY src ./src
COPY configs ./configs
COPY runtime/install_scanner.py /opt/agent-guard/install_scanner.py
COPY runtime/scan.properties /opt/agent-guard/scan.properties
RUN python3 -I /opt/agent-guard/install_scanner.py --arch "$TARGETARCH" --destination /opt/scanner \
    && /opt/scanner/bin/sonar-scanner --version
USER 65532:65532
WORKDIR /work
