const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runBounded } = require('./signingExec');

/**
 * afterAllArtifactBuild — notarize + staple the .dmg artifacts.
 *
 * `afterSign` notarizes and staples the .app. But the .app and the .dmg carry
 * SEPARATE notarization tickets, and an un-notarized dmg downloaded via a
 * browser (which sets the quarantine bit) is rejected by Gatekeeper as
 * "<app> is damaged and can't be opened" — even when the app inside is
 * perfectly notarized. That shipped once (rc.2.1). This hook closes the gap so
 * the disk image the user actually double-clicks is itself notarized.
 *
 * Mirrors afterSign's contract: failure is non-fatal and loud. The release
 * smoke gate (`scripts/release-smoke-macos.sh`) is the hard stop that refuses
 * to publish an unstapled dmg, so a transient notary stall degrades to "gate
 * blocks publish" rather than "broken dmg silently ships".
 *
 * @param {{ artifactPaths: string[], outDir: string }} buildResult
 */
exports.default = async function notarizeDmg(buildResult) {
  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) {
    return;
  }

  const appleId = process.env.appleId;
  const appleIdPassword = process.env.appleIdPassword;
  const teamId = process.env.teamId;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log('notarizeDmg: skipping — missing Apple ID credentials');
    return;
  }

  // The dmg must be code-signed with Developer ID BEFORE notarizing. A merely
  // notarized+stapled-but-unsigned dmg is still rejected by Gatekeeper as
  // "no usable signature" (proven on rc.2.1) — stapling a ticket is not enough,
  // spctl requires a primary signature too. CI passes the identity as CSC_NAME.
  const identity = process.env.CSC_NAME || process.env.identity;
  if (!identity) {
    console.log('notarizeDmg: skipping — no signing identity (CSC_NAME) available');
    return;
  }

  for (const dmg of dmgs) {
    const name = path.basename(dmg);
    try {
      console.log(`notarizeDmg: code-signing ${name} with Developer ID (no timestamp)…`);
      signDmgNoTimestamp(identity, dmg);

      // The notary submit + staple both contact Apple over the network and can
      // hit transient stalls — e.g. NSURLErrorDomain Code=-1001 "request timed
      // out" — that have nothing to do with the artifact or our credentials.
      // Without a retry a single Apple hiccup ships the dmg signed-but-unstapled
      // and the smoke gate blocks the entire release (v0.9.8 arm64 hit exactly
      // this). Retry the network-bound steps with backoff before degrading.
      await notarizeAndStapleWithRetry({ dmg, name, appleId, appleIdPassword, teamId });

      // Stapling rewrites the dmg bytes, so the updater metadata that referenced
      // the pre-staple dmg is now stale. Repair the sha512/size in latest-mac.yml.
      repairUpdaterMetadata(buildResult.outDir, dmg);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`::warning title=DMG notarization not completed::${name}: ${message}`);
      console.warn(
        `⚠️ ${name} ships signed-but-unstapled. The release smoke gate will block publishing it — re-run once Apple's notary recovers.`
      );
    }
  }
};

/** Sleep without blocking the event loop (the hook is async). */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Submit the dmg to the Apple notary service and staple the ticket, retrying
 * the network-bound pair on transient failure. Apple's notary endpoint
 * intermittently returns connection timeouts (-1001); a one-off blip should not
 * block a release. Throws only after every attempt fails, so the caller still
 * degrades to "signed-but-unstapled" and the smoke gate makes the final call.
 */
async function notarizeAndStapleWithRetry({ dmg, name, appleId, appleIdPassword, teamId }) {
  const maxAttempts = 3;
  const backoffMs = 60000;
  const submitCmd = [
    'xcrun notarytool submit',
    `"${dmg}"`,
    `--apple-id "${appleId}"`,
    `--team-id "${teamId}"`,
    '--password "$NOTARYTOOL_PWD"',
    '--wait',
    '--timeout 20m',
  ].join(' ');

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`notarizeDmg: submitting ${name} to Apple notary service (attempt ${attempt}/${maxAttempts})…`);
      execSync(submitCmd, {
        stdio: 'inherit',
        env: { ...process.env, NOTARYTOOL_PWD: appleIdPassword },
      });

      // Staple the ticket so Gatekeeper validates the dmg offline. `stapler`
      // contacts Apple's ticket servers with no client timeout, so bound it too.
      if (!runBounded('xcrun', ['stapler', 'staple', dmg], { timeoutMs: 300000, label: `notarizeDmg: stapling ${name}` })) {
        throw new Error(`stapler staple failed or timed out for ${name}`);
      }
      console.log(`notarizeDmg: stapled ${name}`);
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts) {
        console.warn(
          `notarizeDmg: ${name} attempt ${attempt}/${maxAttempts} failed (${message}); retrying in ${backoffMs / 1000}s…`
        );
        await delay(backoffMs);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Code-sign the dmg with Developer ID but WITHOUT a secure timestamp.
 *
 * The dmg does NOT need its own secure timestamp: it still carries a Developer
 * ID signature (satisfying Gatekeeper's "must be signed" requirement), and
 * notarization — whose stapled ticket IS Apple-timestamped — is what makes
 * Gatekeeper accept the quarantined dmg. Proven end-to-end locally with the real
 * Ferrox cert: `--timestamp=none` dmg -> notarytool **Accepted** -> stapled ->
 * `spctl` **accepted (source=Notarized Developer ID)** on a quarantined copy.
 * `--timestamp=none` also drops an unnecessary Apple TSA round-trip.
 *
 * NOTE on the original v0.9.7 "codesign hang": it was NOT the Apple TSA. The
 * build's temp keychain auto-locks at the 300s default, and the dmg is signed
 * minutes after the app — past the lock — so codesign hung waiting for an
 * unlock prompt that never comes in CI. The real fix is
 * `security set-keychain-settings -t <long>` in the workflow's keychain setup;
 * codesign needs the unlocked keychain regardless of the timestamp flag.
 *
 * Still spawned via `runBounded` (no shell, hard timeout) as cheap defense, and
 * `--verify --strict` confirms the signature before we trust it. A failure here
 * throws so the caller degrades to "signed-but-unstapled" and the smoke gate
 * blocks publishing.
 */
function signDmgNoTimestamp(identity, dmg) {
  const name = path.basename(dmg);
  if (
    !runBounded('codesign', ['--force', '--timestamp=none', '--sign', identity, dmg], {
      timeoutMs: 60000,
      label: `notarizeDmg: signing ${name}`,
    })
  ) {
    throw new Error(`codesign (no-timestamp) failed for ${name}`);
  }
  if (
    !runBounded('codesign', ['--verify', '--strict', dmg], {
      timeoutMs: 60000,
      label: `notarizeDmg: verifying ${name}`,
    })
  ) {
    throw new Error(`codesign --verify failed for ${name}`);
  }
}

/**
 * Update the dmg's sha512 + size in the update manifest after stapling changed
 * its bytes. electron-builder writes sha512 as base64 of the raw SHA-512 digest.
 *
 * The dmg's url lives in latest-mac.yml (x64) OR latest-arm64-mac.yml (arm64)
 * depending on the arch being built, so we patch whichever manifest in outDir
 * actually references this dmg. Hardcoding latest-mac.yml (the original bug) left
 * every arm64 release's dmg metadata stale, which is what made the in-app update
 * fail integrity verification with "checksum mismatch" (#109). Edits are surgical
 * (only the entry whose url matches this dmg) and self-verified: a patch that did
 * not stick is logged loudly. Never throws into the caller.
 */
function repairUpdaterMetadata(outDir, dmgPath) {
  try {
    const name = path.basename(dmgPath);
    const buf = fs.readFileSync(dmgPath);
    const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
    const size = buf.length;

    // Every mac update manifest in the build output (per-arch named).
    const manifests = fs
      .readdirSync(outDir)
      .filter((f) => /^latest.*mac.*\.yml$/.test(f))
      .map((f) => path.join(outDir, f));

    let patched = false;
    for (const yml of manifests) {
      const lines = fs.readFileSync(yml, 'utf8').split('\n');
      const urlIdx = lines.findIndex((l) => l.includes(`url: ${name}`));
      if (urlIdx === -1) {
        continue; // this manifest does not list the dmg
      }
      // sha512 + size are the two lines that follow this url within its block.
      for (let i = urlIdx + 1; i < Math.min(urlIdx + 4, lines.length); i++) {
        lines[i] = lines[i]
          .replace(/(\s*sha512:\s*).*/, `$1${sha512}`)
          .replace(/(\s*size:\s*).*/, `$1${size}`);
      }
      fs.writeFileSync(yml, lines.join('\n'));
      // Self-verify: re-read and confirm the live hash is now present, so a
      // botched patch is visible in the build log rather than shipping silently.
      if (!fs.readFileSync(yml, 'utf8').includes(sha512)) {
        console.warn(`::warning::notarizeDmg: metadata repair for ${name} in ${path.basename(yml)} did not stick`);
      } else {
        console.log(`notarizeDmg: repaired updater metadata for ${name} in ${path.basename(yml)}`);
      }
      patched = true;
    }
    if (!patched && manifests.length > 0) {
      // mac auto-update uses the .zip, so a dmg absent from the manifest can be
      // legitimate - but log it so a genuine miss (e.g. an arch mismatch) is seen.
      console.log(`notarizeDmg: ${name} not referenced by any mac update manifest (updates apply via the .zip)`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`notarizeDmg: could not repair updater metadata: ${message}`);
  }
}
