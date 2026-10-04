import { existsSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';

import { EnvironmentError, firstLine } from './errors.js';

const CHANNELS = ['chrome', 'msedge', 'chromium'];

// The three shapes Playwright uses for a browser it cannot find. Deliberately
// narrow: "no such file" also comes back from a missing shared library, which is
// a real launch failure and must not be swallowed by the next candidate.
const MISSING_BROWSER = /Executable doesn't exist|is not found|npx playwright install/i;

const MISSING_LIBRARY = /shared object|shared librar|error while loading|\blib[\w.+-]*\.so\b/i;

// Chromium's own wording when another instance holds the profile.
const PROFILE_IN_USE = /SingletonLock|ProcessSingleton|profile appears to be in use|already in use/i;

// Playwright rewrites the startup log to its own "Chromium sandboxing failed!"
// heading whenever the browser log carries any of the other three shapes.
const SANDBOX_FAILED = /Chromium sandboxing failed|No usable sandbox|crbug\.com\/357670|crbug\.com\/638180/i;

const PROFILE_HINT =
  'Close it, or give this run a profile of its own with --profile <dir> (or the LATEXTO_PROFILE environment variable).';

// Emitted once, after an unsandboxed relaunch has actually succeeded.
export const SANDBOX_NOTICE = 'The browser sandbox is not available here, so the browser is running without it.';

const SANDBOX_HINT =
  '--sandbox requires one, and containers without usable user namespaces cannot provide it. ' +
  'Without that flag the browser starts unsandboxed when the environment cannot sandbox it.';

// Playwright 1.58+ installs Chrome for Testing layouts (chrome-linux64, chrome-mac-<arch>,
// chrome-win64), and later revisions chrome-linux-arm64; the older chrome-linux / chrome-mac /
// chrome-win layouts remain in caches written before then. Full builds first, headless shells after.
const CHROMIUM_EXECUTABLES = {
  darwin: [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-headless-shell-mac-arm64/chrome-headless-shell',
    'chrome-headless-shell-mac-x64/chrome-headless-shell',
    'chrome-mac/headless_shell',
  ],
  win32: [
    'chrome-win64/chrome.exe',
    'chrome-win/chrome.exe',
    'chrome-headless-shell-win64/chrome-headless-shell.exe',
    'chrome-win/headless_shell.exe',
  ],
  linux: [
    'chrome-linux64/chrome',
    'chrome-linux-arm64/chrome',
    'chrome-linux/chrome',
    'chrome-headless-shell-linux64/chrome-headless-shell',
    'chrome-headless-shell-linux-arm64/chrome-headless-shell',
    'chrome-linux/headless_shell',
  ],
};

const PUPPETEER_EXECUTABLES = {
  darwin: [
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-headless-shell',
  ],
  win32: ['chrome.exe', 'chrome-headless-shell.exe'],
  linux: ['chrome', 'chrome-headless-shell'],
};

export function defaultProfileDir() {
  if (process.env.LATEXTO_PROFILE) return process.env.LATEXTO_PROFILE;
  switch (process.platform) {
    case 'darwin':
      return path.join(homedir(), 'Library', 'Caches', 'latexto');
    case 'win32':
      return path.join(localAppData(), 'latexto');
    default:
      return path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'latexto');
  }
}

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
}

function platformKey() {
  if (process.platform === 'darwin' || process.platform === 'win32') return process.platform;
  return 'linux';
}

function playwrightCacheDir() {
  const fromEnv = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (fromEnv && fromEnv !== '0') return fromEnv;
  switch (process.platform) {
    case 'darwin':
      return path.join(homedir(), 'Library', 'Caches', 'ms-playwright');
    case 'win32':
      return path.join(localAppData(), 'ms-playwright');
    default:
      return path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'ms-playwright');
  }
}

function puppeteerCacheDir() {
  return process.env.PUPPETEER_CACHE_DIR || path.join(homedir(), '.cache', 'puppeteer');
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function firstExisting(root, relatives) {
  for (const relative of relatives) {
    const candidate = path.join(root, ...relative.split('/'));
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function compareVersions(a, b) {
  const left = a.split(/[.\-_]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(/[.\-_]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function playwrightChromium() {
  const cache = playwrightCacheDir();
  const builds = [];
  for (const entry of listDir(cache)) {
    if (!entry.isDirectory()) continue;
    const match = /^chromium(_headless_shell)?-(\d+)$/.exec(entry.name);
    if (!match) continue;
    builds.push({ dir: path.join(cache, entry.name), revision: Number(match[2]), full: !match[1] });
  }
  builds.sort((a, b) => Number(b.full) - Number(a.full) || b.revision - a.revision);
  for (const build of builds) {
    // Playwright writes this marker after extraction; without it the download was interrupted.
    if (!isFile(path.join(build.dir, 'INSTALLATION_COMPLETE'))) continue;
    const executable = firstExisting(build.dir, CHROMIUM_EXECUTABLES[platformKey()]);
    if (executable) return executable;
  }
  return null;
}

function puppeteerChromium() {
  const cache = puppeteerCacheDir();
  const versions = [];
  for (const flavour of ['chrome', 'chrome-headless-shell']) {
    for (const entry of listDir(path.join(cache, flavour))) {
      if (!entry.isDirectory()) continue;
      const version = entry.name.replace(/^[a-z0-9]+-/i, '');
      versions.push({ dir: path.join(cache, flavour, entry.name), version, full: flavour === 'chrome' });
    }
  }
  versions.sort((a, b) => compareVersions(b.version, a.version) || Number(b.full) - Number(a.full));
  for (const build of versions) {
    for (const inner of listDir(build.dir)) {
      if (!inner.isDirectory()) continue;
      const executable = firstExisting(path.join(build.dir, inner.name), PUPPETEER_EXECUTABLES[platformKey()]);
      if (executable) return executable;
    }
  }
  return null;
}

export function browserCandidates() {
  const candidates = [];
  const fromEnv = process.env.LATEXTO_BROWSER;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new EnvironmentError(`LATEXTO_BROWSER points at ${fromEnv}, which does not exist.`);
    }
    candidates.push({ label: `LATEXTO_BROWSER (${fromEnv})`, options: { executablePath: fromEnv } });
  }
  for (const channel of CHANNELS) {
    candidates.push({ label: `playwright channel ${channel}`, options: { channel } });
  }
  const playwrightBuild = playwrightChromium();
  if (playwrightBuild) {
    candidates.push({ label: `playwright cache (${playwrightBuild})`, options: { executablePath: playwrightBuild } });
  }
  const puppeteerBuild = puppeteerChromium();
  if (puppeteerBuild) {
    candidates.push({ label: `puppeteer cache (${puppeteerBuild})`, options: { executablePath: puppeteerBuild } });
  }
  return candidates;
}

function messageOf(error) {
  return error && error.message ? String(error.message) : '';
}

function libraryHint(message) {
  return MISSING_LIBRARY.test(message)
    ? '\nIt is missing a system library: install them with "npx playwright install-deps chromium".'
    : '';
}

export function noBrowserError(attempts, lastError) {
  const tried = attempts.length > 0 ? `\nTried: ${attempts.join(', ')}.` : '';
  const message = messageOf(lastError);
  const detail = message ? `\nLast error: ${firstLine(message)}` : '';
  return new EnvironmentError(
    'No Chromium based browser was found.' +
      tried +
      detail +
      '\nInstall one with "npx playwright install chromium", or point LATEXTO_BROWSER at a Chrome, Edge or Chromium executable.' +
      libraryHint(message),
  );
}

export function launchFailedError(label, error) {
  const message = messageOf(error);
  return new EnvironmentError(`The browser (${label}) did not start: ${firstLine(message)}${libraryHint(message)}`);
}

export function isMissingBrowser(error) {
  return MISSING_BROWSER.test(messageOf(error));
}

export function isProfileInUse(error) {
  return PROFILE_IN_USE.test(messageOf(error));
}

export function isSandboxFailure(error) {
  return SANDBOX_FAILED.test(messageOf(error));
}

// Only --sandbox reaches this; everything else falls back instead. No detail
// from the error: playwright's first line for this failure is its generic
// "browser has been closed", and the sandbox diagnosis it rewrites into the log
// body is what SANDBOX_FAILED already matched.
export function sandboxFailedError(label) {
  return new EnvironmentError(`The browser (${label}) could not start its sandbox.\n${SANDBOX_HINT}`);
}

export function profileInUseError(profileDir, pid) {
  const holder = pid ? ` (process ${pid})` : '';
  return new EnvironmentError(`Another browser is using the profile ${profileDir}${holder}. ${PROFILE_HINT}`);
}

/**
 * The pid of the live browser holding this profile, 0 when nothing does.
 * Chromium marks a profile in use with a SingletonLock symlink naming
 * <host>-<pid>; only a lock from this host whose process still answers counts,
 * because a stale lock is Chromium's own to clean up and refusing on one would
 * lock the user out of their profile for good.
 */
export function profileLockHolder(profileDir) {
  let target;
  try {
    target = readlinkSync(path.join(profileDir, 'SingletonLock'));
  } catch {
    return 0;
  }
  const match = /^(.*)-(\d+)$/.exec(target);
  if (!match || match[1] !== hostname()) return 0;
  const pid = Number(match[2]);
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return error && error.code === 'EPERM' ? pid : 0;
  }
}
