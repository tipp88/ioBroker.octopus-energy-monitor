# Older changes
## 0.6.3 (2026-06-11)
* (tipp88) Fixed repository compliance issues by removing custom GitHub/NPM installation instructions from README.md.
* (tipp88) Upgraded dependencies (axios to ^1.17.0, @tsconfig/node22 to ^22.0.5).

## 0.6.2 (2026-06-08)
* (tipp88) Upgraded out-of-date devDependencies (including typescript to ~6.0.3) and updated TSConfig base reference to Node 22.
* (tipp88) Adjusted CI test matrix to test Node 22 and 24 (dropping unsupported Node 20).
* (tipp88) Excluded unit test files from TypeScript typecheck scope and Fixed a time-dependent unit test bug in `main.test.js` by mocking global Date.

## 0.6.1 (2026-06-08)
* (tipp88) Fixed repository compliance issues: added missing intermediate parent folder/channel/device structures.
* (tipp88) Updated minimum Node.js engine requirement to Node 22.
* (tipp88) Upgraded out-of-date devDependencies and added Node.js 20 testing to CI matrix.
* (tipp88) Added ignore rule for `@types/node` major version updates to Dependabot.
* (tipp88) Populated missing admin configuration translation keys for all languages.

## 0.6.0 (2026-05-29)
* (tipp88) Added option to set a custom billing period start day, with automatic calculation, standard slot-split metrics, and aggregation under the dynamic `octopus.periods` tree.
* (tipp88) Implemented completeness check for billing periods: periods are only written to the object tree if all required daily data points are present in the history database.
* (tipp88) Integrated monthly standing charge (`monthlyStandingCharge`) from Kraken GraphQL API via the active tariff agreement ID, with proportional cost calculation added to both billing periods and the current calendar month.
* (tipp88) Added optional §14a EnWG price calculation support with NT/ST/HT time windows, custom grid fees, and automatic retroactive recalculation.
* (tipp88) Refactored §14a EnWG support: EnWG states are only created when setting is enabled, simplified grid fee inputs to gross/net toggle, and fixed time window configuration table columns.
* (tipp88) Moved periodic adapter run logs from info to debug level.

## 0.5.5 (2026-05-12)
* (tipp88) Fixed 'splitGoTariff' setting to enforce 'Go' tariff splitting even if the API does not provide time windows.

## 0.5.4 (2026-05-07)
* (tipp88) Activate automated release workflow with Trusted Publishing and Sentry integration.

## 0.5.3 (2026-05-07)
* (tipp88) Fix missing responsive size attributes in `jsonConfig.json` (Issue #1 follow-up).
* (tipp88) Resize SVG logo and its `viewBox` to exactly 512x512 pixels.

## 0.5.2 (2026-05-07)
* (tipp88) Add manual refresh button for Octopus devices to trigger on-demand status updates.

## 0.5.1 (2026-05-07)
* (tipp88) Fix all issues reported by ioBroker repository checker (Issue #1).

## 0.5.0 (2026-05-07)
* (tipp88) Implement Smart Charging control switch (Suspend/Resume) and dynamic device fetching via Kraken API.

## 0.4.4 (2026-05-07)
* (tipp88) Fetch and store Inexogy meter master data and current live reading.

## 0.4.3 (2026-05-07)
* (tipp88) Fixed API token expiration by implementing automatic re-login.
* (tipp88) Replaced fixed daily cron job with configurable update interval (default 60 minutes).
* (tipp88) Removed node-cron dependency.

## 0.4.2 (2026-05-05)
* (tipp88) Fixed Inexogy data syncing when Octopus data already exists.

## 0.4.1 (2026-05-05)
* (tipp88) Fixed missing meter ID in master data fetch.
* (tipp88) Fixed GraphQL variable type for meter readings (Date vs DateTime).

## 0.4.0 (2026-05-05)
* (tipp88) Implement estimated meter reading calculation based on official Kraken data.

## 0.3.2 (2026-05-05)
* (tipp88) Include dynamic slot consumption and cost in history JSON.

## 0.3.1 (2026-05-05)
* (tipp88) Fix linting errors and repository structure.

## 0.3.0 (2026-05-05)
* (tipp88) Implement dynamic tariffs, hierarchical history, and master data fetch.

## 0.2.3 (2026-05-05)
* (tipp88) Updated adapter logo and icon.

## 0.2.2 (2026-05-05)
* (tipp88) Renamed adapter to ioBroker.octopus-energy-monitor

## 0.2.1 (2026-05-05)
* (tipp88) Fixed adapter checker warnings and errors.

## 0.2.0 (2026-04-23)
* (tipp88) Added data retention setting and aggregated history JSON states.

## 0.1.0 (2026-04-23)
* (tipp88) Initial release with 30-day API cache sweep and deep property introspection.
