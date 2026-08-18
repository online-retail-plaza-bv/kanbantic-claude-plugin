'use strict';

//
// memory-path.test.js — KBT-B492 / KBT-TC3582
//
// Unit-covers the two pure helpers that decide whether the anti-memory hook
// does anything at all:
//   - `isLocalMemoryPath`  (scripts/memory-path.js)
//   - `extractFilePath`    (hooks/pre-tool-use-memory-guard.js)
//
// Why these are tested apart from the hook's network path: this matcher runs on
// EVERY Write and Edit in EVERY repository. Too broad and the hook asks for
// confirmation everywhere and gets switched off within a day; too narrow and it
// does nothing. The negative cases below are therefore the sharpest assertions
// in this file — `src/memory/cache.ts` and `MEMORY.md.bak` are the two that a
// naive regex gets wrong.
//
// Zero deps — Node built-ins only.
//

const test = require('node:test');
const assert = require('node:assert/strict');

const { isLocalMemoryPath, normalizePath } = require('../scripts/memory-path.js');
const { extractFilePath } = require('../hooks/pre-tool-use-memory-guard.js');

// ---------------------------------------------------------------------------
// Must match — the paths KBT-TRUL021 is about
// ---------------------------------------------------------------------------

test('matches a Windows project-memory path', () => {
  assert.equal(
    isLocalMemoryPath('C:\\Users\\admin123\\.claude\\projects\\C--github-Kanbantic\\memory\\foo.md'),
    true
  );
});

test('matches the same path in POSIX form', () => {
  assert.equal(
    isLocalMemoryPath('/c/Users/admin123/.claude/projects/C--github-Kanbantic/memory/foo.md'),
    true
  );
});

test('matches regardless of casing', () => {
  assert.equal(
    isLocalMemoryPath('/home/x/.CLAUDE/Projects/Some-Slug/MEMORY/note.md'),
    true
  );
});

test('matches MEMORY.md at root level and nested', () => {
  assert.equal(isLocalMemoryPath('MEMORY.md'), true);
  assert.equal(isLocalMemoryPath('/c/Users/admin123/.claude/projects/x/MEMORY.md'), true);
  assert.equal(isLocalMemoryPath('some/deep/path/MEMORY.md'), true);
});

test('matches a nested file below the memory directory', () => {
  assert.equal(
    isLocalMemoryPath('/home/x/.claude/projects/slug/memory/sub/dir/fact.md'),
    true
  );
});

// ---------------------------------------------------------------------------
// Must NOT match — the false-positive guards
// ---------------------------------------------------------------------------

test('does not match ordinary source files', () => {
  assert.equal(isLocalMemoryPath('src/Kanbantic.Domain/Foo.cs'), false);
  assert.equal(isLocalMemoryPath('plugin/hooks/hooks.json'), false);
  assert.equal(isLocalMemoryPath('C:\\github\\Kanbantic\\README.md'), false);
});

test('does not match a "memory" directory outside .claude/projects', () => {
  // The sharpest negative: a real app can legitimately have src/memory/.
  assert.equal(isLocalMemoryPath('src/memory/cache.ts'), false);
  assert.equal(isLocalMemoryPath('/app/lib/memory/store.js'), false);
});

test('does not match .claude/projects/memory without a project slug segment', () => {
  // `<slug>` must be a real segment; this shape is not the per-project store.
  assert.equal(isLocalMemoryPath('/home/x/.claude/projects/memory/foo.md'), false);
});

test('does not match a filename that merely starts with MEMORY.md', () => {
  assert.equal(isLocalMemoryPath('MEMORY.md.bak'), false);
  assert.equal(isLocalMemoryPath('/tmp/MEMORY.md.old'), false);
  assert.equal(isLocalMemoryPath('NOT-MEMORY.md'), false);
});

// ---------------------------------------------------------------------------
// Missing / malformed input — must never throw
// ---------------------------------------------------------------------------

test('returns false for absent, empty, and non-string input without throwing', () => {
  assert.equal(isLocalMemoryPath(undefined), false);
  assert.equal(isLocalMemoryPath(null), false);
  assert.equal(isLocalMemoryPath(''), false);
  assert.equal(isLocalMemoryPath('   '), false);
  assert.equal(isLocalMemoryPath(42), false);
  assert.equal(isLocalMemoryPath({}), false);
});

test('normalizePath collapses separators and folds case', () => {
  assert.equal(normalizePath('C:\\A\\\\B/c.MD'), 'c:/a/b/c.md');
  assert.equal(normalizePath(''), '');
  assert.equal(normalizePath(null), '');
});

// ---------------------------------------------------------------------------
// Payload extraction — the hook's other pure decision (TC3582 step 3 + 4)
// ---------------------------------------------------------------------------

test('extractFilePath reads tool_input.file_path', () => {
  assert.equal(
    extractFilePath({ tool_input: { file_path: '/x/MEMORY.md' } }),
    '/x/MEMORY.md'
  );
});

test('extractFilePath returns empty for missing or malformed events', () => {
  assert.equal(extractFilePath(null), '');
  assert.equal(extractFilePath(undefined), '');
  assert.equal(extractFilePath({}), '');
  assert.equal(extractFilePath({ tool_input: {} }), '');
  assert.equal(extractFilePath({ tool_input: { file_path: '' } }), '');
  assert.equal(extractFilePath({ tool_input: { file_path: null } }), '');
  assert.equal(extractFilePath({ tool_input: 'not-an-object' }), '');
});

test('extractFilePath accepts the snake_case and camelCase spellings', () => {
  // Different tools in the Claude Code surface have used both; accepting each
  // costs nothing and a missed spelling silently disables the hook.
  assert.equal(extractFilePath({ tool_input: { filePath: '/x/MEMORY.md' } }), '/x/MEMORY.md');
});
