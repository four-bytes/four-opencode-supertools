# Release Process

This project uses [release-please](https://github.com/googleapis/release-please) for automated releases.

## How it works

1. Commits to `main` are analyzed by release-please
2. A release PR is automatically created/updated with version bumps and changelog updates
3. When the release PR is merged, a GitHub release is created and the package is published to npm

## Manual release

In exceptional cases, a manual release can be done:

```bash
npm version <major|minor|patch>
bun run build
npm publish --access public
```

## Versioning

This project follows [Semantic Versioning](https://semver.org/).
