'use strict';
const assert = require('assert');
const load = require('./harness');
const GD = load();
const { Engine } = GD;

function makeRoom(count, seats) {
  const room = Engine.newRoom('seat-test', 'p0');
  for (let i = 0; i < count; i++) {
    const player = Engine.addPlayer(room, { id: `p${i}`, name: `玩家${i}`, isBot: false });
    if (seats && seats[i] !== undefined) player.seatIndex = seats[i];
  }
  return room;
}

// Moving into an empty physical seat must leave the old seat empty, even with only two players.
{
  const room = makeRoom(2, [1, 6]);
  assert.strictEqual(Engine.shiftSeat(room, 'p0', 1), true);
  assert.strictEqual(room.players.find(p => p.id === 'p0').seatIndex, 2);
  assert.strictEqual(room.players.find(p => p.id === 'p1').seatIndex, 6);
  assert.strictEqual(Engine.shiftSeat(room, 'p0', -1), true);
  assert.strictEqual(room.players.find(p => p.id === 'p0').seatIndex, 1);
  assert.strictEqual(room.players.find(p => p.id === 'p1').seatIndex, 6);
}

// The fixed eight-seat ring wraps from 7 to 0, not from n-1 to 0.
{
  const room = makeRoom(2, [7, 3]);
  assert.strictEqual(Engine.shiftSeat(room, 'p0', 1), true);
  assert.strictEqual(room.players.find(p => p.id === 'p0').seatIndex, 0);
  assert.strictEqual(room.players.find(p => p.id === 'p1').seatIndex, 3);
}

// An occupied target is swapped, while all other gaps remain untouched.
{
  const room = makeRoom(3, [2, 3, 7]);
  assert.strictEqual(Engine.shiftSeat(room, 'p0', 1), true);
  assert.strictEqual(room.players.find(p => p.id === 'p0').seatIndex, 3);
  assert.strictEqual(room.players.find(p => p.id === 'p1').seatIndex, 2);
  assert.strictEqual(room.players.find(p => p.id === 'p2').seatIndex, 7);
}

// New arrivals use the first genuinely empty physical seat, without compacting existing players.
{
  const room = makeRoom(2, [0, 4]);
  const third = Engine.addPlayer(room, { id: 'p2', name: '玩家2', isBot: false });
  assert.strictEqual(third.seatIndex, 1);
  assert.deepStrictEqual(room.players.map(p => p.seatIndex), [0, 4, 1]);
}

// Removing a player does not pull anyone else into the vacated chair.
{
  const room = makeRoom(3, [0, 3, 7]);
  assert.strictEqual(Engine.kickPlayer(room, 'p0', 'p1'), true);
  assert.strictEqual(room.players.find(p => p.id === 'p0').seatIndex, 0);
  assert.strictEqual(room.players.find(p => p.id === 'p2').seatIndex, 7);
}

// Starting a full game preserves the chosen seat positions.
{
  const room = makeRoom(8, [0, 2, 4, 6, 7, 5, 3, 1]);
  const before = Object.fromEntries(room.players.map(p => [p.id, p.seatIndex]));
  assert.strictEqual(Engine.start(room), true);
  room.players.forEach(p => assert.strictEqual(p.seatIndex, before[p.id], `seat moved at game start: ${p.id}`));
}

console.log('v10.8.19 fixed eight-seat regression: PASS');
process.exit(0);
