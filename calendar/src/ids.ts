/** `Work` → `work`: a calendar's or an account's id from its name. */
export function idOf(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'calendar';
}
