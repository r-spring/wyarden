# Wyarden checks

The `monitor-live-tests` entry in `checks.json` runs the live monitor suite from the repository root. Run the same command directly from a terminal:

```sh
node --test "ui-concepts/monitor-3d-live/test/*.test.js"
```

Install a current Node.js LTS. The page tests use Edge or Chrome when available and otherwise report skips. To package the extension after checking a change, follow the source build instructions. [Wyarden README](https://github.com/r-spring/wyarden#build-or-preview-from-source)
