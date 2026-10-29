'use strict';

/**
 * Writes RequireJS chunks into the deployed static dir and installs a small
 * loader at the top of requirejs-config.js.
 *
 * Why not require.config({bundles}): mage/requirejs/mixins finds mixins by
 * comparing require.toUrl(target) with the mixins config, and with `bundles`
 * toUrl() returns the bundle URL, so every mixin of a bundled module would be
 * silently dropped. Instead require.load is wrapped (as Magento's own jsbuild
 * does): a request for a bundled module loads its chunk once, the chunk's named
 * defines register through the normal define queue (so the mixins defQueue hook
 * still sees them) and toUrl() is untouched.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const acorn = require('acorn');
const walk = require('acorn-walk');
const {analyze, proposeChunks, proposeLazyChunks} = require('./analyze');

const OUT_DIR = 'rjs-optimize';
const MARK_START = '/* rjs-optimize:start */';
const MARK_END = '/* rjs-optimize:end */';

/**
 * Turns one module file into a named-define snippet, or returns {skip: reason}.
 * Only AMD files with exactly one anonymous define (or one define already named
 * with this id) are bundled; anything else keeps loading as a single file.
 */
function toNamedDefine(id, src) {
    let ast;
    try {
        ast = acorn.parse(src, {ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowHashBang: true});
    } catch (e) {
        return {skip: 'parse error'};
    }
    const defines = [];
    walk.simple(ast, {
        CallExpression(node) {
            if (node.callee.type === 'Identifier' && node.callee.name === 'define') {
                defines.push(node);
            }
        }
    });
    if (defines.length !== 1) {
        return {skip: defines.length ? defines.length + ' define() calls' : 'not AMD'};
    }
    const call = defines[0];
    const first = call.arguments[0];
    if (!first) {
        return {skip: 'empty define()'};
    }
    if (first.type === 'Literal' && typeof first.value === 'string') {
        return first.value === id ? {code: src} : {skip: 'defines "' + first.value + '"'};
    }
    let insert = JSON.stringify(id) + ',';
    // define(function (require) { require('x') }): RequireJS finds deps by scanning
    // factory.toString() for `require(`, which breaks once the parameter is mangled,
    // so write them out the way RequireJS would have discovered them
    const isFn = first.type === 'FunctionExpression' || first.type === 'ArrowFunctionExpression';
    if (call.arguments.length === 1 && isFn && first.params.length) {
        const deps = first.params.length === 1 ? ['require'] : ['require', 'exports', 'module'];
        walk.simple(first.body, {
            CallExpression(node) {
                const arg = node.arguments[0];
                if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1
                    && arg.type === 'Literal' && typeof arg.value === 'string') {
                    deps.push(arg.value);
                }
            }
        });
        insert += JSON.stringify(deps) + ',';
    }
    return {code: src.slice(0, first.start) + insert + src.slice(first.start)};
}

function textDefine(id, content) {
    return 'define(' + JSON.stringify(id) + ',function(){return ' + JSON.stringify(content) + ';});';
}

/** Short readable name of a module id: Magento_Catalog/js/price-box -> price-box. */
function baseName(id) {
    const parts = id.replace(/^text!/, '').replace(/\.html$/, '').split('/');
    const last = parts.pop();
    return ['default', 'index', 'main'].includes(last) && parts.length ? parts.pop() + '-' + last : last;
}

/** Main module of a group: the largest one no other module of the group depends on. */
function entryModule(modules, graph) {
    const inGroup = new Set(modules);
    const imported = new Set();
    for (const id of modules) {
        for (const e of graph.nodes.get(id).edges) {
            if (inGroup.has(e.to) && e.to !== id) {
                imported.add(e.to);
            }
        }
    }
    const tops = modules.filter((id) => !imported.has(id) && !id.startsWith('text!'));
    const size = (id) => graph.nodes.get(id).size;
    return (tops.length ? tops : modules).reduce((a, b) => (size(b) > size(a) ? b : a));
}

function uniqueNamer() {
    const taken = new Set();
    return {
        taken,
        claim(name) {
            let unique = name;
            for (let i = 2; taken.has(unique); i++) {
                unique = name + '-' + i;
            }
            taken.add(unique);
            return unique;
        }
    };
}

/**
 * Readable chunk names: `common` for all pages, the page name for single-page chunks,
 * the shared page-name prefix when there is one (product + product-configurable ->
 * `product`), the two page names joined for a pair (cart_checkout), otherwise the
 * chunk's main module (price-box, catalog-add-to-cart, swatch-renderer).
 */
function nameChunks(chunks, graph) {
    const names = new Map();
    const namer = uniqueNamer();
    // page names first so they are never taken by a shared chunk
    for (const c of chunks) {
        if (c.sig === '*') {
            names.set(c.sig, namer.claim('common'));
        } else if (c.pages.length === 1) {
            names.set(c.sig, namer.claim(c.pages[0]));
        }
    }
    for (const c of chunks) {
        if (names.has(c.sig)) {
            continue;
        }
        const split = c.pages.map((p) => p.split('-'));
        const prefix = [];
        for (let i = 0; split.every((parts) => i < parts.length && parts[i] === split[0][i]); i++) {
            prefix.push(split[0][i]);
        }
        let name;
        if (prefix.length && !namer.taken.has(prefix.join('-'))) {
            name = prefix.join('-');
        } else if (c.pages.length === 2) {
            name = c.pages.join('_');
        } else {
            name = baseName(entryModule(c.modules, graph));
        }
        names.set(c.sig, namer.claim(name));
    }
    return names;
}

/**
 * lazy-<root> for a chunk owned by one lazy root (lazy-checkmo-method); a chunk shared by
 * several roots is named after its main module plus -shared (lazy-payment-default-shared).
 */
function nameLazyChunks(chunks, graph, namer) {
    const names = new Map();
    for (const c of chunks) {
        const name = c.roots.length === 1
            ? 'lazy-' + baseName(c.roots[0])
            : 'lazy-' + baseName(entryModule(c.modules, graph)) + '-shared';
        names.set(c.sig, namer.claim(name));
    }
    return names;
}

/** Merges chunks smaller than minSize that span several pages into `common`. */
function mergeSmallChunks(chunks, minSize) {
    const common = chunks.find((c) => c.sig === '*');
    if (!common) {
        return chunks;
    }
    const out = [];
    for (const c of chunks) {
        if (c !== common && c.pages.length > 1 && c.size < minSize) {
            common.modules.push(...c.modules);
            common.size += c.size;
        } else {
            out.push(c);
        }
    }
    return out;
}

function loaderSource(chunkFiles, moduleMap) {
    return `(function (require) {
    'use strict';
    var chunks = ${JSON.stringify(chunkFiles)},
        map = ${JSON.stringify(moduleMap)},
        state = {},
        load = require.load;

    function loadChunk(context, i, waiting) {
        var s = state[i];

        if (!s) {
            s = state[i] = {waiting: [], node: null};
            // nameToUrl like any module: Magento's min resolver turns it into *.min.js when
            // JS minification is on, and urlArgs/baseUrl apply as usual
            s.node = load(context, '_rjso_' + i, context.nameToUrl(chunks[i]));
            if (s.node && s.node.addEventListener) {
                s.node.addEventListener('error', function () {
                    // chunk missing: fall back to single files for everything that waited on it
                    s.failed = true;
                    s.waiting.forEach(function (args) {
                        load.apply(require, args);
                    });
                });
            }
        }
        if (waiting) {
            s.failed ? load.apply(require, waiting) : s.waiting.push(waiting);
        }
    }

    require.load = function (context, moduleName, url) {
        var i = map[moduleName];

        if (i === undefined || context.contextName !== '_') {
            return load.apply(this, arguments);
        }
        loadChunk(context, i, [context, moduleName, url]);
    };

    /** Starts downloading the chunks a page will need, before RequireJS discovers them. */
    require.rjsOptimizePreload = function (names) {
        var context = require.s.contexts._;

        names.forEach(function (name) {
            var i = chunks.indexOf(name);

            if (i !== -1) {
                loadChunk(context, i);
            }
        });
    };
})(require);
`;
}

/** Loader between the markers that stripLoader() looks for. */
function wrapLoader(code) {
    return MARK_START + '\n' + code.trim() + '\n' + MARK_END + '\n';
}

/**
 * Keeps Magento_Csp subresource integrity in sync: checkout pages put integrity
 * attributes on every script (window.sriHashes), so the edited requirejs-config.js
 * must get a new hash and chunks get their own.
 */
function updateSri(project, changed, removedPrefix) {
    const file = path.join(project.staticDir, 'sri-hashes.json');
    if (!fs.existsSync(file)) {
        return false;
    }
    const prefix = path.relative(path.join(project.root, 'pub/static'), project.staticDir).split(path.sep).join('/') + '/';
    const hashes = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of Object.keys(hashes)) {
        if (key.startsWith(prefix + removedPrefix)) {
            delete hashes[key];
        }
    }
    for (const rel of changed) {
        const abs = path.join(project.staticDir, rel);
        if (fs.existsSync(abs)) {
            hashes[prefix + rel] = 'sha256-' + crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('base64');
        }
    }
    fs.writeFileSync(file, JSON.stringify(hashes));
    return true;
}

function stripLoader(src) {
    const a = src.indexOf(MARK_START);
    const b = src.indexOf(MARK_END);
    return a !== -1 && b !== -1 ? src.slice(0, a) + src.slice(b + MARK_END.length + 1) : src;
}

async function minify(code, name, warnings) {
    let terser;
    try {
        terser = require('terser');
    } catch (e) {
        warnings.push('terser not installed, chunks are not minified');
        return code;
    }
    try {
        const r = await terser.minify(code, {compress: {passes: 1}, mangle: {reserved: ['require', 'exports', 'module', 'define']}, format: {comments: false}});
        return r.code;
    } catch (e) {
        warnings.push(`minify failed for ${name}: ${e.message}, written unminified`);
        return code;
    }
}

/**
 * With dev/js/merge_files on, pages load pub/static/_cache/merged/<hash>.js built from
 * require.js + mixins.js + requirejs-config.js. Merged files made before the loader was
 * installed would not contain it, so they are removed; Magento rebuilds them (and their
 * SRI hashes) on the next request.
 */
function clearMergedJs(root) {
    const dir = path.join(root, 'pub/static/_cache/merged');
    let removed = 0;
    if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.js')) {
                fs.rmSync(path.join(dir, f), {force: true});
                removed++;
            }
        }
    }
    return removed;
}

async function build(opts) {
    const r = await analyze(opts);
    // Magento's own JS bundling replaces RequireJS loading and cannot be combined with rjs-optimize
    if (r.jsFlags['dev/js/enable_js_bundling']) {
        throw new Error('Magento JS bundling is enabled (dev/js/enable_js_bundling). Disable it before using static:optimize:run.');
    }
    const {graph, project} = r;
    const staticDir = project.staticDir;
    const outDir = path.join(staticDir, OUT_DIR);
    const warnings = [...r.warnings];
    const skipped = [];
    // "exclude" patterns from static-optimize.json, "*" matches any characters
    const patterns = (opts.context.exclude || []).map((p) => new RegExp('^' + p.split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
    const excluded = (id) => patterns.some((re) => re.test(id.replace(/^text!/, '')));

    const lazyChunks = proposeLazyChunks(r);
    const chunks = mergeSmallChunks(proposeChunks(r), opts.minChunk).concat(lazyChunks);
    const names = nameChunks(chunks.filter((c) => !c.lazy), graph);
    nameLazyChunks(lazyChunks, graph, uniqueNamer()).forEach((name, sig) => names.set(sig, name));
    // text! resources go with the chunk of the first module that uses them; they
    // must not be the reason a chunk is requested (the text plugin loads them itself)
    const results = [];
    // Rebuilds never empty the directory first: pages being served keep finding the chunks of
    // the current loader, and browsers holding an older requirejs-config.js (same URL until the
    // next static deploy) still find the previous generation, which is pruned one build later.
    fs.mkdirSync(outDir, {recursive: true});
    const previous = readManifest(outDir);
    const previousFiles = previous ? previous.chunks.map((c) => c.file) : [];

    const moduleMap = {};
    const chunkFiles = [];
    for (const c of chunks) {
        const parts = [];
        const included = [];
        let rawSize = 0;
        for (const id of c.modules) {
            if (excluded(id)) {
                skipped.push({id, reason: 'excluded in static-optimize.json'});
                continue;
            }
            const n = graph.nodes.get(id);
            const src = fs.readFileSync(n.file, 'utf8');
            if (n.plugin === 'text') {
                parts.push(textDefine(id, src));
                included.push(id);
                rawSize += n.size;
                continue;
            }
            if (n.plugin) {
                skipped.push({id, reason: 'plugin ' + n.plugin});
                continue;
            }
            const res = toNamedDefine(id, src);
            if (res.skip) {
                skipped.push({id, reason: res.skip});
                continue;
            }
            // a statement boundary between files that may lack a trailing semicolon/newline
            parts.push(res.code + '\n;');
            included.push(id);
            rawSize += n.size;
        }
        if (!included.length) {
            continue;
        }
        const name = names.get(c.sig);
        let code = parts.join('\n');
        if (opts.minify) {
            code = await minify(code, name, warnings);
        }
        const hash = crypto.createHash('md5').update(code).digest('hex').slice(0, 8);
        const rel = `${OUT_DIR}/${name}.${hash}`;
        // named like the site's other static JS: *.min.js when dev/js/minify_files is on
        const file = rel + (opts.minify ? '.min.js' : '.js');
        fs.writeFileSync(path.join(staticDir, file), code);
        const chunkIndex = chunkFiles.length;
        chunkFiles.push(rel);
        for (const id of included) {
            if (!id.startsWith('text!')) {
                moduleMap[id] = chunkIndex;
            }
        }
        results.push({name, file, pages: c.pages || [], lazy: !!c.lazy, roots: c.roots,
            modules: included.length, ids: included, rawSize, size: Buffer.byteLength(code)});
    }

    // page -> chunk files, for per-page preloading
    const pages = {};
    for (const [page, p] of Object.entries(r.pages)) {
        pages[page] = {
            handles: p.handles.filter((h) => h !== 'default'),
            chunks: results.filter((c) => c.pages.includes(page)).map((c) => chunkFiles[results.indexOf(c)])
        };
    }
    const manifest = {
        generated: new Date().toISOString(),
        theme: project.theme,
        locale: project.locale,
        chunks: results,
        pages,
        skipped
    };
    manifest.previous = previousFiles;
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const loader = loaderSource(chunkFiles, moduleMap);
    const configFiles = ['requirejs-config.js', 'requirejs-config.min.js'];
    for (const f of configFiles) {
        const file = path.join(staticDir, f);
        if (fs.existsSync(file)) {
            // minified like the rest of requirejs-config.min.js
            const code = f.endsWith('.min.js') ? await minify(loader, f, warnings) : loader;
            fs.writeFileSync(file, wrapLoader(code) + stripLoader(fs.readFileSync(file, 'utf8')));
        }
    }
    const keep = new Set(results.map((c) => c.file).concat(previousFiles));
    for (const f of fs.readdirSync(outDir)) {
        if (f !== 'manifest.json' && !keep.has(OUT_DIR + '/' + f)) {
            fs.rmSync(path.join(outDir, f), {force: true});
        }
    }
    const sriFiles = configFiles.concat([...keep]);
    if (!updateSri(project, sriFiles, OUT_DIR + '/')) {
        warnings.push('sri-hashes.json not found: if Magento_Csp SRI is used, checkout will reject the edited requirejs-config.js');
    }
    const merged = clearMergedJs(project.root);
    if (merged) {
        warnings.push(`removed ${merged} merged JS file(s) from pub/static/_cache/merged (rebuilt by Magento with the loader)`);
    }
    for (const [page, handles] of Object.entries(r.skippedPages)) {
        warnings.push(`page type "${page}" skipped: no layout for ${handles.join(', ')} on this site`);
    }
    return {analysis: r, manifest, warnings};
}

function readManifest(outDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    } catch (e) {
        return null;
    }
}

/** Removes chunks and the loader, restoring the stock RequireJS behaviour. */
function clean(opts) {
    const {loadProject} = require('./project');
    const project = loadProject(opts);
    fs.rmSync(path.join(project.staticDir, OUT_DIR), {recursive: true, force: true});
    for (const f of ['requirejs-config.js', 'requirejs-config.min.js']) {
        const file = path.join(project.staticDir, f);
        if (fs.existsSync(file)) {
            fs.writeFileSync(file, stripLoader(fs.readFileSync(file, 'utf8')));
        }
    }
    updateSri(project, ['requirejs-config.js', 'requirejs-config.min.js'], OUT_DIR + '/');
    clearMergedJs(project.root);
    return project;
}

module.exports = {build, clean, toNamedDefine};
