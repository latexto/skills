import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { EnvironmentError, UsageError } from './errors.js';

const { O_CREAT, O_NOFOLLOW = 0, O_TRUNC, O_WRONLY } = constants;

export function uniquePath(target) {
  if (!existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let n = 1; ; n += 1) {
    const candidate = path.join(dir, `${base}-${n}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

function isDirectory(target) {
  const info = statSync(target, { throwIfNoEntry: false });
  return Boolean(info && info.isDirectory());
}

/**
 * Resolves where a generated file goes and guarantees its directory exists.
 * A relative `requested` resolves against baseDir (default the working
 * directory) and an existing directory target means <dir>/<fallbackName>; with
 * no `requested` the file is fallbackName in baseDir. Without `overwrite` an
 * existing file is left alone and "-1", "-2" and so on are appended; with
 * `confine` a target that escapes baseDir is refused instead of written.
 */
export function resolveOutputPath(requested, fallbackName, options = {}) {
  const { baseDir = process.cwd(), overwrite = false, confine = false } = options;
  const root = path.resolve(baseDir);

  let target = path.resolve(root, requested || fallbackName);
  if (requested && isDirectory(target)) target = path.join(target, fallbackName);

  if (confine) {
    const inside = path.relative(root, target);
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
      throw new UsageError(`The output must stay inside ${root}, but ${target} is outside it.`);
    }
  }

  const dir = path.dirname(target);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new EnvironmentError(`Cannot create the output directory ${dir}: ${error.message}`);
  }
  return overwrite ? target : uniquePath(target);
}

function symlinkRefusal(target) {
  let destination = '';
  try {
    destination = ` pointing at ${readlinkSync(target)}`;
  } catch {
    // A link that cannot be read is refused just the same.
  }
  return new EnvironmentError(
    `Refusing to write ${target}: it is a symbolic link${destination}, so the bytes would land there instead. ` +
      'Delete it, or choose another path with -o.',
  );
}

/**
 * Refuses a target whose last component is a symbolic link. An untrusted project
 * can plant one where the output goes (the documented flow compiles inside the
 * project directory), and a plain write would follow it onto a file of the
 * user's. Called once when the path is chosen, so a run ends before the browser
 * starts, and again at the write below.
 */
export function refuseSymlinkTarget(target) {
  const link = lstatSync(target, { throwIfNoEntry: false });
  if (link && link.isSymbolicLink()) throw symlinkRefusal(target);
}

// O_NOFOLLOW closes the gap between that check and the open; Windows does not
// define it, so there the check is the only guard.
export function writeOutputFile(target, bytes) {
  refuseSymlinkTarget(target);

  let fd;
  try {
    fd = openSync(target, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o666);
    writeFileSync(fd, bytes);
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'EMLINK') throw symlinkRefusal(target);
    throw new EnvironmentError(`Cannot write ${target}: ${error.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
