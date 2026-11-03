# Hosted credits

Hosted credits let an operator fund managed model calls without requiring Stripe or a customer
payment. The operator console is `/admin/credits`; web and Electron share it. Mobile users can
check their balance in Settings, while operators use the web console to administer the deployment.

## Access and rollout

Configure the existing managed model connection and credentials on the server. Set
`RAKAZO_ADMIN_EMAILS` to the operator accounts; each account must have a verified email address.
Organization ownership does not grant deployment administration. Every administration API checks
operator access on the server, including reads and reports.

Apply database migrations, then finish upgrading every API and worker before enabling hosted
credits or changing tariffs. The migration is additive and existing calls retain the default
at-cost tariff. Do not activate the new accounting behavior while old processes can settle calls.
Keep a database backup and verify the upgrade in a staging deployment first.

Hosted credits start disabled, with zero daily allowance and zero daily grant budget. Configure
the policy explicitly in the operator console. A zero budget disables automatic grants; it does
not mean unlimited funding. The budget limits credits issued, not the provider's invoice. Manual
grants and previously issued balances are separate from the automatic daily grant budget.

After the first activation, disabling the policy suspends new managed model calls. It does not
restore the legacy unmetered path. BYOK calls remain independent. API and worker processes read
the live policy when choosing funding and reserving credits.

## Credit units and model tariffs

One displayed credit represents 1,000 integer accounting micros. At the default tariff, 1,000
credits cover one US dollar of known model usage. Credits are usage units, not cash or revenue.
The database and API preserve exact integer amounts, including fractional displayed credits.
Each call rounds provider cost upward to an accounting micro, applies its multiplier, then rounds
the charge upward to a whole accounting micro. Tiny calls therefore remain chargeable.

A tariff identifies an exact provider/model pair and applies a multiplier to its metered model
cost. A multiplier of 1 charges at cost; 2 consumes twice as many credits for the same usage.
The default for models without an override is 1. Tariffs do not change the recorded provider
cost, and do not configure provider credentials, model availability, or an inference price list.

Each call reserves an upper cost estimate before inference and saves the applicable multiplier.
Settlement and recovery use that saved multiplier even if an operator changes the tariff later.
Calls whose usage cannot be established retain their reservation for reconciliation. Do not
release an unknown-cost hold by assuming the provider charged nothing.

## Funding and corrections

Operators can assign a daily allowance or an account-specific override, grant credits manually,
and remove available credits through a signed adjustment. Every change requires a reason and a
replay-safe request identifier. Retrying the same request must not change the balance twice.
Corrections append evidence to the audit history rather than deleting earlier records.

Automatic allowances use UTC days and expire at the next UTC midnight. They are allocated on
demand, so inactive accounts do not require a scheduled grant. Reservations preserve their source
lot: returning a hold after its allowance expired does not revive that allowance. Adjustments
cannot remove credits already held by in-flight calls.

Daily subsidies require a verified user and that user's canonical personal organization. Creating
additional spaces or organizations does not create additional daily entitlements. The beneficiary
receipt and deployment grant total survive organization deletion, so recreating an organization
does not reset either limit. Email verification is an eligibility gate, not a complete defense
against people creating multiple identities; deployments still need signup abuse controls.

## Cost reporting

The console compares known provider cost with charged credits and pending reservations by
provider/model over a bounded UTC date range. Missing costs are shown separately. The date range
is inclusive at the start and exclusive at the end. Grants, corrections, and expiring allowances
are financing events, not inference costs or sales.
Historical call totals come from the durable audit history and remain visible after an
organization is deleted. Available account balances exclude expired, unspent allowances.

Provider costs alone do not measure the operating margin of a hosted bot. Account separately
for sandbox compute, storage, external tools, data preparation, and actual advertising or data
licensing receipts. This feature neither collects training datasets nor integrates an advertising
network.

## Verification

The ordinary unit suite is offline. The existing integration harness runs PostgreSQL tests with
the runtime database role and row-level security:

```sh
pnpm exec tsx packages/testkit/src/cli/harness.ts --integration --spec=credits
```

The tests cover credit accounting, authorized operator actions, replay handling, daily grants,
and reporting. The admin browser journey uses the same disposable database and scripted services:

```sh
pnpm exec tsx packages/testkit/src/cli/harness.ts --e2e --spec=admin-credits
```

It opens the operator console and verifies an audited revocation through mocked RPC responses;
server authorization and financial effects are covered separately by the API/PostgreSQL suites.
Web coverage uses the existing Playwright setup; do not run the Electron E2E suite
as routine verification on a maintainer's desktop.
