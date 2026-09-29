/**
 * @withbuddi/plugin-weather — the weather for the owner's places, from
 * Open-Meteo with no key, and one message when something severe is coming.
 *
 * Three read tools a model sees (`weather.now`, `weather.forecast`,
 * `weather.places`), the owner's places and units on Settings → Weather
 * through `ownerOnly` tools, the Weather page in the rail (`page.ts`), and
 * one sentinel, `weather.severe`. The service
 * is a parameter (`createWeatherManifest`), so every test runs on a stub.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core/plugin';
import { openMeteo, type WeatherService } from './open-meteo.js';
import { createSevereSentinel } from './sentinel.js';
import { createAddPlaceTool, removePlaceTool, setHomeTool, setUnitsTool, weatherPages, weatherQueries } from './settings.js';
import { createForecastTool, createNowTool, createPlacesTool } from './tools.js';
import { createWeatherGlance } from './home.js';
import { weatherViews } from './views.js';
import { createPageQueries, weatherRailPage } from './page.js';
import { VERSION } from './version.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function createWeatherManifest(service: WeatherService = openMeteo): PluginManifest {
  return {
    name: 'weather',
    version: VERSION,
    schema: 'weather',
    migrationsDir: MIGRATIONS_DIR,
    description:
      'The weather now and the forecast for the places you save, from Open-Meteo with no key, and a message ' +
      'once when severe weather is coming at one of them.',
    network: [
      { host: 'geocoding-api.open-meteo.com', why: 'Finding a place you name: the name goes, its coordinates come back.' },
      { host: 'api.open-meteo.com', why: 'The forecast: a latitude and longitude go, no key and nothing else.' },
    ],
    uses: ['http', 'owner:notify'],
    tools: [
      createNowTool(service),
      createForecastTool(service),
      createPlacesTool(service),
      createAddPlaceTool(service),
      removePlaceTool,
      setHomeTool,
      setUnitsTool,
    ],
    sentinels: [createSevereSentinel(service)],
    pages: [weatherRailPage, ...weatherPages],
    queries: [...weatherQueries, ...createPageQueries(service)],
    views: weatherViews,
    home: [createWeatherGlance(service)],
  };
}

export const manifest: PluginManifest = createWeatherManifest();

export default manifest;

export * from './open-meteo.js';
export * from './places.js';
export * from './severe.js';
export * from './units.js';
export * from './tools.js';
export * from './settings.js';
export * from './sentinel.js';
export * from './views.js';
export * from './home.js';
export * from './page.js';
