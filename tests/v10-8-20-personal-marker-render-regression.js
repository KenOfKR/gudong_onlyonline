'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const board = fs.readFileSync(path.join(root, 'js/ui/board.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
const expected = ['⭕', '❌', '❓', '老', '藥', '鄭', '許', '方', '姬', '木', '黃', '壞', '好'];
const block = board.match(/const CHAIN_PERSONAL_MARKERS = \[([^\]]+)\]/);
assert(block, 'the personal symbol palette exists');
const actual = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
assert.deepStrictEqual(actual, expected, 'all 13 requested symbols are present, in order');
assert(/id="chainMarkerPanel"[\s\S]*id="chainMarkerTools"[\s\S]*id="chains"/.test(html),
  'the symbol toolbar must have its own persistent DOM container, separate from the timeline content');
const htmlButtons = [...html.matchAll(/data-chain-marker-pick="([^"]+)"/g)].map(m => m[1]).filter(x => x !== '');
assert.deepStrictEqual(htmlButtons, expected, 'the 13 original symbol buttons must exist directly in index.html before JavaScript starts');
assert(/aria-label="個人標記工具，最多同時保留 24 個"/.test(html), 'toolbar copy must explain the increased 24-placement cap');
assert(/data-chain-marker-count>0\/24</.test(html), 'toolbar must visibly display the 24-placement cap');
assert(board.includes("bindChainMarkerEvents(markerPanel)") && board.includes("querySelector('[data-chain-marker-pick=\"⭕\"]')"),
  'renderChains binds the stable parent and only fills missing legacy markup; it does not own first paint');
assert(board.includes("UI.html('chains', `<div style=\"display:grid;grid-template-columns:repeat(3"),
  'timeline re-render must not overwrite the toolbar');
assert((board.match(/data-chain-marker-pick="\$\{marker\}"/g) || []).length === 1,
  'legacy pages can still rebuild all symbols from the exact 13-symbol array');
assert(css.includes('.chain-marker-tools') && css.includes('.chain-marker-tool'),
  'the toolbar and symbols have visible styles');
assert(board.includes('拖曳到玩家；手機先點符號再點玩家'), 'the UI exposes drag and mobile tap instructions');
console.log('PASS v10.8.20 personal marker rendering: 13 symbols + 24 placement capacity mounted to stable dedicated toolbar');
