# Runner image

The production image uses AWS's snapshot-safe Amazon Linux 2023 MicroVM base and
ARM64 throughout. The Dockerfile pins and verifies:

- Lambda MicroVM AL2023 base image digest;
- GitHub Actions runner 2.335.1;
- Docker Engine RPM 25.0.16;
- Docker Buildx 0.35.0;
- Docker Compose 5.3.0;
- AWS CLI 2.33.15.

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
  -e ALLOW_VFS_FALLBACK=true \
  -p 9000:9000 \
  lambda-microvm-github-runner:test
```

Call `/aws/lambda-microvms/runtime/v1/validate` until it returns 200. The local
fallback permits `vfs` because nested `overlay2` is commonly unavailable.
Production keeps `ALLOW_VFS_FALLBACK=false`; AWS image validation fails unless
`overlay2` works.

## Required AWS image settings

- minimum memory: 4,096 MiB;
- CPU architecture: `ARM_64`;
- additional OS capabilities: `ALL`;
- image-build egress: managed `INTERNET_EGRESS`;
- lifecycle hook port: 9000;
- `/ready` and `/validate` image hooks enabled;
- `/run`, `/resume`, `/suspend`, and `/terminate` runtime hooks enabled.

Runner launches should use managed `NO_INGRESS` and `INTERNET_EGRESS`. The
MicroVM execution role needs CloudWatch log delivery and scoped
`lambda:TerminateMicrovm` permission for the supervisor's cleanup call.
