# Runner image

The production image uses AWS's snapshot-safe Amazon Linux 2023 MicroVM base and
ARM64 throughout. The Dockerfile pins and verifies:

- Lambda MicroVM AL2023 base image digest;
- GitHub Actions runner 2.335.1;
- Docker Engine RPM 25.0.16;
- Docker Buildx 0.35.0;
- Docker Compose 5.3.0;
- fuse-overlayfs 1.17;
- AWS CLI 2.35.13, including the `lambda-microvms` service model.

The image snapshot contains no registered runner, JIT configuration, Docker
daemon, or live network connection. The lifecycle supervisor starts Docker and
one JIT runner only when Lambda invokes `/run`.

## Local checks

```bash
docker build -t lambda-microvm-github-runner:test runner-image
npm run test:supervisor
```

Nested Docker validation requires an ARM64 Docker host:

```bash
docker run --rm --privileged \
  -p 9000:9000 \
  lambda-microvm-github-runner:test
```

Call `/aws/lambda-microvms/runtime/v1/validate` until it returns 200. The local
and production supervisors try `overlay2`, then the copy-on-write
`fuse-overlayfs`, and finally `vfs`. Validation succeeds only after the selected
driver can run a container and resolve external registry DNS. The supervisor log
records which driver started; `vfs` remains available as the least
space-efficient fallback.

## Required AWS image settings

- minimum memory: 2,048 MiB;
- CPU architecture: `ARM_64`;
- additional OS capabilities: `ALL`;
- image-build egress: managed `INTERNET_EGRESS`;
- lifecycle hook port: 9000;
- `/ready` and `/validate` image hooks enabled;
- `/run`, `/resume`, `/suspend`, and `/terminate` runtime hooks enabled.

Runner launches should use managed `NO_INGRESS` and `INTERNET_EGRESS`. The
MicroVM execution role needs CloudWatch log delivery and only the
`lambda:TerminateMicrovm` action for the supervisor's cleanup call.
