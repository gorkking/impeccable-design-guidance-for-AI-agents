import fs from 'fs';
import path from 'path';

/**
 * Rewrite project-relative script paths for the plugin subtree (issue #523).
 *
 * The ./plugin subtree is a verbatim copy of the dist/claude-code output,
 * where {{scripts_path}} resolves to `.claude/skills/impeccable/scripts`,
 * a path relative to the user's project. Run from the plugin cache, that
 * path points at whatever the project has installed: a plugin-only user
 * gets MODULE_NOT_FOUND, and a dual-install user silently runs the
 * project's (possibly older) skill copy.
 *
 * There is no literal path that works for plugins (CLAUDE_PLUGIN_ROOT is
 * hook-only), so the plugin's markdown uses the `<skill-base-dir>` form
 * SKILL.md's Setup step 1 already leads with: the runtime shows the
 * skill's loaded base directory when it loads the skill, and scripts
 * resolve against that.
 */

// The resolved {{scripts_path}} in dist/claude-code output, fixed by the
// Claude Code transformer's configDir (.claude) + skill name (impeccable).
export const CLAUDE_PROJECT_SCRIPTS_PATH = '.claude/skills/impeccable/scripts';

export const PLUGIN_SCRIPTS_PATH = '<skill-base-dir>/scripts';

// The project-path rule pre-approves a path inside the user's project, the
// one place the plugin must NOT run scripts from. Claude Code Bash rules
// support mid-pattern wildcards, so scope approval to the skill's own
// scripts directory wherever the plugin cache puts it.
export const PLUGIN_ALLOWED_TOOLS_RULE = 'Bash(node */skills/impeccable/scripts/*)';

// Setup step 1's second sentence names the project path as the fallback
// when the runtime reports no base directory. A plugin install has no
// working project fallback (that path is the bug this rewrite exists to
// fix), and every instruction in the plugin copy already carries the
// token, so the sentence loses its fallback clause.
const SETUP_FALLBACK_TEXT =
  'That base directory resolves every `node .claude/skills/impeccable/scripts/...` command in this skill and its references, ' +
  'and `.claude/skills/impeccable/scripts` is the fallback only when the runtime reports no base directory.';
const SETUP_PLUGIN_TEXT =
  'Every `node <skill-base-dir>/scripts/...` command in this skill and its references resolves against that base directory.';

/**
 * Rewrite one markdown file's content for the plugin subtree. Pure, so the
 * unit suite can pin every rewrite without a build.
 */
export function rewritePluginMarkdown(content) {
  return content
    // Order matters: the allowed-tools rule contains the project path, so
    // rewrite it before the generic path replacement turns it into a
    // rule that matches nothing.
    .replaceAll(`Bash(node ${CLAUDE_PROJECT_SCRIPTS_PATH}/*)`, PLUGIN_ALLOWED_TOOLS_RULE)
    .replaceAll(SETUP_FALLBACK_TEXT, SETUP_PLUGIN_TEXT)
    .replaceAll(CLAUDE_PROJECT_SCRIPTS_PATH, PLUGIN_SCRIPTS_PATH);
}

/**
 * Fail the build when the copied SKILL.md no longer matches the rewrite.
 * The fallback-sentence replacement keys on the exact Setup step 1 text; if
 * SKILL.src.md rewords it, replaceAll silently no-ops and the plugin ships
 * the project path as its fallback. Loud beats wrong: the build stops here
 * so plugin-paths.js gets updated alongside the source.
 */
export function verifyPluginSkillRewrite(skillMdPath) {
  const content = fs.readFileSync(skillMdPath, 'utf-8');
  if (!content.includes(SETUP_PLUGIN_TEXT)) {
    throw new Error(
      `Plugin rewrite drift: ${skillMdPath} is missing the <skill-base-dir> resolution sentence. ` +
      "SKILL.src.md's Setup step 1 fallback sentence no longer matches the replacement in " +
      'scripts/lib/plugin-paths.js (issue #523); update SETUP_FALLBACK_TEXT to the new wording.',
    );
  }
  if (!content.includes(PLUGIN_ALLOWED_TOOLS_RULE)) {
    throw new Error(
      `Plugin rewrite drift: ${skillMdPath} is missing the allowed-tools rule ` +
      `${PLUGIN_ALLOWED_TOOLS_RULE}. SKILL.src.md's allowed-tools entry no longer matches the ` +
      'replacement in scripts/lib/plugin-paths.js (issue #523).',
    );
  }
}

/**
 * Apply rewritePluginMarkdown to every .md file under dir, recursively.
 * Script files are left alone: the only project-relative paths in them
 * (hook-admin.mjs) install project-scoped hooks via ${CLAUDE_PROJECT_DIR},
 * which is that command's actual job.
 */
export function rewritePluginMarkdownTree(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewritePluginMarkdownTree(entryPath);
    } else if (entry.name.endsWith('.md')) {
      const original = fs.readFileSync(entryPath, 'utf-8');
      const rewritten = rewritePluginMarkdown(original);
      if (rewritten !== original) fs.writeFileSync(entryPath, rewritten);
    }
  }
}
