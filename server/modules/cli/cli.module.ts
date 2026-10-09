import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CliApplication, CliPackageMetadata } from '@/shared/types.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

import { createCliService } from './cli.service.js';

/**
 * Creates the production CLI application for the executable entrypoint. This is
 * the CLI module's single composition root: it reads package metadata and wires
 * the concrete Node filesystem, environment, and module-start adapters before
 * passing them into the otherwise isolated CLI service.
 */
export function createCliApplication(): CliApplication {
  const applicationRoot = findApplicationRoot(getModuleDirectory(import.meta.url));
  const packageMetadataJson = JSON.parse(
    fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8'),
  ) as { version: string; homepage?: string; bugs?: { url?: string } };
  const packageMetadata: CliPackageMetadata = {
    version: packageMetadataJson.version,
    homepage: packageMetadataJson.homepage,
    bugsUrl: packageMetadataJson.bugs?.url,
  };
  const homeDirectory = os.homedir();

  return createCliService({
    applicationRoot,
    defaultDatabasePath: path.join(homeDirectory, '.agentharbor', 'auth.db'),
    homeDirectory,
    packageMetadata,
    environment: process.env,
    fileSystem: {
      pathExists: (filePath: string) => fs.existsSync(filePath),
      getFileStats: (filePath: string) => {
        const stats = fs.statSync(filePath);
        return { size: stats.size, modifiedAt: stats.mtime };
      },
    },
    output: {
      log: (message?: string) => console.log(message),
      error: (message?: string) => console.error(message),
    },
    startServer: async () => {
      // The server executable is an entrypoint rather than a feature module,
      // so it has no barrel contract to import through.
      // eslint-disable-next-line boundaries/no-unknown
      await import('../../index.js');
    },
  });
}
