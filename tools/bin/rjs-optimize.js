#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {analyze, proposeChunks} = require('../src/analyze');
const {build, clean} = require('../src/build');

function parseArgs(argv) {
    const args = {_: []};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const [k, v] = a.slice(2).split('=');
            args[k] = v !== undefined ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
        } else {
            args._.push(a);
        }
    }
    return args;
}

const kb = (b) => (b / 1024).toFixed(0) + ' KB';
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function sizeOf(graph, ids) {
    let s = 0;
    for (const id of ids) {
        const n = graph.nodes.get(id);
        s += n && n.file && !n.missing ? n.size : 0;
    }
    return s;
}

function countFiles(graph, ids) {
    let c = 0;
    for (const id of ids) {
        const n = graph.nodes.get(id);
        c += n && n.file && !n.missing ? 1 : 0;
    }
    return c;
}

/** Options for the theme/locale described by the context file bin/magento static:optimize:run wrote. */
function contextOpts(args) {
    if (!args.context) {
        throw new Error('missing --context FILE (run through bin/magento static:optimize:run)');
    }
    const context = JSON.parse(fs.readFileSync(args.context, 'utf8'));
    const opts = {context, root: context.root, theme: context.theme, locale: context.locale};
    if (args.pages) {
        opts.pages = JSON.parse(fs.readFileSync(args.pages, 'utf8'));
    }
    return opts;
}

async function runBuild(args, base) {
    // chunks are minified like the rest of the site's JS: dev/js/minify_files of the store view
    const opts = {...base, minify: !!base.context.jsFlags['dev/js/minify_files'], minChunk: (args['min-chunk'] !== undefined && args['min-chunk'] !== true ? +args['min-chunk'] : 0) * 1024,
        maxChunk: (args['max-chunk'] !== undefined && args['max-chunk'] !== true ? +args['max-chunk'] : 0) * 1024,
        progressive: !!args.progressive};
    const t0 = Date.now();
    const {manifest, warnings} = await build(opts);
    console.log(`\nrjs-optimize build  ${opts.theme} / ${opts.locale}  (${Date.now() - t0} ms)`);
    console.log(`minify: ${opts.minify ? 'on' : 'off'} (dev/js/minify_files)\n`);
    console.log(pad('chunk', 46) + lpad('modules', 8) + lpad('source', 10) + lpad('output', 10) + '  pages');
    for (const c of manifest.chunks) {
        const scope = c.lazy ? 'lazy, loaded on demand' : (c.pages.length === Object.keys(manifest.pages).length ? '*' : c.pages.join(','));
        console.log(pad(c.file, 46) + lpad(c.modules, 8) + lpad(kb(c.rawSize), 10) + lpad(kb(c.size), 10) + '  ' + scope);
    }
    console.log('\nper page:');
    for (const [page, p] of Object.entries(manifest.pages)) {
        console.log('  ' + pad(page, 22) + p.chunks.length + ' chunks');
    }
    const reasons = {};
    for (const s of manifest.skipped) {
        reasons[s.reason] = (reasons[s.reason] || 0) + 1;
    }
    console.log(`\nnot bundled (load as single files): ${manifest.skipped.length}  ` + Object.entries(reasons).map(([k, v]) => `${k}: ${v}`).join(', '));
    if (args.verbose) {
        manifest.skipped.forEach((s) => console.log(`  - ${s.id} (${s.reason})`));
    }
    warnings.forEach((w) => console.log('warning: ' + w));
    console.log('\nloader installed in requirejs-config.js; manifest: rjs-optimize/manifest.json');
}

async function check(args, opts) {
    const t0 = Date.now();
    const r = await analyze(opts);
    const {graph, pages} = r;

    console.log(`\nrjs-optimize check  ${opts.theme} / ${opts.locale}  (${Date.now() - t0} ms)`);
    console.log(`static dir: ${path.relative(r.project.root, r.project.staticDir)}`);
    console.log(`modules enabled: ${r.project.modules.size}, theme chain: ${r.project.themeChain.map((t) => t.code).join(' -> ')}`);
    console.log(r.cms ? `database content: ${r.cms.pages} CMS pages, ${r.cms.blocks} blocks, ${r.cms.widgets} widget placements` : 'database content: not read');
    r.warnings.forEach((w) => console.log('warning: ' + w));
    console.log(`graph: ${graph.nodes.size} module ids, global deps: ${r.globalIds.join(', ')}`);
    console.log(`global deps load ${countFiles(graph, r.globalSet)} files, ${kb(sizeOf(graph, r.globalSet))}, ${r.globalDepth} request rounds\n`);

    console.log(pad('page', 22) + lpad('entries', 8) + lpad('files', 7) + lpad('size', 9) + lpad('rounds', 8) + lpad('+lazy', 7) + lpad('lazyKB', 9) + lpad('ifconf', 8) + lpad('ifcKB', 8));
    for (const [name, p] of Object.entries(pages)) {
        console.log(pad(name, 22) + lpad(Object.keys(p.entries).length, 8) + lpad(countFiles(graph, p.sync), 7)
            + lpad(kb(sizeOf(graph, p.sync)), 9) + lpad(p.rounds, 8)
            + lpad(countFiles(graph, p.lazyOnly), 7) + lpad(kb(sizeOf(graph, p.lazyOnly)), 9)
            + lpad(countFiles(graph, p.conditional), 8) + lpad(kb(sizeOf(graph, p.conditional)), 8));
    }
    console.log('  files/size = loaded before page is interactive (sync + mixins); rounds = sequential request waves;');
    console.log('  +lazy = loaded later on demand (require() in code, uiComponent children, KO templates)');
    console.log('  ifconf = only used by blocks with ifconfig: not bundled, loads as single files when enabled\n');

    const flags = {};
    for (const p of Object.values(pages)) {
        for (const [block, flag] of Object.entries(p.ifconfigBlocks)) {
            (flags[flag] = flags[flag] || new Set()).add(block);
        }
    }
    const condEntries = new Set(Object.values(pages).flatMap((p) => Object.keys(p.conditionalEntries)));
    const values = Object.values(r.project.ifconfig);
    console.log(`ifconfig (store config): ${values.filter((v) => v === true).length} flags on -> bundled, `
        + `${values.filter((v) => v === false).length} off -> not rendered, `
        + `${values.filter((v) => v === null).length} differ between store views -> ${condEntries.size} JS entries as single files`);
    if (args.verbose) {
        for (const [flag, blocks] of Object.entries(flags)) {
            console.log(`  ${flag}: ${[...blocks].join(', ')}`);
        }
        for (const id of condEntries) {
            console.log(`  - ${id}`);
        }
    }
    console.log('');

    // mixins
    const mixins = graph.mixins;
    let mixinCount = 0;
    const orphanMixins = [];
    for (const [file, m] of mixins) {
        mixinCount += m.mixins.length;
        if (!fs.existsSync(file)) {
            orphanMixins.push(m.target);
        }
    }
    console.log(`mixins: ${mixinCount} mixins on ${mixins.size} targets` + (orphanMixins.length ? `, ${orphanMixins.length} target(s) missing: ${orphanMixins.join(', ')}` : ''));

    // single importer modules (inline candidates)
    let single = 0;
    let singleSize = 0;
    const entryIds = new Set(Object.values(pages).flatMap((p) => Object.keys(p.entries)).concat(r.globalIds));
    for (const n of graph.nodes.values()) {
        if (!n.file || n.missing || entryIds.has(n.id)) {
            continue;
        }
        const imp = r.importers.get(n.id);
        if (imp && imp.size === 1 && [...imp][0].endsWith('|sync')) {
            single++;
            singleSize += n.size;
        }
    }
    console.log(`single-importer modules (inline into parent): ${single}, ${kb(singleSize)}`);

    const chunks = proposeChunks(r);
    console.log(`\nproposed chunks (grouped by pages that need them, sync only):`);
    for (const c of chunks.slice(0, 15)) {
        console.log('  ' + pad(c.sig === '*' ? 'common (all pages)' : c.sig, 60) + lpad(c.modules.length, 5) + ' files ' + lpad(kb(c.size), 8));
    }
    if (chunks.length > 15) {
        console.log(`  ... ${chunks.length - 15} more`);
    }

    // per page after bundling: requests = number of chunks touching the page
    console.log('\nestimated requests per page after bundling (vs now):');
    for (const [name, p] of Object.entries(pages)) {
        const used = chunks.filter((c) => c.pages.includes(name));
        console.log('  ' + pad(name, 22) + lpad(used.length, 4) + ' chunks  (now ' + countFiles(graph, p.sync) + ' files, ' + p.rounds + ' rounds)');
    }

    // issues
    const byType = {};
    for (const i of graph.issues) {
        (byType[i.type] = byType[i.type] || []).push(i.message);
    }
    const cycles = graph.findCycles();
    console.log('\nissues:');
    for (const [t, list] of Object.entries(byType)) {
        console.log(`  ${t}: ${list.length}`);
        for (const m of list.slice(0, args.verbose ? list.length : 8)) {
            console.log('    - ' + m);
        }
        if (!args.verbose && list.length > 8) {
            console.log(`    ... (--verbose for all)`);
        }
    }
    console.log(`  sync cycles: ${cycles.length}`);
    for (const c of cycles.slice(0, 5)) {
        console.log('    - ' + c.join(' -> '));
    }
    const unresolved = new Set(Object.values(pages).flatMap((p) => p.unresolvedTemplates));
    console.log(`  unresolved templates: ${unresolved.size}`);

    // unused
    const byDir = {};
    for (const f of r.unused) {
        const top = f.split('/')[0];
        byDir[top] = (byDir[top] || 0) + 1;
    }
    console.log(`\nJS files never reached from any analysed page: ${r.unused.length} (report only, may be used by CMS/widgets/other pages)`);
    console.log('  ' + Object.entries(byDir).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([d, c]) => `${d}:${c}`).join('  '));

    if (args.json) {
        const out = {
            theme: opts.theme,
            locale: opts.locale,
            globalDeps: r.globalIds,
            pages: Object.fromEntries(Object.entries(pages).map(([k, p]) => [k, {
                handles: p.handles,
                rounds: p.rounds,
                entries: p.entries,
                sync: [...p.sync],
                lazy: [...p.lazyOnly],
                ifconfigBlocks: p.ifconfigBlocks,
                conditionalEntries: p.conditionalEntries,
                conditional: [...p.conditional],
                unresolvedTemplates: p.unresolvedTemplates
            }])),
            modules: Object.fromEntries([...graph.nodes.values()].map((n) => [n.id, {
                file: n.file && path.relative(r.project.staticDir, n.file),
                size: n.size,
                missing: n.missing || undefined,
                edges: n.edges
            }])),
            chunks: chunks.map((c) => ({pages: c.pages, size: c.size, modules: c.modules})),
            issues: graph.issues,
            cycles,
            unused: r.unused
        };
        fs.writeFileSync(args.json, JSON.stringify(out, null, 2));
        console.log(`\nfull report: ${args.json}`);
    }
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'check';
const fail = (e) => {
    console.error(args.verbose ? e : 'error: ' + e.message);
    process.exit(1);
};
const commands = {
    check: (opts) => check(args, opts),
    build: (opts) => runBuild(args, opts),
    clean: (opts) => {
        const project = clean(opts);
        console.log('removed rjs-optimize chunks and loader from ' + path.relative(project.root, project.staticDir));
    }
};
if (commands[cmd]) {
    Promise.resolve().then(() => commands[cmd](contextOpts(args))).catch(fail);
} else {
    console.error([
        'Engine of bin/magento static:optimize:run, which writes the context file and runs:',
        '  rjs-optimize check --context FILE [--json out.json] [--verbose]    analyse, change nothing',
        '  rjs-optimize build --context FILE [--min-chunk 0] [--max-chunk 0]  write chunks + loader into pub/static',
        '  rjs-optimize clean --context FILE                                  remove chunks + loader',
        '  [--pages pages.json] overrides the analysed page types'
    ].join('\n'));
    process.exit(1);
}
