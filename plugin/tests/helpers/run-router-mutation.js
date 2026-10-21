#!/usr/bin/env node
'use strict';

//
// run-router-mutation.js — KBT-TC4195 stap 6 / KBT-T5219
//
// Runs plugin/tests/permission-request-router.test.js with the always-allow
// mutant (helpers/router-mutant.js) in place of the router and checks that the
// mutation is KILLED: every `no decision:` case must be red. Prints the totals.
//
//   npm run test:router:mutation
//
// Exit 0 when the mutant is killed (all negative cases red), 1 otherwise. The
// env name below is read by the test file only — no production hook knows it.
//

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST = path.join(__dirname, '..', 'permission-request-router.test.js');

const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', TEST], {
  env: { ...process.env, ROUTER_MUTATION: 'always-allow' },
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

const out = `${r.stdout || ''}\n${r.stderr || ''}`;
const num = (key) => {
  const m = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(out);
  return m ? Number(m[1]) : NaN;
};
const tests = num('tests');
const fail = num('fail');
const pass = num('pass');
const negGreen = (out.match(/^\s*ok \d+ - no decision: /gm) || []).length;
const negRed = (out.match(/^\s*not ok \d+ - no decision: /gm) || []).length;

console.log(`router mutation run (always-allow mutant): ${fail}/${tests} red, ${pass} green; negative cases red ${negRed}, green ${negGreen}`);

if (!Number.isFinite(tests) || tests === 0) {
  console.error('could not read the test totals');
  console.error(out.slice(-4000));
  process.exit(1);
}
if (negGreen > 0 || negRed === 0 || fail === 0) {
  console.error('MUTANT SURVIVED: at least one negative case did not notice an always-allow router');
  for (const line of out.match(/^\s*ok \d+ - no decision: .*$/gm) || []) console.error(`  ${line.trim()}`);
  process.exit(1);
}
console.log('mutant killed');
process.exit(0);
