// plugin/scripts/setup.mjs — shared interactive setup engine.
// Entry points: /crossverify:setup (plugin), node install.mjs (clone),
// npx crossverify init (phase 2). One code path for all three.
//
// Interactive flow intentionally not unit-tested: it is a readline dialog;
// all effects delegate to tested functions (setConfKey, addHook).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/entry.mjs';
import { setConfKey, globalConfPath, projectConfPath } from './lib/config.mjs';
import { addHook, quoteForCommand } from './lib/settings.mjs';
import { resolveCodexCommand } from './lib/codex.mjs';
import { createPrompter, StdinClosedError } from './lib/prompt.mjs';

function detectCodex() {
  const resolved = resolveCodexCommand();
  const res = spawnSync(resolved.command, resolved.wrap(['--version']), { encoding: 'utf8' });
  if (res.error || res.status !== 0) return null;
  return (res.stdout || '').trim();
}

// Is `crossverify` itself resolvable on PATH? Plugin/clone installs never add
// it — only an npm global install (phase 2) or a manual symlink/alias would.
// Print-only, non-interactive-safe: never prompts, just tells the user what
// to run instead.
function isOnPath(cmd) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    encoding: 'utf8',
  });
  return !probe.error && probe.status === 0;
}

// Plugin installs get their Stop hook from hooks/hooks.json and must never
// also merge one into settings.json (that would fire the hook twice). The
// primary signal is CLAUDE_PLUGIN_ROOT, but the command that invokes this
// script is prompt-substituted by Claude Code, not exported into the child's
// env — so an agent-run Bash command can lose it. Fall back to recognizing
// the plugin cache directory layout from this module's own path.
function detectPluginContext() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'env:CLAUDE_PLUGIN_ROOT';
  const here = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  if (here.includes('/.claude/plugins/') || here.includes('/plugins/cache/')) {
    return 'path:plugin-cache-layout';
  }
  return null;
}

async function ask(prompter, question, choices, def) {
  for (;;) {
    const raw = (
      await prompter.ask(`${question} [${choices.join('/')}] (default: ${def}): `)
    )
      .trim()
      .toLowerCase();
    if (raw === '') return def;
    if (choices.includes(raw)) return raw;
    console.log(`Please answer one of: ${choices.join(', ')}`);
  }
}

export async function main() {
  const cwd = process.cwd();
  const changed = [];

  // 1. Codex CLI is a hard prerequisite — fail fast with a pointer.
  const codexVersion = detectCodex();
  if (codexVersion === null) {
    console.error('crossverify setup: Codex CLI not found on PATH.');
    console.error('Install it first: https://github.com/openai/codex');
    console.error('Then re-run this setup.');
    process.exit(1);
  }
  console.log(`Found Codex CLI: ${codexVersion}`);

  const prompter = createPrompter();

  // 2. Collect ALL answers first — no config write happens until every
  //    question has been answered. If stdin closes mid-dialog (piped/
  //    non-interactive input), bail out cleanly before touching anything.
  let scope, output;
  try {
    scope = await ask(
      prompter,
      'Enable crossverify globally or for this project only?',
      ['global', 'project'],
      'project'
    );
    output = await ask(
      prompter,
      'Where should verdict reports go?',
      ['project', 'global'],
      'project'
    );
  } catch (err) {
    prompter.close();
    if (err instanceof StdinClosedError) {
      console.error('stdin closed — run interactively: node install.mjs (or pipe both answers: printf "project\\nproject\\n" | node install.mjs)');
      process.exit(1);
    }
    throw err;
  }

  try {
    // 3. Apply answers now that the whole dialog succeeded.
    setConfKey(scope, 'enabled', '1', cwd);
    const confPath = scope === 'global' ? globalConfPath() : projectConfPath(cwd);
    changed.push(confPath);

    setConfKey(scope, 'output', output, cwd);

    // 4. Stop hook: plugin installs get it from hooks.json — never touch
    //    settings.json in that case.
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const pluginContext = detectPluginContext();
    if (pluginContext) {
      console.log(
        `Plugin install detected (${pluginContext}): Stop hook is provided by hooks.json — settings.json not touched.`
      );
    } else {
      let result;
      try {
        result = addHook(settingsPath);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
      changed.push(settingsPath);
      if (result.backedUp) changed.push(settingsPath + '.bak');
      console.log(
        result.added
          ? `Stop hook added to ${settingsPath} (backup: ${settingsPath}.bak)`
          : `Stop hook already present in ${settingsPath} — left as-is.`
      );
    }

    // 5. Statusline offer — print only, NEVER write the statusLine key
    //    (Claude Code has one statusLine slot; clobbering it is forbidden).
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch {
        settings = {};
      }
    }
    const segmentPath = fileURLToPath(
      new URL('./statusline-segment.mjs', import.meta.url)
    );
    if (!('statusLine' in settings)) {
      console.log('');
      console.log(
        'Optional: no statusLine configured. For a passive [VFY] indicator, add this to your settings.json yourself:'
      );
      console.log(
        `  "statusLine": { "type": "command", "command": ${JSON.stringify(`node ${quoteForCommand(segmentPath)}`)} }`
      );
    } else {
      console.log('');
      console.log(
        'Existing statusLine detected — crossverify never overwrites it. To append the [VFY] segment, add this to the end of your statusline command:'
      );
      console.log(`  node ${quoteForCommand(segmentPath)}`);
    }

    // 6. Final summary: every path written/changed.
    console.log('');
    console.log('Setup complete. Paths written/changed:');
    for (const p of [...new Set(changed)]) console.log(`  ${p}`);
    console.log('Undo at any time: crossverify uninstall (prints every path it removes).');

    // 7. `crossverify` is not on PATH for plugin/clone installs — print the
    //    exact command to use instead. Print-only, never prompts.
    if (!isOnPath('crossverify')) {
      const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
      console.log('');
      console.log("'crossverify' is not on PATH. Use this instead of the bare command:");
      console.log(`  node "${cliPath}" <args>`);
      console.log('Or add a shell alias:');
      console.log(`  alias crossverify='node "${cliPath}"'`);
    }
  } finally {
    prompter.close();
  }
}

// Self-run when executed directly (node plugin/scripts/setup.mjs);
// inert when imported by install.mjs, which calls main() itself.
if (isMainModule(import.meta.url)) {
  await main();
}
