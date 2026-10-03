# Changelog

What changes in @withbuddi/plugin-computer from one release to the next, newest first.

## 0.1.0 — unreleased

### Added

- Computer control as a plugin: agents work in the apps on your Mac that you allow, through the native helper that used to ship inside buddi, now carried here as a universal, ad-hoc-signed binary. It provides buddi's "your apps" route (host API 1.29 `routes`): health, look and act, the owner's list of apps (`reach`), take-over without a remote hand, and native typing for `secret.type`.
- Settings → Computer: the helper, Accessibility and Screen Recording with Allow in macOS and Check again; the apps agents may use with Add an app, Use as browser and Remove, and the browser's profile; and what happens with an app that isn't listed (ask me, or don't open it).
- Readiness on the Plugins page: helper present, both permissions allowed; "macOS only" anywhere else.
- The list of apps buddi's browser kept before is copied the first time the plugin starts.
