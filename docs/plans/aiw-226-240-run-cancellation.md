# AIW-226 + AIW-240: honest terminal state and a run-id cancel path

Branch: `feat/aiw-226-240-run-cancellation` (from fresh main, includes AIW-223 schedule trigger). Two tickets, one plan, two PRs. Phase 1 (AIW-226) merges first and stabilises the cancel-core; Phase 2 (AIW-240) reuses it.

## Problem

Two ends of the same story: how a run finishes, and who can finish it.

- **AIW-226 (bug).** When something ends a run from the outside, the run's real outcome can be lost. Drag a ticket out of its column at the instant its run fails on its own and Slack says `canceled`, not `failed`. Push a new plan while an approval is pending and the older plan's run row sits in `awaiting` forever.
- **AIW-240 (feature).** Every cancel path today addresses a run by its Jira ticket key (Slack `/cancel`, the column-leave webhook). Runs from a webhook or a schedule have no ticket, so nothing, no dashboard, no command, can stop them. A scheduled run that starts at 09:00 on a bad instruction cannot be halted before it opens a PR; the only bound is the job timeout.

## Rozwiazanie

- A run's real outcome survives both external-end paths: a self-finished run keeps its true label in Slack and in the webhook response, and a superseded plan's run row is settled the moment the new plan arrives.
- An operator can stop any run in progress by run id from an authenticated surface, ticket or no ticket: a Cancel control in the runs list, and a Cancel-current-run control in the schedule panel. Cancelling releases the subject so a schedule blocked by that run resumes on the next evaluation, and the record shows a human stopped it, distinct from a run the system settled on its own. Cancelling a run that already finished reports what actually happened, not a false success. A member without the dispatch role gets 403.

## User stories

1. Jako operator chce, zeby wyciagniecie ticketu z kolumny w momencie gdy run sam failuje pokazalo `failed`, nie `canceled`, zeby Slack nie klamal o wyniku.
2. Jako operator chce, zeby nowy plan dla tego samego ticketu zamykal run starego planu, zeby nie zostawal `awaiting` na zawsze.
3. Jako operator chce zatrzymac dowolny trwajacy run z listy runow, takze webhookowy i zaplanowany bez ticketu, zeby zly run nie doszedl do otwarcia PR.
4. Jako operator chce zatrzymac trwajacy zaplanowany run z panelu schedule, zeby nastepne wystapienie ruszylo normalnie.
5. Jako operator chce, zeby anulowanie juz-skonczonego runu bylo no-opem raportujacym prawdziwy wynik, nie falszywym sukcesem.
6. Jako reviewer chce widziec, ze run anulowal czlowiek (a nie system), zeby audyt byl jednoznaczny.
7. Jako admin chce, zeby member bez roli dispatch dostal 403 na anulowaniu, zeby uprawnienia byly spojne z reszta akcji mutujacych run.

## Decyzje implementacyjne

**Wspolny cancel-core (istnieje).** `cancel-run.ts` ma juz `cancelRunDetailed` / `cancelSubjectRunDetailed`, ktore zwracaja `alreadyTerminal` (run osiagnal stan terminalny sam, zanim cancel go dosiegnal). Reconciler juz go uzywa poprawnie (skip notify + log gdy `alreadyTerminal`). Obie fazy reuzywaja ten sam dyskryminator, nie wprowadzaja drugiego pojecia "already finished".

**AIW-226 defekt 1.** `cancelTrackedRun` (webhook column-leave) wola plain `cancelRun`, ktore odrzuca `alreadyTerminal`, a oba call-sites raportuja `canceled` na golym boolean, do Slacka i do body odpowiedzi. Fix: przelaczyc na wariant `Detailed`, przepuscic `alreadyTerminal` do call-sites, i gdy `true` zachowac prawdziwy wynik zamiast `canceled` (mirror gałęzi w reconcilerze). Terminal juz jest wykrywany przed cancelem, ale istnieje okno wyscigu miedzy tym sprawdzeniem a `workflowRun.cancel()`, ktore `alreadyTerminal` domyka.

**AIW-226 defekt 2.** Supersede pending approvala to jedno CTE `update ... set status='superseded' where ticket and pending`, ktore nie dotyka `workflow_runs`. Sciezka clarifications robi to poprawnie: po superseded wola `resolveAwaitingRunsForTicket(db, ticketKey, currentRunId)`, ktore flipuje inne `awaiting` runy tego ticketu na `blocked` (z wykluczeniem biezacego). Fix: dodac te sama wywolanie po supersede w approvals, zachowujac single-statement/CTE (neon-http nie ma transakcji; partial unique index "one pending per ticket" to jedyny straznik).

**AIW-240 cancel-by-run-id.** Nowy helper `cancelRunById(db, runId, actor, deps)`. Reverse lookup runId -> subject jest DWUSTOPNIOWY, bo swiezy run trzyma claim w `active_runs` zanim powstanie wiersz `workflow_runs` (pierwszy zapis to `recordBlockStatuses`; przed nim PK-lookup samego `workflow_runs` dalby 404 na zywym runie, dokladnie w oknie "zatrzymaj zly run zanim otworzy PR"):
- Najpierw `active_runs where run_id = ?` (zywe runy: state `bound|parking|parked`, `run_id` not null) -> `subjectKey`. To pokrywa run w locie od momentu bound.
- Fallback `workflow_runs` PK po `run_id` -> `status` (dla runow juz poza `active_runs`, czyli terminalnych). Brak w obu -> 404.
- Status terminalny (mapa outcome, patrz nizej) -> no-op, raportuje faktyczny status, nie falszywy sukces (analogicznie do `alreadyTerminal`).
- W locie -> `cancelSubjectRunDetailed(subjectKey, ...)` (osiaga `releaseCancellation`, ktore zwalnia subject). Zapis stanu TYLKO gdy `result.cancelled === true` i NIE gdy `alreadyTerminal`; wynik to `status='blocked'` + `status_reason='cancelled by <actor label>'`, przez istniejacy `markRunBlockedOnCancel` (nie wymyslamy nowego statusu). KRYTYCZNE: zapis ma guard only-advance-in-flight (`where status not in (success,failed,blocked,awaiting)`), tak jak `markRunFailedOnSelfMove`, zeby run ktory sam skonczyl sie `success`/`failed` w oknie wyscigu nie zostal nadpisany.

Dlaczego `blocked`, nie nowy `cancelled` status: caly read-path (`coerceStatus`, `RUN_STATUSES`, KPI counts, chipy) zna tylko `{success,running,failed,blocked,awaiting}`; `STATUS_MAP.cancelled='blocked'` i `markRunBlockedOnCancel` to ustalona konwencja dla zewnetrznego anulowania. Rozroznienie human-vs-system niesie `status_reason`, nie osobna wartosc statusu.

Zwolnienie subjectu sprawia, ze schedule zablokowany przez ten run (odrzucany jako `already_claimed`) rusza na nastepnym przebiegu crona (`evaluateScheduleTriggers` w poll), w obu politykach: skip/queue (wspoldzielony `schedule:<id>`) i allow (per-occurrence, spada `inFlightCeilingBlocker`).

**AIW-240 route.** `POST /api/v1/runs/[runId]/cancel`, `requireDashboardActor` + `canDispatchWorkflowRuns` (owner|admin), member -> 403 (mirror manual-dispatch). Dashboard proxuje przez istniejacy `forward` helper.

**AIW-240 rozroznienie human vs system.** Dwa poziomy, bo webhookowy run nie ma occurrence:
- Zawsze: `workflow_runs.status='blocked'` + `status_reason='cancelled by <actor>'` (zrodlo prawdy, decyzja z grillingu).
- Dodatkowo dla scheduled runu: occurrence ledger. Dzis occurrence jest zamrozony na `outcome='started'` od startu runu do konca (brak kroku "run ended -> settle occurrence"), a istniejaca wartosc `'cancelled'` znaczy "nigdy nie wystartowal". Dodajemy NOWA wartosc outcome (rekomendacja: `run_cancelled`) i flipujemy occurrence `started -> run_cancelled` na cancel scheduled runu. To odroznia human-cancel-in-flight od pre-start `cancelled` i od runu, ktory system settlowal sam. UWAGA na blast-radius: `run_cancelled` musi trafic w JEDNYM zakresie do wszystkich trzech: DB check-constraint + `ScheduleOccurrenceOutcome` (worker), shared union `contracts/api.ts`, oraz DWIE wyczerpujace mapy w dashboardzie (`SCHEDULE_OUTCOME_STYLES`, `SCHEDULE_OUTCOME_MEANING` w config-fields.tsx). Pominiecie ktoregokolwiek to albo fail dashboard-typecheck (gdy union dostal wartosc a mapy nie), albo pusty/zepsuty chip (gdy union nie dostal). Dlatego shared union nalezy do E5, a mapy dashboardu do E7 (ten sam plik co kontrolka cancel), z E7 po E5 i dashboard-typecheck w DoD E7.

Occurrence `started` jest juz SETTLED (`pending=false`); flip `started -> run_cancelled` jest PIERWSZYM zapisem mutujacym settled occurrence, wbrew inwariantowi "settled jest terminalny" (occurrence-store.ts:20-24). Bezpieczne tylko dlatego, ze oba writery `recordOccurrenceStarted` odpalaja przy dispatchu, na dlugo przed ludzkim cancelem; ten fakt musi zostac zapisany, zeby przyszla zmiana nie przeniosla tego zapisu.

**Formaty subjectow (do rozpoznania rodzaju runu w UI/logice):** `webhook:<endpointId>:<subjectId>`, `schedule:<scheduleId>[:<epochMillis>]`, ticket/pr/repo/org (subject-key.ts).

## Seamy i decyzje testowe

| Seam | Obserwowane zachowanie | Prior art (plik:linia) |
|------|------------------------|------------------------|
| Webhook cancel path, `jira.post.test.ts` (pglite) | Ticket wyciagniety gdy run juz failed -> Slack `failed`/skip, body nie `cancelled` | `reconcile.ts:79-90,187-195` (alreadyTerminal branch), `jira.post.ts:573,119,376` |
| Approvals supersede, `approvals/store.test.ts` + `run-telemetry.test.ts` (pglite) | Po supersede stary run row -> `blocked`, dokladnie jeden pending | `clarifications/store.ts:218-222`, `run-telemetry.test.ts:615-664` |
| `cancelRunById`, `cancel-run.test.ts` (unit, mocked registry) | run-id w locie -> cancel + subject released; terminalny -> no-op z realnym statusem; brak -> 404 | `cancel-run.ts:80-140,232-318` |
| Cancel route, route test (pglite) | 200 cancel; member -> 403; juz-terminalny -> no-op | `manual-dispatch.post.ts:25-28`, `approve.post.ts:22-25` |
| Occurrence settle-on-cancel, `schedule` occurrence test (pglite) | Cancel scheduled run -> occurrence `run_cancelled`, nastepne occurrence rusza | `occurrence-store.ts:347-374`, `schema.ts:996-1064,1053` |

## Out of scope

- Rejected-plan revision path (AIW-218).
- Kosmetyczne logowanie kanonicznej nazwy statusu Jira (audit vs Weryfikacja) z AIW-226.
- Poprawka copy `SCHEDULE_PAUSE_CANCELS_NOTE` (osobno, wg ticketu).
- Cancel z poziomu Slacka po run id (ticket wspomina tylko dashboard + schedule panel).

## Zalozenia

- **Zal. 1 (occurrence outcome):** dodajemy nowa wartosc `run_cancelled` do check-constraintu `schedule_occurrences.outcome` migracja, zamiast reuzywac `cancelled` (ktory znaczy "nigdy nie wystartowal"). Rekomendacja przyjeta; sceptyk ocenia czy to nie mnozy stanow bez potrzeby (alternatywa: `cancelled` + `skip_reason`).
- **Zal. 2 (settle timing):** flip `started -> run_cancelled` jest pierwszym zapisem mutujacym settled occurrence i lamie inwariant "settled terminalny" (occurrence-store.ts:20-24), bezpieczny tylko bo `recordOccurrenceStarted` odpala przy dispatchu, przed cancelem. E5 potwierdza greppem czytelnikow `scheduleOccurrences`, ze zaden nie zaklada niezmiennosci `started`, i dopisuje komentarz o tym warunku przy flipie.
- **Zal. 3 (reverse lookup, POPRAWIONE po pre-mortemie):** czysty PK-lookup `workflow_runs` NIE wystarcza, bo swiezy run trzyma tylko `active_runs` zanim powstanie wiersz `workflow_runs` (404 na zywym runie w oknie startu). Lookup jest dwustopniowy: `active_runs where run_id` (zywe, do cancel) -> fallback `workflow_runs` PK (terminalne, do no-op). `active_runs` nie ma indeksu na `run_id`; tabela trzyma tylko zywe runy, wiec skan jest tani; index dodajemy tylko jesli E3 zmierzy, ze trzeba.
- **Zal. 5 (semantyka settle superseded, potwierdzona przez pre-mortem):** superseded run settlujemy na `blocked` (nie `success`), zgodnie z `resolveAwaitingRunsForTicket` (docstring: predecessor nigdy nie dostal odpowiedzi, `success` bylby klamstwem). Fraza AC "settled the same way a decision settles it" jest luzna; wlasciwy analog to clarification-supersede (`blocked`), nie decision (`success`). Znany, niski efekt uboczny (dziedziczony po clarifications): moze `blocked`-settlowac niepowiazany `awaiting` run dzielacy ten sam ticket key.
- **Zal. 4 (dispatch role):** "ta sama rola co inne akcje mutujace run" = `canDispatchWorkflowRuns`. Jesli produkt chce osobnej roli cancel, to zmiana w roles.ts.

## Etapy

| # | Etap | Seam | Zakres plikow | Tier | Sceptyk | TDD | Delegacja | DoD |
|---|------|------|---------------|------|---------|-----|-----------|-----|
| E1 | AIW-226 def.1: `cancelTrackedRun` -> `cancelSubjectRunDetailed`, przepusc `alreadyTerminal`, oba call-sites rozgaleziaja Slack+response (mirror reconcile) | webhook cancel path | `apps/worker/src/routes/webhooks/jira.post.ts` | opus | tak | tak | nie | `pnpm --filter worker exec vitest run src/routes/webhooks/jira.post.test.ts` zielone z nowa regresja (already-terminal -> nie `canceled`); typecheck czysto |
| E2 | AIW-226 def.2: po supersede w approvals wolaj `resolveAwaitingRunsForTicket` (mirror clarifications), single-statement/CTE | approvals supersede | `apps/worker/src/approvals/store.ts` | opus | tak | tak | nie | `vitest run src/approvals/store.test.ts` zielone z nowa asercja (superseded -> stary run `blocked`, jeden pending); typecheck |
| E3 | AIW-240 core: `cancelRunById` (dwustopniowy lookup active_runs->workflow_runs, terminal->no-op, in-flight->cancelSubjectRunDetailed+release, zapis przez `markRunBlockedOnCancel` gated na cancelled===true + only-advance guard) | cancel-run unit | `apps/worker/src/lib/cancel-run.ts`, `apps/worker/src/db/queries/runs-read.ts` | opus | tak | tak | nie | `vitest run src/lib/cancel-run.test.ts` zielone (cancel->blocked+reason / no-op-terminal / 404 / release / race: self-success nie nadpisany); helper wyeksportowany z sygnatura dla E4/E5; typecheck |
| E4 | AIW-240 route: `POST /api/v1/runs/[runId]/cancel` (role gate 403) + dashboard proxy | cancel route | `apps/worker/src/routes/api/v1/runs/[runId]/cancel.post.ts`, `apps/dashboard/app/api/.../runs handler + route` | sonnet | tak | tak | nie | route test zielony (200/403/no-op); `grep` potwierdza `canDispatchWorkflowRuns`; typecheck obu pakietow |
| E5 | AIW-240 schedule: migracja (nowy outcome `run_cancelled`) + `ScheduleOccurrenceOutcome` (worker) + shared union `contracts/api.ts` + settle occurrence na cancel scheduled runu (flip started->run_cancelled z komentarzem o inwariancie) | occurrence settle | `apps/worker/drizzle/0043_*.sql`, `apps/worker/drizzle/meta/_journal.json`, `apps/worker/src/db/schema.ts`, `apps/worker/src/schedule-trigger/occurrence-store.ts`, `apps/shared/contracts/api.ts` | opus | tak | tak | nie | occurrence test zielony (cancel scheduled -> `run_cancelled`, next occurrence rusza); grep czytelnikow `scheduleOccurrences` bez zalozenia niezmiennosci `started`; migracja w formacie 0042; worker+shared typecheck |
| E6 | AIW-240 UI: przycisk Cancel w liscie runow (desktop + mobile), wola route | runs list | `apps/dashboard/components/cockpit/screens/runs.tsx`, `.../mobile/screens/runs-mobile.tsx` | sonnet | tak | nie | tak | typecheck dashboard; przycisk widoczny tylko dla runu w locie (status `running`); klik wola cancel endpoint (recenzja recznie + istniejace testy zielone) |
| E7 | AIW-240 UI: Cancel-current-run w panelu schedule (evaluating branch, surface `lastStartedRunId`) ORAZ obie mapy outcome (`SCHEDULE_OUTCOME_STYLES`, `SCHEDULE_OUTCOME_MEANING`) dostaja `run_cancelled` | schedule panel | `apps/dashboard/components/cockpit/flow-editor/config-fields.tsx` | sonnet | tak | nie | tak | `vitest run` na `config-fields-schedule-trigger.test.tsx` zielone; obie exhaustive mapy pokrywaja `run_cancelled`; dashboard typecheck czysty (lapie brak klucza w mapie); kontrola widoczna gdy schedule ma run w locie |

Kolejnosc i wspolbieznosc: **Faza 1** E1 || E2 (rozlaczne pliki), oba merguja PR-em #1. **Faza 2** startuje po merge #1. E3 pierwszy (zamraza `cancelRunById`). Potem E4 || E5 (rozlaczne pliki, oba potrzebuja E3; E5 zamraza wartosc `run_cancelled` w shared union). E6 po E4 (potrzebuje route). **E7 po E4 + E5** (route + shared union; E7 dodaje `run_cancelled` do map dashboardu, wiec dashboard-typecheck E7 domyka blast-radius z F3). E6 || E7 (rozlaczne pliki dashboardu). Faza 2 merguje PR-em #2. Uwaga: w oknie miedzy E5 (union += run_cancelled) a E7 (mapy += run_cancelled) dashboard-typecheck jest czerwony; to wewnatrz jednego brancha PR#2, domyka go E7 przed koncem fazy.

## Rollout

Po merge #1: deploy, potwierdz na prodzie ze webhook column-leave przy self-failed runie daje `failed` w Slacku, i ze supersede planu settluje stary run. Po merge #2: deploy (migracja 0043 przy buildzie), potwierdz cancel zaplanowanego runu z dashboardu (next occurrence rusza) i webhookowego, oraz 403 dla membera.
