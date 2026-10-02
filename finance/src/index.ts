/**
 * @buddi/tool-finance — the read-only finance plugin.
 *
 * Almost every tool is a read over plugin-owned data or a pure computation and
 * is tier `auto`. The exceptions are the ones that DESTROY or rewrite a record —
 * `finance.merge_accounts`, `finance.remove_account`,
 * `finance.update_transactions` and `finance.delete_transactions` — and the two
 * that write a batch of rows, `finance.commit_import` and `finance.import_csv`,
 * which are `gated`: the owner sees exactly what changes and what goes before
 * any of them runs. The two imports may be remembered for a conversation.
 * The plugin owns the `finance` Postgres schema and ships its own migrations;
 * core never references these tables.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest } from '@buddi/core/plugin';
import { VERSION } from './version.js';
import { financeMissions } from './missions.js';
import { financeSentinels } from './sentinels/index.js';
import { financeSkills } from './skills.js';
import { financeViews } from './views.js';
import { financeHome } from './home.js';
import { financeMetrics } from './metrics.js';
import { listAccounts, mergeAccounts, removeAccount, setBalance, updateAccount } from './tools/accounts.js';
import { spendingBaseline } from './tools/baseline.js';
import { cardActivity, statementForecastTool } from './tools/cards.js';
import {
  creditOverviewTool,
  creditPlanTool,
  creditScoreHistory,
  creditUtilization,
  paymentHistory,
  recordCreditScore,
  recordPayment,
  setCardTerms,
  upcomingStatementsTool,
} from './tools/credit.js';
import { projectCashflow } from './tools/cashflow.js';
import {
  listLiabilities,
  payoffEstimate,
  removeLiability,
  setLiability,
} from './tools/liabilities.js';
import { getPreferences, setPreferences } from './tools/preferences.js';
import { linkReceipt, listReceipts, recordReceipt } from './tools/receipts.js';
import { reconcile } from './tools/reconcile.js';
import { commitImport, discardImport, stageImport } from './tools/staging.js';
import { deleteTransactions, findTransactions, updateTransactions } from './tools/corrections.js';
import { addRecurring, listRecurring, removeRecurring } from './tools/recurring.js';
import {
  importCsv,
  recordContribution,
  recordTransaction,
  summary,
} from './tools/transactions.js';

/** Absolute path to this plugin's migrations, resolved from the built file. */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/**
 * The manifest, tools and watches together. `sentinels` is core's own optional
 * field; the intersection only says this plugin always ships some, so the
 * tests can read `manifest.sentinels` without a null check.
 */
export const manifest: PluginManifest & { sentinels: NonNullable<PluginManifest['sentinels']> } = {
  name: 'finance',
  version: VERSION,
  schema: 'finance',
  migrationsDir: MIGRATIONS_DIR,
  author: { name: 'withbuddi', url: 'https://withbuddi.com' },
  description:
    'Keeps your accounts, cards, loans, recurring charges and receipts in one place, projects your cash flow, ' +
    'and watches for a breached floor, a payment coming due and a statement closing high. Nothing leaves this computer.',
  // It talks to no host: every figure is one the owner or an agent recorded.
  network: [],
  tools: [
    setPreferences,
    getPreferences,
    setBalance,
    updateAccount,
    listAccounts,
    mergeAccounts,
    removeAccount,
    addRecurring,
    listRecurring,
    removeRecurring,
    recordTransaction,
    recordContribution,
    importCsv,
    stageImport,
    commitImport,
    discardImport,
    findTransactions,
    updateTransactions,
    deleteTransactions,
    reconcile,
    recordReceipt,
    listReceipts,
    linkReceipt,
    summary,
    spendingBaseline,
    projectCashflow,
    setLiability,
    listLiabilities,
    removeLiability,
    payoffEstimate,
    recordCreditScore,
    creditScoreHistory,
    recordPayment,
    paymentHistory,
    creditUtilization,
    creditOverviewTool,
    setCardTerms,
    creditPlanTool,
    upcomingStatementsTool,
    cardActivity,
    statementForecastTool,
  ],
  metrics: financeMetrics,
  sentinels: financeSentinels,
  skills: financeSkills,
  missions: financeMissions,
  // No agent of its own: the CFO is a catalogue agent (withbuddi.com), and an
  // owner who accepted Ledger from an earlier version keeps it. Watchers and
  // missions address roles, so they reach whoever holds them.
  views: financeViews,
  home: [financeHome],
  uses: ['files:library'],
};

export default manifest;

export {
  setPreferences,
  getPreferences,
  setBalance,
  updateAccount,
  listAccounts,
  mergeAccounts,
  removeAccount,
  addRecurring,
  listRecurring,
  removeRecurring,
  recordTransaction,
  recordContribution,
  importCsv,
  stageImport,
  commitImport,
  discardImport,
  findTransactions,
  updateTransactions,
  deleteTransactions,
  reconcile,
  recordReceipt,
  listReceipts,
  linkReceipt,
  summary,
  spendingBaseline,
  projectCashflow,
  setLiability,
  listLiabilities,
  removeLiability,
  payoffEstimate,
  recordCreditScore,
  creditScoreHistory,
  recordPayment,
  paymentHistory,
  creditUtilization,
  creditOverviewTool,
  setCardTerms,
  creditPlanTool,
  upcomingStatementsTool,
  cardActivity,
  statementForecastTool,
};

export { financeSentinels } from './sentinels/index.js';
export { financeSkills } from './skills.js';
export * from './missions.js';
export * from './sentinels/helpers.js';

export * from './accounts.js';
export * from './projection.js';
export * from './baseline.js';
export * from './amortization.js';
export * from './credit.js';
export * from './csv.js';
export * from './merchant.js';
export * from './cards.js';
export * from './metrics.js';
export { loadStatementForecast } from './tools/cards.js';
export { financeViews } from './views.js';
