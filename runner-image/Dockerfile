FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:05cb9b38d841e7ff1b693dc9e894909612f340bf99ec97d426e8000a5bbe96c3

ARG RUNNER_VERSION=2.335.1
ARG RUNNER_SHA256=6d1e85bfd1a506a8b17c1f1b9b57dba458ffed90898799aaa9f599520b0d9207
ARG BUILDX_VERSION=0.35.0
ARG BUILDX_SHA256=c4248d6cbc4a619a7e0b4609c11e509ad4ac0b475e1c64817c0ac20c5d90c766
ARG COMPOSE_VERSION=5.3.0
ARG COMPOSE_SHA256=ba0d9f5ce70086b3830448ce2f8a6405513c996065fe45d2f7c144a1f0d99398
ARG DOCKER_PACKAGE=docker-25.0.16-1.amzn2023.0.2.aarch64
ARG AWSCLI_PACKAGE=awscli-2-2.33.15-1.amzn2023.0.1.noarch

RUN dnf install -y --setopt=install_weak_deps=0 \
      "${DOCKER_PACKAGE}" \
      "${AWSCLI_PACKAGE}" \
      bzip2 \
      ca-certificates \
      curl-minimal \
      findutils \
      git \
      gzip \
      iproute \
      iptables-nft \
      jq \
      krb5-libs \
      libicu \
      lttng-ust \
      procps-ng \
      python3 \
      shadow-utils \
      tar \
      unzip \
      util-linux \
      which \
      xz \
      zlib \
  && dnf clean all \
  && rm -rf /var/cache/dnf /var/cache/libdnf5

RUN set -eux; \
    runner_archive="/tmp/actions-runner.tar.gz"; \
    curl --fail --location --silent --show-error \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz" \
      --output "${runner_archive}"; \
    echo "${RUNNER_SHA256}  ${runner_archive}" | sha256sum --check --strict; \
    mkdir -p /opt/actions-runner; \
    tar --extract --gzip --file "${runner_archive}" --directory /opt/actions-runner; \
    rm -f "${runner_archive}"

RUN set -eux; \
    plugin_dir="/usr/local/lib/docker/cli-plugins"; \
    mkdir -p "${plugin_dir}"; \
    curl --fail --location --silent --show-error \
      "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-arm64" \
      --output "${plugin_dir}/docker-buildx"; \
    echo "${BUILDX_SHA256}  ${plugin_dir}/docker-buildx" | sha256sum --check --strict; \
    curl --fail --location --silent --show-error \
      "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-aarch64" \
      --output "${plugin_dir}/docker-compose"; \
    echo "${COMPOSE_SHA256}  ${plugin_dir}/docker-compose" | sha256sum --check --strict; \
    chmod 0755 "${plugin_dir}/docker-buildx" "${plugin_dir}/docker-compose"; \
    docker buildx version; \
    docker compose version

RUN set -eux; \
    useradd --create-home --shell /bin/bash runner; \
    usermod --append --groups docker runner; \
    mkdir -p /tmp/runner /opt/hostedtoolcache /home/runner/_work; \
    chown -R runner:runner \
      /opt/actions-runner \
      /opt/hostedtoolcache \
      /tmp/runner \
      /home/runner

COPY supervisor.py /opt/runner-supervisor/supervisor.py
RUN chmod 0755 /opt/runner-supervisor/supervisor.py

ENV HOOK_PORT=9000 \
    DOCKER_DNS=169.254.169.253 \
    DOCKER_STORAGE_DRIVER=overlay2 \
    DOCKERD_START_ATTEMPTS=1 \
    DOCKERD_START_TIMEOUT=50 \
    ALLOW_VFS_FALLBACK=false \
    RUNNER_ROOT=/opt/actions-runner \
    RUNNER_USER=runner

EXPOSE 9000

CMD ["python3", "/opt/runner-supervisor/supervisor.py"]
