'use strict';

//
// KBT-F720 (KBT-TC3712) — Integration: the plugin's own README + the two unattended-run
// skills (kanbantic-orchestrate, kanbantic-bug-autopilot) must (a) never mention the
// non-existent `check_messages` tool, (b) point at the real polling fallback
// (`get_channel_messages`), and (c) send an agent that needs human input during an
// unattended run to the channel protocol (send_message + wait_for_user) rather than only
// to a live terminal (`AskUserQuestion`).
//
// These are static-content assertions on the actual shipped Markdown a skill loads at
// runtime — the "Integration" level of KBT-F720's test-policy (KBT-B551 declared record).
//

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const README_PATH = path.resolve(__dirname, '..', 'README.md');
const ORCHESTRATE_PATH = path.resolve(__dirname, '..', 'skills', 'kanbantic-orchestrate', 'SKILL.md');
const BUG_AUTOPILOT_PATH = path.resolve(__dirname, '..', 'skills', 'kanbantic-bug-autopilot', 'SKILL.md');

test('KBT-TC3712a — README no longer references the non-existent check_messages tool', () => {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  assert.doesNotMatch(readme, /check_messages/, 'README must not mention the non-existent check_messages tool');
});

test('KBT-TC3712b — README documents get_channel_messages as the polling fallback', () => {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  assert.match(readme, /get_channel_messages/, 'README must document get_channel_messages as the polling fallback');
});

test('KBT-TC3712c — README references the chat-protocol Toolkit Rule (KBT-TRUL041 / KBT-F720)', () => {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  assert.match(readme, /KBT-TRUL041/, 'README must point at the Toolkit Rule that is the source of truth for the chat-protocol');
  assert.match(readme, /Chat-protocol/i, 'README must have a chat-protocol section');
});

test('KBT-TC3712d — kanbantic-orchestrate points unattended human-input to the channel protocol', () => {
  const skill = fs.readFileSync(ORCHESTRATE_PATH, 'utf8');
  assert.match(skill, /send_message/, 'orchestrate must mention send_message for agent-to-agent / human hand-offs');
  assert.match(skill, /wait_for_user/, 'orchestrate must mention wait_for_user, not only AskUserQuestion');
  assert.match(skill, /KBT-TRUL041/, 'orchestrate must reference the chat-protocol Toolkit Rule');
});

test('KBT-TC3712e — kanbantic-bug-autopilot points unattended human-input to the channel protocol', () => {
  const skill = fs.readFileSync(BUG_AUTOPILOT_PATH, 'utf8');
  assert.match(skill, /send_message/, 'bug-autopilot must mention send_message for unattended human-input');
  assert.match(skill, /wait_for_user/, 'bug-autopilot must mention wait_for_user');
  assert.match(skill, /KBT-TRUL041/, 'bug-autopilot must reference the chat-protocol Toolkit Rule');
  assert.match(skill, /category:\s*"Rule"/, 'bug-autopilot must load the Rule-category Toolkit items (not just ClaudeMd)');
});
