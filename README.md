# four-opencode-supertools

Token-efficient supertools for opencode agents.

## Tools

### `apply_patch`

Apply a unified diff patch to a file. Saves ~90% tokens compared to full-file `write` for modifications. Uses standard unified diff format (same as `diff -u` output).

**Parameters:**
- `file_path` (string) — Absolute path to the file to patch
- `patch` (string) — Unified diff patch to apply

## Install

Add to your `opencode.json`:
```json
{
  "plugin": ["file:///home/robby/four-opencode-supertools"]
}
```

## Development

```bash
mise run setup    # Install dependencies
mise run build    # Build the plugin
mise run test     # Run tests
mise run typecheck # Type check
mise run lint     # Lint code
```

## License

Apache-2.0
