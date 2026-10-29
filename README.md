# RequireJS Optimize

`oocscommerce/module-requirejs-optimize`

Bundles the RequireJS modules of a Magento 2 storefront into a few chunks per page type, without a
browser: like Vite, it finds what each page needs by reading the code, not by recording page loads.

Static analysis of layout XML, templates, PHP blocks, CMS content and widgets
→ JS entry points per page type → module graph → chunks per page type, with lazy modules
merged per lazy root. The Magento module collects the site context with Magento APIs; the
Node engine in `tools/` parses JS and writes the chunks.

## Features

- No browser, no crawling: entry points come from layout, templates, PHP blocks, CMS pages/blocks and widgets
- Chunks per page type (`common`, `product`, `cart_checkout`, ...); mixins and single-use dependencies merged with the module that uses them
- Lazy modules stay lazy, merged per lazy root with their dependencies, mixins and knockout templates
- `ifconfig` blocks follow the store configuration
- Works with `merge_files`, `minify_files` (chunks become `*.min.js`) and Magento_Csp SRI hashes
- Falls back to single files when a chunk fails to load; rebuilds do not break pages being loaded
- No `npm install` on the site: the engine ships as one file

## Installation

Requirements: Magento 2.4, production mode, Node.js 18+ on the machine that runs `bin/magento`,
`dev/js/enable_js_bundling` off.

```bash
composer require oocscommerce/module-requirejs-optimize
bin/magento module:enable OOCS_RequireJsOptimize
bin/magento setup:upgrade && bin/magento setup:di:compile
bin/magento setup:static-content:deploy
bin/magento static:optimize:run        # build every theme/locale used by an active store view
```

## Usage

Run `bin/magento static:optimize:run` after every `setup:static-content:deploy`: the deploy
rewrites `requirejs-config.js` and `sri-hashes.json`, which removes the loader.

```bash
bin/magento static:optimize:run [build|check|clean] [--theme Vendor/theme] [--locale xx_XX]
        [--min-chunk 0] [--json report.json] [--node /path/to/node] [-v]
bin/magento static:optimize:init [--force]   # write static-optimize.json with the default page types
```

### Configuration: `static-optimize.json`

Optional, in the Magento root; `bin/magento static:optimize:init` writes it with the defaults.

```json
{
    "exclude": ["Vendor_Slider/js/*"],
    "entries": {"home": ["Magento_PageBuilder/js/widget-initializer"]},
    "pages": {
        "home": ["default", "cms_index_index", "cms_page_view"],
        "wishlist": ["default", "wishlist_index_index"]
    }
}
```

- `pages`: page types and the layout handles Magento loads for each. Without the file the
  defaults are used (home, category, product simple/configurable/bundle/grouped, search, cart,
  checkout, success, login, account). Page types whose handles have no layout on the site are
  skipped.
- Blocks with `ifconfig="..."` in layout XML follow the store configuration of the store views
  using the theme/locale: flag on -> bundled like any block, off -> not rendered so its JS is
  ignored, different values between those store views -> its JS stays single files. Run
  `static:optimize:run` again after changing such a setting.
- `exclude`: module ids never bundled (`*` matches anything, `/` included); they load as single
  files, e.g. a third-party module that breaks inside a bundle.
- `entries`: extra entry modules per page type for JS the static analysis cannot find (added by
  PHP at runtime, Page Builder...); they and their dependencies are bundled for that page type.

With `-v` the context file handed to the engine is kept in `var/tmp/oocs_requirejsoptimize/`.

## Customizing the engine

PHP (`Console/`, `Model/`) collects the site context with Magento APIs; the Node engine in
`tools/` does the analysis and writes the chunks. The command runs `tools/dist/rjs-optimize.js`,
a single file with all dependencies bundled, so sites need no `npm install`.

| Path | Role |
| --- | --- |
| `tools/bin/rjs-optimize.js` | CLI: `check`, `build`, `clean` |
| `tools/src/project.js` | reads the context file written by PHP |
| `tools/src/requirejs.js` | `requirejs-config.js`, module id → file resolution, mixins |
| `tools/src/layout.js` | layout XML, templates, PHP blocks, CMS → JS entry points |
| `tools/src/graph.js` | module dependency graph (acorn) |
| `tools/src/analyze.js` | modules per page type, chunk proposal |
| `tools/src/build.js` | chunk files, loader, SRI hashes, clean |

After changing `tools/src` or `tools/bin`, rebuild the single file and commit it:

```bash
cd tools
npm ci            # once: acorn, fast-xml-parser, terser, esbuild
npm run dist      # writes dist/rjs-optimize.js
```

When `dist/rjs-optimize.js` is missing, the command runs `tools/bin/rjs-optimize.js` from the sources
instead, which needs `npm ci`. Delete the dist file while developing to skip the rebuild step.

Debugging: `-v` keeps the context file and prints its path, so the engine can be run on it directly
(module in `vendor/oocscommerce/module-requirejs-optimize`, or `app/code/OOCS/RequireJsOptimize`):

```bash
bin/magento static:optimize:run check -v
node vendor/oocscommerce/module-requirejs-optimize/tools/bin/rjs-optimize.js check \
    --context var/tmp/oocs_requirejsoptimize/context-Magento_luma-en_US.json --json report.json
```

## What build does

- Groups modules by the set of page types that need them (`common`, `product`, `cart_checkout`, ...);
  mixins and single-use dependencies end up next to the module that uses them. Pages that may
  load a module through an `ifconfig` block count for the grouping.
- Lazy modules (uiComponent children, `require()` on demand) stay lazy but are merged per lazy
  root with their dependencies, mixins and templates (`lazy-checkmo-method`); modules shared
  by several roots get one shared lazy chunk (`lazy-payment-default-shared`: place-order + mixins).
  A lazy group of a single module keeps loading as its own file.
- Chunks contain named defines; text templates are inlined; they are minified with terser when
  the store has `dev/js/minify_files` on, like the rest of its JS.
- Prepends a loader to `requirejs-config.js` that wraps `require.load`: requesting a bundled
  module loads its chunk once. `require.config({bundles})` is not used because it makes
  `require.toUrl()` return the bundle URL, which breaks `mage/requirejs/mixins`.
- Not bundled, loaded as single files like before: non-AMD files, modules listed in `exclude`,
  modules used only by `ifconfig` blocks whose flag differs between store views, and anything the static analysis did not find. A chunk that
  fails to load falls back to single files.

`--pages` overrides the analysed page types, e.g. `{"product": ["default", "catalog_product_view"]}`.

## Known gaps

- knockout templates whose path is computed at runtime
- Page Builder content types are not analysed
- JS added only by PHP code paths the static scan cannot follow loads as single files

## License

[MIT](LICENSE.txt)
