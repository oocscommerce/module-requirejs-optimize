# Changelog

## 1.1.0

- PHP 7.2+: no PHP 7.3/8 syntax, own exit codes instead of `Command::SUCCESS/FAILURE` (Symfony Console 5.1+), Composer 1 class loaders supported. Properties, methods and constants are protected so a preference can extend the classes.
- Subresource integrity hashes are collected and saved by Magento_Csp's own plugin, in the storage of the Magento version: fixes `requirejs-config.js` keeping its old hash on 2.4.7 (cache storage). Magento before 2.4.7 is skipped.
- Merged JS files (`dev/js/merge_files`) are no longer deleted: pages still in the full page cache kept loading a missing file. The static content version, which names merged files, is refreshed even when `dev/static/sign` is off.
- The static content version is refreshed only after a successful build/clean; `--no-version-refresh` keeps it.
- The context file is removed even when the engine run fails.
- `requirejs-config.js` blocks that never finish time out after 5 s and are skipped.
- README: command options.

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
