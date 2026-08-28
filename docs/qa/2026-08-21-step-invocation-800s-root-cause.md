# Inwokacje /step umierające na suficie 800 s: przyczyna, naprawa, dowody

Data: 2026-08-21. Dotyczy prod Arthura (projekt `prj_2NOaSKdixAgcsee1FbO1Xr8eceVS`, deployment `dpl_EKy97z2kS7MvvHdkR2Q4U9HAuKN2`, wydanie 2026.08.8), run `wrun_01M0J1WX7HECNWK3J8G6SBH56X` (UP-4765). Kontynuacja handoffu `docs/plans/2026-08-21-step-invocation-800s-incident.md`.

## Werdykt

Jedna inwokacja `/.well-known/workflow/v1/step` = jeden step WDK (handler `@workflow/core` 4.8.0 `runtime/step-handler.js`, dostawa push przez Vercel Queues, `@vercel/queue` 0.3.1 `consumeMessage`, jedna wiadomość na callback). Hipoteza "runtime przetwarza wiele stepów w jednej inwokacji" jest **fałszywa**.

Przyczyną jest **hipoteza 2**: step `checkPhaseDone` (`apps/worker/src/sandbox/poll-agent.ts`) woła `Sandbox.get` i `sandbox.runCommand("test", ["-f", sentinel])` bez żadnego limitu czasu. Klient `@vercel/sandbox` 1.8.1 nie ma własnego timeoutu (`base-client.js` ustawia wręcz `bodyTimeout: 0`). Gdy sandbox przestał odpowiadać, promise nigdy się nie rozstrzygnął, inwokacja żyła do sufitu funkcji (800 s), Vercel ją zabił (504), kolejka po upływie visibility timeout (300 s, odnawiany co 60 s, stąd ~287 s po zgonie) dostarczyła **tę samą wiadomość** ponownie, nowy attempt tego samego stepu zawisł identycznie. Trzy cykle po ~18 min, potem ręczny cancel.

## Dowody

1. Event log WDK runa (CLI `workflow inspect steps|events -r wrun_01M0J1WX7HECNWK3J8G6SBH56X -b vercel` z `WORKFLOW_VERCEL_PROJECT`/`TEAM` Arthura, cwd poza repo, żeby CLI nie podmieniło projektu na `.vercel/` z repo):

   | step | stepName | status | attempt | createdAt | step_started |
   |---|---|---|---|---|---|
   | `step_01M0J1WXT6K5Q6Q9T3DJED252E` | `sandbox/poll-agent//checkPhaseDone` | running | 3 | 11:57:54.679Z | 11:57:54.859Z, 12:16:01.903Z, 12:34:09.270Z |

   Wszystkie 99 wcześniejszych stepów pętli poll (readRunBudgetClockStep ×2, delayPhasePollStep, readRunBudgetClockStep ×2, checkPhaseDone; 6 na tick co ~32 s) są `completed`, poprzednie `checkPhaseDone` kończyły się w 200-300 ms. `run_cancelled` 12:48:33.151Z.

2. Runtime logi Vercela (`get_runtime_logs`, scope po deploymentId): 504 "Task timed out after 800 seconds" o 11:57:54, 12:16:00, 12:34:07. Te znaczniki czasu to **czas startu** requestu (pokrywają się co do sekundy ze `step_started` trzech attemptów), nie czas zgonu. Wniosek handoffu "inwokacja startowała ~11:44:34, w fazie planningu" był artefaktem odejmowania 800 s od czasu startu. Czwarta dostawa 12:52:14 (= zgon trzeciego attemptu 12:47:29 + ~287 s) dostała 200: run był już cancelled, handler odrzucił wiadomość na RunExpired, po czym `/flow` 200 o 12:52:16.

3. Logi `level=warning|error` dla deploymentu w oknie 11:50-12:50 zawierają wyłącznie te trzy 504; żadnego logu aplikacji ze stepu (kod nie logował przed zawisem).

4. Kod: `poll-agent.ts` `checkPhaseDone` przed zmianą: brak `signal`, brak wyścigu z timerem; `@vercel/sandbox/dist/api-client/base-client.js:22` `bodyTimeout: 0`; `api-client.js:175` `wait: "true"` (long poll na zakończenie komendy).

## Nierozstrzygnięte

Dlaczego sandbox przestał odpowiadać o 11:57:54 (ok. 18 min od `prepare`, 12,4 min fazy implementation na Codex gpt-5.6-sol high). Kandydaci: VM przeciążony (CPU/RAM przez Codexa), zawieszenie po stronie API sandboxów. Id sandboxa zniknął razem z ręcznie usuniętym wierszem `active_runs`; do sprawdzenia w panelu Sandboxes Vercela przy następnym wystąpieniu (log `sandbox_phase_check_deadline_exceeded` poda `sandboxId`).

## Naprawy (branch `wip/run-analysis-report`, niezacommitowane na 21.08 15:30)

1. **Deadline na wywołania sandboxa w stepach pętli** (`apps/worker/src/sandbox/sandbox-deadline.ts`, `SANDBOX_STEP_DEADLINE_MS = 60_000`, `withSandboxDeadline` = AbortSignal + `Promise.race` z timerem, więc działa także gdy klient zignoruje sygnał). Objęte: `checkPhaseDone` (zwraca `"stopped"` + log warn `sandbox_phase_check_deadline_exceeded`), `stopPhaseCommand` (`poll-phase.ts`), `teardownSandbox`. Pętla poll traktuje `"stopped"` jak dotąd (`stoppedObservations`), więc wedgnięty sandbox kończy się porażką fazy z powodem, nie runem w RUNNING.
2. **Watchdog martwego silnika** (`apps/worker/src/lib/run-stall-watchdog.ts`, wpięty w `reconcileRuns` dla claimów `bound` gdy jest `db`): jeśli WDK mówi `running`, a najnowszy step runa jest `running` dłużej niż `STALLED_STEP_AFTER_MS` (20 min, czyli więcej niż pełny cykl 800 s + redelivery), run dostaje `status=failed` z czytelnym `statusReason` (`markRunFailedByWatchdog`, guard na in-flight), potem cancel przez `cancelRunDetailed` (ticket w AI ląduje w Backlogu, żeby discovery go nie zdispatchowało) lub `cancelSubjectRunDetailed`. Kotwica to `createdAt` najnowszego stepu, bo redelivery pisze nowe `step_started` co cykl i reguła "ostatnie zdarzenie" widziałaby aktywność.
3. **Drain stepów ignoruje martwe stepy** (`apps/worker/src/lib/workflow-step-drain.ts`, `DEAD_STEP_AFTER_MS = 20 min`): running step, którego `max(startedAt, updatedAt)` jest starsze niż sufit inwokacji, nie blokuje zwolnienia claimu (warunek wstępny: run terminalny, co spełniają wszyscy trzej wywołujący). Dwudziestominutowy próg zostawia realny margines ponad Enterprise 900 s; dokładnie 900 s nadal jest pending. Log warn `workflow_step_drain_ignored_dead_steps`. Dodatkowo `reconcileRuns` loguje warn `reconcile_cancelling_claim_unconverged` przy każdej nieudanej konwergencji claimu `cancelling` (wcześniej cisza).

## Weryfikacja

- `pnpm --filter worker exec tsc --noEmit`: exit 0.
- `vitest run` na 7 plikach: `sandbox/poll-agent.test.ts`, `workflows/blocks/poll-phase.test.ts`, `lib/workflow-step-drain.test.ts`, `lib/run-stall-watchdog.test.ts`, `lib/reconcile.test.ts`, `lib/cancel-run.test.ts`, `lib/run-start-lifecycle.test.ts`: 132 testy zielone (po dostosowaniu asercji `getCommand`/`Sandbox.get` w poll-phase.test do nowego argumentu `signal`).
- Reprodukcja przed fixem: `git stash` samego `poll-agent.ts` i `vitest run src/sandbox/poll-agent.test.ts --testTimeout=3000` daje `× checkPhaseDone > reports stopped even when the sandbox client ignores the abort signal (Test timed out in 3000ms)` oraz `× teardownSandbox > gives up on a sandbox that never answers the stop (Test timed out)`; po `stash pop` oba zielone w ~25 ms.
- Szerokie suity wyłącznie przez CI (zasada repo).

## Do zrobienia po stronie operacyjnej

- Fix trafia do Arthura dopiero przez wydanie (`artur-release`). Do tego czasu wedgnięty run: `runs_cancel`, a claim zakleszczony w `cancelling` zwalnia dopiero cron `/cron/poll` (u Arthura co 15 min) po wejściu fixu 3; ręcznie: `DELETE FROM active_runs WHERE subject_key = 'ticket:jira:<KEY>'`.
- Sprostowanie na Slacku: przyczyną nie był brak wzorca detached+poll (jest od lipca), tylko brak limitu czasu na pojedynczym wywołaniu sandboxa w ticku poll.
