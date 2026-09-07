import { mkdirSync } from 'node:fs';

import { chromium } from 'playwright-core';

import {
  browserCandidates,
  defaultProfileDir,
  isMissingBrowser,
  isProfileInUse,
  isSandboxFailure,
  launchFailedError,
  noBrowserError,
  profileInUseError,
  profileLockHolder,
  SANDBOX_NOTICE,
  sandboxFailedError,
} from './browser.js';
import { CompileError, EnvironmentError, UsageError, firstLine } from './errors.js';

export const DEFAULT_URL = 'https://latex.to';
export const DEFAULT_TIMEOUT_SECONDS = 1200;
export const SUPPORTED_API_VERSION = 1;

const API_WAIT_MS = 120_000;

const CLOSED_MSG = 'The browser session is closed; open a new one.';

// The page API rejects a bad argument with its own sentence before anything is
// compiled or rendered. Those are the caller's mistake (exit 2), not a document
// that failed to build.
const ARGUMENT_REJECTIONS = [
  /^files must /,
  /^source must /,
  /^main /,
  /^page must /,
  /^scale must /,
  /^crop /,
  /^Unknown engine /,
  /^Unknown bibliography /,
  /is not a usable file name\.$/,
  /is not valid base64\.$/,
  /must be a Uint8Array, an ArrayBuffer or \{ base64 \}\.$/,
  /^This PDF has \d+ page\(s\), so page \d+ does not exist\.$/,
];

const OUTDATED_HINT =
  'The site may predate this API. Update the CLI ("npm install -g latexto@latest") and see https://latex.to/agents/.';

/**
 * Runs before every page script. It installs the bridge the evaluate() calls
 * below use: bytes cross as chunked base64 (a Uint8Array serialises poorly and
 * a PDF is megabytes), and a rejection is reported as a value so its .log
 * survives the trip, which a thrown Error does not.
 */
function installBridge() {
  window.__latextoToBase64 = (bytes) => {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < view.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, view.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  };
  window.__latextoFailure = (error) => ({
    ok: false,
    message: (error && error.message) || String(error),
    log: error && typeof error.log === 'string' ? error.log : '',
  });
  window.addEventListener('latexto:status', (event) => {
    const message = event && event.detail && event.detail.message;
    if (typeof message === 'string' && typeof window.__latextoStatus === 'function') {
      window.__latextoStatus(message);
    }
  });
}

async function launchContext({ profileDir, headed, requireSandbox, onNotice }) {
  mkdirSync(profileDir, { recursive: true });
  const holder = profileLockHolder(profileDir);
  if (holder) throw profileInUseError(profileDir, holder);

  const attempted = [];
  let lastError = null;
  for (const candidate of browserCandidates()) {
    const launch = (chromiumSandbox) =>
      chromium.launchPersistentContext(profileDir, {
        headless: !headed,
        chromiumSandbox,
        args: ['--disable-dev-shm-usage'],
        ...candidate.options,
      });
    try {
      return await launch(true);
    } catch (error) {
      if (isProfileInUse(error)) throw profileInUseError(profileDir, 0);
      if (isSandboxFailure(error)) {
        if (requireSandbox) throw sandboxFailedError(candidate.label);
        // A machine that cannot sandbox cannot sandbox any of the candidates,
        // so this one is retried rather than the next one tried.
        const context = await launch(false).catch((retryError) => {
          throw launchFailedError(candidate.label, retryError);
        });
        if (onNotice) onNotice(SANDBOX_NOTICE);
        return context;
      }
      lastError = error;
      if (!isMissingBrowser(error)) throw launchFailedError(candidate.label, error);
      attempted.push(candidate.label);
    }
  }
  throw noBrowserError(attempted, lastError);
}

export async function openSession(options = {}) {
  const {
    url = DEFAULT_URL,
    profileDir = defaultProfileDir(),
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    headed = false,
    requireSandbox = false,
    onStatus,
    onClose,
  } = options;

  const timeoutMs = Math.max(1, Math.round(timeoutSeconds * 1000));
  const openMs = Math.min(timeoutMs, API_WAIT_MS);
  const context = await launchContext({ profileDir, headed, requireSandbox, onNotice: onStatus });
  try {
    if (onStatus) {
      await context.exposeFunction('__latextoStatus', (message) => {
        onStatus(String(message));
      });
    }
    await context.addInitScript(installBridge);

    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(openMs);
    await open(page, url, openMs);
    const info = await readApi(page, url, openMs);
    return new LatextoSession({ context, page, info, timeoutMs, url, onClose });
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function open(page, url, timeout) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (error) {
    throw new EnvironmentError(
      `Could not open ${url}: ${firstLine(error.message)}.` +
        '\nThe site may be down, or this machine may be offline or behind a proxy that blocks it.',
    );
  }
}

async function readApi(page, url, waitMs) {
  try {
    await page.waitForFunction(() => typeof window.latexto === 'object' && window.latexto !== null, undefined, {
      timeout: waitMs,
    });
  } catch {
    throw new EnvironmentError(
      `No page API (window.latexto) appeared at ${url} within ${Math.round(waitMs / 1000)} seconds. ${OUTDATED_HINT}`,
    );
  }

  const info = await page.evaluate(() => ({
    apiVersion: window.latexto.apiVersion,
    engines: Array.isArray(window.latexto.engines) ? window.latexto.engines.slice() : [],
    bibliographies: Array.isArray(window.latexto.bibliographies) ? window.latexto.bibliographies.slice() : [],
    isolated: Boolean(window.crossOriginIsolated) && typeof SharedArrayBuffer === 'function',
    bridge: typeof window.__latextoToBase64 === 'function',
  }));

  if (info.apiVersion !== SUPPORTED_API_VERSION) {
    throw new EnvironmentError(
      `The page API at ${url} reports version ${info.apiVersion}, this CLI speaks version ${SUPPORTED_API_VERSION}. ${OUTDATED_HINT}`,
    );
  }
  if (!info.bridge) {
    throw new EnvironmentError(`The byte bridge did not install on ${url}, so results cannot be read back.`);
  }
  return info;
}

function rejection(result, hint = '') {
  if (ARGUMENT_REJECTIONS.some((shape) => shape.test(result.message))) return new UsageError(result.message);
  return new CompileError(result.message + hint, result.log);
}

export class LatextoSession {
  #context;
  #page;
  #timeoutMs;
  #markClosed;

  constructor({ context, page, info, timeoutMs, url, onClose }) {
    this.#context = context;
    this.#page = page;
    this.#timeoutMs = timeoutMs;
    this.url = url;
    this.closed = false;
    this.#markClosed = () => {
      if (this.closed) return;
      this.closed = true;
      if (onClose) onClose();
    };
    context.on('close', this.#markClosed);
    page.on('close', this.#markClosed);
    page.on('crash', this.#markClosed);
    this.apiVersion = info.apiVersion;
    this.engines = info.engines;
    this.bibliographies = info.bibliographies;
    this.crossOriginIsolated = info.isolated;
  }

  get isolationHint() {
    if (this.crossOriginIsolated) return '';
    return `\n${this.url} is not cross-origin isolated, so SharedArrayBuffer is unavailable and no PDF can be produced. The server must send the COOP and COEP headers.`;
  }

  async compile({ files, main, engine, bibliography }) {
    const request = { files, main };
    if (engine) request.engine = engine;
    if (bibliography) request.bibliography = bibliography;

    const result = await this.#evaluate(async (request) => {
      try {
        const output = await window.latexto.compile(request);
        return {
          ok: true,
          pdf: window.__latextoToBase64(output.pdf),
          log: typeof output.log === 'string' ? output.log : '',
        };
      } catch (error) {
        return window.__latextoFailure(error);
      }
    }, request);

    if (!result.ok) throw rejection(result, this.isolationHint);
    return { pdf: Buffer.from(result.pdf, 'base64'), log: result.log };
  }

  async pdfToPng({ pdf, page = 1, scale = 2, crop = 'auto' }) {
    const request = { pdf: { base64: Buffer.from(pdf).toString('base64') }, page, scale, crop };

    const result = await this.#evaluate(async (request) => {
      try {
        const output = await window.latexto.pdfToPng(request);
        return {
          ok: true,
          png: window.__latextoToBase64(output.png),
          width: output.width,
          height: output.height,
          pageCount: output.pageCount,
          effectiveScale: output.effectiveScale,
        };
      } catch (error) {
        return window.__latextoFailure(error);
      }
    }, request);

    if (!result.ok) throw rejection(result);
    return {
      png: Buffer.from(result.png, 'base64'),
      width: result.width,
      height: result.height,
      pageCount: result.pageCount,
      effectiveScale: result.effectiveScale,
    };
  }

  async katexToPng({ source, scale = 2 }) {
    const result = await this.#evaluate(async (request) => {
      try {
        const output = await window.latexto.katexToPng(request);
        return {
          ok: true,
          png: window.__latextoToBase64(output.png),
          width: output.width,
          height: output.height,
        };
      } catch (error) {
        return window.__latextoFailure(error);
      }
    }, { source, scale });

    if (!result.ok) throw rejection(result);
    return { png: Buffer.from(result.png, 'base64'), width: result.width, height: result.height };
  }

  async close() {
    await this.#context.close().catch(() => {});
    this.#markClosed();
  }

  async #evaluate(body, request) {
    if (this.closed) throw new EnvironmentError(CLOSED_MSG);
    let timer;
    const seconds = Math.round(this.#timeoutMs / 1000);
    const expiry = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new EnvironmentError(`Timed out after ${seconds} seconds waiting for ${this.url}.`)),
        this.#timeoutMs,
      );
    });
    try {
      return await Promise.race([this.#page.evaluate(body, request), expiry]);
    } catch (error) {
      if (error instanceof EnvironmentError || error instanceof CompileError) throw error;
      if (this.closed) throw new EnvironmentError(CLOSED_MSG);
      throw new EnvironmentError(`The browser page failed: ${firstLine(error.message)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
