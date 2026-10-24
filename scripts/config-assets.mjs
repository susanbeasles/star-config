import { readdirSync } from 'node:fs';
import path from 'node:path';

/** Enumerate only regular files and directories in the owned config tree. */
export function configAssets(root, directory = 'configs') {
  return readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return configAssets(root, rel);
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported config asset: ${rel}`);
      }
      return [rel];
    })
    .sort();
}
