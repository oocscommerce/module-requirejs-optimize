# Changelog

## 1.0.3

- `build` and `clean` refresh the static content version (like `setup:static-content:deploy --refresh-content-version-only`), so browsers and CDNs load the new `requirejs-config.js`.
- The loader in `requirejs-config.min.js` is minified.
- A chunk that fails to load logs a console warning and falls back to individual files, without an uncaught script error or a `requirejs.onError` report.
- README: Luma benchmark.

## 1.0.2

- Fix "add is not a function" when CMS content references JS modules.
- requirejs-config.js blocks that read globals printed by the page (e.g. a theme flag) no longer stop the run: the global reads as undefined; a block failing for another reason is skipped with a warning.

## 1.0.1

- Fix CMS content query on Adobe Commerce (content staging links CMS store tables by `row_id`).

## 1.0.0

- Initial release.
