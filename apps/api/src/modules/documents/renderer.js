import PDFDocument from 'pdfkit';

/** Replaces {{path.to.value}} tokens and evaluates simple {{#if x}}...{{/if}} sections. */
export function renderTemplate(templateBody, variables) {
  const resolve = (path) =>
    path
      .split('.')
      .reduce((accumulator, key) => (accumulator == null ? undefined : accumulator[key]), variables);

  let output = String(templateBody ?? '');

  output = output.replace(/\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, path, body) => {
    const value = resolve(path);
    return value ? body : '';
  });

  const missing = [];
  output = output.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path) => {
    const value = resolve(path);
    if (value === undefined || value === null || value === '') {
      missing.push(path);
      return '—';
    }
    return String(value);
  });

  return { html: output, missing_variables: [...new Set(missing)] };
}

function htmlToBlocks(html) {
  const withBreaks = String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|h1|h2|h3|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ');

  return withBreaks
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Produces a PDF from the rendered template. The renderer lays out text blocks rather
 * than interpreting full CSS, which keeps generation dependency-light and predictable;
 * complex HTML layout is not preserved.
 */
export function renderPdf({ title, html, header = null, footer = null, branding = {} }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: title } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const primary = branding.primary_color ?? '#0F5132';

    if (header) {
      doc.fontSize(9).fillColor('#6b7280').text(htmlToBlocks(header).join(' '), { align: 'right' });
      doc.moveDown(0.5);
    }
    doc.fillColor(primary).fontSize(18).text(title, { align: 'left' });
    doc.moveDown(0.5);
    doc.strokeColor(primary).lineWidth(1).moveTo(56, doc.y).lineTo(539, doc.y).stroke();
    doc.moveDown(1);

    doc.fillColor('#111827').fontSize(11);
    for (const block of htmlToBlocks(html)) {
      doc.text(block, { align: 'left', lineGap: 3 });
      doc.moveDown(0.4);
    }

    if (footer) {
      doc.moveDown(2);
      doc.fontSize(8).fillColor('#6b7280').text(htmlToBlocks(footer).join(' '), { align: 'center' });
    }
    doc.end();
  });
}
