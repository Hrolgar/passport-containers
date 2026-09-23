# Passport

URL to container rules that follow your Firefox account. Runs in Firefox and Zen.

Why: Firefox's own Multi-Account Containers only maps a whole domain to one container and
Containerise's per-path rules never leave the machine. Passport keeps per-path rules in
`storage.sync`, which rides the Firefox account, and recreates the containers by name
wherever you sign in. Bookmark keywords and tags already sync natively, so the whole
identity setup arrives with one login on a new machine.

## Rules

One per line, `pattern , Container`. Edit them on the options page or add one from the
toolbar popup for the current site.

    github.com/acme-corp , Work                plain: host + path, segment boundaries
    @app\.example\.com/\?account=2 , Client A   @ = regex on the full URL (sees the query)
    !*.internal.example/* , Work               ! = glob on host + path
    # comment

The most specific match wins (longest pattern), so `mail.google.com , Personal` and
`mail.google.com/mail/u/1 , Work` can coexist in any order. A plain rule never
matches on a query string; use `@` for that. Container name `Default` forces the plain
uncontained profile.

## How it routes

A `webRequest` blocking listener on top-level navigations checks the URL. If the tab is
already in the right container nothing happens. Otherwise the request is cancelled and the
URL reopened in a new tab in the right container next to the old one. A fresh tab
(about:blank, newtab) is closed; a tab that was already on a page is left where it was.

## Develop

    npm install
    npm test            # matcher unit tests (node --test)
    npm run lint        # web-ext lint
    npm run build       # dist/*.zip
    npm run sign        # unlisted AMO signing, needs WEB_EXT_API_KEY / WEB_EXT_API_SECRET

For a quick manual test load `src/manifest.json` via about:debugging, This Firefox,
Load Temporary Add-on. Temporary add-ons vanish on restart; sign for a permanent install.

## Release

`main` is the live version. Every push to `main` runs tests, lint and a build. If the
`version` in `src/manifest.json` has no `vX.Y.Z` tag yet, the same run submits that version
to addons.mozilla.org (listed channel), creates the tag and a GitHub release with the source
package. Pushing without a version bump only runs the checks.

So a release is: bump `version` in `src/manifest.json` (and `package.json`), commit, push.
Mozilla reviews listed versions by hand, usually within a day or two, then signed-in browsers
update automatically. AMO never accepts a version number it has seen before, deleted ones
included, so always go up.

Install: https://addons.mozilla.org/firefox/addon/passport-containers/
