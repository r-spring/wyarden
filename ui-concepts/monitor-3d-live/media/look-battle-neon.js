/* Wyarden 3D monitor: the "Battle neon" look. NOT BUILT YET: this file is a stub.
 *
 * Until the look is written, the page draws it like NEXUS and the switcher says "not built".
 * To build it: replace this whole file by the look, as LOOKS.md (beside media/) describes, and
 * leave out `stub`. The test then stops counting it as "to do" and checks it like every built look.
 *
 * Source of the original: This repository at commit 0a8c20c: media/board.css lines 23 to 26 and 297 to 348 (git show 0a8c20c:media/board.css).
 */
(function (root) {
  'use strict';
  const inNode = typeof module !== 'undefined' && module.exports;
  const look = (inNode ? require('./looks.js') : root.MonitorLookRegistry).stub('battle-neon');

  if (inNode) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
