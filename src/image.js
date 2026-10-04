import { UsageError } from './errors.js';

// The page API's own ceiling on a render scale.
export const MAX_SCALE = 8;

const DOCUMENT_MARKERS = /\\documentclass|\\begin\{document\}/;
const MATH_DELIMITERS = /\$|\\\[|\\\(|\\begin\{(equation|align|gather|multline|eqnarray|displaymath|math)\*?\}/;

// A % starts a comment unless an odd number of backslashes escapes it, so a
// commented out \documentclass does not make a snippet a document.
function withoutComments(source) {
  return String(source).replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, '$1$2');
}

export function isDocumentSource(source) {
  return DOCUMENT_MARKERS.test(withoutComments(source));
}

// A snippet with no delimiter anywhere is a bare formula; one with any
// delimiter already says where its math is and passes through untouched.
export function asMathBody(source) {
  const body = source.trim();
  return MATH_DELIMITERS.test(body) ? body : `\\[\n${body}\n\\]`;
}

export function wrapSnippet(source) {
  return [
    '\\documentclass{article}',
    '\\usepackage{amsmath}',
    '\\usepackage{amssymb}',
    '\\pagestyle{empty}',
    '\\begin{document}',
    asMathBody(source),
    '\\end{document}',
    '',
  ].join('\n');
}

export function parseCrop(value) {
  if (value === undefined || value === 'auto') return 'auto';
  if (value === 'none') return 'none';
  const parts = String(value).split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new UsageError(`--crop wants auto, none, or four numbers x,y,width,height. Got "${value}".`);
  }
  const [x, y, width, height] = parts;
  if (x < 0 || y < 0) throw new UsageError(`--crop x and y are measured from the top left corner and cannot be negative. Got "${value}".`);
  if (width <= 0 || height <= 0) throw new UsageError(`--crop width and height must be above 0. Got "${value}".`);
  return { x, y, width, height };
}

async function compiledPage(session, { files, main, engine, bibliography, project, clean, page, scale, crop }) {
  const { pdf } = await session.compile({ files, main, engine, bibliography, project, clean });
  const rendered = await session.pdfToPng({ pdf, page, scale, crop });
  return { ...rendered, route: 'tex' };
}

/**
 * One routing rule for every caller: a full document goes through TeX Live, a
 * bare snippet through KaTeX unless the caller asks otherwise. A caller that
 * staged a project itself passes { files, main } instead of { source }, which
 * is a document by construction and skips the rule.
 */
export async function renderImage(session, options = {}) {
  const {
    source,
    name = 'main.tex',
    files,
    main,
    mode = 'auto',
    page = 1,
    scale = 2,
    crop = 'auto',
    engine,
    bibliography,
    project,
    clean,
  } = options;

  if (files) return compiledPage(session, { files, main, engine, bibliography, project, clean, page, scale, crop });

  const isDocument = isDocumentSource(source);

  if (mode === 'fast') {
    if (isDocument) {
      throw new UsageError(
        'The input is a full LaTeX document, which the KaTeX route cannot render. Drop --fast (or mode "fast") to compile it.',
      );
    }
    const rendered = await session.katexToPng({ source: asMathBody(source), scale });
    return { ...rendered, route: 'katex' };
  }

  if (mode !== 'tex' && !isDocument) {
    const rendered = await session.katexToPng({ source: asMathBody(source), scale });
    return { ...rendered, route: 'katex' };
  }

  const document = isDocument ? source : wrapSnippet(source);
  const documentName = isDocument ? name : 'main.tex';
  return compiledPage(session, {
    files: { [documentName]: document },
    main: documentName,
    engine,
    bibliography,
    project,
    clean,
    page,
    scale,
    crop,
  });
}
