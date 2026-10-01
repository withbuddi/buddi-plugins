# weather

The weather now and the forecast for the places you save, and one message when
something severe is coming at one of them.

## What it does

Three tools your agents can read, none of which changes anything:
`weather.now`, `weather.forecast` (up to 7 days) and `weather.places`. A
question without a place is about home. Your places come from Settings →
Profile in buddi (Home, Work and any other you name), which this plugin reads
and never changes; home is your profile's Home. On Settings → Weather you add
a place for the weather only and pick metric or imperial. With no place at
all, home is the city your timezone names (Europe/Paris is Paris), found and
saved the first time a tool needs it, and the Plugins page says "Pick a place
for the forecast" until then.

Another plugin that requires this one may ask for the forecast at one of your
places (its `forecast` export), and nothing else of it.

The Weather page in the rail shows one place at a time, picked at the top:
today (now, the next 24 hours, the temperature over the chance of rain), the
week (pick a day to see its hours) and ten days ahead, with a warning at the
top when something severe is coming there. It reads the forecast once per
place every ten minutes and saves nothing.

## What runs on a timer

`weather.severe`, every three hours: the next 24 hours at each saved place.
Thunderstorms, heavy rain or snow, extreme heat or cold, or strong wind send
you one message for the day, through the channel your notification settings
pick. The same storm seen again later is not a second message.

## What it stores

`weather.place` (the places you added here, each with its name,
coordinates and zone), `weather.settings` (your units) and `weather.alert` (the severe
weather it already told you about, kept a week).

## What leaves the machine

To Open-Meteo, which needs no account and no key: a place name you type, to
find it, and the latitude and longitude of a place, for its forecast. Nothing
about you, your agents or your conversations.

Schema: weather
Hosts: geocoding-api.open-meteo.com, api.open-meteo.com
