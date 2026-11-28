/* Wyarden 3D monitor: the "Paper dark" look. NOT BUILT YET: this file is a stub.
 *
 * Until the look is written, the page draws it like NEXUS and the switcher says "not built".
 * To build it: replace this whole file by the look, as LOOKS.md (beside media/) describes, and
 * leave out `stub`. The test then stops counting it as "to do" and checks it like every built look.
 *
 * Source of the original: public/index.html lines 19 to 22.
 */
(function (root) {
  'use strict';
  const inNode = typeof module !== 'undefined' && module.exports;
  const look = (inNode ? require('./looks.js') : root.MonitorLookRegistry).stub('paper-dark');

  if (inNode) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
