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
  css-usage <htmlDir> <cssPath|cssDir|glob> [options]

Examples:
  # Tek CSS dosyası
  css-usage ./src ./src/styles/main.css

  # SCSS tek dosya (projede 'sass' yüklüyse)
  css-usage ./src ./src/styles/main.scss

  # styles klasöründeki TÜM .css dosyaları
  css-usage ./src "./src/styles/**/*.css"

  # styles klasöründeki TÜM .scss dosyaları (sass gerekli)
  css-usage ./src "./src/styles/**/*.scss"

  # Budama (çıktıyı dosyaya yaz)
  css-usage ./src "./src/styles/**/*.{css,scss}" --remove --out ./src/styles/pruned.css

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

/* -------------------- Yardımcılar: dosya listeleme / glob -------------------- */
async function listFilesRecursive(root, exts) {
  const out = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) out.push(...(await listFilesRecursive(p, exts)));
    else if (exts.some(ex => p.toLowerCase().endsWith(ex))) out.push(p);
  }
  return out;
}
function isGlob(p) {
  return /[*?[\]{}]/.test(p);
}
function globToRegex(globPattern) {
  // çok basit glob -> regex: ** -> .*, * -> [^/]* ; özel regex karakterlerini kaçır
  const esc = globPattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*\\\*/g, '::DOUBLESTAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLESTAR::/g, '.*');
  return new RegExp('^' + esc + '$', 'i');
}
function firstStaticBase(globPattern) {
  const parts = path.normalize(globPattern).split(path.sep);
  const until = [];
  for (const seg of parts) {
    if (/[*?[\]{}]/.test(seg)) break;
    until.push(seg);
  }
  if (!until.length) return process.cwd();
  const base = until.join(path.sep);
  return path.isAbsolute(base) ? base : path.resolve(process.cwd(), base);
}
async function expandCssInputs(input) {
  // tek dosya?
  const st = await fs.stat(input).catch(() => null);
  if (st?.isFile()) return [path.resolve(input)];
  // klasör?
  if (st?.isDirectory()) {
    const files = await listFilesRecursive(input, ['.css', '.scss', '.sass']);
    return files.map(f => path.resolve(f));
  }
  // glob?
  if (isGlob(input)) {
    const base = firstStaticBase(input);
    const all = await listFilesRecursive(base, ['.css', '.scss', '.sass']);
    const absPattern = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
    const re = globToRegex(absPattern);
    return all
      .map(f => path.resolve(f))
      .filter(f => re.test(f));
  }
  // aksi halde tek dosya gibi dene (fs hata verecektir)
  return [path.resolve(input)];
}

/* -------------------- HTML/JSX içinden class toplama -------------------- */
/* Statik kullanım:
   - class="..."
   - className="..."
   Dinamik ifadeler (clsx, template literal, değişken) kapsam dışı (lite).
*/
async function listFiles(dir, exts) {
  return listFilesRecursive(dir, exts);
}
async function collectUsedClasses(htmlDir, { verbose }) {
  const files = await listFiles(htmlDir, ['.html', '.htm', '.jsx', '.tsx']);
  const used = new Set();

  for (const file of files) {
    const content = await fs.readFile(file, 'utf8');

    // class="..." ve className="..." (tek/double/backtick) — statik
    const matches = content.match(/class(Name)?\s*=\s*["'`](.*?)["'`]/g) || [];
    for (const m of matches) {
      const inner = m.replace(/^class(Name)?\s*=\s*["'`](.*?)["'`]$/, '$2');
      inner.split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    }

    // Çok basit template literal yakalama (className={`foo bar`}) — yine statik string içerirse
    const tmpl = content.match(/className\s*=\s*\{\s*`([^`]+)`\s*\}/g) || [];
    for (const t of tmpl) {
      const inner = t.replace(/^className\s*=\s*\{\s*`([^`]+)`\s*\}$/, '$1');
      inner.split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    }
  }

  if (verbose) console.log(`[usage] scanned ${files.length} files, found ${used.size} unique classes`);
  return used;
}

/* -------------------- SCSS derleme (opsiyonel) + çoklu dosya okuma -------------------- */
async function safeLoadSass() {
  // Önce ESM import, olmazsa createRequire fallback (npx / farklı node_modules senaryoları)
  try {
    return await import('sass');
  } catch {
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      return require('sass');
    } catch {
      return null;
    }
  }
}
async function readManyCssOrScss(paths, { verbose }) {
  let sass = null;
  let buffer = '';

  for (const p of paths) {
    const lower = p.toLowerCase();
    if (lower.endsWith('.scss') || lower.endsWith('.sass')) {
      if (!sass) sass = await safeLoadSass();
      if (!sass) {
        console.error(`[error] 'sass' not found. Install it in your project to compile SCSS: npm i -D sass`);
        process.exit(1);
      }
      const res = await sass.compileAsync(p, {
        style: 'expanded',
        loadPaths: ['node_modules'] // scoped importları çözmek için
      });
      if (verbose) console.log(`[scss] compiled: ${path.relative(process.cwd(), p)}`);
      buffer += '\n' + res.css;
    } else {
      const txt = await fs.readFile(p, 'utf8');
      buffer += '\n' + txt;
      if (verbose) console.log(`[css] loaded: ${path.relative(process.cwd(), p)}`);
    }
  }
  return buffer;
}

/* -------------------- CSS class yakalama (regex, naive) -------------------- */
function collectCssClasses(cssText) {
  const cleaned = cssText.replace(/\/\*.*?\*\//gs, '');
  const matches = cleaned.match(/\.([_a-zA-Z][_a-zA-Z0-9-]*)/g) || [];
  return new Set(matches.map(m => m.slice(1)));
}

/* -------------------- CSS budama (rule bazında) -------------------- */
function pruneCss(cssText, used) {
  // Naive: içinde hiç "kullanılan" class geçmeyen rule'u komple sil
  return cssText.replace(/[^{}]+{[^{}]*}/g, block => {
    const classes = (block.match(/\.([_a-zA-Z][_a-zA-Z0-9-]*)/g) || []).map(x => x.slice(1));
    return classes.some(c => used.has(c)) ? block : '';
  });
}

/* -------------------- Ana akış -------------------- */
async function main() {
  const opts = parseArgs(process.argv);

  const used = await collectUsedClasses(opts.htmlDir, opts);

  const cssInputs = await expandCssInputs(opts.cssPath);
  if (!cssInputs.length) {
    console.error(`[error] No CSS/SCSS files matched for: ${opts.cssPath}`);
    process.exit(1);
  }
  if (opts.verbose) console.log(`[css] matched ${cssInputs.length} file(s)`);

  const cssText = await readManyCssOrScss(cssInputs, opts);
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
  console.error(e?.stack || e);
  process.exit(1);
});