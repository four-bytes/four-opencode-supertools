# Contributing

## License

This project is licensed under the Apache License 2.0. All contributions are subject to the same license.

## Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New features
- `fix:` — Bug fixes
- `refactor:` — Code refactoring
- `docs:` — Documentation changes
- `test:` — Test additions or changes
- `chore:` — Maintenance tasks

## Pull Requests

1. Create an issue first
2. Branch from `main` using `feat/NN-description` or `fix/NN-description`
3. Write tests for your changes
4. Ensure `bun test` and `bun run typecheck` pass
5. Open a PR against `main`

## Development Setup

```bash
bun install
bun run build
bun test
```
