# @withbuddi/plugin-computer

Computer control for [buddi](https://github.com/withbuddi/buddi): your agents
work in the apps on your Mac that you allow — open Numbers, read the window,
click and type — in the app's own window, signed in as you. It provides the
third place buddi's browser can look, **your apps**, beside buddi's own
browser and your Chrome ([docs/browser.md](https://github.com/withbuddi/buddi/blob/main/docs/browser.md)).

macOS 14 or newer only. Elsewhere it loads, says "macOS only" on the Plugins
page, and buddi never offers the route.

## Install

From the dashboard: **Settings → Plugins → Browse → Computer → Install**, or

```sh
buddi plugins install @withbuddi/plugin-computer
```

It needs buddi with host API 1.29 (0.1.0-pre.38 or later). The npm package
carries the helper, `helper/buddi-computer`: a universal (arm64 + x86_64)
Swift executable, signed ad hoc, built from `native/Computer.swift` by this
repository's publish workflow on a macOS runner. Nothing else is downloaded.

Then:

1. **Allow the permissions.** Open **Settings → Computer**. Press **Allow in
   macOS** on Accessibility and Screen Recording and grant them to the helper
   (or to the app or service macOS names in its prompt: it may attribute the
   helper to whatever launched buddi). Press **Check again**. macOS may ask you
   to restart buddi; a rebuilt helper may need the permissions granted again.
2. **Choose the apps.** **Apps agents may use** starts with Chrome and Safari
   (or the list buddi kept before computer control was a plugin). **Add an
   app** picks one installed on this Mac; **Use as browser** marks the browser
   websites open in; with a Chromium browser, **Websites open in** picks its
   profile. **Another app** says what happens with an app that isn't listed:
   **Ask me** (a card in the chat) or **Don't open it**.
3. **Turn your apps on** in **Settings → Computer & browser** (the Your apps
   row appears once this plugin is installed). Owners who had *Use my apps*
   on before have it on already.
4. **Ask an agent** granted `browser.*`: "Add September's power bill to the
   household sheet in Numbers."

From a checkout of this repository: `pnpm install && pnpm --filter
@withbuddi/plugin-computer build` (builds the helper for this Mac's
architecture with the Xcode Command Line Tools), then install the folder.

## How agents use it

The same `browser.act` tool as every page: `{action:"open", app:"Numbers"}`
(or `appId`), then the window comes back as a page — a picture and refs from
the accessibility tree — and the agent clicks a ref (`{action:"click",
target:{ref:"ax12"}}`), fills one, presses a key, scrolls, or clicks a point
in the picture (`target:{x,y}`). `navigate` opens a website in the browser
app you marked. buddi picks this route only for app jobs; web pages stay in
buddi's own browser or your Chrome.

- **The app is found by name through Spotlight**, as exactly one installed
  application; none or several is refused with the close names, never a guess.
- **An app not on your list** turns the call into a card in the agent's
  conversation, "Use Voicito on your computer?", naming the agent, the app and
  its bundle id as found on this Mac: **Once** (this conversation),
  **Always** (added to the list; at 32 apps it counts as Once) or Reject. buddi
  keeps the answers; this plugin keeps the list.
- **Before any input** the helper checks it is the same window, in front, and
  that the target is the one in the latest picture. An old picture, a secure
  field, a disabled target or a point outside the picture is refused before
  anything is sent. If another app came forward, the agent is told to open
  the app again; nothing was typed.
- **One conversation at a time** controls your apps; the next waits its turn.
- **Take over** from the Canvas: anything in flight is cut off and the agent
  sends nothing until you give it back. There is no remote hand: you take over
  at the Mac itself. The Canvas keeps showing the window's picture.
- **Release and close never close an app.** Apps, documents and tabs stay open.
- **secret.type** types a secret you saved under Keys and secrets into the
  focused field of the app in front, as the helper reads it; every use asks
  you with a card naming the app.

## Permissions and what leaves the machine

- **What is captured.** Only the selected app's focused window, never the
  whole desktop. Its picture and a bounded amount of accessibility text go to
  the agent's model provider. Secure accessibility fields are masked and
  cannot be filled; anything else visible can be, so take over yourself for
  passwords and two-factor codes.
- **What the helper can do.** It is a short-lived fixed executable with
  bounded JSON input, output and time (20 seconds, 60 for a permission
  prompt); it gets only `PATH`, `HOME`, `TMPDIR`, the locale and the user name
  from buddi's environment. No script, arbitrary shortcut, clipboard or file
  transfer.
- **The network.** Your apps use their own network and sign-ins. The
  public-address check applies to `navigate` only; buddi's browser guard does
  not constrain an app's own traffic, the links it follows or the apps it
  launches. The list of apps limits which app buddi opens, **not what an
  allowed app itself can do**. This is not a sandbox.
- **This plugin sends nothing itself**, owns no database tables, and keeps
  `settings.json` in its own folder (`<buddi data>/plugins-data/computer`),
  readable only by you.

## Limits

- App menus, complex popovers, minimised or off-screen windows and custom
  widgets may expose no usable accessibility target. Only the one focused
  window is captured. No drag, right-click, arbitrary keyboard shortcut, or
  view across several monitors.
- A click on a point needs the picture unchanged since the last look, so an
  animation can make it fail, safely; refs are better.
- OS input does not make automation undetectable to a website.
- The tests here use a fake helper; only the build and the version probe run
  against the real system.

## Try it

Allow Calculator, ask an agent to open it and work out 12 × 7 by clicking the
buttons, and to report the result; Calculator stays open.

## Publishing

`computer@<version>` tags publish through `.github/workflows/publish.yml`:
a macOS job builds the universal helper, checks its two architectures and its
signature and that it answers, and hands it to the publish job, which packs it
(`BUDDI_REQUIRE_HELPER=1`: no helper, no publish) and checks the tarball
carries it executable.

## License

Apache-2.0.
