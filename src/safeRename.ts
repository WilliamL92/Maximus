import * as fs from 'fs';

/**
 * Atomically rename `tmp` to `dest`, retrying on transient Windows errors.
 *
 * On Windows, `rename` can intermittently fail with EPERM/EBUSY/EACCES when
 * the destination is briefly held open by another process — typically an
 * antivirus scanner, the Windows Search indexer, OneDrive/Dropbox sync, or
 * a file watcher. These locks are released within a few hundred ms.
 */
export async function safeRename(tmp: string, dest: string): Promise<void> {
  const delays = [50, 100, 200, 400, 800, 1500];
  let lastErr: NodeJS.ErrnoException | undefined;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await fs.promises.rename(tmp, dest);
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const transient = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES';
      if (!transient || attempt === delays.length) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastErr;
}
