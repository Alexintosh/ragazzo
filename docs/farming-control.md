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

Use **Ask team** on a page or position to prepare a message for the coordinator.
The draft carries the selected context. You can edit and send it in the
Farming Control group. Connect a supported model through the ordinary Ragazzo
model settings to receive a generated reply.

| Specialist | Available financial reads |
| --- | --- |
| Coordinator | Portfolio, Harvest, Accounting, Risk |
| Accounting | Accounting and Harvest |
| Tax | Accounting and optional tax module capabilities |
| Risk | Monitoring and Portfolio |
| Operations | Portfolio and Harvest |

Each specialist has a persistent instruction set and a built-in skill. Financial
calls use fixed GET endpoints and enforce the configured account, workspace,
role and run context on the server. Team handoffs use normal Ragazzo group
conversations. Wallet approval, accounting writes and tax filing use the
existing FC workflows.

The pages show the canonical all-wallet portfolio scope. Harvest distinguishes
current and fallback marks. Accounting shows realized amounts and costs.
Amounts retain FC's decimal strings in transport. The UI identifies unavailable
sources, incomplete valuation and the dates of observations.

If the team was archived or its membership changed, restore its five specialist
profiles and original group membership to resume the existing conversation.
Opening the financial pages and refreshing their source data work independently
of group restoration.
