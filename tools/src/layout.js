'use strict';

/**
 * Static entry-point discovery per page type.
 *
 * For a list of layout handles it merges module + theme layout XML (following
 * <update handle>, honoring remove="true"), collects rendered templates and
 * block/view-model classes, then scans those .phtml/.php files for JS that
 * Magento will load: x-magento-init / data-mage-init keys, require([...]),
 * jsLayout `component`s and knockout templates.
 */
const fs = require('fs');
const path = require('path');
const {XMLParser} = require('fast-xml-parser');

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    preserveOrder: true,
    trimValues: true,
    parseTagValue: false
});

function readXml(file) {
    try {
        return parser.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return [];
    }
}

/** preserveOrder nodes: [{tag: [...children], ':@': {attrs}}] */
function tagOf(node) {
    return Object.keys(node).find((k) => k !== ':@');
}

function textOf(node) {
    const tag = tagOf(node);
    const children = node[tag] || [];
    return children.map((c) => (c['#text'] !== undefined ? String(c['#text']) : '')).join('').trim();
}

const classFileCache = new Map();

/** PHP file of a class: Magento module dirs first, then composer PSR-4 (libraries, odd layouts). */
function classFile(project, className) {
    const cls = className.replace(/^\\/, '').replace(/\\(Proxy|Interceptor)$/, '');
    if (classFileCache.has(cls)) {
        return classFileCache.get(cls);
    }
    let found = null;
    const parts = cls.split('\\');
    const dir = parts.length >= 3 && project.modules.get(parts[0] + '_' + parts[1]);
    if (dir) {
        const file = path.join(dir, ...parts.slice(2)) + '.php';
        found = fs.existsSync(file) ? file : null;
    }
    if (!found) {
        for (const [ns, base] of project.psr4 || []) {
            if (cls.startsWith(ns)) {
                const file = path.join(base, ...cls.slice(ns.length).split('\\')) + '.php';
                if (fs.existsSync(file)) {
                    found = file;
                    break;
                }
            }
        }
    }
    classFileCache.set(cls, found);
    return found;
}

/** Light PHP class reader: namespace/use resolution, parent class, constructor deps, templates. */
function phpClassInfo(src) {
    const ns = (src.match(/^\s*namespace\s+([^;\s]+)\s*;/m) || [])[1] || '';
    const uses = {};
    for (const m of src.matchAll(/^\s*use\s+\\?([A-Za-z0-9_\\]+)(?:\s+as\s+(\w+))?\s*;/gm)) {
        uses[m[2] || m[1].split('\\').pop()] = m[1];
    }
    const fq = (name) => {
        if (name.startsWith('\\')) {
            return name.slice(1);
        }
        const [first, ...rest] = name.split('\\');
        if (uses[first]) {
            return [uses[first], ...rest].join('\\');
        }
        return ns ? ns + '\\' + name : name;
    };
    const ext = src.match(/\bclass\s+\w+\s+extends\s+(\\?[A-Za-z0-9_\\]+)/);
    const deps = [];
    const ctor = src.match(/function\s+__construct\s*\(([\s\S]*?)\)\s*(?::\s*\w+\s*)?\{/);
    if (ctor) {
        for (const m of ctor[1].matchAll(/(\\?[A-Z][A-Za-z0-9_\\]*)\s+\$\w+/g)) {
            deps.push(fq(m[1]));
        }
    }
    const templates = [];
    for (const m of src.matchAll(/\$_template\s*=\s*['"]([^'"]+)['"]|['"]([A-Za-z0-9_]+::[^'"]+\.phtml|[^'"\s:]+\.phtml)['"]/g)) {
        templates.push(m[1] || m[2]);
    }
    return {ns, parent: ext ? fq(ext[1]) : null, deps, templates};
}

function addOwner(map, key, owner) {
    if (!map.has(key)) {
        map.set(key, new Set());
    }
    map.get(key).add(owner);
}

function moduleOfClass(className) {
    const parts = className.replace(/^\\/, '').split('\\');
    return parts.length >= 2 ? parts[0] + '_' + parts[1] : null;
}

class DiIndex {
    constructor(project) {
        this.types = new Map(); // class/virtualType -> {type, objects:[]}
        for (const dir of project.modules.values()) {
            for (const f of ['etc/di.xml', 'etc/frontend/di.xml']) {
                const file = path.join(dir, f);
                if (fs.existsSync(file)) {
                    this.index(fs.readFileSync(file, 'utf8'));
                }
            }
        }
    }

    index(xml) {
        const re = /<(type|virtualType)\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g;
        for (const m of xml.matchAll(re)) {
            const name = m[2].replace(/^\\/, '');
            const typeAttr = m[3].match(/\btype="([^"]+)"/);
            const entry = this.types.get(name) || {type: null, objects: []};
            if (typeAttr) {
                entry.type = typeAttr[1].replace(/^\\/, '');
            }
            for (const o of m[4].matchAll(/xsi:type="object"[^>]*>\s*([^<\s]+)\s*</g)) {
                entry.objects.push(o[1].replace(/^\\/, ''));
            }
            this.types.set(name, entry);
        }
    }

    /** Real PHP classes behind a class or virtualType name plus objects injected into it. */
    related(name) {
        const out = [];
        let current = name.replace(/^\\/, '');
        const guard = new Set();
        while (current && !guard.has(current)) {
            guard.add(current);
            const e = this.types.get(current);
            out.push(current);
            if (e) {
                out.push(...e.objects);
            }
            current = e && e.type;
        }
        return out;
    }
}

class LayoutCollector {
    constructor(project, resolver) {
        this.project = project;
        this.resolver = resolver;
        this.di = new DiIndex(project);
        this.fileCache = new Map();
    }

    /** Layout XML files of a handle, in the order Magento merges them for the theme. */
    layoutFiles(handle) {
        return this.project.layoutFiles[handle] || [];
    }

    resolveTemplate(template, contextModule) {
        let module = contextModule;
        let rel = template;
        const sep = template.indexOf('::');
        if (sep !== -1) {
            module = template.slice(0, sep);
            rel = template.slice(sep + 2);
        }
        if (!module) {
            return null;
        }
        const candidates = this.project.themeChain.map((t) => path.join(t.dir, module, 'templates', rel));
        const dir = this.project.modules.get(module);
        if (dir) {
            candidates.push(path.join(dir, 'view/frontend/templates', rel), path.join(dir, 'view/base/templates', rel));
        }
        return candidates.find((f) => fs.existsSync(f)) || null;
    }

    /**
     * @param {string[]} handles e.g. ['default', 'catalog_product_view']
     */
    collect(handles, cmsByHandle) {
        const state = {
            blocks: new Map(), // name -> {class, template, parent}
            removed: new Set(),
            components: new Map(), // jsLayout component -> Set(owner block)
            koTemplates: new Map(),
            headScripts: new Set(),
            handles: [],
            files: []
        };
        const queue = [...handles];
        const seen = new Set();
        let anon = 0;
        while (queue.length || this.discoverHandles(state, seen, queue, cmsByHandle)) {
            const handle = queue.shift();
            if (seen.has(handle)) {
                continue;
            }
            seen.add(handle);
            state.handles.push(handle);
            for (const file of this.layoutFiles(handle)) {
                state.files.push(path.relative(this.project.root, file));
                const walkNodes = (nodes, parent, inJsLayout) => {
                    for (const node of nodes) {
                        const tag = tagOf(node);
                        if (!tag || tag === '#text') {
                            continue;
                        }
                        const attrs = node[':@'] || {};
                        const children = node[tag] || [];
                        let nextParent = parent;
                        let jsl = inJsLayout;
                        switch (tag) {
                            case 'update':
                                if (attrs.handle) {
                                    queue.push(attrs.handle);
                                }
                                break;
                            case 'block': {
                                const name = attrs.name || ('__anon' + (++anon));
                                const b = state.blocks.get(name) || {};
                                if (attrs.class) {
                                    b.class = attrs.class;
                                }
                                if (attrs.template) {
                                    b.template = attrs.template;
                                }
                                if (attrs.ifconfig) {
                                    b.ifconfig = attrs.ifconfig;
                                }
                                b.parent = b.parent || parent;
                                state.blocks.set(name, b);
                                nextParent = name;
                                if (attrs.remove === 'true') {
                                    state.removed.add(name);
                                }
                                break;
                            }
                            case 'container':
                            case 'referenceContainer':
                            case 'referenceBlock':
                                if (attrs.name) {
                                    if (!state.blocks.has(attrs.name)) {
                                        state.blocks.set(attrs.name, {parent: tag === 'referenceBlock' ? undefined : parent});
                                    }
                                    if (attrs.remove === 'true') {
                                        state.removed.add(attrs.name);
                                    } else if (attrs.remove === 'false') {
                                        state.removed.delete(attrs.name);
                                    }
                                    if (attrs.template) {
                                        state.blocks.get(attrs.name).template = attrs.template;
                                    }
                                    if (attrs.class && tag === 'referenceBlock') {
                                        state.blocks.get(attrs.name).class = attrs.class;
                                    }
                                    nextParent = attrs.name;
                                }
                                break;
                            case 'remove':
                                if (attrs.name) {
                                    state.removed.add(attrs.name);
                                }
                                break;
                            case 'script':
                                if (attrs.src) {
                                    state.headScripts.add(attrs.src);
                                }
                                break;
                            case 'action':
                                if (attrs.method === 'setTemplate' && parent) {
                                    const arg = children.find((c) => tagOf(c) === 'argument');
                                    if (arg) {
                                        state.blocks.get(parent).template = textOf(arg);
                                    }
                                }
                                break;
                            case 'argument':
                                if (attrs.name === 'template' && parent && state.blocks.has(parent)) {
                                    state.blocks.get(parent).template = textOf(node);
                                } else if (attrs.name === 'jsLayout') {
                                    jsl = true;
                                } else if (attrs['xsi:type'] === 'object' && parent && state.blocks.has(parent)) {
                                    const b = state.blocks.get(parent);
                                    (b.objects = b.objects || []).push(textOf(node));
                                }
                                break;
                            case 'item':
                                if (attrs.name === 'component' && attrs['xsi:type'] === 'string') {
                                    addOwner(state.components, textOf(node), parent);
                                } else if (jsl && attrs.name === 'template' && attrs['xsi:type'] === 'string') {
                                    addOwner(state.koTemplates, textOf(node), parent);
                                } else if (attrs['xsi:type'] === 'object' && parent && state.blocks.has(parent)) {
                                    const b = state.blocks.get(parent);
                                    (b.objects = b.objects || []).push(textOf(node));
                                }
                                break;
                            default:
                                break;
                        }
                        walkNodes(children, nextParent, jsl);
                    }
                };
                walkNodes(readXml(file), null, false);
            }
        }
        state.cms = this.cmsFor(state.handles, cmsByHandle);
        return this.scan(state);
    }

    /**
     * Blocks that load extra layout at render time, e.g. the catalog products widget
     * calls addHandle('catalog_widget_product_list') to get its swatch renderers.
     * Queues such handles; returns true when something new was queued.
     */
    discoverHandles(state, seen, queue, cmsByHandle) {
        const classes = new Set();
        for (const [name, b] of state.blocks) {
            if (b.class && !this.isRemoved(state, name)) {
                classes.add(b.class);
            }
        }
        for (const add of this.cmsFor(state.handles, cmsByHandle)) {
            add.blocks.forEach((b) => classes.add(b.class));
        }
        for (const cls of classes) {
            let current = cls.replace(/^\\/, '');
            for (let i = 0; current && i < 6; i++) {
                const f = classFile(this.project, current);
                if (!f) {
                    break;
                }
                const src = this.read(f);
                for (const m of src.matchAll(/addHandle\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
                    if (!seen.has(m[1]) && !queue.includes(m[1])) {
                        queue.push(m[1]);
                    }
                }
                current = phpClassInfo(src).parent;
            }
        }
        return queue.length > 0;
    }

    /**
     * Database content for the merged handles. CMS page content is keyed by page kind
     * (the home page also carries the cms_page_view handle but only renders its own content).
     */
    cmsFor(handles, cmsByHandle) {
        if (!cmsByHandle) {
            return [];
        }
        const out = [];
        for (const h of handles) {
            if (h === 'cms_page_view' && (handles.includes('cms_index_index') || handles.includes('cms_noroute_index'))) {
                continue;
            }
            if (cmsByHandle.has(h)) {
                out.push(cmsByHandle.get(h));
            }
        }
        return out;
    }

    isRemoved(state, name) {
        const guard = new Set();
        let current = name;
        while (current && !guard.has(current)) {
            if (state.removed.has(current)) {
                return true;
            }
            guard.add(current);
            const b = state.blocks.get(current);
            current = b && b.parent;
        }
        return false;
    }

    /**
     * Effect of ifconfig on the block and its ancestors:
     *  - 'off'   a flag is off for every store view of the theme/locale -> block not rendered
     *  - 'maybe' a flag differs between those store views
     *  - null    no ifconfig, or every flag is on -> rendered like any block
     * Returns {state, flag}.
     */
    ifconfigState(state, name) {
        const values = this.project.ifconfig || {};
        const guard = new Set();
        let result = {state: null, flag: null};
        for (let current = name; current && !guard.has(current);) {
            guard.add(current);
            const b = state.blocks.get(current);
            if (b && b.ifconfig) {
                const value = values[b.ifconfig];
                if (value === false) {
                    return {state: 'off', flag: b.ifconfig};
                }
                if (value !== true) {
                    result = {state: 'maybe', flag: b.ifconfig};
                }
            }
            current = b && b.parent;
        }
        return result;
    }

    /**
     * Scans rendered templates and PHP classes for JS entry points.
     * Blocks whose ifconfig flag is off are skipped; blocks whose flag cannot be decided
     * for the theme/locale are scanned separately: their JS is reported as `conditional`
     * and kept out of bundles unless unconditional code needs it too.
     */
    scan(state) {
        const groups = {
            always: {templates: new Set(), classes: new Set(), entries: new Map()},
            conditional: {templates: new Set(), classes: new Set(), entries: new Map()}
        };
        const add = (group, id, source) => {
            if (!group.entries.has(id)) {
                group.entries.set(id, new Set());
            }
            group.entries.get(id).add(source);
        };
        const conditionalFlags = new Map(); // block name -> ifconfig path
        const isActive = (owner) => !owner || (!this.isRemoved(state, owner) && this.ifconfigState(state, owner).state !== 'off');
        const groupOfOwners = (owners) => ([...owners].some((o) => isActive(o) && (!o || !this.ifconfigState(state, o).state))
            ? groups.always : groups.conditional);

        for (const [c, owners] of state.components) {
            if ([...owners].some(isActive)) {
                add(groupOfOwners(owners), c, 'jsLayout');
            }
        }
        for (const [t, owners] of state.koTemplates) {
            if ([...owners].some(isActive)) {
                add(groupOfOwners(owners), 'text!' + (t.endsWith('.html') ? t : t + '.html').replace(/^([^/]+)/, '$1/template'), 'jsLayout');
            }
        }

        // the page root template is rendered on every page (body data-mage-init etc.)
        const root = this.resolveTemplate('Magento_Theme::root.phtml');
        if (root) {
            groups.always.templates.add(root);
        }
        // CMS pages/blocks and widget instances from the database
        for (const add of state.cms || []) {
            for (const b of add.blocks) {
                groups.always.classes.add(b.class);
                for (const tpl of (b.template ? [b.template] : this.classTemplates(b.class))) {
                    const file = this.resolveTemplate(tpl, moduleOfClass(b.class));
                    if (file) {
                        groups.always.templates.add(file);
                    }
                }
            }
            for (const html of add.html) {
                for (const id of this.jsStrings(html, false)) {
                    add(groups.always, id, 'cms content');
                }
            }
        }
        const unresolved = [];
        for (const [name, b] of state.blocks) {
            if (this.isRemoved(state, name)) {
                continue;
            }
            const ifc = this.ifconfigState(state, name);
            if (ifc.state === 'off') {
                continue;
            }
            const group = ifc.state ? groups.conditional : groups.always;
            if (ifc.state && (b.class || b.template)) {
                conditionalFlags.set(name, ifc.flag);
            }
            for (const o of b.objects || []) {
                group.classes.add(o);
            }
            if (b.class) {
                group.classes.add(b.class);
            }
            const ctxModule = b.class ? moduleOfClass(b.class) : null;
            const tpls = b.template ? [b.template] : (b.class ? this.classTemplates(b.class) : []);
            for (const tpl of tpls) {
                const file = this.resolveTemplate(tpl, ctxModule);
                if (file) {
                    group.templates.add(file);
                } else {
                    unresolved.push(tpl);
                }
            }
        }

        const scanned = new Set();
        const phpFiles = new Set();
        for (const group of [groups.always, groups.conditional]) {
            const res = this.scanFiles(group.templates, group.classes, (id, source) => add(group, id, source));
            res.templates.forEach((f) => scanned.add(f));
            res.phpFiles.forEach((f) => phpFiles.add(f));
        }
        const conditional = new Map();
        for (const [id, sources] of groups.conditional.entries) {
            if (!groups.always.entries.has(id)) {
                conditional.set(id, sources);
            }
        }
        return {
            handles: state.handles,
            layoutFiles: state.files,
            headScripts: [...state.headScripts],
            templates: [...scanned].map((f) => path.relative(this.project.root, f)),
            phpFiles: [...phpFiles].map((f) => path.relative(this.project.root, f)),
            unresolvedTemplates: unresolved,
            ifconfigBlocks: Object.fromEntries(conditionalFlags),
            entries: groups.always.entries,
            conditional
        };
    }

    scanFiles(templates, classes, add) {
        // blocks, view models and what they get injected (di.xml arguments, constructor), 2 levels deep
        const phpFiles = new Set();
        let frontier = [...classes];
        const seenClasses = new Set();
        for (let level = 0; level < 3 && frontier.length; level++) {
            const next = [];
            for (const cls of frontier) {
                for (const rel of this.di.related(cls)) {
                    if (seenClasses.has(rel)) {
                        continue;
                    }
                    seenClasses.add(rel);
                    const f = classFile(this.project, rel);
                    if (!f) {
                        continue;
                    }
                    phpFiles.add(f);
                    if (level < 2) {
                        next.push(...phpClassInfo(this.read(f)).deps);
                    }
                }
            }
            frontier = next;
        }

        const pending = [...templates];
        const scanned = new Set();
        while (pending.length) {
            const file = pending.pop();
            if (scanned.has(file)) {
                continue;
            }
            scanned.add(file);
            const src = this.read(file);
            const source = path.relative(this.project.root, file);
            for (const id of this.jsStrings(src, false)) {
                add(id, source);
            }
            // templates rendered from inside templates
            for (const m of src.matchAll(/(?:setTemplate|getTemplateFile|fetchView)\(\s*['"]([^'"]+\.phtml)['"]/g)) {
                const f = this.resolveTemplate(m[1], this.moduleOfFile(file));
                if (f) {
                    pending.push(f);
                }
            }
            for (const m of src.matchAll(/createBlock\(\s*\\?([A-Za-z0-9_\\]+)::class/g)) {
                for (const t of this.classTemplates(m[1])) {
                    const f = this.resolveTemplate(t, moduleOfClass(m[1]));
                    if (f) {
                        pending.push(f);
                    }
                }
            }
        }
        for (const file of phpFiles) {
            const src = this.read(file);
            const source = path.relative(this.project.root, file);
            for (const id of this.jsStrings(src, true)) {
                add(id, source);
            }
        }
        return {templates: scanned, phpFiles};
    }

    moduleOfFile(file) {
        for (const [name, dir] of this.project.modules) {
            if (file.startsWith(dir + path.sep)) {
                return name;
            }
        }
        const m = file.match(/\/([A-Z][A-Za-z0-9]*_[A-Za-z0-9]+)\/templates\//);
        return m ? m[1] : null;
    }

    /** Templates a block class may render: $_template, setTemplate(), *.phtml constants; walks parents until found. */
    classTemplates(className, depth = 0) {
        const start = className.replace(/^\\/, '');
        let current = start;
        const guard = new Set();
        while (current && !guard.has(current)) {
            guard.add(current);
            const f = classFile(this.project, current);
            if (!f) {
                return [];
            }
            const src = this.read(f);
            const info = phpClassInfo(src);
            if (info.templates.length) {
                const module = moduleOfClass(current);
                return info.templates.map((t) => (t.includes('::') ? t : module + '::' + t));
            }
            // dispatcher block: createBlock($type) picks a child block at runtime
            // (e.g. Magento\Captcha\Block\Captcha -> Block/Captcha/*.php); use those children
            if (current === start && depth === 0 && /createBlock\(\s*\$/.test(src)) {
                const dir = f.slice(0, -4);
                if (fs.existsSync(dir)) {
                    return fs.readdirSync(dir).filter((n) => n.endsWith('.php'))
                        .flatMap((n) => this.classTemplates(start + '\\' + n.slice(0, -4), depth + 1));
                }
            }
            current = info.parent;
        }
        return [];
    }

    read(file) {
        if (!this.fileCache.has(file)) {
            this.fileCache.set(file, fs.readFileSync(file, 'utf8'));
        }
        return this.fileCache.get(file);
    }

    /**
     * Strings in templates/PHP that name JS modules.
     * phtml: JSON object keys (x-magento-init, data-mage-init) and require([...]) arrays.
     * php:   array keys/values around `=>` (jsLayout built in PHP, layout processors).
     */
    jsStrings(src, php) {
        const out = new Set();
        const test = (s) => {
            if (this.resolver.isModule(s)) {
                out.add(s);
            }
        };
        if (php) {
            for (const m of src.matchAll(/['"]([^'"\s]{1,150})['"]\s*=>/g)) {
                test(m[1]);
            }
            for (const m of src.matchAll(/['"]component['"]\s*=>\s*['"]([^'"]+)['"]/g)) {
                test(m[1]);
            }
            return out;
        }
        for (const m of src.matchAll(/["']([^"'\s<>{}]{1,150})["']\s*:/g)) {
            test(m[1]);
        }
        for (const m of src.matchAll(/\brequire(?:js)?\s*\(\s*\[([^\]]*)\]/g)) {
            for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
                test(s[1]);
            }
        }
        // any other path-like string, e.g. gallery "mixins":["magnifier/magnify"]
        for (const m of src.matchAll(/["']([A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-./]+)["']/g)) {
            test(m[1]);
        }
        return out;
    }
}

module.exports = {LayoutCollector};
