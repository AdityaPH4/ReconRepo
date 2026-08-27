/**
 * Local-disk object store.
 *
 * Stands in for S3 during development so the app runs with no cloud
 * credentials. Same interface, same key layout — swapping to `s3ObjectStore`
 * changes only which implementation `index.ts` constructs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStore, PutObjectInput } from './types.js';

export function createLocalObjectStore(root: string): ObjectStore {
  /** Blocks keys that would escape the storage root. */
  function resolveKey(key: string): string {
    const full = path.resolve(root, key);
    const rootResolved = path.resolve(root);
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
      throw new Error(`Refusing to access object outside storage root: ${key}`);
    }
    return full;
  }

  return {
    driver: 'local',

    async put({ key, body }: PutObjectInput) {
      const full = resolveKey(key);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, body);
      return { key };
    },

    async get(key: string) {
      return fs.readFile(resolveKey(key));
    },

    async exists(key: string) {
      try {
        await fs.access(resolveKey(key));
        return true;
      } catch {
        return false;
      }
    },
  };
}
