/* Monitor 3D mock-up: where things go.
 *
 * Y is the class (one fixed floor each), X and Z are ownership (one column per session, in order
 * of first appearance), and inside a column each floor has nine fixed slots. A position is a pure
 * function of (column, floor, slot): it never depends on how many nodes there are, on the clock,
 * on a name or on the look. That is what keeps an existing node still when another arrives or
 * leaves.
 */
(function (root) {
  'use strict';

  const FLOORS = ['agent', 'mcp', 'tool', 'resource'];            // top to bottom
  const FLOOR_LEVEL = { resource: 0, tool: 1, mcp: 2, agent: 3 };
  const FLOOR_OF = { agent: 'agent', subagent: 'agent', mcp: 'mcp', tool: 'tool', resource: 'resource' };
  const FLOOR_TITLE = { agent: 'AGENTS', mcp: 'MCP SERVERS / BOUNDARY', tool: 'TOOLS', resource: 'RESOURCES' };

  const FLOOR_GAP = 170;        // world units between two floors
  const SPREAD = 1.6;           // "Separate the floors" multiplies the gap by this
  const COLUMNS_PER_ROW = 6;
  const MAX_COLUMNS = 12;
  const CELL = 200;             // a column's footprint, square
  const PITCH = 250;            // column to column, along X
  const ROW_PITCH = 320;        // row to row, along Z (the second row stands behind the first)
  const SLOT_PITCH = 62;
  const SLOTS = 9;              // a 3 x 3 grid in each cell
  const STACK_SLOT = 8;         // the last slot belongs to the "+N" stack
  const AGENT_SLOT = 4;         // the centre of the agent floor belongs to the agent itself
  const DOCK = -1;              // the column index of the boundary dock, where MCP servers stand

  function floorY(floor, spread) {
    return FLOOR_LEVEL[floor] * FLOOR_GAP * (spread || 1);
  }
  function columnOrigin(col) {
    if (col === DOCK) return [-PITCH, 0];
    return [(col % COLUMNS_PER_ROW) * PITCH, Math.floor(col / COLUMNS_PER_ROW) * ROW_PITCH];   // +Z is away from the camera
  }
  function slotOffset(slot) {
    return [(slot % 3 - 1) * SLOT_PITCH, (Math.floor(slot / 3) - 1) * SLOT_PITCH];   // row 0 is at the front
  }
  /** World position of a slot. `place` is anything with col, floor and slot. */
  function position(place, spread) {
    const origin = columnOrigin(place.col), offset = slotOffset(place.slot);
    return [origin[0] + offset[0], floorY(place.floor, spread), origin[1] + offset[1]];
  }
  /** The four corners of one column's tile on one floor. */
  function tile(col, floor, spread) {
    const origin = columnOrigin(col), y = floorY(floor, spread), h = CELL / 2;
    return [[origin[0] - h, y, origin[1] - h], [origin[0] + h, y, origin[1] - h], [origin[0] + h, y, origin[1] + h], [origin[0] - h, y, origin[1] + h]];   // front left first
  }
  /** Which floors a column has: the dock only carries the MCP floor, a session column the other three. */
  function floorsOf(col) {
    return col === DOCK ? ['mcp'] : ['agent', 'tool', 'resource'];
  }
  /** The slots a class may take in its cell, lowest first. */
  function slotsFor(cls) {
    if (cls === 'agent') return [AGENT_SLOT];
    if (cls === 'subagent') return [0, 1, 2, 3, 5, 6, 7];
    return [0, 1, 2, 3, 4, 5, 6, 7];
  }
  /** The box around the floors of the given columns, with the dock unless `withDock` is false. */
  function bounds(cols, spread, withDock) {
    const all = (withDock === false ? [] : [DOCK]).concat(cols || []), h = CELL / 2;
    const min = [Infinity, 0, Infinity], max = [-Infinity, floorY('agent', spread) + 60, -Infinity];
    for (const col of all) {
      const origin = columnOrigin(col);
      min[0] = Math.min(min[0], origin[0] - h); max[0] = Math.max(max[0], origin[0] + h);
      min[2] = Math.min(min[2], origin[1] - h); max[2] = Math.max(max[2], origin[1] + h);
    }
    return { min, max };
  }

  const api = {
    FLOORS, FLOOR_LEVEL, FLOOR_OF, FLOOR_TITLE, FLOOR_GAP, SPREAD, COLUMNS_PER_ROW, MAX_COLUMNS, CELL, PITCH, ROW_PITCH,
    SLOT_PITCH, SLOTS, STACK_SLOT, AGENT_SLOT, DOCK,
    floorY, columnOrigin, slotOffset, position, tile, floorsOf, slotsFor, bounds
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MonitorLayout = api;
})(typeof window === 'undefined' ? globalThis : window);
