# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

# Keep application pins aligned with Ansible (checked by docker/test_dockerfile.py).
ARG BB_VERSION=0.49.0
ARG PI_VERSION=1.5.0
ARG CODEX_VERSION=0.163.0
ARG CLAUDE_VERSION=2.1.319
ARG HERMES_VERSION=0.23.3
ARG HERMES_INSTALLER_SHA256=c73dad4dcf7c9ecadb98578e28cc763d23d7be3fa1b513545319038795493214
ARG RCLONE_VERSION=1.75.2
ARG RCLONE_ARCHIVE_SHA256=349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702
ARG RCLONE_BINARY_SHA256=ed7ab1f17876bb006c3df3949a3044959671afd9112362dacaa5dd1647735bc1
ARG UV_VERSION=0.13.7
ARG UV_SHA256=c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83
ARG CHROME_KEY_SHA256=54dea5f6c2a26091578cf52a999cebc6b64df478d37ad4dce96376b711e3b27c

# The Chrome and verified binary downloads below currently support amd64 only.
RUN set -eu; \
    test "$(dpkg --print-architecture)" = amd64; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl git libatomic1 python3 ripgrep tini unzip util-linux; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /etc/apt/keyrings/google-chrome.asc; \
    echo "$CHROME_KEY_SHA256  /etc/apt/keyrings/google-chrome.asc" | sha256sum -c -; \
    echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main' \
      > /etc/apt/sources.list.d/pa-bb-google-chrome.list; \
    printf 'repo_add_once="false"\nrepo_reenable_on_distupgrade="false"\n' > /etc/default/google-chrome; \
    apt-get update; \
    apt-get install -y --no-install-recommends google-chrome-stable; \
    rm -f /etc/apt/sources.list.d/google-chrome.list /etc/apt/sources.list.d/google-chrome.sources; \
    rm -rf /var/lib/apt/lists/*; \
    usermod --login bb --home /home/bb --move-home node; \
    groupmod --new-name bb node

RUN set -eu; \
    curl -fsSL "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-amd64.zip" -o /tmp/rclone.zip; \
    echo "$RCLONE_ARCHIVE_SHA256  /tmp/rclone.zip" | sha256sum -c -; \
    unzip -q /tmp/rclone.zip -d /tmp/rclone; \
    echo "$RCLONE_BINARY_SHA256  /tmp/rclone/rclone-v${RCLONE_VERSION}-linux-amd64/rclone" | sha256sum -c -; \
    install -m 0755 "/tmp/rclone/rclone-v${RCLONE_VERSION}-linux-amd64/rclone" /usr/local/bin/rclone; \
    curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/uv.tar.gz; \
    echo "$UV_SHA256  /tmp/uv.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tar.gz -C /tmp; \
    install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /tmp/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/; \
    rm -rf /tmp/rclone /tmp/rclone.zip /tmp/uv.tar.gz /tmp/uv-x86_64-unknown-linux-gnu; \
    env -u RCLONE_VERSION rclone version; uv --version; uvx --version

ENV HOME=/home/bb \
    PATH=/home/bb/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER bb
WORKDIR /home/bb
RUN set -eu; \
    umask 077; \
    mkdir -p .local/bin .bb .pi/agent .codex .hermes; \
    printf 'prefix=%s/.local\n' "$HOME" > .npmrc; \
    npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$PI_VERSION"; \
    npm install -g "bb-app@$BB_VERSION" "@openai/codex@$CODEX_VERSION"; \
    curl -fsSL https://claude.ai/install.sh -o /tmp/install-claude.sh; \
    bash /tmp/install-claude.sh "$CLAUDE_VERSION"; \
    curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/v${HERMES_VERSION}/scripts/install.sh" -o /tmp/install-hermes.sh; \
    echo "$HERMES_INSTALLER_SHA256  /tmp/install-hermes.sh" | sha256sum -c -; \
    HERMES_HOME="$HOME/.hermes" bash /tmp/install-hermes.sh \
      --branch "v$HERMES_VERSION" --dir "$HOME/.hermes/hermes-agent" \
      --non-interactive --skip-browser --skip-computer-use; \
    rm /tmp/install-claude.sh /tmp/install-hermes.sh; \
    npm cache clean --force; \
    pi --version; codex --version; claude --version; hermes --version

WORKDIR /opt/pa-bb
COPY --chown=bb:bb . .
RUN set -e; for plugin in /opt/pa-bb/plugins/*; do \
      if [ -f "$plugin/package.json" ]; then \
        (cd "$plugin" && npm ci --include=dev --no-audit --no-fund); \
      fi; \
    done; \
    npm cache clean --force

WORKDIR /home/bb
VOLUME ["/home/bb"]
EXPOSE 38886
HEALTHCHECK --start-period=5m --interval=30s --timeout=5s \
    CMD curl --fail --silent http://127.0.0.1:38886/api/v1/system/version > /dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "python3", "/opt/pa-bb/docker/entrypoint.py"]
