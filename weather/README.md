# @withbuddi/plugin-weather

The weather for the places you keep, for [buddi](https://withbuddi.com): now,
the next seven days, and one message when something severe is on its way.

It reads from [Open-Meteo](https://open-meteo.com), which asks for no account
and no key. What leaves your computer is a place name you type and the
coordinates of your places. Nothing else.

## Install

```bash
buddi plugins install @withbuddi/plugin-weather
```

Then grant the tools to an agent (`weather.*`), or let Planner pick them up:
its morning brief opens with today's weather at home when this plugin is
installed.

## What your agents get

- `weather.now { place? }`: the temperature, the sky, the wind, and today's
  high and low.
- `weather.forecast { place?, days? }`: day by day, up to 7 days.
- `weather.places`: the places you saved, which one is home, and your units.

All three only read. A place is one of yours (Home, Work…) or any city by
name; left out, it is home.

## Your places

Since buddi's host API 1.18 your places live in buddi, on Settings → Profile,
and this plugin reads them (it asks for "reads your places" on its install
card): Home there is home here, and Work and the rest are offered on the
Weather page. A Home and Work kept by an older version of this plugin moved to
your profile once, when buddi first started on 1.18. Until there is a place,
the Plugins page says "Pick a place for the forecast".

Another plugin that requires weather may call its one export, `forecast {
place?, latitude?, longitude?, days? }`: the forecast at one of your places
(home when none is named) or at coordinates, in your units, read-only.

## The Weather page

A place in the rail. Pick the place at the top (Home, Work, …), then Today
(now in large, then one panel of the next 24 hours: temperature, rain or wind
as a chart with its values written on it, over the hourly strip; hover or pick
an hour and both mark it), Week (pick a day to see its hours in the same
panel) or 10 days. A warning sits at the top when something severe is coming
there in the next 24 hours. Needs buddi with host API 1.18. Hours, sunrise
and sunset read the way your Profile says (12-hour or 24-hour), and a night
hour wears the moon — the crescent over a cloud when partly cloudy, on a buddi
with host API 1.22 (the plain cloud before).

## On Home and the lock screen

The Weather widget: small, the temperature, the sky and the place, the next
twelve hours as a sparkline, today's high and low; medium, the same over a
strip of the next hours, every other one, the moon at night. Each placement
picks its place, its units and its Times — Profile (the default), 12-hour
("6 PM") or 24-hour ("18:00").

## Settings → Weather

Your places — those from your profile first, marked as such, then any you add
here for the weather only — and your units. With no place at all, home is the
city your timezone names, so a fresh install answers "what's the weather?"
without a question. Units start from
the language you answer in and your timezone.

## Severe weather

Every three hours buddi looks at the next 24 hours at each saved place. A
thunderstorm, heavy rain (10 mm in an hour or 30 mm in a day), heavy snow
(10 cm in a day), extreme heat (35°C), extreme cold (−15°C) or gusts of 75
km/h send you one message for that day, through the channel your notification
settings pick. The same storm seen on the next look is not a second message.

Open-Meteo publishes no official warnings, so these are forecast thresholds,
not your weather service's alerts.

## Licence

Apache-2.0.
