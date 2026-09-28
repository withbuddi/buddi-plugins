/**
 * `weather.severe`: every three hours, the next 24 hours at each saved place,
 * against the thresholds in `severe.ts`. A new event tells the owner once,
 * urgency `today`, through `owner:notify`; the `weather.alert` row is what
 * makes it once, so a storm seen on eight runs is one message. It returns no
 * findings: nothing here needs an agent to speak.
 */
import type { Finding, Sentinel, SentinelContext } from '@buddi/core/plugin';
import type { WeatherService } from './open-meteo.js';
import { listPlaces, unitsFor } from './places.js';
import { describeEvents, eventKey, severeEvents, type SevereEvent } from './severe.js';

export const EVERY_3H = 3 * 60 * 60;

export function createSevereSentinel(service: WeatherService): Sentinel {
  return {
    id: 'weather.severe',
    description: 'Tells the owner once when severe weather is forecast in the next 24 hours at a saved place.',
    every: EVERY_3H,
    async run(ctx: SentinelContext): Promise<Finding[]> {
      const buddi = ctx.buddi!;
      const notify = buddi.owner.notify;
      if (notify === undefined) return [];
      // No saved place is a quiet state: the home from the timezone is a
      // tool's convenience, not something to watch unasked.
      const places = await listPlaces(buddi.db);
      if (places.length === 0) return [];
      const { units } = await unitsFor(buddi);
      const now = buddi.clock.now();
      await buddi.db.query(`delete from weather.alert where sent_at < $1`, [new Date(now.getTime() - 7 * 86_400_000)]);
      for (const place of places) {
        const forecast = await service.forecast({ latitude: place.latitude, longitude: place.longitude, days: 2, hourly: true }, buddi.http);
        const fresh: Array<{ key: string; event: SevereEvent }> = [];
        for (const event of severeEvents(forecast.hours, now)) {
          const key = eventKey(place.id, event);
          const { rows } = await buddi.db.query(
            `insert into weather.alert (key, place_id, sent_at) values ($1, $2, $3) on conflict (key) do nothing returning key`,
            [key, place.id, now],
          );
          if (rows.length > 0) fresh.push({ key, event });
        }
        if (fresh.length === 0) continue;
        // One message per place per look: a storm with its wind is one thing to read.
        const { title, text } = describeEvents(fresh.map((f) => f.event), place.label, units);
        await notify({ urgency: 'today', title, text, dedupeKey: fresh[0]!.key, link: { route: '#/settings/p.weather' } });
      }
      return [];
    },
  };
}
