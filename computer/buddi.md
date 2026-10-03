# computer

Lets your agents work in the apps on your Mac that you allow: open Numbers,
add a row, read what is on screen, click and type, in the app's own window,
signed in as you. It gives buddi's browser a third place to look, "your
apps", next to buddi's own browser and your Chrome.

## What it does

When you name an app in a task ("add the power bill to the household sheet
in Numbers"), the agent opens it and works in its focused window through a
small native helper this plugin carries (`helper/buddi-computer`, built from
`native/Computer.swift`, signed ad hoc). The helper reads the window's
accessibility tree and a picture of that one window, never the whole screen,
and sends clicks and keystrokes only after checking that the same window is
still in front. It runs no shell, no AppleScript and no browser debugging.

One agent at a time works in your apps; the others wait their turn. You can
take over from the conversation's Canvas: the agent sends nothing until you
give it back. Your apps are never closed.

An app on your list opens without asking. Any other app asks you first with a
card in the chat (Allow once, or Always to add it to the list), or is refused
if you chose "Don't open it" on Settings → Computer. Websites open in the
browser app you mark on the list.

macOS 14 or newer only. On another computer the plugin loads, says it is
macOS only, and buddi never offers your apps.

## What you set up

Settings → Computer: allow **Accessibility** and **Screen Recording** for the
helper in macOS (Allow in macOS opens macOS's own prompts), and the apps
agents may use. Turn your apps on or off in Settings → Computer & browser.

## What it stores

`settings.json` in its own folder: the list of apps, the browser app and its
profile, and what to do with an app that is not listed. It owns no database
tables. The first time it starts it copies the list buddi's browser kept
before computer control was a plugin.

## What runs on a timer

Nothing.

## What leaves the machine

The plugin itself sends nothing anywhere. While an agent works in an app, a
picture of that app's window and a bounded amount of its accessibility text
go to the agent's model provider, as any page an agent looks at does. Your
apps keep using their own network and sign-ins.

Schema: computer
