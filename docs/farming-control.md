# Farming Control

Connect this branch to a running Farming Control instance to open Portfolio, Harvest,
Risk and Accounting inside the Ragazzo workspace. Both the pages and the five
specialists use the same read-only FC client. The integration also works in the
web shell hosted by Electron.

## Connect a personal workspace

1. Start the ordinary Ragazzo instance and sign in with the intended account.
   The local account session at `/api/auth/get-session` identifies its immutable
   `user.id`. Keep the session response private.
2. Set `FARMING_CONTROL_OWNER_USER_ID` to that ID and `FARMING_CONTROL_API_URL`
   to the private FC HTTP origin reachable from the Ragazzo API and worker.
   For host development, use the loopback origin of the running FC API.
3. Restart Ragazzo with these two settings. Open `/app/farming/portfolio`
   in the account's private Personal space. The first visit provisions the
   team. Later visits reopen its existing group and specialists.

Source-hosted development uses the existing checkout commands in the README.
The Compose manifests forward both settings to the server processes. Container
loopback addresses identify the container itself. For Docker Desktop, verify
that the FC origin is reachable from the Ragazzo service before using a host
alias in its configuration. FC can stay on its own host runtime and database.

## Using the team

Use **Ask team** on a page to prepare a message for the coordinator.
The draft carries the selected context. You can edit and send it in the
Farming Control group. Connect a supported model through the ordinary Ragazzo
model settings to receive a generated reply.

**Mention to agent** on a Risk card opens the FC Risk direct chat with a tag
for that exposure. From a signal's detail view the tag also identifies the
signal. Type your question beside the tag and send it when ready. You can
remove a tag or add another card to the same draft.

The tag identifies the monitor by its stable exposure ID. FC Risk uses that
reference to read the current evidence and linked positions within the
account's visible wallet scope. The card chooses the specialist by role, so
renaming the specialist preserves the same conversation.

Type `@` in the FC Coordinator chat to search visible positions, wallets,
protocols and monitored exposures. Pick a suggestion and add your question.
Position, wallet and protocol tags also work with Operations and Risk. Monitor
tags use the Risk tool in chats with that grant. From a position's detail view,
you can also mention the position or one of its linked wallets or protocols.

A selected tag carries the entity kind and stable ID. Typing a name without
selecting a suggestion leaves it as text. In either case you can ask about a
position. Specialists with portfolio access search the visible catalog for a
newly typed name, including a Safe suffix, and read the matching position.
They can ask you to distinguish similar matches. Earlier tags remain available
for follow-up questions about the same subject.

For a question about how yield changed, the Coordinator, Operations and Risk
can call `farming_control_position_history` with the selected position ID.
It defaults to the period since opening. A confirmed opening, an earlier
deposit reference and the start of tracking are labelled separately. The
history shows dated rates, monthly first and last observations, comparable
extremes and coverage. A seven-day lookback on a provider quote describes
that single quote even when the series spans months.

The same read reports earned contributions and confirmed Harvest in separate
fields. When the full-period accrual has no baseline, supported calendar
months remain visible alongside the gaps. Clients can use the authenticated
`farmingControl.positionHistory` RPC for the detailed series.

Wallet reads identify linked positions. The wallet inventory records current
links and does not establish who owned a historical position mark.

| Specialist | Available financial reads |
| --- | --- |
| Coordinator | Portfolio, Harvest, Accounting, Risk |
| Accounting | Accounting and Harvest |
| Tax | Accounting and optional tax module capabilities |
| Risk | Monitoring and Portfolio |
| Operations | Portfolio and Harvest |

Each specialist has an editable profile and a deployment-provided role skill.
The skills adapt the read workflows from Farming Control Operations, Monitoring
and Cash-out/Tax to each specialist's granted tools. Opening the team updates
these skills on existing installations. The worker also supplies the applicable
workflow on each specialist run. Financial calls use fixed GET endpoints and
enforce the configured account, workspace,
role and run context on the server. Team handoffs use normal Ragazzo group
conversations. Wallet approval, accounting writes and tax filing use the
existing FC workflows.

Portfolio uses the wallet visibility saved in Farming Control. The Asset Set
selector requests that set's positions and active-capital totals from FC. The
positions table starts with active positions ordered by value. Select a column
heading to sort by value, annual rate or projected 30-day yield. APR and APY
retain their source rate type. The 30-day yield is FC's projection in USD.

The all-sets chart reads saved portfolio valuations for the same wallet scope.
It plots the latest available observation per UTC day plus the first and last
observations in each fetched window. Open the observations to inspect their
timestamps and values. FC currently supplies this history at portfolio level.
Selecting an Asset Set shows the set's current metrics and a history
availability message.

Risk groups monitored exposure by pool, market or vault. The Curve and Morpho
read models provide the signal statuses, and the saved wallet scope determines
which active holdings appear as linked positions. The gauge marks the most
severe observed signal. Its coverage label distinguishes partial evidence, and
a neutral gauge identifies subjects without a current assessment. A green
withdrawal or utilization reading applies to that specific check. Selecting a
signal shows its evidence and prepares its context for FC Risk. The specialists
can still look up monitor diagnostics through the existing Risk tool.

For a Morpho card, FC Risk receives the monitor state, the timestamp and block
of its accepted observation, and the amounts or ratios the source measured.
When a current observation is unavailable, the specialist can report the last
accepted observation returned in the requested history window, with its date.
Only current assessments determine the gauge.

Harvest distinguishes current and fallback marks. Accounting shows realized
amounts and costs. Amounts retain FC's decimal strings in transport. Source
details identify unavailable data, incomplete valuation and observation dates.

If the team was archived or its membership changed, restore its five specialist
profiles and original group membership to resume the existing conversation.
Opening the financial pages and refreshing their source data work independently
of group restoration.


## Verify a specialist conversation

Use the pilot Coordinator and two visible positions with similar names. Select
the first suggestion and ask what it earned. Paste the full name of the second
position as plain text in a follow-up. Check that the reply identifies the
second position and its lifecycle. Ask what was attached: the bot should
distinguish a selected ID from a name it found through search. Then select the
second chip and compare the bot’s earnings window, proceeds, units and rate
coverage with the same position in FC. In the run activity, look for
`farming_control_find` on the plain-text turn and `farming_control_entity` on
the matched position. A stored chip alone only verifies message transport.
