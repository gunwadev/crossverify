#!/usr/bin/env node
// install.mjs — clone-path entry point (audit-first users):
//   git clone <repo> && node install.mjs
// Same setup engine as /crossverify:setup — no separate logic here.
import { main } from './plugin/scripts/setup.mjs';

await main();
