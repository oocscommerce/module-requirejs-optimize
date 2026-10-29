'use strict';

/**
 * Evaluates the deployed requirejs-config.js and reproduces RequireJS id
 * normalization (relative ids, map, paths, plugins) so module ids can be
 * resolved to files under pub/static without a browser.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const acorn = require('acorn');

// ms per requirejs-config.js block; Magento's own run in well under 100 ms
const CONFIG_BLOCK_TIMEOUT = 5000;

function isObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
}

/** Same semantics as RequireJS context.configure(): deep mix for objects, concat for deps. */
function mergeConfig(target, cfg) {
    for (const [key, value] of Object.entries(cfg)) {
        if (key === 'deps') {
            target.deps = (target.deps || []).concat(value);
        } else if (key === 'shim') {
            target.shim = target.shim || {};
            for (const [id, shim] of Object.entries(value)) {
                target.shim[id] = Array.isArray(shim) ? {deps: shim} : shim;
            }
        } else if (['paths', 'bundles', 'config', 'map'].includes(key)) {
            target[key] = deepMix(target[key] || {}, value);
        } else {
            target[key] = value;
        }
    }
    return target;
}

function deepMix(target, source) {
    for (const [k, v] of Object.entries(source)) {
        target[k] = isObject(v) && isObject(target[k]) ? deepMix(target[k], v) : (isObject(v) ? deepMix({}, v) : v);
    }
    return target;
}

function loadRequireConfig(staticDir) {
    let file = path.join(staticDir, 'requirejs-config.js');
    if (!fs.existsSync(file)) {
        file = path.join(staticDir, 'requirejs-config.min.js');
    }
    // ignore a previously installed rjs-optimize loader block
    const src = fs.readFileSync(file, 'utf8').replace(/\/\* rjs-optimize:start \*\/[\s\S]*?\/\* rjs-optimize:end \*\/\n?/, '');
    const merged = {};
    const req = function () {};
    let calls = [];
    // applied once the block has run, so running it again does not repeat its config
    req.config = (cfg) => calls.push(cfg);
    const known = {require: req, requirejs: req, window: {}, document: {}, navigator: {userAgent: ''}, console};
    known.window.require = req;
    const context = vm.createContext(known);
    // statement by statement, so one failing requirejs-config.js block does not drop the others
    for (const node of acorn.parse(src, {ecmaVersion: 'latest', allowHashBang: true}).body) {
        const code = src.slice(node.start, node.end);
        for (let attempt = 0; attempt < 20; attempt++) {
            calls = [];
            try {
                // a block that never ends (e.g. waits for a global in a loop) is skipped like a failing one
                vm.runInContext(code, context, {filename: file, timeout: CONFIG_BLOCK_TIMEOUT});
                break;
            } catch (e) {
                // a global the theme expects from the page (e.g. a flag printed in <head>): undefined, run again
                const missing = e && e.name === 'ReferenceError' && /^(\S+) is not defined$/.exec(e.message);
                if (!missing) {
                    console.error(`warning: ${path.basename(file)}: skipped a block that fails outside the browser (${e.message})`);
                    break;
                }
                context[missing[1]] = undefined;
            }
        }
        calls.forEach((cfg) => mergeConfig(merged, cfg));
    }
    return merged;
}

class Resolver {
    constructor(staticDir, config) {
        this.staticDir = staticDir;
        this.config = config;
        this.map = config.map || {};
        this.paths = config.paths || {};
        this.shim = config.shim || {};
        this.existsCache = new Map();
    }

    /** Longest segment-prefix match of `name` among keys of `table`. */
    static longestPrefix(name, table) {
        const parts = name.split('/');
        for (let i = parts.length; i > 0; i--) {
            const prefix = parts.slice(0, i).join('/');
            if (Object.prototype.hasOwnProperty.call(table, prefix)) {
                return {prefix, value: table[prefix], rest: parts.slice(i).join('/')};
            }
        }
        return null;
    }

    applyMap(name, parentId) {
        if (parentId) {
            const scope = Resolver.longestPrefix(parentId, Object.fromEntries(
                Object.entries(this.map).filter(([k]) => k !== '*')
            ));
            if (scope) {
                const hit = Resolver.longestPrefix(name, scope.value);
                if (hit) {
                    return hit.rest ? hit.value + '/' + hit.rest : hit.value;
                }
            }
        }
        if (this.map['*']) {
            const hit = Resolver.longestPrefix(name, this.map['*']);
            if (hit) {
                return hit.rest ? hit.value + '/' + hit.rest : hit.value;
            }
        }
        return name;
    }

    static resolveRelative(name, parentId) {
        if (!parentId || name[0] !== '.') {
            return name;
        }
        const base = parentId.split('/').slice(0, -1);
        for (const part of name.split('/')) {
            if (part === '..') {
                base.pop();
            } else if (part !== '.') {
                base.push(part);
            }
        }
        return base.join('/');
    }

    /**
     * Normalizes an id as seen from parentId.
     * Returns {id, plugin, resource} where id is the canonical module id.
     */
    normalize(rawName, parentId) {
        const bang = rawName.indexOf('!');
        if (bang !== -1) {
            const plugin = this.normalize(rawName.slice(0, bang), parentId).id;
            let resource = rawName.slice(bang + 1);
            if (resource) {
                resource = this.applyMap(Resolver.resolveRelative(resource, parentId), parentId);
            }
            return {id: plugin + '!' + resource, plugin, resource};
        }
        const id = this.applyMap(Resolver.resolveRelative(rawName, parentId), parentId);
        return {id, plugin: null, resource: null};
    }

    /** Maps a normalized non-plugin id (or text resource with extension) to a file path, or null if external. */
    toFile(id, hasExtension) {
        if (/^(https?:)?\/\//.test(id) || id.endsWith('.js') && !hasExtension) {
            return null;
        }
        let rel = id;
        const hit = Resolver.longestPrefix(id, this.paths);
        if (hit) {
            const target = Array.isArray(hit.value) ? hit.value[0] : hit.value;
            if (/^(https?:)?\/\//.test(target)) {
                return null;
            }
            rel = hit.rest ? target + '/' + hit.rest : target;
        }
        if (hasExtension) {
            return path.join(this.staticDir, rel);
        }
        // with dev/js/minify_files on, deploy writes only *.min.js
        const file = path.join(this.staticDir, rel + '.js');
        const min = path.join(this.staticDir, rel + '.min.js');
        return !this.exists(file) && this.exists(min) ? min : file;
    }

    exists(file) {
        if (!this.existsCache.has(file)) {
            this.existsCache.set(file, fs.existsSync(file));
        }
        return this.existsCache.get(file);
    }

    /** Resolves an id to {id, file, plugin}; file is null for external/virtual modules. */
    resolve(rawName, parentId) {
        const n = this.normalize(rawName, parentId);
        if (n.plugin) {
            const file = n.plugin === 'text' && n.resource ? this.toFile(n.resource, true) : null;
            return {id: n.id, plugin: n.plugin, resource: n.resource, file};
        }
        return {id: n.id, plugin: null, file: this.toFile(n.id, false)};
    }

    /** True when the string plausibly names an existing JS module (used for template heuristics). */
    isModule(rawName) {
        if (!rawName || /[\s{}"'<>$*,:;=]/.test(rawName) || rawName.length > 200) {
            return false;
        }
        const r = this.resolve(rawName);
        return !!r.file && !r.plugin && this.exists(r.file);
    }

    /** mixins config resolved to {targetFile: [mixinId, ...]} the way mage/requirejs/mixins matches by URL. */
    mixinsByTargetFile() {
        const raw = ((this.config.config || {}).mixins) || {};
        const out = new Map();
        for (const [target, mixins] of Object.entries(raw)) {
            const t = this.resolve(target);
            if (!t.file) {
                continue;
            }
            for (const [mixin, enabled] of Object.entries(mixins || {})) {
                if (!enabled) {
                    continue;
                }
                if (!out.has(t.file)) {
                    out.set(t.file, {target: t.id, mixins: []});
                }
                out.get(t.file).mixins.push(mixin);
            }
        }
        return out;
    }
}

module.exports = {loadRequireConfig, Resolver};
