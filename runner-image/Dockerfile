FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:05cb9b38d841e7ff1b693dc9e894909612f340bf99ec97d426e8000a5bbe96c3

ARG RUNNER_VERSION=2.335.1
ARG RUNNER_SHA256=6d1e85bfd1a506a8b17c1f1b9b57dba458ffed90898799aaa9f599520b0d9207
ARG NPM_VERSION=11.18.0
ARG NPM_SHA512=4faecce0be70366d1c67b1012c4adc1246354a6cc45bf589f92003073b05518d547403df1475c542d67a4845e22b4fafcd7cac0af02c7a96cc6814f09eb003fb
ARG BUILDX_VERSION=0.35.0
ARG BUILDX_SHA256=c4248d6cbc4a619a7e0b4609c11e509ad4ac0b475e1c64817c0ac20c5d90c766
ARG COMPOSE_VERSION=5.3.0
ARG COMPOSE_SHA256=ba0d9f5ce70086b3830448ce2f8a6405513c996065fe45d2f7c144a1f0d99398
ARG FUSE_OVERLAYFS_VERSION=1.17
ARG FUSE_OVERLAYFS_SHA256=34c9995c929dd52f45cca985858d7e58d9a9626104bc2610db218aaa11115c23
ARG DOCKER_PACKAGE=docker-25.0.16-1.amzn2023.0.2.aarch64
ARG AWSCLI_VERSION=2.35.13
ARG AWSCLI_SHA256=c562b596fa9711f340c82307ca9eff576a4b96e75f1a003d1e6b2fec77820883

RUN dnf install -y --setopt=install_weak_deps=0 \
      "${DOCKER_PACKAGE}" \
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
    awscli_archive="/tmp/awscliv2.zip"; \
    curl --fail --location --silent --show-error \
      "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-${AWSCLI_VERSION}.zip" \
      --output "${awscli_archive}"; \
    echo "${AWSCLI_SHA256}  ${awscli_archive}" | sha256sum --check --strict; \
    unzip -q "${awscli_archive}" -d /tmp; \
    /tmp/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli; \
    rm -rf "${awscli_archive}" /tmp/aws; \
    aws --version; \
    aws lambda-microvms help >/dev/null

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
    npm_archive="/tmp/npm.tgz"; \
    curl --fail --location --silent --show-error \
      "https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz" \
      --output "${npm_archive}"; \
    echo "${NPM_SHA512}  ${npm_archive}" | sha512sum --check --strict; \
    for node_root in \
      /opt/actions-runner/externals/node20 \
      /opt/actions-runner/externals/node24; do \
      npm_root="${node_root}/lib/node_modules/npm"; \
      rm -rf "${npm_root}"; \
      mkdir -p "${npm_root}"; \
      tar --extract --gzip --file "${npm_archive}" \
        --directory "${npm_root}" --strip-components=1; \
      test "$("${node_root}/bin/node" \
        "${npm_root}/bin/npm-cli.js" --version)" = "${NPM_VERSION}"; \
      test "$("${node_root}/bin/node" -p \
        "require('${npm_root}/node_modules/tar/package.json').version")" = \
        "7.5.19"; \
    done; \
    rm -f "${npm_archive}"

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
    fuse_overlayfs="/usr/local/bin/fuse-overlayfs"; \
    curl --fail --location --silent --show-error \
      "https://github.com/containers/fuse-overlayfs/releases/download/v${FUSE_OVERLAYFS_VERSION}/fuse-overlayfs-aarch64" \
      --output "${fuse_overlayfs}"; \
    echo "${FUSE_OVERLAYFS_SHA256}  ${fuse_overlayfs}" | sha256sum --check --strict; \
    chmod 0755 "${fuse_overlayfs}"; \
    "${fuse_overlayfs}" --version

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
    RUNNER_ROOT=/opt/actions-runner \
    RUNNER_USER=runner

EXPOSE 9000

CMD ["python3", "/opt/runner-supervisor/supervisor.py"]
