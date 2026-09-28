/**
 * Settings → Weather: the owner's places and units. The writes are
 * `ownerOnly` tools, so no model is ever shown them; the reads are one query.
 */
import { z } from 'zod';
import type { PageDescriptor, PageQuery, ToolDefinition } from '@buddi/core/plugin';
import type { WeatherService } from './open-meteo.js';
import { cityOfZone, listPlaces, removePlace, savePlace, setHome, setUnits, unitsFor } from './places.js';

export const WEATHER_NOTICE =
  'Forecasts come from Open-Meteo, which needs no account or key. Only a place name you type and the latitude ' +
  'and longitude of your places leave this computer. buddi tells you once when something severe is coming at a ' +
  'saved place in the next 24 hours: thunderstorms, heavy rain or snow, extreme heat or cold, strong wind.';

export const weatherQueries: PageQuery[] = [
  {
    name: 'settings',
    params: z.object({}),
    async produce(_params, ctx) {
      const buddi = ctx.buddi!;
      const places = await listPlaces(buddi.db);
      const { units, chosen } = await unitsFor(buddi);
      const city = cityOfZone(buddi.owner.timezone);
      return {
        units,
        unitsNote: chosen ? '' : 'Not chosen yet: this is what your language and timezone suggest.',
        empty: places.length === 0,
        suggestion:
          city === undefined
            ? 'No place yet, and your timezone names no city: add your home below.'
            : `No place yet. Until you add one, home is ${city}, from your timezone.`,
        places: places.map((p) => ({
          id: p.id,
          label: p.label,
          name: p.name,
          coordinates: `${p.latitude.toFixed(2)}, ${p.longitude.toFixed(2)}`,
          home: p.isHome ? [{ value: 'home', tone: 'accent' }] : [],
          isHome: p.isHome,
        })),
      };
    },
  },
];

const addInput = z
  .object({
    label: z.string().trim().min(1).max(40).describe('What the owner calls it: Home, Work, Mum\'s.'),
    place: z.string().trim().min(2).max(120).describe('A city or town, with its country if it is ambiguous.'),
    home: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  })
  .strict();

export function createAddPlaceTool(service: WeatherService): ToolDefinition<z.infer<typeof addInput>, { note: string }> {
  return {
    name: 'weather.add_place',
    description: 'Save a place for the weather. The owner\'s own.',
    tier: 'auto',
    ownerOnly: true,
    input: addInput,
    async execute(input, ctx) {
      const buddi = ctx.buddi!;
      const found = (await service.geocode(input.place, buddi.http))[0];
      if (!found) throw new Error(`No place called "${input.place}" was found. Try the city name, with its country.`);
      const saved = await savePlace(buddi.db, input.label, found, { home: input.home === true || input.home === 'true' });
      return { note: `Saved ${saved.label}: ${saved.name}${saved.isHome ? ', your home' : ''}.` };
    },
  };
}

const idInput = z.object({ id: z.string().min(1).max(60) }).strict();

export const removePlaceTool: ToolDefinition<z.infer<typeof idInput>, { note: string }> = {
  name: 'weather.remove_place',
  description: 'Forget a saved place. The owner\'s own.',
  tier: 'auto',
  ownerOnly: true,
  input: idInput,
  async execute(input, ctx) {
    const removed = await removePlace(ctx.buddi!.db, input.id);
    if (!removed) throw new Error('That place is not saved.');
    return { note: `Removed ${removed.label}.` };
  },
};

export const setHomeTool: ToolDefinition<z.infer<typeof idInput>, { note: string }> = {
  name: 'weather.set_home',
  description: 'Make a saved place home. The owner\'s own.',
  tier: 'auto',
  ownerOnly: true,
  input: idInput,
  async execute(input, ctx) {
    const place = await setHome(ctx.buddi!.db, input.id);
    if (!place) throw new Error('That place is not saved.');
    return { note: `${place.label} is home now.` };
  },
};

const unitsInput = z.object({ units: z.enum(['metric', 'imperial']) }).strict();

export const setUnitsTool: ToolDefinition<z.infer<typeof unitsInput>, { note: string }> = {
  name: 'weather.set_units',
  description: 'Metric or imperial. The owner\'s own.',
  tier: 'auto',
  ownerOnly: true,
  input: unitsInput,
  async execute(input, ctx) {
    await setUnits(ctx.buddi!.db, input.units);
    return { note: input.units === 'metric' ? 'Saved: °C, km/h and mm.' : 'Saved: °F, mph and inches.' };
  },
};

export const weatherPages: PageDescriptor[] = [
  {
    id: 'settings',
    title: 'Weather',
    place: 'settings',
    icon: 'globe',
    data: { query: 'settings' },
    body: [
      { kind: 'notice', text: WEATHER_NOTICE },
      {
        kind: 'section',
        title: 'Places',
        note: 'Home is what a question without a place is about, and what the morning brief reads.',
        body: [
          { kind: 'notice', text: { path: 'suggestion' }, when: { path: 'empty', equals: true } },
          {
            kind: 'table',
            query: { query: 'settings' },
            rows: 'places',
            columns: [
              { key: 'label', label: 'Name' },
              { key: 'name', label: 'Place', fit: 'wrap' },
              { key: 'coordinates', label: 'Coordinates' },
              { key: 'home', label: 'Home', pill: {} },
            ],
            actions: [
              {
                tool: 'weather.set_home',
                label: 'Make home',
                done: { path: 'note' },
                args: { id: { row: 'id' } },
                when: { path: 'isHome', equals: false },
              },
              {
                tool: 'weather.remove_place',
                label: 'Remove',
                tone: 'danger',
                confirm: 'Remove {label}? buddi stops watching its weather.',
                done: { path: 'note' },
                args: { id: { row: 'id' } },
              },
            ],
            empty: 'No place saved.',
          },
          {
            kind: 'form',
            drawer: { title: 'Add a place', button: 'Add a place' },
            fields: [
              { name: 'label', label: 'Name', type: 'text', required: true, hint: 'What you call it: Home, Work.' },
              { name: 'place', label: 'City or town', type: 'text', required: true, hint: 'With its country if the name is common, e.g. Portland, Maine.' },
              { name: 'home', label: 'This is home', type: 'checkbox' },
            ],
            submit: {
              tool: 'weather.add_place',
              label: 'Add the place',
              tone: 'accent',
              busy: 'Finding it…',
              done: { path: 'note' },
              then: 'close',
              args: { label: { field: 'label' }, place: { field: 'place' }, home: { field: 'home' } },
            },
          },
        ],
      },
      {
        kind: 'section',
        title: 'Units',
        body: [
          {
            kind: 'form',
            initial: { query: 'settings' },
            fields: [
              {
                name: 'units',
                label: 'Units',
                type: 'select',
                from: 'units',
                options: [
                  { value: 'metric', label: 'Metric: °C, km/h, mm' },
                  { value: 'imperial', label: 'Imperial: °F, mph, inches' },
                ],
              },
            ],
            submit: {
              tool: 'weather.set_units',
              label: 'Save',
              busy: 'Saving…',
              done: { path: 'note' },
              args: { units: { field: 'units' } },
            },
          },
          { kind: 'notice', text: { path: 'unitsNote' }, when: { path: 'unitsNote', equals: '', not: true } },
        ],
      },
    ],
  },
];
