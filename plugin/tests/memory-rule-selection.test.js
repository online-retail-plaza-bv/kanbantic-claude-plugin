'use strict';

//
// memory-rule-selection.test.js — KBT-B678 / KBT-TC3602
//
// Covers the selector after it moved from CONTENT matching to TAG matching:
//   - `taggedMemoryRules` (all tagged items)
//   - `selectMemoryRule`  (the first, or null)
//
// The sharpest assertions here are the negative ones. Four of the six cases
// below are easy to satisfy; the two that carry the fix are:
//
//   1. an item naming MEMORY.md WITHOUT the tag must NOT match — that is the
//      only assertion proving text matching was *replaced* rather than
//      *supplemented*. An implementation keeping both mechanisms side by side
//      passes everything else while the false-positive risk stays.
//   2. the ADM-TRUL007 shape — "in-memory session state on production
//      replicas" — must not match either. Measuring that case is why widening
//      the pattern (direction C) was rejected on KBT-B678.
//
// Zero deps — Node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MEMORY_GUARD_TAG,
  taggedMemoryRules,
  selectMemoryRule,
} = require('../hooks/pre-tool-use-memory-guard.js');

/** A Toolkit item as `list_toolkit_items` returns it. */
function item(overrides) {
  return Object.assign(
    {
      id: '00000000-0000-0000-0000-000000000000',
      code: 'KBT-TRUL900',
      category: 'Rule',
      title: 'Stub rule',
      content: 'Stub body.\n',
      tags: [],
      isActive: true,
    },
    overrides
  );
}

// ---------------------------------------------------------------------------
// The tag is the selector
// ---------------------------------------------------------------------------

test('the tag name is exactly "memory-guard"', () => {
  // Pinned deliberately: the tag lives in the workspace's own Tag table and is
  // matched by name. A rename here silently disables the hook everywhere.
  assert.equal(MEMORY_GUARD_TAG, 'memory-guard');
});

test('an item carrying the tag is selected', () => {
  const items = [
    item({ code: 'KBT-TRUL001', tags: ['backend'] }),
    item({ code: 'KBT-TRUL021', tags: ['memory-guard'] }),
    item({ code: 'KBT-TRUL099', tags: [] }),
  ];
  assert.equal(selectMemoryRule(items).code, 'KBT-TRUL021');
  assert.equal(taggedMemoryRules(items).length, 1);
});

test('the tag is matched alongside other tags on the same item', () => {
  const items = [item({ code: 'ADM-TRUL006', tags: ['docs', 'memory-guard', 'testing'] })];
  assert.equal(selectMemoryRule(items).code, 'ADM-TRUL006');
});

// ---------------------------------------------------------------------------
// The two assertions that carry the fix
// ---------------------------------------------------------------------------

test('an untagged item naming MEMORY.md and the memory path does NOT match', () => {
  // The exact shape the old content matcher keyed on. If this passes, text
  // matching is gone rather than merely supplemented.
  const items = [
    item({
      code: 'KBT-TRUL021',
      title: 'NOOIT lokale memory — kennis in de AI Toolkit',
      content:
        'Schrijf niets in ~/.claude/projects/<slug>/memory/ of MEMORY.md voor dit werkgebied.\n',
      tags: [],
    }),
  ];
  assert.equal(selectMemoryRule(items), null);
  assert.deepEqual(taggedMemoryRules(items), []);
});

test('the ADM-TRUL007 shape does not match — "in-memory" is about production replicas', () => {
  // Why widening the matcher was rejected (KBT-B678). A pattern on /memory/i
  // would quote a rule about infrastructure at a memory write.
  const items = [
    item({
      code: 'ADM-TRUL007',
      title: 'adminhub-api draait in prod met exact 1 replica — in-memory sessiestate',
      content: 'Schalen naar 2 replicas verliest sessies zolang de state in-memory staat.\n',
      tags: ['devops'],
    }),
  ];
  assert.equal(selectMemoryRule(items), null);
});

// ---------------------------------------------------------------------------
// Multiple tagged items — first wins, all reported
// ---------------------------------------------------------------------------

test('more than one tagged item: the first is selected, every hit stays available', () => {
  const items = [
    item({ code: 'KBT-TRUL021', tags: ['memory-guard'] }),
    item({ code: 'KBT-TRUL077', tags: ['memory-guard'] }),
  ];
  assert.equal(selectMemoryRule(items).code, 'KBT-TRUL021');

  // The hook needs every hit for its debug line; taking the first must not
  // discard the knowledge that there were more.
  const all = taggedMemoryRules(items);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((i) => i.code), ['KBT-TRUL021', 'KBT-TRUL077']);
});

// ---------------------------------------------------------------------------
// Nothing tagged, and malformed input
// ---------------------------------------------------------------------------

test('a populated list without the tag yields null', () => {
  const items = [
    item({ code: 'KBT-TRUL001', tags: ['backend'] }),
    item({ code: 'KBT-TRUL002', tags: ['docs', 'testing'] }),
  ];
  assert.equal(selectMemoryRule(items), null);
});

test('missing, null and empty tag arrays never throw', () => {
  const items = [
    item({ tags: undefined }),
    item({ tags: null }),
    item({ tags: [] }),
    item({ tags: 'memory-guard' }), // string, not array — must not count
    null,
    undefined,
  ];
  assert.equal(selectMemoryRule(items), null);
  assert.deepEqual(taggedMemoryRules(items), []);
});

test('non-array input yields an empty result rather than an exception', () => {
  for (const bad of [undefined, null, '', 42, {}, 'memory-guard']) {
    assert.deepEqual(taggedMemoryRules(bad), []);
    assert.equal(selectMemoryRule(bad), null);
  }
});

test('an exact name match is required — near misses do not count', () => {
  const items = [
    item({ code: 'A', tags: ['memory-guards'] }),
    item({ code: 'B', tags: ['Memory-Guard'] }),
    item({ code: 'C', tags: ['hook:memory-guard'] }),
    item({ code: 'D', tags: [' memory-guard'] }),
  ];
  // Case and whitespace matter: the workspace writes the tag by hand, and a
  // near miss must fail loudly at verification time rather than half-work.
  assert.equal(selectMemoryRule(items), null);
});
