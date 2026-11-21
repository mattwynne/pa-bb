# syntax=docker/dockerfile:1
# The dependency manifest currently supports Ubuntu 24.04 on amd64 only.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN test "$(dpkg --print-architecture)" = amd64 \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       ansible-core ca-certificates curl git python3 sudo tini \
    && useradd --create-home --uid 1000 --shell /bin/bash bb

ENV HOME=/home/bb \
    PATH=/home/bb/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    ANSIBLE_ROLES_PATH=/opt/pa-bb/provisioning/roles
WORKDIR /opt/pa-bb
COPY --chown=bb:bb . .

# Reuse the host's reviewed dependency pins, but not its systemd/service tasks.
RUN ansible-playbook -i localhost, -c local docker/build.yml \
    && apt-get purge -y ansible-core sudo \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /root/.ansible /home/bb/.ansible

USER bb
RUN set -e; for plugin in /opt/pa-bb/plugins/*; do \
      if [ -f "$plugin/package.json" ]; then \
        (cd "$plugin" && npm ci --include=dev --no-audit --no-fund); \
      fi; \
    done

WORKDIR /home/bb
VOLUME ["/home/bb"]
EXPOSE 38886
HEALTHCHECK --start-period=5m --interval=30s --timeout=5s \
    CMD curl --fail --silent http://127.0.0.1:38886/api/v1/system/version > /dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "python3", "/opt/pa-bb/docker/entrypoint.py"]
