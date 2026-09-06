# Odpowiedź dla Diany na feedback Arthura (2026-08-18)

Draft do wklejenia na Slacku (Filip wysyła sam). Diana poprosiła o odpowiedź/fix
na 4 punkty z arkusza feedbacku Arthura do czasu, aż wejdą do biura o 2PM.
Ticket z punktu 2 = **[AIW-291](https://blazity.atlassian.net/browse/AIW-291)**.

## Draft (English, paste-ready)

```
Triage of the four items in the sheet, grouped by root cause:

1 & 4 — the two "transient" failures (UP-4859 GitLab catalog timeout, and the
/tmp codex_home error). Both are environment/transient, not workflow
regressions, and a retry got past them. Two different underlying causes:
 - #1 is a flaky GitLab "list projects" call that times out at 15s with zero
   retries, so a single hiccup fails the whole run and needs a manual re-move
   to the AI column. Fix in progress: bounded retries + higher timeout on that
   step so it self-recovers.
 - #4 is NOT a sandbox init failure. The "/tmp codex_home" line is a benign,
   by-design codex warning that prints on every run, including successful ones
   (codex refuses to drop PATH-helper binaries under /tmp; non-fatal). The real
   failure ($0.00 billed, no output) is an OpenAI-side rejection on the tenant
   key; we're confirming the exact reason from the run's codex logs (fingerprint
   points to credits/quota/auth). Separately we'll surface the real stderr cause
   instead of the benign warning so this stops being misattributed.

2 — "how do I review a bot PR / talk to the agent?" Artur already answered
in-thread: comment on the PR like a human PR, then move the ticket back to the
AI column and it regenerates from your feedback. There's no live back-and-forth
with the agent yet; today the loop is comment -> retrigger. Filed a feature
ticket to add a proper conversational review loop (AIW-291).

3 — "bot doesn't enforce CI pipeline green." Two parts: (a) The configured
pre-PR checks DO include the install steps (uv sync, yarn install) and DO work
on a healthy run: they passed twice on 2026-08-17. The MR you saw said "yarn
checks were blocked because dependencies are not installed" because when an
install step fails or is cut short, the runner does not hard-stop, so later
checks run without node_modules and the bot pushes a misleading result. Fix
(PR #304): a check that reports missing deps now fails loudly instead of
pushing a false green; we are also making a failed install abort its group so
it cannot cascade. (b) The bot doesn't watch the external MR pipeline to green:
that's a feature (poll the pipeline, feed failures into a fix loop, ignore
Meticulous as requested).

Net: the workflow itself is healthy (a full ticket->PR run went green on the
tenant this morning). The failures are environmental/flaky plus one real gap in
CI enforcement. Fixes for 1, 3, 4 are being worked now; 2 is a filed feature.
```

## Kontekst / mapowanie na robotę (dla nas, nie do wysyłki)

| Punkt arkusza | Co to jest | Status u nas |
|---|---|---|
| #1 GitLab timeout (UP-4859, `listFreshRepositoryCatalogStep`, 15s, 0 retry) | flaky upstream, brak retry | [PR #302](https://github.com/Blazity/ai-workflow/pull/302): timeout 15→18s, 2→3 próby, jitter backoff |
| #2 review/rozmowa z agentem | znane ograniczenie, Artur odpowiedział | ticket **AIW-291** założony |
| #3 CI green (a) checki pominięte bo brak deps (b) brak pilnowania pipeline'a | (a) bug, (b) feature | (a) fix agent → PR `fix/pre-pr-checks-deps`; (b) scope note + osobny ticket |
| #4 `/tmp` codex_home init, $0.00 | rodzina "sandbox instability" | diagnoza agent → fix `fix/codex-home-init` albo raport, że to platforma |

Dowód, że workflow jest zdrowy: run `wrun_01M07V4FT0P8ET4YXTZ7CHCFJ1` (UP-4846)
przeszedł dziś rano trigger → prepare → planning → implementation → checks →
finalize → **open-pr = ok** na prodzie Arthura. Faile to środowisko (Vercel
Sandbox reclaim/init) + sporadyczny `provider_error` na kluczu OpenAI Arthura,
nie zepsuty pipeline.

## Do zrobienia, zanim to wyślesz
- [ ] Podmień numery PR-ów za "fix in progress", jak agenty zwrócą linki.
- [ ] Potwierdź, czy #4 to faktycznie kod (agent diagnozuje) zanim obiecasz "hardening".
- [ ] Zdecyduj, czy część (b) z #3 idzie jako osobny ticket przed wysyłką (żeby dać Zachowi numer).
