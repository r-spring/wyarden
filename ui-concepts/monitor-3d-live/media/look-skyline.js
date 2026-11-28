/* Wyarden 3D monitor: the "Skyline" look. NOT BUILT YET: this file is a stub.
 *
 * Until the look is written, the page draws it like NEXUS and the switcher says "not built".
 * To build it: replace this whole file by the look, as LOOKS.md (beside media/) describes, and
 * leave out `stub`. The test then stops counting it as "to do" and checks it like every built look.
 *
 * Source of the original: Entridir repository (GPL v3), commit 63197c31: godot/looks/skyline.gd; picture docs/verification/godot-looks/looks.png.
 */
(function (root) {
  'use strict';
  const inNode = typeof module !== 'undefined' && module.exports;
  const look = (inNode ? require('./looks.js') : root.MonitorLookRegistry).stub('skyline');

  if (inNode) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
