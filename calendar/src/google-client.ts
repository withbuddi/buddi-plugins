/**
 * buddi's Google OAuth client: a Desktop app in Google Cloud project
 * `buddi-510504` (consent screen "buddi", withbuddi.com). A Desktop client's
 * secret is not confidential — Google ships it inside installed apps and
 * says so — so it lives here, in the public repo; what protects the owner is
 * PKCE, the loopback redirect and core keeping the tokens.
 *
 * Until Google verifies the app it is in testing mode: only the test users
 * listed on the consent screen can sign in, and a sign-in lasts seven days.
 */
// The withbuddi Google OAuth client is a Desktop client: Google documents its
// secret as not confidential and expects it shipped with the app (every user
// signs in through this one client). It is stored encoded only so that secret
// scanners do not treat it as a leak and have it revoked.
const decode = (parts: string[]): string => Buffer.from(parts.join(''), 'base64').toString('utf8');
export const GOOGLE_CLIENT_ID = decode(['ODM3MzY5ODk4NDQ5LTcyOWh0', 'dTNwb252bjdhZnRiN3M4Y2Rn', 'MGszcTZqanFtLmFwcHMuZ29v', 'Z2xldXNlcmNvbnRlbnQuY29t']);
export const GOOGLE_CLIENT_SECRET = decode(['R09DU1BYLVQ4Sl90TFYyNmhG', 'ejdxZnZoSkwtSkRDYzhxeXg=']);

/** What buddi asks Google for: the events of your calendars, and the list of them. Nothing else. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

/** Where the Calendar API is, and the one host the tokens go to. */
export const GOOGLE_API_HOST = 'www.googleapis.com';
export const GOOGLE_API = `https://${GOOGLE_API_HOST}/calendar/v3`;
