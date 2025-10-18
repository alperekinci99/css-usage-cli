import fs from 'node:fs/promises';
import path from 'node:path';

/* -------------------- Argüman Parser -------------------- */
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { remove: false, out: 'pruned.css', verbose: false };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--remove' || a === '-r') opts.remove = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if ((a === '--out' || a === '-o') && args[i + 1]) opts.out = args[++i];
    else positional.push(a);
  }

  if (positional.length < 2) {
    console.log(`Usage:
  css-usage <htmlDir> <cssPath> [options]

Examples:
  css-usage ./playground ./playground/styles.css
  css-usage ./playground ./playground/styles.scss --remove --out pruned.css

Options:
  -r, --remove       Remove unused CSS rules
  -o, --out <file>   Output CSS (default: pruned.css)
  -v, --verbose      Verbose logs
`);
    process.exit(1);
  }

  opts.htmlDir = positional[0];
  opts.cssPath = positional[1];
  return opts;
}

/* -------------------- HTML class toplama -------------------- */
async function listFiles(dir, exts) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p, exts)));
    else if (exts.some(ex => p.endsWith(ex))) out.push(p);
  }
  return out;
}

async function collectUsedClasses(htmlDir, { verbose }) {
  const htmlFiles = await listFiles(htmlDir, ['.html', '.htm']);
  const used = new Set();

  for (const file of htmlFiles) {
    const content = await fs.readFile(file, 'utf8');
    const matches = content.match(/class(Name)?=["'`](.*?)["'`]/g) || [];
    matches.forEach(m => {
      const inner = m.replace(/^class(Name)?=["'`](.*?)["'`]$/, '$2');
      inner.split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    });
  }

  if (verbose) console.log(`[usage] scanned ${htmlFiles.length} HTML files, found ${used.size} unique classes`);
  return used;
}

/* -------------------- CSS / SCSS içeriği -------------------- */
async function readCssOrScss(cssPath, { verbose }) {
  if (cssPath.endsWith('.scss') || cssPath.endsWith('.sass')) {
    try {
      const sass = await import('sass');
      const res = await sass.compileAsync(cssPath, { style: 'expanded' });
      if (verbose) console.log(`[scss] compiled successfully (${res.css.length} chars)`);
      return res.css;
    } catch {
      console.error(`[error] 'sass' not installed. Run: npm i sass`);
      process.exit(1);
    }
  }
  return await fs.readFile(cssPath, 'utf8');
}

/* -------------------- CSS class yakalama -------------------- */
function collectCssClasses(cssText) {
  const cleaned = cssText.replace(/\/\*.*?\*\//gs, '');
  const matches = cleaned.match(/\.([_a-zA-Z][_a-zA-Z0-9-]*)/g) || [];
  return new Set(matches.map(m => m.slice(1)));
}

/* -------------------- CSS budama -------------------- */
function pruneCss(cssText, used) {
  return cssText.replace(/[^{}]+{[^{}]*}/g, block => {
    const classes = (block.match(/\.([_a-zA-Z][_a-zA-Z0-9-]*)/g) || []).map(x => x.slice(1));
    return classes.some(c => used.has(c)) ? block : '';
  });
}

/* -------------------- Ana akış -------------------- */
async function main() {
  const opts = parseArgs(process.argv);
  const used = await collectUsedClasses(opts.htmlDir, opts);
  const cssText = await readCssOrScss(opts.cssPath, opts);
  const cssClasses = collectCssClasses(cssText);

  const unused = [...cssClasses].filter(c => !used.has(c));
  const usedCount = cssClasses.size - unused.length;

  console.log(`\nCSS classes: ${cssClasses.size}`);
  console.log(`Used: ${usedCount}`);
  console.log(`Unused: ${unused.length}\n`);
  if (unused.length) console.log(unused.map(c => '- ' + c).join('\n'));

  if (opts.remove) {
    const pruned = pruneCss(cssText, used);
    await fs.writeFile(opts.out, pruned, 'utf8');
    console.log(`\nPruned CSS written to ${opts.out}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});