# Passport

URL to container rules that follow your Firefox account. Runs in Firefox and Zen.

Why: Firefox's own Multi-Account Containers only maps a whole domain to one container and
Containerise's per-path rules never leave the machine. Passport keeps per-path rules in
`storage.sync`, which rides the Firefox account, and recreates the containers your rules and
keywords name wherever you sign in. Containers nothing refers to are left alone, and deleting
one in Firefox sticks. Bookmark keywords and tags already sync natively, so the whole
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

## Keywords and bookmarks

The popup can do the whole thing in one go: the rule, a bookmark in a folder you pick
(default: a "Passport" folder in the bookmarks menu), and a Passport keyword. Keywords live
in sync storage next to the rules. Type `mail` alone in the URL bar, exactly as you would a
bookmark keyword, and the page opens directly in its container. Firefox's own bookmark
keywords cannot be set by an extension (there is no API for it), so Passport does it
differently: a bare word in the URL bar becomes a search on your default engine, and Passport
catches that request before it loads when the word is one of your keywords. Works with
Google, Bing, DuckDuckGo, Startpage, Ecosia, Brave, Qwant, Yahoo, Yandex and Kagi as the
default engine. `go mail` works as well. Passport keywords also carry the container, which a
bookmark keyword never could.

## Keyword arguments

Put `%s` in a keyword's URL and whatever you type after the keyword fills it in:
`kgh klaria-web` with `https://github.com/acme/%s`. A keyword without `%s` ignores
extra words and lets the search happen, so `pdb news` is still a search.

## Reopen, pause, shortcuts

The popup has a "Reopen in" row that moves the current tab into another container, and a
pause switch that stops all routing until you resume it (also in the toolbar icon's
right-click menu, with an "II" badge while paused). Keys: Ctrl+Alt+P opens the popup,
Ctrl+Alt+Right / Left reopen the tab in the next or previous container. Rebind them in
about:addons, gear menu, Manage Extension Shortcuts.

## Problems, backup

The Sites tab lists inconsistencies at the top: duplicate rules, invalid regex, plain rules
with a query string, keywords whose site a rule sends elsewhere, containers not yet created,
and a default search engine the bare-keyword trick cannot see. The Advanced tab downloads a
JSON backup and restores one, merged into or replacing what is there.

## One site, several containers

Two keywords can point at the same URL with different containers (`pdb` to Personal, `kdb`
to Work). Keyword launches bypass the rules, so a rule for that site does not pull them back.
For bookmarks you click, put the container in the URL: `https://site/?passport=Work` opens
in Work and the parameter is stripped before the site sees it. The popup has a checkbox that
writes the bookmark that way. Rules stay the default for plain links and typed URLs.

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

## Develop and test locally

    git clone https://github.com/hrolgar/passport-containers && cd passport-containers
    npm install && npm test

Load it into your real Firefox profile without signing: about:debugging, This Firefox, Load
Temporary Add-on, pick `src/manifest.json`. It runs with your real containers, bookmarks and
sync storage. Edit a file, then press Reload on that page to pick the change up. Temporary
add-ons are removed when Firefox exits.

## Release

Every push to `main` runs tests, lint and a build, and nothing else: main never publishes,
because every upload to addons.mozilla.org restarts the human review. To publish, bump
`version` in `src/manifest.json` and `package.json`, push, then either push a matching tag
(`git tag v0.3.0 && git push origin v0.3.0`) or press "Run workflow" on the CI and release
action. That submits the version to AMO's listed channel, tags if needed, and creates a GitHub
release. AMO never accepts a version number it has seen before, deleted ones included.

Install: https://addons.mozilla.org/firefox/addon/passport-containers/
