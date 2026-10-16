/**
 * rename() that rides out Windows' brief locks (an antivirus or indexer
 * holding a file we just wrote), which show up as EPERM, EBUSY or EACCES.
 * Any other error, or a lock that lasts past about 750 ms, is thrown.
 */

import { rename } from "node:fs/promises";

export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}
