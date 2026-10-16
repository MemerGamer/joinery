/**
 * Fake git history for the demo repos. Pure data: `seed.ts` turns it into real
 * repositories. Everything here is invented (names, emails at example.com).
 */

export type Person = { readonly name: string; readonly email: string };

export const PRIYA: Person = { name: 'Priya Raman', email: 'priya.raman@example.com' };
export const MARCUS: Person = { name: 'Marcus Webb', email: 'marcus.webb@example.com' };
export const SOFIA: Person = { name: 'Sofia Lindqvist', email: 'sofia.lindqvist@example.com' };
export const JOHN: Person = { name: 'John Doe', email: 'john.doe@example.com' };

/** `null` deletes the file. */
export type Files = Readonly<Record<string, string | null>>;

export type Commit = {
  readonly message: string;
  readonly author: Person;
  /** How long ago, in hours. */
  readonly hoursAgo: number;
  readonly files: Files;
};

export type Branch = {
  readonly name: string;
  readonly commits: readonly Commit[];
  /** Check the branch out in a linked worktree with this uncommitted edit applied. */
  readonly worktree?: { readonly dir: string; readonly dirty: Files };
};

export type RepoFixture = {
  readonly dir: string;
  readonly main: readonly Commit[];
  readonly branches: readonly Branch[];
};

const d = (days: number): number => days * 24;

/** A small branch with one commit, for open PRs nobody has started reviewing (the Homebase queue). */
const small = (name: string, author: Person, hoursAgo: number, path: string, body: string): Branch => ({
  name,
  commits: [{ message: name.split('/')[1]!.replace(/-/g, ' '), author, hoursAgo, files: { [path]: body } }],
});

// ---------------------------------------------------------------------------
// billing-service
// ---------------------------------------------------------------------------

const BILLING_BASE: Files = {
  'package.json': `{
  "name": "billing-service",
  "version": "1.8.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "stripe": "^17.2.0",
    "zod": "^3.23.8"
  }
}
`,
  'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
`,
  'README.md': `# billing-service

Invoices, subscriptions and payment collection for the Acme platform.

\`\`\`sh
bun install
bun run dev
\`\`\`
`,
  'src/config.ts': `import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(4100),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  DATABASE_URL: z.string().url(),
});

export const config = schema.parse(process.env);
`,
  'src/lib/logger.ts': `type Fields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

export function createLogger(scope: string): Logger {
  const write = (level: string, message: string, fields: Fields = {}): void => {
    console.log(JSON.stringify({ level, scope, message, ...fields, ts: new Date().toISOString() }));
  };
  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
`,
  'src/lib/money.ts': `export type Money = { readonly amountMinor: number; readonly currency: string };

export function money(amountMinor: number, currency = 'USD'): Money {
  return { amountMinor, currency };
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(\`currency mismatch: \${a.currency} vs \${b.currency}\`);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function formatMoney(m: Money): string {
  return \`\${(m.amountMinor / 100).toFixed(2)} \${m.currency}\`;
}
`,
  'src/invoices/types.ts': `import type { Money } from '../lib/money';

export type Plan = {
  readonly id: string;
  readonly name: string;
  readonly monthlyPrice: Money;
};

export type Subscription = {
  readonly id: string;
  readonly customerId: string;
  readonly planId: string;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
};

export type InvoiceLine = {
  readonly description: string;
  readonly amount: Money;
};

export type Invoice = {
  readonly id: string;
  readonly customerId: string;
  readonly status: 'draft' | 'open' | 'paid' | 'void';
  readonly lines: readonly InvoiceLine[];
  readonly total: Money;
  readonly createdAt: Date;
};
`,
  'src/invoices/repository.ts': `import type { Invoice, Plan, Subscription } from './types';

export interface InvoiceRepository {
  insert(invoice: Invoice): Promise<void>;
  get(id: string): Promise<Invoice | null>;
  update(invoice: Invoice): Promise<void>;
  getSubscription(id: string): Promise<Subscription | null>;
  saveSubscription(subscription: Subscription): Promise<void>;
  getPlan(id: string): Promise<Plan | null>;
}
`,
  'src/invoices/service.ts': `import { randomUUID } from 'node:crypto';
import type { PaymentGateway } from '../payments/gateway';
import { add, money } from '../lib/money';
import type { Logger } from '../lib/logger';
import type { InvoiceRepository } from './repository';
import type { Invoice, InvoiceLine } from './types';

export class InvoiceService {
  constructor(
    private readonly repo: InvoiceRepository,
    private readonly gateway: PaymentGateway,
    private readonly log: Logger,
  ) {}

  async createInvoice(customerId: string, lines: readonly InvoiceLine[]): Promise<Invoice> {
    const total = lines.reduce((sum, line) => add(sum, line.amount), money(0));
    const invoice: Invoice = {
      id: \`inv_\${randomUUID()}\`,
      customerId,
      status: 'draft',
      lines,
      total,
      createdAt: new Date(),
    };
    await this.repo.insert(invoice);
    this.log.info('invoice created', { invoiceId: invoice.id, customerId });
    return invoice;
  }

  async finalize(invoiceId: string): Promise<Invoice> {
    const invoice = await this.repo.get(invoiceId);
    if (invoice === null) throw new Error(\`invoice \${invoiceId} not found\`);
    if (invoice.status !== 'draft') return invoice;

    const open: Invoice = { ...invoice, status: 'open' };
    await this.repo.update(open);
    await this.gateway.charge(open.customerId, open.total, { idempotencyKey: open.id });
    return open;
  }

  /** Moves a subscription to another plan. The new price applies from the next period. */
  async changePlan(subscriptionId: string, newPlanId: string): Promise<void> {
    const subscription = await this.repo.getSubscription(subscriptionId);
    if (subscription === null) throw new Error(\`subscription \${subscriptionId} not found\`);
    await this.repo.saveSubscription({ ...subscription, planId: newPlanId });
    this.log.info('plan changed', { subscriptionId, newPlanId });
  }
}
`,
  'src/payments/gateway.ts': `import type { Money } from '../lib/money';

export type ChargeOptions = { readonly idempotencyKey: string };

export interface PaymentGateway {
  charge(customerId: string, amount: Money, options: ChargeOptions): Promise<{ id: string }>;
  refund(chargeId: string, amount?: Money): Promise<void>;
}
`,
  'src/payments/stripeGateway.ts': `import Stripe from 'stripe';
import { config } from '../config';
import type { Money } from '../lib/money';
import { createLogger } from '../lib/logger';
import type { ChargeOptions, PaymentGateway } from './gateway';

const log = createLogger('stripe');
const stripe = new Stripe(config.STRIPE_SECRET_KEY);

export const stripeGateway: PaymentGateway = {
  async charge(customerId: string, amount: Money, options: ChargeOptions) {
    // Retry transient failures a couple of times before giving up.
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const intent = await stripe.paymentIntents.create(
          {
            customer: customerId,
            amount: amount.amountMinor,
            currency: amount.currency.toLowerCase(),
            confirm: true,
          },
          { idempotencyKey: options.idempotencyKey },
        );
        return { id: intent.id };
      } catch (error) {
        lastError = error;
        log.warn('charge attempt failed', { attempt, customerId });
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw lastError;
  },

  async refund(chargeId: string, amount?: Money) {
    await stripe.refunds.create({
      payment_intent: chargeId,
      ...(amount === undefined ? {} : { amount: amount.amountMinor }),
    });
  },
};
`,
  'src/payments/webhook.ts': `import { createHmac } from 'node:crypto';
import { config } from '../config';

export type WebhookEvent = { readonly id: string; readonly type: string; readonly data: unknown };

/** Verifies a \`t=<unix>,v1=<hex>\` signature header against the raw request body. */
export function verifyWebhook(rawBody: string, header: string): WebhookEvent {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const expected = createHmac('sha256', config.STRIPE_WEBHOOK_SECRET)
    .update(\`\${parts['t']}.\${rawBody}\`)
    .digest('hex');
  if (parts['v1'] !== expected) throw new Error('invalid webhook signature');
  return JSON.parse(rawBody) as WebhookEvent;
}
`,
  'src/http/routes.ts': `import { Hono } from 'hono';
import { z } from 'zod';
import { formatMoney, money } from '../lib/money';
import type { InvoiceService } from '../invoices/service';
import { verifyWebhook } from '../payments/webhook';

const createInvoiceBody = z.object({
  customerId: z.string(),
  lines: z.array(z.object({ description: z.string(), amountMinor: z.number().int(), currency: z.string() })),
});

export function routes(invoices: InvoiceService): Hono {
  const app = new Hono();

  app.post('/invoices', async (c) => {
    const body = createInvoiceBody.parse(await c.req.json());
    const invoice = await invoices.createInvoice(
      body.customerId,
      body.lines.map((l) => ({ description: l.description, amount: money(l.amountMinor, l.currency) })),
    );
    return c.json({ id: invoice.id, total: formatMoney(invoice.total) }, 201);
  });

  app.post('/invoices/:id/finalize', async (c) => {
    const invoice = await invoices.finalize(c.req.param('id'));
    return c.json({ id: invoice.id, status: invoice.status });
  });

  app.post('/webhooks/stripe', async (c) => {
    const event = verifyWebhook(await c.req.text(), c.req.header('stripe-signature') ?? '');
    return c.json({ received: true, id: event.id });
  });

  return app;
}
`,
  'src/index.ts': `import { config } from './config';
import { routes } from './http/routes';
import { InvoiceService } from './invoices/service';
import { createLogger } from './lib/logger';
import { stripeGateway } from './payments/stripeGateway';
import { createPgRepository } from './db/client';

const log = createLogger('server');
const service = new InvoiceService(createPgRepository(config.DATABASE_URL), stripeGateway, log);

Bun.serve({ port: config.PORT, fetch: routes(service).fetch });
log.info('billing-service listening', { port: config.PORT });
`,
  'src/db/client.ts': `import type { InvoiceRepository } from '../invoices/repository';

export function createPgRepository(_url: string): InvoiceRepository {
  throw new Error('not wired in this checkout');
}
`,
  'test/invoices.test.ts': `import { expect, test } from 'bun:test';
import { add, formatMoney, money } from '../src/lib/money';

test('add sums minor units', () => {
  expect(add(money(1250), money(399)).amountMinor).toBe(1649);
});

test('formatMoney renders two decimals', () => {
  expect(formatMoney(money(1250))).toBe('12.50 USD');
});
`,
};

const PRORATION_TS = `import { allocate } from '../lib/allocate';
import { money, type Money } from '../lib/currency';
import type { Plan } from '../invoices/types';

export type Proration = {
  /** Credit for the unused part of the old plan (negative or zero). */
  readonly credit: Money;
  /** Charge for the remaining part of the period on the new plan. */
  readonly charge: Money;
  /** Fraction of the period still ahead of \`now\`, 0..1. */
  readonly remaining: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Prorates a mid-period plan change by whole days: the customer is credited for
 * the unused days of the old plan and charged for the same days on the new one.
 */
export function prorate(from: Plan, to: Plan, periodStart: Date, periodEnd: Date, now: Date): Proration {
  const totalDays = Math.round((periodEnd.getTime() - periodStart.getTime()) / DAY_MS);
  const clampedNow = Math.min(Math.max(now.getTime(), periodStart.getTime()), periodEnd.getTime());
  const daysLeft = Math.ceil((periodEnd.getTime() - clampedNow) / DAY_MS);
  const remaining = totalDays === 0 ? 0 : daysLeft / totalDays;

  const unused = Math.round(from.monthlyPrice.amountMinor * remaining);
  const upcoming = Math.round(to.monthlyPrice.amountMinor * remaining);

  return {
    credit: money(-unused, from.monthlyPrice.currency),
    charge: money(upcoming, to.monthlyPrice.currency),
    remaining,
  };
}

/** Splits a prorated amount over \`parts\` invoices without losing a cent. */
export function spread(amount: Money, parts: number): Money[] {
  return allocate(amount, Array.from({ length: parts }, () => 1));
}
`;

const CURRENCY_TS = `export type Money = { readonly amountMinor: number; readonly currency: string };

export function money(amountMinor: number, currency = 'USD'): Money {
  return { amountMinor, currency };
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(\`currency mismatch: \${a.currency} vs \${b.currency}\`);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function formatMoney(m: Money, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency }).format(m.amountMinor / 100);
}
`;

const ALLOCATE_TS = `import { money, type Money } from './currency';

/**
 * Splits \`m\` proportionally to \`ratios\`. Remainder cents go to the first
 * buckets so the parts always add back up to \`m\`.
 */
export function allocate(m: Money, ratios: readonly number[]): Money[] {
  const total = ratios.reduce((a, b) => a + b, 0);
  if (total === 0) throw new Error('ratios must not sum to zero');
  const shares = ratios.map((r) => Math.trunc((m.amountMinor * r) / total));
  let remainder = m.amountMinor - shares.reduce((a, b) => a + b, 0);
  const step = remainder > 0 ? 1 : -1;
  for (let i = 0; remainder !== 0; i = (i + 1) % shares.length) {
    shares[i] = (shares[i] ?? 0) + step;
    remainder -= step;
  }
  return shares.map((s) => money(s, m.currency));
}
`;

const SERVICE_PRORATED = (BILLING_BASE['src/invoices/service.ts'] as string)
  .replace(
    "import { add, money } from '../lib/money';",
    "import { prorate } from '../billing/proration';\nimport { add, money } from '../lib/currency';",
  )
  .replace(
    /  \/\*\* Moves a subscription[\s\S]*$/,
    `  /**
   * Moves a subscription to another plan. The change takes effect immediately:
   * the unused part of the old plan is credited and the rest of the period on
   * the new plan is invoiced.
   */
  async changePlan(subscriptionId: string, newPlanId: string, now = new Date()): Promise<Invoice | null> {
    const subscription = await this.repo.getSubscription(subscriptionId);
    if (subscription === null) throw new Error(\`subscription \${subscriptionId} not found\`);
    if (subscription.planId === newPlanId) return null;

    const [from, to] = await Promise.all([this.repo.getPlan(subscription.planId), this.repo.getPlan(newPlanId)]);
    if (from === null || to === null) throw new Error('unknown plan');

    const proration = prorate(from, to, subscription.currentPeriodStart, subscription.currentPeriodEnd, now);
    await this.repo.saveSubscription({ ...subscription, planId: newPlanId });

    const invoice = await this.createInvoice(subscription.customerId, [
      { description: \`Unused time on \${from.name}\`, amount: proration.credit },
      { description: \`Remaining time on \${to.name}\`, amount: proration.charge },
    ]);
    this.log.info('plan changed', { subscriptionId, newPlanId, remaining: proration.remaining });
    return invoice.total.amountMinor > 0 ? this.finalize(invoice.id) : invoice;
  }
}
`,
  )
  // `.replace` with a string only touches the first match, which is what we want.
  .replace("from '../lib/money'", "from '../lib/currency'");

const RETRY_TS = `import type { Logger } from './logger';

export type RetryOptions = {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Return false to fail fast on errors that will not get better by waiting. */
  readonly shouldRetry?: (error: unknown) => boolean;
  readonly log?: Logger;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs \`fn\`, retrying with exponential backoff and full jitter. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 4, baseDelayMs = 150, maxDelayMs = 4_000, shouldRetry = () => true, log } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !shouldRetry(error)) break;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delay = Math.random() * ceiling;
      log?.warn('retrying after failure', { attempt, delayMs: Math.round(delay) });
      await sleep(delay);
    }
  }
  throw lastError;
}
`;

export const BILLING: RepoFixture = {
  dir: 'billing-service',
  main: [
    {
      message: 'Scaffold billing-service with Hono and Stripe',
      author: PRIYA,
      hoursAgo: d(34),
      files: {
        'package.json': BILLING_BASE['package.json'] as string,
        'tsconfig.json': BILLING_BASE['tsconfig.json'] as string,
        'README.md': BILLING_BASE['README.md'] as string,
        'src/config.ts': BILLING_BASE['src/config.ts'] as string,
        'src/index.ts': BILLING_BASE['src/index.ts'] as string,
        'src/db/client.ts': BILLING_BASE['src/db/client.ts'] as string,
      },
    },
    {
      message: 'Add invoice model, repository interface and service',
      author: PRIYA,
      hoursAgo: d(28),
      files: {
        'src/invoices/types.ts': BILLING_BASE['src/invoices/types.ts'] as string,
        'src/invoices/repository.ts': BILLING_BASE['src/invoices/repository.ts'] as string,
        'src/invoices/service.ts': BILLING_BASE['src/invoices/service.ts'] as string,
        'src/lib/money.ts': BILLING_BASE['src/lib/money.ts'] as string,
        'src/lib/logger.ts': BILLING_BASE['src/lib/logger.ts'] as string,
        'test/invoices.test.ts': BILLING_BASE['test/invoices.test.ts'] as string,
      },
    },
    {
      message: 'Charge invoices through a Stripe payment gateway',
      author: MARCUS,
      hoursAgo: d(21),
      files: {
        'src/payments/gateway.ts': BILLING_BASE['src/payments/gateway.ts'] as string,
        'src/payments/stripeGateway.ts': BILLING_BASE['src/payments/stripeGateway.ts'] as string,
      },
    },
    {
      message: 'Expose invoice routes and the Stripe webhook endpoint',
      author: MARCUS,
      hoursAgo: d(14),
      files: {
        'src/http/routes.ts': BILLING_BASE['src/http/routes.ts'] as string,
        'src/payments/webhook.ts': BILLING_BASE['src/payments/webhook.ts'] as string,
      },
    },
  ],
  branches: [
    small('feat/invoice-pdf-export', MARCUS, 5, 'src/invoices/pdf.ts', "export const invoiceFileName = (id: string): string => `invoice-${id}.pdf`;\n"),
    small('fix/tax-rounding-eu', SOFIA, 14, 'src/billing/tax.ts', 'export const roundTax = (cents: number): number => Math.round(cents);\n'),
    small('chore/bump-stripe-sdk', PRIYA, 40, 'src/payments/sdkVersion.ts', "export const STRIPE_API_VERSION = '2025-02-24';\n"),
    {
      name: 'feat/prorate-plan-changes',
      commits: [
        {
          message: 'Rename lib/money to lib/currency, add allocate() and Intl formatting',
          author: SOFIA,
          hoursAgo: d(3) + 6,
          files: {
            'src/lib/money.ts': null,
            'src/lib/currency.ts': CURRENCY_TS,
            'src/lib/allocate.ts': ALLOCATE_TS,
            'src/invoices/types.ts': (BILLING_BASE['src/invoices/types.ts'] as string).replace('../lib/money', '../lib/currency'),
            'src/payments/gateway.ts': (BILLING_BASE['src/payments/gateway.ts'] as string).replace('../lib/money', '../lib/currency'),
            'src/payments/stripeGateway.ts': (BILLING_BASE['src/payments/stripeGateway.ts'] as string).replace('../lib/money', '../lib/currency'),
            'src/http/routes.ts': (BILLING_BASE['src/http/routes.ts'] as string).replace('../lib/money', '../lib/currency'),
            'test/invoices.test.ts': (BILLING_BASE['test/invoices.test.ts'] as string)
              .replace('../src/lib/money', '../src/lib/currency')
              .replace("toBe('12.50 USD')", "toBe('$12.50')"),
          },
        },
        {
          message: 'Prorate plan changes by remaining days in the period',
          author: SOFIA,
          hoursAgo: d(2) + 3,
          files: {
            'src/billing/proration.ts': PRORATION_TS,
            'src/invoices/service.ts': SERVICE_PRORATED,
          },
        },
        {
          message: 'Add POST /subscriptions/:id/plan and proration tests',
          author: SOFIA,
          hoursAgo: 5,
          files: {
            'src/http/routes.ts': (BILLING_BASE['src/http/routes.ts'] as string)
              .replace('../lib/money', '../lib/currency')
              .replace(
                "  app.post('/webhooks/stripe'",
                `  app.post('/subscriptions/:id/plan', async (c) => {
    const { planId } = z.object({ planId: z.string() }).parse(await c.req.json());
    const invoice = await invoices.changePlan(c.req.param('id'), planId);
    return c.json({ invoiceId: invoice?.id ?? null, total: invoice === null ? null : formatMoney(invoice.total) });
  });

  app.post('/webhooks/stripe'`,
              ),
            'test/proration.test.ts': `import { expect, test } from 'bun:test';
import { prorate } from '../src/billing/proration';
import { money } from '../src/lib/currency';

const starter = { id: 'starter', name: 'Starter', monthlyPrice: money(3000) };
const growth = { id: 'growth', name: 'Growth', monthlyPrice: money(9000) };
const start = new Date('2026-03-01T00:00:00Z');
const end = new Date('2026-03-31T00:00:00Z');

test('halfway through the period credits half of the old plan', () => {
  const p = prorate(starter, growth, start, end, new Date('2026-03-16T00:00:00Z'));
  expect(p.credit.amountMinor).toBe(-1500);
  expect(p.charge.amountMinor).toBe(4500);
});

test('a change after the period end prorates nothing', () => {
  const p = prorate(starter, growth, start, end, new Date('2026-04-02T00:00:00Z'));
  expect(p.remaining).toBe(0);
});
`,
          },
        },
      ],
    },
    {
      name: 'fix/webhook-signature-replay',
      commits: [
        {
          message: 'Reject stale Stripe webhooks and compare signatures in constant time',
          author: MARCUS,
          hoursAgo: d(1) + 4,
          files: {
            'src/payments/webhook.ts': `import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

export type WebhookEvent = { readonly id: string; readonly type: string; readonly data: unknown };

/** Events older than this are treated as replays. Stripe's own libraries default to five minutes. */
const TOLERANCE_SECONDS = 300;

/** Verifies a \`t=<unix>,v1=<hex>\` signature header against the raw request body. */
export function verifyWebhook(rawBody: string, header: string, nowSeconds = Math.floor(Date.now() / 1000)): WebhookEvent {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const timestamp = Number(parts['t']);
  const signature = parts['v1'];
  if (!Number.isFinite(timestamp) || signature === undefined) throw new Error('malformed webhook signature header');
  if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) throw new Error('webhook timestamp outside tolerance');

  const expected = createHmac('sha256', config.STRIPE_WEBHOOK_SECRET).update(\`\${timestamp}.\${rawBody}\`).digest();
  const given = Buffer.from(signature, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error('invalid webhook signature');
  }
  return JSON.parse(rawBody) as WebhookEvent;
}
`,
          },
        },
        {
          message: 'Return 400 instead of 500 for rejected webhooks',
          author: MARCUS,
          hoursAgo: d(1),
          files: {
            'src/http/routes.ts': (BILLING_BASE['src/http/routes.ts'] as string).replace(
              "    const event = verifyWebhook(await c.req.text(), c.req.header('stripe-signature') ?? '');\n    return c.json({ received: true, id: event.id });",
              `    try {
      const event = verifyWebhook(await c.req.text(), c.req.header('stripe-signature') ?? '');
      return c.json({ received: true, id: event.id });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'rejected' }, 400);
    }`,
            ),
          },
        },
      ],
    },
    {
      name: 'refactor/retry-with-backoff',
      commits: [
        {
          message: 'Extract withRetry helper with exponential backoff and jitter',
          author: PRIYA,
          hoursAgo: 30,
          files: { 'src/lib/retry.ts': RETRY_TS },
        },
        {
          message: 'Use withRetry in the Stripe gateway',
          author: PRIYA,
          hoursAgo: 28,
          files: {
            'src/payments/stripeGateway.ts': `import Stripe from 'stripe';
import { config } from '../config';
import type { Money } from '../lib/money';
import { createLogger } from '../lib/logger';
import { withRetry } from '../lib/retry';
import type { ChargeOptions, PaymentGateway } from './gateway';

const log = createLogger('stripe');
const stripe = new Stripe(config.STRIPE_SECRET_KEY);

/** Card declines and invalid requests are final; only network and 5xx errors are worth another try. */
const isTransient = (error: unknown): boolean =>
  error instanceof Stripe.errors.StripeConnectionError || error instanceof Stripe.errors.StripeAPIError;

export const stripeGateway: PaymentGateway = {
  async charge(customerId: string, amount: Money, options: ChargeOptions) {
    return withRetry(
      async () => {
        const intent = await stripe.paymentIntents.create(
          {
            customer: customerId,
            amount: amount.amountMinor,
            currency: amount.currency.toLowerCase(),
            confirm: true,
          },
          { idempotencyKey: options.idempotencyKey },
        );
        return { id: intent.id };
      },
      { shouldRetry: isTransient, log },
    );
  },

  async refund(chargeId: string, amount?: Money) {
    await withRetry(
      () =>
        stripe.refunds.create({
          payment_intent: chargeId,
          ...(amount === undefined ? {} : { amount: amount.amountMinor }),
        }),
      { shouldRetry: isTransient, log },
    );
  },
};
`,
          },
        },
      ],
    },
    {
      name: 'feat/dunning-emails',
      commits: [
        {
          message: 'Sketch dunning schedule for failed payments',
          author: JOHN,
          hoursAgo: 52,
          files: {
            'src/dunning/schedule.ts': `export type DunningStep = { readonly afterDays: number; readonly template: 'reminder' | 'final-notice' | 'suspend' };

/** Days after the first failed charge at which we nudge the customer. */
export const DUNNING_SCHEDULE: readonly DunningStep[] = [
  { afterDays: 1, template: 'reminder' },
  { afterDays: 5, template: 'reminder' },
  { afterDays: 12, template: 'final-notice' },
];

export function nextStep(daysSinceFailure: number, sent: number): DunningStep | null {
  const step = DUNNING_SCHEDULE[sent];
  return step !== undefined && daysSinceFailure >= step.afterDays ? step : null;
}
`,
            'src/dunning/mailer.ts': `import type { Logger } from '../lib/logger';
import type { DunningStep } from './schedule';

export interface Mailer {
  send(to: string, template: DunningStep['template'], vars: Record<string, string>): Promise<void>;
}

export async function sendDunning(mailer: Mailer, log: Logger, to: string, step: DunningStep, invoiceId: string): Promise<void> {
  await mailer.send(to, step.template, { invoiceId });
  log.info('dunning email sent', { to, template: step.template, invoiceId });
}
`,
          },
        },
      ],
      worktree: {
        dir: 'billing-service-dunning',
        dirty: {
          'src/dunning/schedule.ts': `export type DunningStep = { readonly afterDays: number; readonly template: 'reminder' | 'final-notice' | 'suspend' };

/** Days after the first failed charge at which we nudge the customer. */
export const DUNNING_SCHEDULE: readonly DunningStep[] = [
  { afterDays: 1, template: 'reminder' },
  { afterDays: 5, template: 'reminder' },
  { afterDays: 12, template: 'final-notice' },
  { afterDays: 21, template: 'suspend' },
];

export function nextStep(daysSinceFailure: number, sent: number): DunningStep | null {
  const step = DUNNING_SCHEDULE[sent];
  return step !== undefined && daysSinceFailure >= step.afterDays ? step : null;
}
`,
        },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// storefront-web
// ---------------------------------------------------------------------------

const STORE_BASE: Files = {
  'package.json': `{
  "name": "storefront-web",
  "version": "0.9.0",
  "private": true,
  "type": "module",
  "dependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" }
}
`,
  'src/cart/store.ts': `import { useSyncExternalStore } from 'react';

export type CartItem = { readonly sku: string; readonly name: string; readonly priceCents: number; readonly qty: number };

let items: readonly CartItem[] = [];
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export function addItem(item: Omit<CartItem, 'qty'>): void {
  const existing = items.find((i) => i.sku === item.sku);
  items = existing
    ? items.map((i) => (i.sku === item.sku ? { ...i, qty: i.qty + 1 } : i))
    : [...items, { ...item, qty: 1 }];
  emit();
}

export function useCart(): readonly CartItem[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => items,
  );
}
`,
  'src/components/Header.tsx': `import { useCart } from '../cart/store';

export function Header() {
  const items = useCart();
  const count = items.reduce((n, i) => n + i.qty, 0);
  return (
    <header className="flex items-center justify-between border-b px-6 py-4">
      <a href="/" className="text-lg font-semibold">Lumen Goods</a>
      <span aria-label="Cart">Cart ({count})</span>
    </header>
  );
}
`,
};

export const STOREFRONT: RepoFixture = {
  dir: 'storefront-web',
  main: [
    {
      message: 'Initial storefront with header and cart store',
      author: SOFIA,
      hoursAgo: d(19),
      files: STORE_BASE,
    },
  ],
  branches: [
    small('feat/wishlist-sharing', MARCUS, 9, 'src/wishlist/share.ts', "export const shareUrl = (id: string): string => `https://shop.example.com/w/${id}`;\n"),
    small('fix/checkout-focus-ring', SOFIA, 26, 'src/styles/focus.css', ':focus-visible {\n  outline: 2px solid #4f46e5;\n  outline-offset: 2px;\n}\n'),
    {
      name: 'feat/cart-drawer',
      commits: [
        {
          message: 'Add slide-over cart drawer',
          author: JOHN,
          hoursAgo: 20,
          files: {
            'src/cart/store.ts': (STORE_BASE['src/cart/store.ts'] as string).replace(
              'export function useCart()',
              `export function removeItem(sku: string): void {
  items = items.filter((i) => i.sku !== sku);
  emit();
}

export const cartTotalCents = (cart: readonly CartItem[]): number =>
  cart.reduce((sum, i) => sum + i.priceCents * i.qty, 0);

export function useCart()`,
            ),
            'src/components/CartDrawer.tsx': `import { cartTotalCents, removeItem, useCart } from '../cart/store';

export function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const items = useCart();
  if (!open) return null;
  return (
    <aside role="dialog" aria-label="Shopping cart" className="fixed inset-y-0 right-0 w-96 bg-white p-6 shadow-xl">
      <button onClick={onClose} className="mb-4 text-sm text-gray-500">Close</button>
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.sku} className="flex justify-between">
            <span>{item.name} x{item.qty}</span>
            <button onClick={() => removeItem(item.sku)}>Remove</button>
          </li>
        ))}
      </ul>
      <p className="mt-6 font-medium">Total: \${(cartTotalCents(items) / 100).toFixed(2)}</p>
    </aside>
  );
}
`,
            'src/components/Header.tsx': (STORE_BASE['src/components/Header.tsx'] as string)
              .replace("import { useCart } from '../cart/store';", "import { useState } from 'react';\nimport { useCart } from '../cart/store';\nimport { CartDrawer } from './CartDrawer';")
              .replace('  const count', '  const [open, setOpen] = useState(false);\n  const count')
              .replace(
                '<span aria-label="Cart">Cart ({count})</span>',
                '<button onClick={() => setOpen(true)} aria-label="Open cart">Cart ({count})</button>\n      <CartDrawer open={open} onClose={() => setOpen(false)} />',
              ),
          },
        },
      ],
    },
  ],
};
