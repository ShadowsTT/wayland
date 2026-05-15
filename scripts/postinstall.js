/**
 * Postinstall script for Wayland
 * Handles native module installation for different environments
 */

const { execSync } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');

// Note: web-tree-sitter is now a direct dependency in package.json
// No need for symlinks or copying - npm will install it directly to node_modules

/**
 * Widen declared dep ranges for any package whose version we've pinned
 * via this repo's `resolutions` / `overrides` blocks.
 *
 * Why: our root package.json security-pins several upstream packages
 * (axios, @xmldom/xmldom, body-parser, hono, jws, lodash-es,
 * mdast-util-to-hast, node-forge, tar, tmp, ws) to specific minimum
 * versions that fix CVEs. Bun's flat-hoist install puts the pinned
 * version at the root of node_modules/. Runtime resolution walks up the
 * tree and finds it, so the app works fine. BUT electron-builder's
 * dep-tree traversal collector reads each downstream package's declared
 * range literally — when a downstream declares e.g.
 * `axios: "~1.13.3"` but our override installs 1.16.x, the traversal
 * rejects the build with "production dependency not found ... version=~1.13.3".
 *
 * Fix: walk every nested package.json under node_modules/ and, for any
 * declared dep whose name is in our overrides list, rewrite the range
 * to `*`. This is safe because our root overrides still control which
 * version actually gets installed — the wildcard only relaxes the
 * traversal's literal-range check.
 *
 * Idempotent — only writes when the range actually needs widening.
 *
 * Limitation: this clobbers nested package.json files in node_modules.
 * They'll be restored on the next `bun install`, which is why this is
 * a postinstall script: every install reapplies the patches.
 */
function patchOverriddenDepRanges() {
  const rootPkg = require('../package.json');
  const overrideMap = { ...(rootPkg.resolutions || {}), ...(rootPkg.overrides || {}) };
  const overrideNames = new Set(Object.keys(overrideMap));
  if (overrideNames.size === 0) return;

  const nmRoot = path.join(__dirname, '..', 'node_modules');
  if (!fs.existsSync(nmRoot)) return;

  const pkgPaths = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('@')) {
        // npm scope dir — walk into it
        walk(full);
        continue;
      }
      if (entry.name === 'node_modules') {
        // Nested node_modules — walk into it
        walk(full);
        continue;
      }
      // Regular package dir
      const pkgFile = path.join(full, 'package.json');
      if (fs.existsSync(pkgFile)) {
        pkgPaths.push(pkgFile);
      }
      // Also descend into any nested node_modules this package may have
      const nestedNm = path.join(full, 'node_modules');
      if (fs.existsSync(nestedNm)) {
        walk(nestedNm);
      }
    }
  }
  walk(nmRoot);

  let patched = 0;
  let touched = 0;
  for (const pkgFile of pkgPaths) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch {
      continue;
    }
    let modified = false;
    for (const field of ['dependencies', 'optionalDependencies']) {
      const deps = pkg[field];
      if (!deps) continue;
      for (const depName of Object.keys(deps)) {
        if (overrideNames.has(depName) && deps[depName] !== '*') {
          deps[depName] = '*';
          modified = true;
          touched++;
        }
      }
    }
    if (modified) {
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
      patched++;
    }
  }
  if (patched > 0) {
    console.log(
      `[postinstall] Widened ${touched} declared dep range(s) across ${patched} package.json file(s) to '*' (override-pinned: ${[...overrideNames].join(', ')})`
    );
  }
}

function runPostInstall() {
  // Apply nested-dep range widenings before electron-builder install-app-deps.
  patchOverriddenDepRanges();
  try {
    // Check if we're in a CI environment
    const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
    const electronVersion = require('../package.json').devDependencies.electron.replace(/^[~^]/, '');

    console.log(`Environment: CI=${isCI}, Electron=${electronVersion}`);

    if (isCI) {
      // In CI, skip rebuilding to use prebuilt binaries for better compatibility
      // 在 CI 中跳过重建，使用预编译的二进制文件以获得更好的兼容性
      console.log('CI environment detected, skipping rebuild to use prebuilt binaries');
      console.log('Native modules will be handled by electron-forge during packaging');
    } else {
      // In local environment, use electron-builder to install dependencies
      console.log('Local environment, installing app deps');
      execSync('bunx electron-builder install-app-deps', {
        stdio: 'inherit',
        env: {
          ...process.env,
          // Prefer prebuilt native modules over source builds (M25/F16). Set true only when prebuilts are unavailable for a target Electron version.
          npm_config_build_from_source: 'false',
        },
      });
    }
  } catch (e) {
    console.error('Postinstall failed:', e.message);
    // Don't exit with error code to avoid breaking installation
  }
}

// Only run if this script is executed directly
if (require.main === module) {
  runPostInstall();
}

module.exports = runPostInstall;
