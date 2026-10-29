'use strict';

const fs = require('fs');
const path = require('path');
const {loadProject} = require('./project');
const {loadRequireConfig, Resolver} = require('./requirejs');
const {Graph} = require('./graph');
const {LayoutCollector} = require('./layout');


function* walkJs(dir) {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name !== 'rjs-optimize') {
                yield* walkJs(p);
            }
        } else if (e.name.endsWith('.min.js') ? !fs.existsSync(p.slice(0, -7) + '.js') : e.name.endsWith('.js')) {
            yield p;
        }
    }
}

async function analyze(opts) {
    const project = loadProject(opts);
    const warnings = [];
    const c = opts.context.cms || {byHandle: {}, stats: null};
    const cms = {byHandle: new Map(Object.entries(c.byHandle)), stats: c.stats};
    const config = loadRequireConfig(project.staticDir);
    const resolver = new Resolver(project.staticDir, config);
    const graph = new Graph(resolver);
    const collector = new LayoutCollector(project, resolver);
    // page types come from static-optimize.json or the defaults in OOCS\RequireJsOptimize\Model\PageConfig
    const pagesDef = opts.pages || opts.context.pages;
    if (!pagesDef) {
        throw new Error('no page types in the context (run through bin/magento static:optimize:run)');
    }

    const globalIds = (config.deps || []).map((d) => graph.add(d).id);
    const globalSet = graph.closure(globalIds, ['sync', 'mixin']);
    const globalMemo = new Map();
    const globalDepth = Math.max(0, ...globalIds.map((id) => graph.depth(id, globalMemo)));

    const pages = {};
    const skippedPages = {};
    for (const [name, handles] of Object.entries(pagesDef)) {
        // a page type this site does not have (e.g. Magento_Bundle disabled) would only
        // duplicate another page and fragment the chunks
        const absent = handles.filter((h) => h !== 'default' && !collector.layoutFiles(h).length);
        if (absent.length) {
            skippedPages[name] = absent;
            continue;
        }
        const layout = collector.collect(handles, cms.byHandle);
        const entryIds = [];
        const entrySources = {};
        for (const [raw, sources] of layout.entries) {
            const id = graph.add(raw).id;
            entryIds.push(id);
            entrySources[id] = [...sources];
        }
        // entries declared in static-optimize.json for what the scan cannot see
        for (const raw of (opts.context.entries || {})[name] || []) {
            const node = graph.add(raw);
            if (node.missing || (!node.file && !node.plugin)) {
                warnings.push(`entries.${name}: module "${raw}" not found in deployed static content`);
                continue;
            }
            entryIds.push(node.id);
            entrySources[node.id] = (entrySources[node.id] || []).concat('static-optimize.json');
        }
        const conditionalIds = [];
        const conditionalSources = {};
        for (const [raw, sources] of layout.conditional) {
            const id = graph.add(raw).id;
            conditionalIds.push(id);
            conditionalSources[id] = [...sources];
        }
        const sync = graph.closure(globalIds.concat(entryIds), ['sync', 'mixin']);
        const all = graph.closure(globalIds.concat(entryIds), ['sync', 'mixin', 'component', 'template', 'lazy']);
        // templates of components loaded up front are fetched as soon as they render
        for (const id of [...sync]) {
            for (const e of graph.nodes.get(id) ? graph.nodes.get(id).edges : []) {
                if (e.kind === 'template') {
                    sync.add(e.to);
                }
            }
        }
        const memo = new Map();
        const entryDepth = Math.max(0, ...entryIds.map((id) => graph.depth(id, memo, globalSet)));
        pages[name] = {
            handles: layout.handles,
            layoutFiles: layout.layoutFiles.length,
            templates: layout.templates.length,
            unresolvedTemplates: layout.unresolvedTemplates,
            entries: entrySources,
            sync,
            lazyOnly: new Set([...all].filter((id) => !sync.has(id))),
            all,
            ifconfigBlocks: layout.ifconfigBlocks,
            conditionalEntries: conditionalSources,
            // loaded only when an ifconfig flag is on: kept out of bundles
            conditional: new Set([...graph.closure(conditionalIds, ['sync', 'mixin'])].filter((id) => !all.has(id))),
            // may load here (ifconfig on): decides which chunk a module bundled for other pages lands in
            maybe: graph.closure(conditionalIds, ['sync', 'mixin']),
            rounds: globalDepth + entryDepth
        };
    }

    // reverse edges for importer counts
    const importers = new Map();
    for (const n of graph.nodes.values()) {
        for (const e of n.edges) {
            if (!importers.has(e.to)) {
                importers.set(e.to, new Set());
            }
            importers.get(e.to).add(n.id + '|' + e.kind);
        }
    }

    const reachedFiles = new Set();
    for (const n of graph.nodes.values()) {
        if (n.file && !n.missing) {
            reachedFiles.add(n.file);
        }
    }
    const unused = [];
    for (const f of walkJs(project.staticDir)) {
        if (!reachedFiles.has(f)) {
            unused.push(path.relative(project.staticDir, f));
        }
    }

    return {project, config, resolver, graph, globalIds, globalSet, globalDepth, pages, importers, unused, cms: cms.stats, jsFlags: opts.context.jsFlags, warnings, skippedPages};
}

/**
 * Groups modules by the set of pages that need them up front, webpack splitChunks style.
 * Pages that may need a module through an ifconfig block count for the grouping, so
 * enabling that flag does not pull in a chunk built for unrelated pages.
 */
function proposeChunks(result) {
    const pageNames = Object.keys(result.pages);
    const bySig = new Map();
    for (const id of result.graph.nodes.keys()) {
        const n = result.graph.nodes.get(id);
        if (!n.file || n.missing || !pageNames.some((p) => result.pages[p].sync.has(id))) {
            continue;
        }
        const using = pageNames.filter((p) => result.pages[p].sync.has(id) || result.pages[p].maybe.has(id));
        const sig = using.length === pageNames.length ? '*' : using.join('+');
        if (!bySig.has(sig)) {
            bySig.set(sig, {pages: using, modules: [], size: 0});
        }
        const c = bySig.get(sig);
        c.modules.push(id);
        c.size += n.size;
    }
    return [...bySig.entries()].map(([sig, c]) => ({sig, ...c})).sort((a, b) => b.size - a.size);
}

/**
 * Lazy chunks: everything loaded later (uiComponent children, require() on demand) stays
 * lazy, but each lazy root is merged with its own dependencies, mixins and templates so
 * one request replaces many (e.g. a payment renderer + place-order + its mixins).
 * Modules shared by several roots get their own chunk keyed by the roots that share them.
 */
function proposeLazyChunks(result) {
    const {graph, pages} = result;
    const upFront = new Set();
    const lazy = new Set();
    for (const p of Object.values(pages)) {
        p.sync.forEach((id) => upFront.add(id));
    }
    for (const p of Object.values(pages)) {
        p.all.forEach((id) => {
            const n = graph.nodes.get(id);
            if (!upFront.has(id) && n && n.file && !n.missing) {
                lazy.add(id);
            }
        });
    }
    const roots = new Set();
    for (const n of graph.nodes.values()) {
        for (const e of n.edges) {
            if ((e.kind === 'component' || e.kind === 'lazy') && lazy.has(e.to)) {
                roots.add(e.to);
            }
        }
    }
    const rootsOf = new Map();
    for (const r of roots) {
        for (const id of graph.closure([r], ['sync', 'mixin', 'template'])) {
            if (lazy.has(id)) {
                if (!rootsOf.has(id)) {
                    rootsOf.set(id, []);
                }
                rootsOf.get(id).push(r);
            }
        }
    }
    const bySig = new Map();
    for (const [id, rs] of rootsOf) {
        const sig = rs.sort().join('+');
        if (!bySig.has(sig)) {
            bySig.set(sig, {roots: rs, modules: [], size: 0});
        }
        const c = bySig.get(sig);
        c.modules.push(id);
        c.size += graph.nodes.get(id).size;
    }
    // a single module gains nothing from a chunk: it keeps loading as its own file
    return [...bySig.entries()].filter(([, c]) => c.modules.length > 1)
        .map(([sig, c]) => ({sig: 'lazy:' + sig, lazy: true, ...c}))
        .sort((a, b) => b.size - a.size);
}

module.exports = {analyze, proposeChunks, proposeLazyChunks};
