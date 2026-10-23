// @ts-check
/**
 * Local SonarQube (Community Build) in Docker, for SonarLint connected mode and CLI scans.
 * Bound to 127.0.0.1; the DB password is generated per machine and kept outside the repo
 * (~/.config/star-config/sonar.env, mode 0600). The scan token is read from SONAR_TOKEN
 * in the environment and never written to disk or passed on the command line.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { assetPath } from './assets.js';
import { validateHostPath } from './hook-boundary.js';
import { bold, dim, exec, green, log, red } from './runner.js';

export const SCANNER = '/opt/star-config/sonar/bin/sonar-scanner';

const URL = 'http://127.0.0.1:9000';

function envFile() {
  const dir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'),
    'star-config',
  );
  const file = path.join(dir, 'sonar.env');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `STAR_SONAR_DB_PASSWORD=${randomBytes(24).toString('hex')}\n`, {
      mode: 0o600,
    });
  }
  return file;
}

/** @param {string[]} args */
function compose(args, cwd = process.cwd()) {
  return exec(
    'docker',
    ['compose', '-f', assetPath('configs/sonarqube-compose.yml'), '--env-file', envFile(), ...args],
    { cwd },
  );
}

/**
 * @param {string} sub  up | scan | down | status
 * @param {{ cwd: string, purge?: boolean }} opts
 */
export function sonar(sub, { cwd, purge = false }) {
  switch (sub) {
    case 'up': {
      const code = compose(['up', '-d', '--wait']);
      if (code === 0) {
        log(green(`✔ SonarQube is up at ${URL}`));
        log(`${bold('Next:')}
  1. Open ${URL} — first login admin/admin forces a password change.
  2. My Account → Security → generate a token, then: ${dim('export SONAR_TOKEN=<token>')}  (don't commit it)
  3. IDE: SonarQube for IDE → Connected Mode → SonarQube Server → ${URL}
  4. ${dim('star-config sonar scan')}`);
      }
      return code;
    }
    case 'scan': {
      if (!process.env.SONAR_TOKEN) {
        log(
          red(
            '✖ SONAR_TOKEN is not set. Generate one in SonarQube (My Account → Security) and export it.',
          ),
        );
        return 1;
      }
      if (process.env.SONAR_HOST_URL && process.env.SONAR_HOST_URL !== URL) {
        throw new Error('Sonar scans require the approved local endpoint http://127.0.0.1:9000');
      }
      // Resolve no package or repository-selected executable while a token is present.
      validateHostPath(SCANNER);
      // This is the installed unprivileged controller client, not the scanner itself.
      // The protected policy/image selects project settings, dependencies and network.
      return exec(SCANNER, [], {
        cwd,
        env: {
          SONAR_TOKEN: process.env.SONAR_TOKEN,
          PATH: '/usr/bin:/bin',
        },
      });
    }
    case 'down':
      return compose(['down', ...(purge ? ['--volumes'] : [])]);
    case 'status':
      return compose(['ps']);
    default:
      log('Usage: star-config sonar up | scan | status | down [--purge]');
      return 2;
  }
}
