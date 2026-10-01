/**
 * The manifest is the contract: a tool that is not listed here does not exist
 * as far as an agent's grant is concerned, however well it is written.
 */
import { describe, expect, it } from 'vitest';
import { manifest } from './index.js';
import { LEDGER_OFFER_QUERY } from './agents.js';
import { ADVISOR_ROLES, CREDIT_ROLES } from './sentinels/roles.js';

const names = manifest.tools.map((t) => t.name);

describe('the finance manifest', () => {
  it('lists the credit tools', () => {
    expect(names).toContain('finance.record_credit_score');
    expect(names).toContain('finance.credit_overview');
    expect(names).toContain('finance.set_card_terms');
  });

  it('keeps every credit tool on tier auto — they read and compute, nothing else', () => {
    for (const name of [
      'finance.record_credit_score',
      'finance.credit_overview',
      'finance.set_card_terms',
    ]) {
      expect(manifest.tools.find((t) => t.name === name)?.tier).toBe('auto');
    }
  });

  it('tells the model when to ask the owner, and with which tool', () => {
    const describedBy = (name: string) =>
      manifest.tools.find((t) => t.name === name)?.description ?? '';
    expect(describedBy('finance.credit_overview')).toMatch(/ONCE/);
    expect(describedBy('finance.credit_overview')).toMatch(/finance\.set_card_terms/);
    expect(describedBy('finance.set_card_terms')).toMatch(/ask once/i);
    expect(describedBy('finance.record_credit_score')).toMatch(/ask once/i);
  });

  it('says what it is and that it talks to no host', () => {
    expect(manifest.description).toMatch(/Nothing leaves this computer/);
    expect(manifest.network).toEqual([]);
  });

  it('asks before an import writes, and lets the owner remember it for a conversation', () => {
    for (const name of ['finance.commit_import', 'finance.import_csv']) {
      const tool = manifest.tools.find((t) => t.name === name)!;
      expect(tool.tier).toBe('gated');
      expect(tool.reusableApproval).toBe(true);
      expect(typeof tool.describe).toBe('function');
    }
    expect(manifest.tools.find((t) => t.name === 'finance.stage_import')!.tier).toBe('auto');
  });

  it('names every tool exactly once', () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it('ships the statement-closing sentinel and the credit missions and skill', () => {
    expect(manifest.sentinels.map((s) => s.id)).toContain('finance.statement-closing');
    const missions = manifest.missions?.map((m) => m.id) ?? [];
    expect(missions).toContain('monthly-score');
    expect(missions).toContain('pre-statement-review');
    const credit = manifest.missions?.filter((m) => m.agentRole === 'credit') ?? [];
    expect(credit).toHaveLength(2);
    expect(manifest.skills?.map((s) => s.name)).toContain('coaching-a-credit-score');
  });

  it('gathers every watcher\'s wakes into one run per two minutes, ten at most', () => {
    expect(manifest.sentinels.length).toBeGreaterThan(0);
    for (const sentinel of manifest.sentinels) {
      expect(sentinel.coalesce, sentinel.id).toEqual({ windowSeconds: 120, maxWaitSeconds: 600 });
    }
  });

  it('proposes one agent, Ledger, and it also holds the credit role — the advisor wearing a hat', () => {
    expect(manifest.agents?.map((a) => a.id)).toEqual(['ledger']);
    const ledger = manifest.agents![0]!;
    expect(ledger).toMatchObject({ id: 'ledger', handle: 'ledger', name: 'Ledger' });
    expect(ledger.description).toBe(
      'Cash-flow advisor: balances, recurring items, liabilities, and a projection before any purchase.',
    );
    // Every role a mission or a sentinel asks for is one Ledger holds.
    const asked = new Set([...(manifest.missions ?? []).map((m) => m.agentRole), ...CREDIT_ROLES, ...ADVISOR_ROLES]);
    for (const role of asked) expect(ledger.roles).toContain(role);
    expect(ledger.persona).toContain('{{today}}');
    expect(ledger.skills?.map((s) => s.name)).toEqual(manifest.skills?.map((s) => s.name));
  });

  it("grants Ledger this plugin's own tools and the four families it reads and writes, nothing else", () => {
    const ledger = manifest.agents![0]!;
    expect(ledger.tools).toEqual(['finance.*', 'memory.*', 'artifacts.*', 'reminder.*', 'schedule.*']);
    // The finance glob reaches exactly this plugin's tool table.
    const finance = ledger.tools.filter((t) => t.startsWith('finance.'));
    expect(finance).toEqual(['finance.*']);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.startsWith('finance.'))).toBe(true);
    for (const tool of ledger.tools) expect(tool).not.toMatch(/^(browser|host|email|mail|platform)\./);
  });

  it('declares the daily check and the Friday recap as they ship', () => {
    const ledger = manifest.agents![0]!;
    expect(ledger.missions?.map((m) => m.id)).toEqual(['daily-check', 'friday-recap']);
    for (const mission of ledger.missions ?? []) {
      const shipped = manifest.missions?.find((m) => m.id === mission.id);
      expect(mission).toMatchObject({
        name: shipped?.name,
        cron: shipped?.cron,
        prompt: shipped?.prompt,
        alwaysDeliver: shipped?.alwaysDeliver,
        misfirePolicy: shipped?.misfirePolicy,
      });
    }
    expect(ledger.missions?.find((m) => m.id === 'daily-check')?.cron).toBe('0 8 * * *');
    expect(ledger.missions?.find((m) => m.id === 'friday-recap')?.cron).toBe('0 8 * * FRI');
  });

  it('offers Ledger through a query the manifest carries', () => {
    const ledger = manifest.agents![0]!;
    expect(ledger.offer?.query).toBe(LEDGER_OFFER_QUERY);
    expect(manifest.queries?.map((q) => q.name)).toContain(LEDGER_OFFER_QUERY);
  });

  it('names no agent by id anywhere — sentinels and missions address a role', () => {
    for (const mission of manifest.missions ?? []) {
      expect(mission.agentId).toBeUndefined();
      expect(mission.agentRole).toBeTruthy();
    }
  });
});
