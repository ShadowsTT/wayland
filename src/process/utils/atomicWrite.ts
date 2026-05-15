/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Atomic file-write helpers for state files.
 *
 * Plain writeFile/writeFileSync truncates the destination then streams bytes.
 * If the process crashes mid-write the file is left empty or partial and the
 * next launch fails JSON.parse — losing analytics IDs, CDP registry state,
 * Wayland config, or user workspace paths.
 *
 * The helpers below write to a sibling `.tmp-<pid>-<ts>` file first, then
 * rename into place. POSIX rename is atomic on the same filesystem, so a crash
 * leaves either the old file intact or the new file fully written — never a
 * truncated half.
 *
 * Scope: state files only. User-content writes (where partial output is
 * recoverable by the user) intentionally do not use these helpers.
 */

import { promises as fs } from 'fs';
import * as fsSync from 'fs';

export async function writeFileAtomic(
  targetPath: string,
  data: string | Buffer,
  opts?: fsSync.WriteFileOptions
): Promise<void> {
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, data, opts);
  await fs.rename(tmp, targetPath);
}

export function writeFileSyncAtomic(
  targetPath: string,
  data: string | Buffer,
  opts?: fsSync.WriteFileOptions
): void {
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fsSync.writeFileSync(tmp, data, opts);
  fsSync.renameSync(tmp, targetPath);
}
