#!/usr/bin/env node
'use strict';

//
// router-mutant.js — KBT-TC4195 stap 6 / KBT-T5219
//
// The always-allow MUTANT of permission-request-router.js: the very same
// production script, started through its injection seam `main({ decide })`
// with a decide() that allows everything. The suite spawns this file in place
// of the router (only when ROUTER_MUTATION=always-allow is set for the TEST
// process) to prove that its negative cases go red against a router that
// allows too much.
//
// Test-only. Never referenced from hooks.json; the production router reads no
// environment switch at all.
//

const path = require('node:path');

const router = require(path.join(__dirname, '..', '..', 'hooks', 'permission-request-router.js'));

router.main({ decide: () => ({ allow: true, rule: 'mutation:always-allow' }) })
  .catch(() => process.exit(0));
