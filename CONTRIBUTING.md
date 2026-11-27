# Contributing to Wyarden

For a change to the live monitor, work under `ui-concepts/monitor-3d-live/`. Its editor host is in `extension.js`, its local session and collector code is in `lib/`, and its webview code is in `media/`. The simulated browser preview lives under `ui-concepts/monitor-3d/`.

Build and check the live monitor from the repository root with a current Node.js LTS:

```sh
node --test "ui-concepts/monitor-3d-live/test/*.test.js"
node ui-concepts/monitor-3d-live/tools/pack.js
```

For changes to the simulated preview, run `node ui-concepts/monitor-3d/check.js`. Use synthetic session events in tests and examples. If you test manually, install the built VSIX in a separate editor profile and use a disposable local workspace. Describe the host, provider, and exact steps in the pull request.

Keep the per-session data filters and loopback-only hub intact. Preserve attribution in adapted files. Discuss bigger runtime or privacy changes in an issue before implementing them. [Issues](https://github.com/r-spring/wyarden/issues) · [Code of conduct](https://github.com/r-spring/wyarden/blob/main/CODE_OF_CONDUCT.md) · [Private security reporting](https://github.com/r-spring/wyarden/security/advisories/new)
