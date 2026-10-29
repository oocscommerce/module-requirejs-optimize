'use strict';

/**
 * Builds the RequireJS module graph by parsing deployed JS files with acorn.
 *
 * Edge kinds:
 *  - sync:  define([...]) deps, require('x') sugar, shim deps -> loaded before the module executes
 *  - mixin: config.mixins of the module -> loaded in parallel with the module (mage/requirejs/mixins)
 *  - component: uiComponent `component` children -> loaded when the parent creates them
 *  - template: knockout templates -> fetched as soon as the component renders
 *  - lazy:  require([...]) inside code -> loaded only when that code path runs (datepicker...)
 */
const fs = require('fs');
const acorn = require('acorn');
const walk = require('acorn-walk');

const KO_TEMPLATE = /^[A-Za-z0-9_]+\/[A-Za-z0-9_\-./]+$/;

function stringValue(node) {
    if (!node) {
        return null;
    }
    if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis[0].value.cooked;
    }
    return null;
}

function arrayStrings(node) {
    if (!node || node.type !== 'ArrayExpression') {
        return null;
    }
    return node.elements.map(stringValue).filter((s) => s !== null);
}

function calleeName(node) {
    if (node.type === 'Identifier') {
        return node.name;
    }
    // window.require([...]), requirejs.config is not a load
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
        && node.object.type === 'Identifier' && node.object.name === 'window') {
        return node.property.name;
    }
    return null;
}

function koTemplateId(value) {
    if (value.includes('!') || /\.\w+$/.test(value) && !value.endsWith('.html')) {
        return null;
    }
    const withExt = /\.html$/.test(value) ? value : value + '.html';
    return 'text!' + withExt.replace(/^([^/]+)/, '$1/template');
}

function parse(src) {
    const opts = {ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true, allowAwaitOutsideFunction: true};
    try {
        return acorn.parse(src, {...opts, sourceType: 'script'});
    } catch (e) {
        return acorn.parse(src, {...opts, sourceType: 'module'});
    }
}

/** Extracts raw dependency strings from one JS source. */
function extractDeps(src) {
    const result = {defines: [], sync: [], lazy: [], components: [], templates: [], amd: false, parseError: null};
    let ast;
    try {
        ast = parse(src);
    } catch (e) {
        result.parseError = e.message;
        return result;
    }
    walk.full(ast, (node) => {
        if (node.type === 'CallExpression') {
            const name = calleeName(node.callee);
            const args = node.arguments;
            if (name === 'define') {
                result.amd = true;
                let i = 0;
                const defName = stringValue(args[0]);
                if (defName !== null) {
                    i++;
                }
                const deps = arrayStrings(args[i]);
                result.defines.push({name: defName, deps: deps || []});
                if (deps) {
                    result.sync.push(...deps);
                }
            } else if (name === 'require' || name === 'requirejs') {
                const deps = arrayStrings(args[0]);
                if (deps) {
                    result.lazy.push(...deps);
                } else if (args.length === 1 && stringValue(args[0]) !== null) {
                    // CommonJS sugar: require('x') inside define factory
                    result.sync.push(stringValue(args[0]));
                }
            }
        } else if (node.type === 'Property' && !node.computed) {
            const key = node.key.type === 'Identifier' ? node.key.name : stringValue(node.key);
            const value = stringValue(node.value);
            if (value === null) {
                return;
            }
            if (key === 'component') {
                result.components.push(value);
            } else if (/te?mpl|tpl/i.test(key) && KO_TEMPLATE.test(value)) {
                result.templates.push(value);
            }
        } else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && /te?mpl|tpl/i.test(node.id.name)) {
            // e.g. blockLoaderTemplatePath = 'ui/block-loader'
            const value = stringValue(node.init);
            if (value !== null && KO_TEMPLATE.test(value)) {
                result.templates.push(value);
            }
        }
    });
    return result;
}

class Graph {
    constructor(resolver) {
        this.resolver = resolver;
        this.nodes = new Map(); // id -> node
        this.mixins = resolver.mixinsByTargetFile();
        this.issues = [];
    }

    issue(type, message, extra) {
        this.issues.push({type, message, ...extra});
    }

    /** Adds a module (and transitively its deps) and returns its node. */
    add(rawId, parentId) {
        const r = this.resolver.resolve(rawId, parentId);
        if (this.nodes.has(r.id)) {
            return this.nodes.get(r.id);
        }
        const node = {
            id: r.id,
            file: r.file,
            plugin: r.plugin,
            size: 0,
            amd: false,
            edges: [], // {to, kind}
            missing: false,
            external: !r.file && !r.plugin
        };
        this.nodes.set(r.id, node);

        if (r.plugin) {
            // the plugin module itself is a sync dependency
            this.link(node, r.plugin, 'sync', parentId);
            if (r.file) {
                this.readFile(node, r.file);
            }
            return node;
        }
        if (!r.file) {
            if (!['require', 'module', 'exports'].includes(r.id)) {
                node.virtual = true;
            }
            return node;
        }
        const src = this.readFile(node, r.file);
        if (src === null) {
            return node;
        }
        const deps = extractDeps(src);
        if (deps.parseError) {
            this.issue('parse-error', r.id + ': ' + deps.parseError, {module: r.id});
        }
        node.amd = deps.amd;
        node.defines = deps.defines.map((d) => d.name).filter(Boolean);
        for (const d of deps.sync) {
            this.link(node, d, 'sync', r.id);
        }
        const shim = this.resolver.shim[r.id];
        if (shim && shim.deps) {
            for (const d of shim.deps) {
                this.link(node, d, 'sync', r.id);
            }
        }
        const mix = this.mixins.get(r.file);
        if (mix) {
            for (const m of mix.mixins) {
                this.link(node, m, 'mixin', r.id);
            }
        }
        for (const d of deps.lazy) {
            this.link(node, d, 'lazy', r.id);
        }
        for (const d of deps.components) {
            this.link(node, d, 'component', r.id);
        }
        for (const t of deps.templates) {
            const id = koTemplateId(t);
            if (id) {
                this.link(node, id, 'template', null, true);
            }
        }
        return node;
    }

    readFile(node, file) {
        try {
            const src = fs.readFileSync(file, 'utf8');
            node.size = Buffer.byteLength(src);
            return src;
        } catch (e) {
            node.missing = true;
            return null;
        }
    }

    link(node, rawId, kind, parentId, optional) {
        if (['require', 'module', 'exports'].includes(rawId)) {
            return;
        }
        const target = this.add(rawId, parentId);
        if (target.missing) {
            if (optional) {
                // guessed knockout template path that does not exist: drop silently
                this.nodes.delete(target.id);
                return;
            }
            if (!target.reported) {
                target.reported = true;
                this.issue('missing', target.id + ' (required by ' + node.id + ')', {module: target.id, from: node.id});
            }
        }
        node.edges.push({to: target.id, kind});
    }

    /** Modules reachable from `ids` following the given edge kinds. */
    closure(ids, kinds) {
        const seen = new Set();
        const stack = [...ids];
        while (stack.length) {
            const id = stack.pop();
            if (seen.has(id)) {
                continue;
            }
            seen.add(id);
            const n = this.nodes.get(id);
            if (!n) {
                continue;
            }
            for (const e of n.edges) {
                if (kinds.includes(e.kind)) {
                    stack.push(e.to);
                }
            }
        }
        return seen;
    }

    /**
     * Network waterfall depth: number of sequential request rounds RequireJS needs
     * to load `id` with its sync deps (mixins load in the same round as their target).
     */
    depth(id, memo = new Map(), loaded = new Set(), visiting = new Set()) {
        if (memo.has(id)) {
            return memo.get(id);
        }
        const n = this.nodes.get(id);
        if (!n || visiting.has(id) || loaded.has(id)) {
            return 0;
        }
        visiting.add(id);
        let max = 0;
        for (const e of n.edges) {
            if (e.kind === 'sync') {
                max = Math.max(max, this.depth(e.to, memo, loaded, visiting));
            } else if (e.kind === 'mixin') {
                // starts with the target, so it adds no extra round for itself
                max = Math.max(max, this.depth(e.to, memo, loaded, visiting) - 1);
            }
        }
        visiting.delete(id);
        const own = n.file && !n.missing ? 1 : 0;
        memo.set(id, max + own);
        return max + own;
    }

    findCycles() {
        const cycles = [];
        const state = new Map();
        const stack = [];
        const visit = (id) => {
            state.set(id, 1);
            stack.push(id);
            const n = this.nodes.get(id);
            for (const e of (n ? n.edges : [])) {
                if (e.kind !== 'sync') {
                    continue;
                }
                const s = state.get(e.to);
                if (s === 1) {
                    cycles.push(stack.slice(stack.indexOf(e.to)).concat(e.to));
                } else if (!s) {
                    visit(e.to);
                }
            }
            stack.pop();
            state.set(id, 2);
        };
        for (const id of this.nodes.keys()) {
            if (!state.has(id)) {
                visit(id);
            }
        }
        return cycles;
    }
}

module.exports = {Graph, extractDeps};
