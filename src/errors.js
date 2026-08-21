export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_ENVIRONMENT = 3;

class LatextoError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

export class UsageError extends LatextoError {
  constructor(message) {
    super(message, EXIT_USAGE);
  }
}

export class EnvironmentError extends LatextoError {
  constructor(message) {
    super(message, EXIT_ENVIRONMENT);
  }
}

export class CompileError extends LatextoError {
  constructor(message, log = '') {
    super(message, EXIT_FAILURE);
    this.log = log;
  }
}

export function logTail(log, lines = 60) {
  if (typeof log !== 'string' || log.trim() === '') return '';
  const all = log.replace(/\s+$/, '').split('\n');
  return all.slice(-lines).join('\n');
}

// Playwright errors carry the API name and a multi line call log; what the user
// needs is the one sentence that says what went wrong.
export function firstLine(message) {
  const text = String(message == null ? '' : message).split('\n')[0].trim();
  return text.replace(/^[A-Za-z]+\.[A-Za-z]+:\s*/, '');
}
