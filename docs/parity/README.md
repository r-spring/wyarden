# Windows and Linux parity

Entomatical uses one source tree with generic `windows` and `linux` sides. The feature registry is `docs/parity/FEATURES.md`. Its status tokens and commit identifiers are inherited historical records, not fresh acceptance of this source distribution. Excluded historical evidence is not available here.

Run `npm run parity`, or `node tools/parity.js --side windows` and `node tools/parity.js --side linux`. The checker uses the TypeScript parser to compare board UI strings with the registry. Each string has one owner; aliases, deliberate ignores and temporary side differences remain explicit. A side difference cannot remain when both sides are `done`. Missing strings, unowned strings, duplicate statuses and conflict markers fail the check.

Update the registry when changing visible UI text. Test behavior in the relevant editor and platform before recording new acceptance, with evidence for what was exercised. A local test or package inspection does not establish native or provider acceptance. Features without visible text, layout, colors and host notifications need separate checks.

Windows owns the C# launcher/recorder and their build script. Linux uses the shared Node wrapper and platform-specific process/audio helpers. Other code and webviews are shared; keep platform branches explicit. Select your own editor/profile when installing; see `docs/development.md`. Runtime changes and any external communication remain subject to the user's task permissions.
