'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui', 'board.js'), 'utf8');
const expected = ['⭕', '❌', '❓', '老', '藥', '鄭', '許', '方', '姬', '木', '黃', '壞', '好'];
const markerBlock = source.match(/const CHAIN_PERSONAL_MARKERS = \[([^\]]+)\]/);
assert(markerBlock, 'the personal marker palette must exist');
const actual = [...markerBlock[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
assert.deepStrictEqual(actual, expected, 'the marker palette must match all 13 requested symbols');
assert(source.includes('GD.store.get(key, {})') && source.includes('GD.store.set(key, marks)'),
  'personal markers must be persisted through local browser storage');
assert(source.includes('const MAX_CHAIN_PERSONAL_MARKS = 24;'),
  'the simultaneous personal-mark cap must be tripled to 24 without expanding the symbol palette');
assert(source.includes('countChainMarks(marks) >= MAX_CHAIN_PERSONAL_MARKS'),
  'the 24-mark cap must count placements across the complete game');
assert(source.includes('已達 ${MAX_CHAIN_PERSONAL_MARKS} 個上限') && source.includes('點擊已放置的標記刪除'),
  'the user must be told that deleting a mark frees a placement slot');
assert(source.includes('room.gameId || room.roomId') && source.includes('ownerId'),
  'marker storage must be scoped by room/game and the local viewer');
assert(source.includes("addEventListener('dragstart'") && source.includes("addEventListener('dragover'") && source.includes("addEventListener('drop'"),
  'desktop drag and drop handlers must be present');
assert(source.includes("addEventListener('click', e =>") && source.includes('S.chainMarkerSelected'),
  'mobile tap-to-select then tap-player flow must be present');
assert(source.includes('data-round-index="${i}"') && source.includes('data-player-id="${U.esc(pid)}"'),
  'each personal marker must be stored against a specific round and player');
assert(!/room\.(?:chainMarkers|personalMarkers|playerMarks)/.test(source),
  'personal markers must never be attached to the shared room object');
console.log('v10.8.19 personal marker storage regression: PASS (13 original symbols, 24 simultaneous placements, local-only, round/player scoped, mouse + touch flow)');
