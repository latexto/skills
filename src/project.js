import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { UsageError } from './errors.js';

const SKIPPED_DIRS = new Set(['node_modules']);
// The one dotfile that is staged: the engine reads it in the project root to
// pick the TeX engine, as latexmk would.
const LATEXMKRC = '.latexmkrc';
const MAIN_DEFAULT = 'main.tex';

// Per file, the same ceiling the site puts on a staged image; in total, what one
// project may hold in this process and in the browser page behind it. A refusal
// budget, never a truncation: what does not fit is reported, not shortened.
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

export function decodeUtf8Strict(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The id the page keeps a project's build files under between runs: one per
 * real location (symlinks resolved, the path staging itself reads) and main
 * file, so two projects never read each other's .aux, and a hash, so no local
 * path reaches the page. NUL cannot occur in a path, which keeps the two
 * fields apart.
 */
export function projectId(realPath, main) {
  return createHash('sha256').update(`${realPath}\0${main}`).digest('hex');
}

export function readTextFile(file) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new UsageError(`Cannot read ${file}: ${error.message}`);
  }
  const text = decodeUtf8Strict(bytes);
  if (text === null) throw new UsageError(`${file} is not valid UTF-8 text.`);
  return text;
}

function stageFile(file) {
  const bytes = readFileSync(file);
  const text = decodeUtf8Strict(bytes);
  return text === null ? { base64: bytes.toString('base64') } : text;
}

function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function insideRoot(realRoot, file) {
  let real;
  try {
    real = realpathSync(file);
  } catch {
    return false;
  }
  const relative = path.relative(realRoot, real);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function walk(root, realRoot, relative, entries, skipped) {
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name.startsWith('.') && !(relative === '' && entry.name === LATEXMKRC)) continue;
    const name = relative === '' ? entry.name : `${relative}/${entry.name}`;
    const full = path.join(root, name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(root, realRoot, name, entries, skipped);
      continue;
    }
    if (entry.isSymbolicLink()) {
      // A symlinked directory could loop; a symlinked file is staged only while
      // it still points inside the project.
      const resolved = statSync(full, { throwIfNoEntry: false });
      if (!resolved || !resolved.isFile()) continue;
      if (!insideRoot(realRoot, full)) {
        skipped.push({ name, reason: 'a symlink leaving the project' });
        continue;
      }
    }
    const info = statSync(full, { throwIfNoEntry: false });
    if (!info || !info.isFile()) continue;
    if (info.size > MAX_FILE_BYTES) {
      skipped.push({ name, reason: `${megabytes(info.size)}, over the ${megabytes(MAX_FILE_BYTES)} limit` });
      continue;
    }
    entries.push({ name, full, size: info.size });
  }
}

/**
 * Lists what a project directory offers without reading a byte of it, so an
 * over-budget file is reported from its directory entry and never loaded.
 */
export function listProject(target) {
  const root = path.resolve(target);
  const realRoot = realpathSync(root);
  const entries = [];
  const skipped = [];
  walk(root, realRoot, '', entries, skipped);
  return { root, realRoot, entries, names: entries.map((entry) => entry.name), skipped };
}

/**
 * Reads a listing into the { files } map the page API compiles, dropping the
 * `exclude` path (the file this run is about to write, when it sits inside the
 * project) and anything past the total budget.
 */
export function stageFiles(listing, { exclude } = {}) {
  const excluded = exclude ? path.resolve(exclude) : null;
  const files = Object.create(null);
  const skipped = listing.skipped.slice();
  let total = 0;

  for (const entry of listing.entries) {
    if (excluded && path.resolve(entry.full) === excluded) {
      skipped.push({ name: entry.name, reason: 'the output file' });
      continue;
    }
    if (total + entry.size > MAX_TOTAL_BYTES) {
      skipped.push({ name: entry.name, reason: `past the ${megabytes(MAX_TOTAL_BYTES)} total limit` });
      continue;
    }
    total += entry.size;
    files[entry.name] = stageFile(entry.full);
  }
  return { files, skipped };
}

export function skippedReport(skipped) {
  if (!skipped || skipped.length === 0) return '';
  const listed = skipped.map((entry) => `${entry.name} (${entry.reason})`).join(', ');
  return `skipped ${skipped.length} file${skipped.length === 1 ? '' : 's'}: ${listed}`;
}

/**
 * Turns a .tex file or a project directory into the { files, main, project,
 * skipped, output } the page API compiles. `output` is the file this run will
 * write: a path, or a function of the chosen main name for a caller whose
 * output name depends on it, and it is echoed back resolved. Nothing is read
 * before the main file is known, so the output never stages itself into its
 * own compile.
 */
export function stageProject(target, { main, output } = {}) {
  let info;
  try {
    info = statSync(target);
  } catch {
    throw new UsageError(`${target} does not exist.`);
  }
  const resolveOutput = (chosen) => (typeof output === 'function' ? output(chosen) : output) || null;

  if (info.isFile()) {
    const name = mainForFile(target, main);
    const files = Object.create(null);
    files[name] = stageFile(target);
    const project = projectId(realpathSync(target), name);
    return { files, main: name, project, skipped: [], output: resolveOutput(name) };
  }

  const listing = listProject(target);
  if (listing.names.length === 0) {
    throw new UsageError([`${target} holds no files to compile.`, skippedReport(listing.skipped)].filter(Boolean).join(' '));
  }
  const chosen = chooseMain(listing.names, main, { target });
  const resolved = resolveOutput(chosen);
  const staged = stageFiles(listing, { exclude: resolved });
  if (!(chosen in staged.files)) {
    const dropped = staged.skipped.find((entry) => entry.name === chosen);
    throw new UsageError(`The main file ${chosen} was not staged: ${dropped ? dropped.reason : 'it is unreadable'}.`);
  }
  return {
    files: staged.files,
    main: chosen,
    project: projectId(listing.realRoot, chosen),
    skipped: staged.skipped,
    output: resolved,
  };
}

export function mainForFile(target, requested) {
  const name = path.basename(target);
  if (requested && requested !== name) throw new UsageError(`--main ${requested} does not match the given file ${name}.`);
  return name;
}

export function chooseMain(files, requested, { target = 'the given files', flag = '--main' } = {}) {
  const names = Array.isArray(files) ? files : Object.keys(files);
  if (requested) {
    if (!names.includes(requested)) {
      throw new UsageError(`${flag} ${requested} is not in ${target}. Staged files: ${names.join(', ')}.`);
    }
    return requested;
  }
  if (names.includes(MAIN_DEFAULT)) return MAIN_DEFAULT;

  const roots = names.filter((name) => name.endsWith('.tex') && !name.includes('/'));
  const candidates = roots.length > 0 ? roots : names.filter((name) => name.endsWith('.tex'));
  if (candidates.length === 0) throw new UsageError(`${target} holds no .tex file.`);
  if (candidates.length === 1) return candidates[0];
  throw new UsageError(
    `${target} has no ${MAIN_DEFAULT} and several .tex files. Pick one with ${flag}: ${candidates.join(', ')}.`,
  );
}

export function validateChoice(plural, value, accepted, flag) {
  if (!value) return value;
  if (accepted.length === 0) return value;
  if (accepted.includes(value)) return value;
  throw new UsageError(`${flag} ${value} is not one of the ${plural} the site offers. Accepted: ${accepted.join(', ')}.`);
}
