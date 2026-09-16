# PostHog Self-driving setup report

## Summary

PostHog Self-driving is configured for the GIDEON web application. Session Replay, Error Tracking, and Support were enabled, alongside health, error, and support signal sources; the active scout troop and two Replay Vision monitors will start producing findings as data arrives.

Findings will begin appearing in the [Self-driving inbox](https://us.posthog.com/project/609740/inbox) within about 30 minutes.

## AI data processing

Approved by the wizard’s organization-level gate before this setup began.

## GitHub

The PostHog GitHub App was already connected before this run. GitHub Issues was not selected as a Self-driving source.

## Products enabled

| Product | Result | Notes |
| --- | --- | --- |
| Session Replay | enabled | This is a web app with `posthog-js`; the existing client configuration does not disable recording. No recordings existed at setup time. |
| Error Tracking | enabled | The existing client configuration has `capture_exceptions: true`; no override was required. |
| Support | enabled | Tickets will begin arriving only after an inbound email, inbox, or Slack channel is connected in PostHog. |

## Signal sources

| Signal source | Action | Notes |
| --- | --- | --- |
| `health_checks` / `health_issue` | enabled | Source config `01a0a410-5efb-7672-82d5-93b7faa49271`. |
| `error_tracking` / `issue_created` | enabled | Source config `01a0a410-5f7b-7e21-a449-34841ac858f8`. |
| `error_tracking` / `issue_reopened` | enabled | Source config `01a0a410-5f5b-7a4c-bd50-8646e50d22cd`. |
| `error_tracking` / `issue_spiking` | enabled | Source config `01a0a410-5fdf-78f0-99c1-c11dae33e203`. |
| `conversations` / `ticket` | enabled | Source config `01a0a410-5f68-760e-8e42-6531e8d17a3f`; remains idle until a support channel is connected. |
| `signals_scout` / `cross_source_issue` | on by default | No row is needed; no earlier opt-out existed. |
| Replay Vision | enabled through scanners | The two configured scanners are the source configuration; no separate responder row was created. |

## Connected tools

No external connected-tool responder was selected. No GitHub Issues, Linear, Jira, Sentry, or Zendesk responder was enabled.

## Scout troop

Six of 29 scouts are active, leaving 23 disabled. The enforced budget is **100 runs per day**; **0** had been used when checked, with **100** remaining. The project is enrolled in early access; the current banner says: “Scouts are in early access. Each project gets up to 100 scout runs a day. Contact team-self-driving@posthog.com if you need more.”

### Active scouts

| Scout | Why it is active |
| --- | --- |
| `signals-scout-general` | Correlates cross-product changes and covers unspecialized surfaces. |
| `signals-scout-product-analytics` | Covers product-flow and derived-rate regressions. |
| `signals-scout-ai-observability` | Covers LLM cost, latency, errors, volume, and evaluation behavior. |
| `signals-scout-health-checks` | Prioritizes actionable PostHog setup-health issues. |
| `signals-scout-conversation-availability` | Custom GIDEON monitor for sustained drops in conversation starts per active session. |
| `signals-scout-voice-loop-health` | Custom GIDEON monitor for persistent imbalance across transcription, AI responses, and speech playback. |

### Disabled scouts

| Scout | Reason |
| --- | --- |
| `signals-scout-anomaly-detection` | No established dashboard or insight baseline was found. |
| `signals-scout-apm` | No APM or OpenTelemetry evidence was found. |
| `signals-scout-conversations` | Support tickets are covered by the native Support signal source. |
| `signals-scout-csp-violations` | No PostHog CSP reporting was found. |
| `signals-scout-customer-analytics` | No account/group analytics evidence was found. |
| `signals-scout-data-pipelines` | No CDP or export pipeline evidence was found. |
| `signals-scout-data-warehouse` | No warehouse source was selected or detected. |
| `signals-scout-error-tracking` | Error Tracking is covered by its native source. |
| `signals-scout-experiments` | No active experiments were found. |
| `signals-scout-feature-flags` | No active feature-flag usage was found. |
| `signals-scout-inbox-validation` | This fresh setup has no resolved Self-driving reports to validate. |
| `signals-scout-insight-alerts` | No insight-alert activity was established. |
| `signals-scout-logs` | No PostHog Logs usage was found. |
| `signals-scout-mcp-tool-calls` | No relevant product-side MCP telemetry was established. |
| `signals-scout-observability-gaps` | A focused product and health baseline was preferred for this fresh project. |
| `signals-scout-replay-vision` | The aggregate scanner analyst remains off until scanner observations accumulate. |
| `signals-scout-revenue-analytics` | No payment or revenue surface was found. |
| `signals-scout-session-replay` | Session Replay is covered by the Replay Vision scanners below. |
| `signals-scout-skills-store` | No skills-store hygiene surface was selected. |
| `signals-scout-surveys` | No surveys were found. |
| `signals-scout-tasks` | No PostHog Tasks usage was established. |
| `signals-scout-web-analytics` | No web-analytics traffic or attribution surface was established. |
| `signals-scout-web-vitals` | No web-vitals surface was established. |

## Custom scouts

| Scout | Coverage and discriminator | Why it is distinct |
| --- | --- | --- |
| `signals-scout-conversation-availability` | Watches the ratio of conversation-start requests to active sessions and reports only sustained, broad-reach drops. | The general scout is broad; this provides a dedicated liveness check for GIDEON’s primary conversation entry point. |
| `signals-scout-voice-loop-health` | Watches persistent shifts in the relative activity of transcription, AI responses, and speech playback. | It isolates breakage in the hands-free loop that generic product analytics may not distinguish. |

The user approved both proposed custom scouts; none were declined. If either proves noisy, set its config’s `emit` value to `false` in PostHog to switch it to dry-run mode.

## Replay Vision scanners

A scanner is an LLM that watches individual session recordings on a schedule and pushes qualifying defects to the Self-driving inbox. These are the only items in this setup that spend Replay Vision quota. Scanner findings arrive at half weight, so corroboration is required before they are promoted into an inbox report.

| Scanner | Status | Scope and purpose | Sampling | Estimate |
| --- | --- | --- | --- | --- |
| **GIDEON conversation breakage** | created | URL path `/`, the product’s primary conversation flow. Watches visible microphone, caption, response, card, playback, and control failures. | 0.5 | 0 observations and 0 credits/month from the current 7-day estimate. |
| **GIDEON voice frustration** | created | Sessions containing `$rageclick` only; watches visible struggle with microphone activation, voice controls, retrying, and missing responses. | 1.0 | 0 observations and 0 credits/month from the current 7-day estimate. |

The Replay Vision budget has 2,500 credits remaining, is not exhausted, and has no projected spend. No recordings existed during setup, so both scanners are armed and will begin working when recordings arrive.

## Follow-ups

- [ ] Connect an inbound Support channel (email, inbox, or Slack) in PostHog so the enabled Support responder can receive tickets.
- [ ] Generate or wait for production session recordings; the two Replay Vision monitors and their estimates will begin collecting then.
- [ ] Rate scanner observations with thumbs up/down in their Replay Vision pages once data arrives; this produces configuration recommendations for review.

## What happens next

The scout coordinator picks up fresh configurations within about 30 minutes. Scouts draw from the project’s 100-run daily early-access budget; qualifying findings cluster into reports in the Self-driving inbox, where immediately actionable reports can start coding tasks.

No application source files were changed in this run. The existing client and server PostHog integration was already configured, and its client settings were compatible with the enabled Replay and Error Tracking products.
