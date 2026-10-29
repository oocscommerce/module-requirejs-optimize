'use strict';

/**
 * Project for one theme/locale as described by bin/magento static:optimize: Magento APIs
 * did the discovery (enabled modules, theme chain, layout files, CMS, config), rjs-optimize only
 * reads the context file it wrote.
 */
const fs = require('fs');
const path = require('path');

function loadProject(opts) {
    const ctx = opts.context;
    if (!ctx) {
        throw new Error('missing site context (run through bin/magento static:optimize:run)');
    }
    if (!fs.existsSync(path.join(ctx.staticDir, 'requirejs-config.js')) && !fs.existsSync(path.join(ctx.staticDir, 'requirejs-config.min.js'))) {
        throw new Error('No deployed static content at ' + ctx.staticDir + ' (run setup:static-content:deploy)');
    }
    return {
        root: ctx.root,
        area: 'frontend',
        theme: ctx.theme,
        locale: ctx.locale,
        modules: new Map(ctx.modules),
        themeChain: ctx.themeChain,
        staticDir: ctx.staticDir,
        psr4: ctx.psr4,
        // handle -> layout files in Magento's merge order, theme overrides applied
        layoutFiles: ctx.layoutFiles,
        // ifconfig path -> true (on) | false (off) | null (differs between the store views)
        ifconfig: ctx.ifconfig || {}
    };
}

module.exports = {loadProject};
