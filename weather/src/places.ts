/**
 * The owner's places and units. One place is home: the first one saved, or
 * the one the owner marks. With none saved, home is the city in the owner's
 * timezone (`Europe/Paris` is Paris), found and saved on first use and said
 * so; a zone that names no city (`UTC`, `Etc/GMT+5`) is asked for instead.
 */
import type { BuddiHost, DbArea } from '@buddi/core/plugin';
import type { GeocodedPlace, WeatherService } from './open-meteo.js';
import { defaultUnits, type Units } from './units.js';

export interface Place {
  id: string;
  label: string;
  name: string;
  latitude: number;
  longitude: number;
  timezone: string | null;
  isHome: boolean;
}

type Db = Pick<DbArea, 'query'>;

function toPlace(row: Record<string, unknown>): Place {
  return {
    id: String(row.id),
    label: String(row.label),
    name: String(row.name),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    timezone: row.timezone === null || row.timezone === undefined ? null : String(row.timezone),
    isHome: row.is_home === true,
  };
}

export async function listPlaces(db: Db): Promise<Place[]> {
  const { rows } = await db.query(
    `select id, label, name, latitude, longitude, timezone, is_home from weather.place order by is_home desc, created_at, label`,
  );
  return rows.map((r) => toPlace(r as Record<string, unknown>));
}

/** `Home` → `home`, `The office` → `the-office`. */
export function slugOf(label: string): string {
  const slug = label.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug.slice(0, 40) || 'place';
}

/** "Paris, Île-de-France, France", without repeating a part. */
export function displayName(place: GeocodedPlace): string {
  const parts = [place.name, place.admin1, place.country].filter((p): p is string => typeof p === 'string' && p !== '');
  return parts.filter((p, i) => parts.indexOf(p) === i).join(', ');
}

export async function savePlace(
  db: Db,
  label: string,
  found: GeocodedPlace,
  opts: { home?: boolean } = {},
): Promise<Place> {
  const existing = await listPlaces(db);
  const clean = label.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (clean === '') throw new Error('Give the place a name, like Home or Work.');
  let id = slugOf(clean);
  const same = existing.find((p) => p.label.toLowerCase() === clean.toLowerCase());
  if (!same) {
    for (let n = 2; existing.some((p) => p.id === id); n++) id = `${slugOf(clean)}-${n}`;
  } else {
    id = same.id;
  }
  const home = opts.home === true || existing.length === 0 || same?.isHome === true;
  if (home) await db.query(`update weather.place set is_home = false where is_home and id <> $1`, [id]);
  await db.query(
    `insert into weather.place (id, label, name, latitude, longitude, timezone, is_home)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do update set label = excluded.label, name = excluded.name, latitude = excluded.latitude,
       longitude = excluded.longitude, timezone = excluded.timezone, is_home = excluded.is_home`,
    [id, clean, displayName(found), found.latitude, found.longitude, found.timezone ?? null, home],
  );
  return { id, label: clean, name: displayName(found), latitude: found.latitude, longitude: found.longitude, timezone: found.timezone ?? null, isHome: home };
}

export async function removePlace(db: Db, id: string): Promise<Place | null> {
  const { rows } = await db.query(
    `delete from weather.place where id = $1 returning id, label, name, latitude, longitude, timezone, is_home`,
    [id],
  );
  const removed = rows[0] ? toPlace(rows[0] as Record<string, unknown>) : null;
  if (removed?.isHome) {
    // Home goes to the oldest place left, so there is always one when there is any.
    await db.query(
      `update weather.place set is_home = true where id = (select id from weather.place order by created_at limit 1)`,
    );
  }
  await db.query(`delete from weather.alert where place_id = $1`, [id]);
  return removed;
}

export async function setHome(db: Db, id: string): Promise<Place | null> {
  const places = await listPlaces(db);
  const place = places.find((p) => p.id === id);
  if (!place) return null;
  await db.query(`update weather.place set is_home = (id = $1)`, [id]);
  return { ...place, isHome: true };
}

/** The city a zone names, or undefined: `America/New_York` → `New York`. */
export function cityOfZone(timezone: string): string | undefined {
  if (!timezone.includes('/') || /^(Etc|SystemV|US)\//.test(timezone)) return undefined;
  const city = timezone.split('/').pop()!.replace(/_/g, ' ').trim();
  return city === '' ? undefined : city;
}

/** The units the owner reads: their choice, else what their language and zone suggest. */
export async function unitsFor(buddi: Pick<BuddiHost, 'db' | 'owner'>): Promise<{ units: Units; chosen: boolean }> {
  const { rows } = await buddi.db.query<{ units: Units }>(`select units from weather.settings where id = 1`);
  if (rows[0]) return { units: rows[0].units, chosen: true };
  let language: string | undefined;
  try {
    language = await buddi.owner.language?.();
  } catch {
    language = undefined;
  }
  return { units: defaultUnits(language, buddi.owner.timezone), chosen: false };
}

export async function setUnits(db: Db, units: Units): Promise<void> {
  await db.query(
    `insert into weather.settings (id, units, updated_at) values (1, $1, now())
     on conflict (id) do update set units = excluded.units, updated_at = now()`,
    [units],
  );
}

export const NO_HOME =
  'No place is saved yet and your timezone names no city. Add your home on Settings → Weather, or name a place.';

/**
 * The saved places, with home found from the owner's timezone when there are
 * none. `derived` says home was just made that way, so a tool can say so once.
 */
export async function ensurePlaces(
  buddi: Pick<BuddiHost, 'db' | 'owner' | 'http'>,
  service: WeatherService,
): Promise<{ places: Place[]; derived?: Place }> {
  const places = await listPlaces(buddi.db);
  if (places.length > 0) return { places };
  const city = cityOfZone(buddi.owner.timezone);
  if (city === undefined) return { places };
  const found = (await service.geocode(city, buddi.http))[0];
  if (!found) return { places };
  const home = await savePlace(buddi.db, 'Home', found, { home: true });
  return { places: [home], derived: home };
}

/**
 * The place a tool was asked about: a saved one by label, id or name, else
 * home when none was named, else found by name on the spot (not saved).
 */
export async function resolvePlace(
  buddi: Pick<BuddiHost, 'db' | 'owner' | 'http'>,
  service: WeatherService,
  asked: string | undefined,
): Promise<{ place: Pick<Place, 'label' | 'name' | 'latitude' | 'longitude'>; note?: string }> {
  const { places, derived } = await ensurePlaces(buddi, service);
  const wanted = asked?.trim().toLowerCase();
  if (!wanted) {
    const home = places.find((p) => p.isHome) ?? places[0];
    if (!home) throw new Error(NO_HOME);
    return {
      place: home,
      ...(derived ? { note: `Home is ${derived.name}, from your timezone; change it on Settings → Weather.` } : {}),
    };
  }
  const saved = places.find((p) => p.label.toLowerCase() === wanted || p.id === wanted)
    ?? places.find((p) => p.name.toLowerCase().startsWith(wanted));
  if (saved) return { place: saved };
  const found = (await service.geocode(asked!, buddi.http))[0];
  if (!found) throw new Error(`No place called "${asked}" was found. Try a city name, with its country if it is ambiguous.`);
  return { place: { label: found.name, name: displayName(found), latitude: found.latitude, longitude: found.longitude } };
}
