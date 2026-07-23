// lib/entry.mjs — shared "am I the executed script?" guard for modules that
// are both imported (tests, install.mjs) and run directly (hook, setup).
//
// argv[1] must be realpath'd before comparing: the ESM loader resolves
// import.meta.url through symlinks while argv stays literal, so a symlinked
// invocation (macOS /tmp -> /private/tmp, npm .bin shims, symlinked clone
// dirs) makes a raw comparison fail and the entry point silently no-op with
// exit 0. For a verification hook, "silently does nothing" is the worst
// failure mode available — hence one shared, tested implementation.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  let resolved = argv1;
  try {
    resolved = fs.realpathSync(argv1);
  } catch {
    // path may not exist (deleted between spawn and check) — compare literal
  }
  return importMetaUrl === pathToFileURL(resolved).href;
}
