# Lambda MicroVM GitHub Runner

A repository-scoped JavaScript Action for launching one single-use GitHub
Actions runner on an AWS Lambda MicroVM.

## Status

This initial scaffold defines and tests the safety-critical local primitives:

- strict mode-dependent Action input parsing;
- collision-resistant runner identity and deterministic launch client tokens;
- masked gzip/base64 JIT payloads with a 4,096-byte limit;
- bounded full-jitter retry and quota-aware polling;
- typed GitHub and AWS client boundaries with scripted test doubles.

External GitHub and AWS orchestration is intentionally not connected in this
scaffold. Running the Action validates its inputs and then exits with a clear
not-yet-implemented error. No live AWS calls are made.

## Development

Node.js 24 is required.

```bash
npm ci
npm run check
```

`dist/index.js` is committed because GitHub Actions executes the bundled
artifact directly.

## Product boundaries

Version 1 is ARM64, JIT-only, repository-scoped, and intended for private
repositories with trusted workflow changes. It has no webhook, queue,
dispatcher, warm pool, shell ingress, persistent runner, or boot-time package
installation.

## License

MIT
