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

All three only read. A place is one you saved (home, work) or any city by
name; left out, it is home.

## The Weather page

A place in the rail. Pick the place at the top (Home, Work, …), then Today
(now in large, the next 24 hours, the temperature over the chance of rain),
Week (pick a day to see its hours) or 10 days. A warning sits at the top when
something severe is coming there in the next 24 hours. Needs buddi with host
API 1.12.

## Settings → Weather

Your places and your units. Home starts as the city your timezone names, so a
fresh install answers "what's the weather?" without a question; add or change
it, add work or anywhere else, and pick metric or imperial. Units start from
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
