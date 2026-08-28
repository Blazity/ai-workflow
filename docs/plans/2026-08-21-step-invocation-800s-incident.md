# Incydent: inwokacje /step umieraja na suficie 800 s, run wisi w RUNNING

Handoff dla agenta, ktory ma to zdiagnozowac do konca i naprawic. Stan wiedzy na 2026-08-21 ~15:20 CEST. Autor: sesja diagnostyczna Filipa (Claude), na zywym incydencie u Arthura.

## Co sie stalo (fakty, zweryfikowane)

Prod Arthura, projekt Vercel `ai-workflow-arthur` (prj_2NOaSKdixAgcsee1FbO1Xr8eceVS, team team_IAWwMMQ7tpVzbfjdtAV6MLSi), release 2026.08.8, deployment przypiety do runa: `dpl_EKy97z2kS7MvvHdkR2Q4U9HAuKN2`.

- Run `wrun_01M0J1WX7HECNWK3J8G6SBH56X` (ticket UP-4765, def 1 "Ticket workflow" v10, harness Codex gpt-5.6-sol reasoning high): trigger 11:39:31Z, prepare ok (78.7 s), planning ok (254.8 s), implementation wystartowala 11:45:31Z.
- `get_runtime_errors` dla projektu: grupa **"Vercel Runtime Timeout Error: Task timed out after 800 seconds"**, route `/.well-known/workflow/v1/step`, status 504. Dwa wystapienia w trakcie tego runa: **11:57:54Z** (inwokacja startowala ~11:44:34, jeszcze w fazie planningu) i **12:16:00Z** (start ~12:02:40). Licznik grupy za 7 dni: **count=5, first=2026-08-18T13:08:40Z**, wiec bilo juz wczesniej i to nie jest jednorazowy przypadek.
- Po 12:16 silnik zamilkl calkowicie (zero wywolan `/flow` i `/step` w logach runtime, tylko polling dashboardu). Run wisial w RUNNING z attempt "running", 0 retries, bez zadnego sladu porazki, az do recznego cancel o 12:49:15Z. Dashboard i MCP pokazywaly zdrowy "running", `runs_diagnose` mowil "wait for the run to finish".
- Pierwsze wystapienie z 18.08 13:08 naklada sie czasowo na run `wrun_01M0AEZD66CEPZENMXXQ07S1GC` (UP-4847), ktory skonczyl jako failed i jest sklasyfikowany jako budget_exhausted. Czyli wczesniejsze trafienia maskowaly sie jako "budget", nikt nie widzial timeoutu.

## Co zostalo WYKLUCZONE (nie badac ponownie)

1. **Release / zmiana kodu.** Run byl przypiety do deploymentu z 18.08; na tym samym deploymencie dzien wczesniej przechodzily sukcesy (UP-4091, 306-513 s). Limit 800 s nie wystepuje nigdzie w repo (grep po `maxDuration` w apps/worker), to per-projektowe ustawienie funkcji Vercela.
2. **Podniesienie limitu.** 800 s to maksimum planu Pro na Fluid Compute (default 300). Enterprise daje 900 s. Slepa uliczka.
3. **Teoria "implementation czeka jedna dluga inwokacja".** NIEPRAWDA dla tego kodu i tego wydania. Faza agenta jest detached od lipca: `writeAndStartPhase` odpala wrapper przez `sandbox.runCommand({detached: true})` i oddaje commandId (apps/worker/src/workflows/agent.ts:1451-1530, commit a015cf6f/218765bd, lipiec), a czekanie robi `pollPhaseUntilDone` (agent.ts:5153 dla implementation, 4798 research, 5401 review) tickami po maks 30 s (PHASE_POLL_TICK_MAX_MS, apps/worker/src/workflows/blocks/poll-phase.ts:15). Kazdy tick to osobny step (`delayPhasePollStep`, poll-delay.ts:54-57). To wszystko JEST w wydaniu 2026.08.8. Uwaga: wczesniejsza komunikacja na Slacku podawala te teorie jako przyczyne; jest do sprostowania.

## Zagadka do rozwiazania

Skoro kazdy step w petli poll jest krotki (sleep <=30 s, odczyt sentinela, odczyt budzetu), to CO trzymalo inwokacje `/step` przy zyciu przez 800 s? Hipotezy, uszeregowane:

1. **Runtime WDK przetwarza kolejne stepy w jednej, dlugozyjacej inwokacji** (batching/reuse kolejki). Jedna inwokacja obsluguje tick za tickiem przez caly czas fazy i w koncu wpada w sufit funkcji, ginie w polowie ticku, kolejka redelivery podnosi nastepna inwokacje (stad druga smierc 12:16), az retry sie koncza i silnik milknie. Pasuje do: ciagla aktywnosc silnika 11:44 do 11:57 zakonczona 504; incydent checkow z 19.08, gdzie inwokacja zyla 358631 ms na trasie z limitem 300 s (pamiec projektu: pre-pr-checks-300s-invocation-ceiling, "dwie rozne sygnatury tego samego wyscigu"). Falsyfikacja: w logach runtime deploymentu EKy97 policzyc czas zycia requestow na `/step` (requestId + duration) w oknie 11:44-12:16; jesli pojedynczy requestId zyje setki sekund obejmujac wiele tickow, hipoteza potwierdzona.
2. **Wywolanie API sandboxa w stepie wisi bez timeoutu.** `checkPhaseDone` (apps/worker/src/sandbox/poll-agent.ts) lub `Sandbox.get`/`observeBudget` zawisa na sieci; kod przewiduje bledy (zwraca "stopped"), ale nie przewiduje wiszacego promise, wiec step zyje do sufitu funkcji. Falsyfikacja: te same logi; jesli inwokacja, ktora zginela, obsluzyla dokladnie JEDEN step i jej jedyna aktywnosc to wywolanie sandbox API, potwierdzone. Fix: AbortSignal/timeout na kazde wywolanie @vercel/sandbox w stepach petli.
3. **Sciezka harness (Codex) omija poll w wydaniu 2026.08.8.** Malo prawdopodobne (writeAndStartPhase jest wspolne dla kind i runtime), ale weryfikowac na zrodle TAGU wydania, nie na lokalnym mainie: `git show artur-v2026.08.8:...` w repo zrodlowym po pinie sourceCommit z release-manifest.json.

## Drugi defekt (osobny fix, rownie wazny)

Po smierci inwokacji **run nie ma zadnego watchdoga**: zostaje w RUNNING na zawsze, uzytkownik widzi zdrowy run, `runs_diagnose` kaze czekac. To znana rodzina (pamiec: prod-runs-stuck-running-leak). Do tego cancel przy martwym silniku zostawia claim w stanie "cancelling", ktory zwalnia dopiero `reconcileRuns` na `/cron/poll` (apps/worker/src/lib/cancel-run.ts:261-264, apps/worker/src/lib/reconcile.ts:90-96), a ten cron chodzi u Arthura **co 15 minut** (apps/worker/vercel.json:5), wiec ticket jest niedispatchowalny do kwadransa po cancelu. Pozadane: (a) watchdog wykrywajacy runy z aktywnym claimem bez zadnej aktywnosci silnika przez N minut i przenoszacy je w terminal failed z czytelnym powodem, (b) rozwazyc release claimu synchronicznie w cancel, gdy teardown potwierdzony.

## Trzeci defekt: claim po cancelu zakleszcza sie w "cancelling" (potwierdzone na zywo 13:00-13:05Z)

Po recznym cancelu wedgniętego runa claim subjectu NIE schodzi. Sciezka potwierdzenia cancelu wymaga `confirmWorkflowStepsDrained` (apps/worker/src/lib/cancel-run.ts:520); stepy runa z martwym silnikiem nigdy sie nie drainuja, wiec kazdy cancel konczy jako tornDown-only i zostawia claim w "cancelling". `reconcileRuns` na cronie ponawia to samo co 15 minut i przy niepowodzeniu NIE loguje nic (apps/worker/src/lib/reconcile.ts:97-111 loguje tylko sukces), wiec zakleszczenie jest niewidoczne. Skutek: subject (ticket) trwale niedispatchowalny, preflight wiecznie zwraca `active_run` (manual-dispatch/service.ts:53 blokuje na samym istnieniu wpisu w registry, niezaleznie od stanu). Zweryfikowane: cancel 12:49:15Z, tick crona 13:00Z, preflight 13:03Z nadal `active_run`, zero logow reconcile.

Reczny unblock na produkcji (Neon Arthura): `DELETE FROM active_runs WHERE subject_key = 'ticket:jira:UP-4765';` (tabela active_runs, klucz glowny subject_key; powiazane wiersze sandboxow maja FK na subject_key+owner_token). Pozadany fix: sciezka cancel/reconcile, ktora po potwierdzonym teardownie i terminalnym statusie WDK runa (cancelled) zwalnia claim bez czekania na drain stepow, plus log warn przy kazdej nieudanej probie konwergencji.

## Prior art i narzedzia

- Wzorzec detached + poll i jego koszty: poll-delay.ts (caly komentarz, wazny), poll-phase.ts, PR #318 (e94f5d7c) "run pre-PR checks detached so they survive the invocation ceiling".
- Stanowisko reprodukcyjne checkow: repo aiw-checks-fixture (pamiec projektu: aiw-checks-fixture-repro-harness) z pokretlem czasu trwania; nadaje sie do wymuszenia dlugiej fazy bez palenia kredytow Codexa.
- Diagnostyka Vercela: `get_runtime_errors` (pre-agregowane, nie timeoutuje) najpierw; `get_runtime_logs` TYLKO waskie okna albo scope po deploymentId, szerokie zapytania timeoutuja; group_by requestPath do tanich przegladow. Sanitized LOGS obserwacji nie istnieja dla trwajacego attemptu.
- Dowody o prodzie Arthura wylacznie z prawdziwych zrodel (MCP arthur-prod po auth, dashboard, logi Vercela); lokalny port 43111 to atrapa.

## Ograniczenia robocze

- Zadnych pelnych suit lokalnie; szeroka weryfikacja przez CI. `pnpm build` w apps/worker odpala migracje DB, nie uruchamiac. neon-http nie ma transakcji (zadnych db.transaction() w sciezkach zapisu workera). Stepy WDK: unikalne nazwy, zadnych odczepionych lancuchow stepow (AIW-251), inputy stepow serializuja sie do event logu, wiec nie przepychac przez nie duzych obiektow.
- Fix trafi do Arthura dopiero przez release (procedura artur-release); do tego czasu doraznie u Arthura mozna zdjac codex-execution z reasoning high, zeby skrocic fazy.

## Definicja ukonczenia

1. Zidentyfikowana i udowodniona (logami lub reprodukcja na fixture) dokladna przyczyna 800-sekundowych inwokacji na `/step`.
2. Fix + test, ktory reprodukowal problem przed fixem.
3. Watchdog na runy z martwym silnikiem (terminal failed + powod), z testem.
4. Wpis w docs/qa lub w tym pliku z dowodami weryfikacji.

---

## Wynik diagnozy (2026-08-21, ~15:30 CEST)

Zagadka rozwiązana, dowody i naprawy w `docs/qa/2026-08-21-step-invocation-800s-root-cause.md`. W skrócie:

- Hipoteza 1 (batching stepów w jednej inwokacji) jest fałszywa: `@workflow/core` 4.8.0 + `@vercel/queue` 0.3.1 w trybie push obsługują jedną wiadomość na inwokację.
- Hipoteza 2 potwierdzona event logiem WDK: step `checkPhaseDone` (`step_01M0J1WXT6K5Q6Q9T3DJED252E`, utworzony 11:57:54.679Z) zawisł na API sandboxa i był dostarczany trzy razy (`step_started` 11:57:54, 12:16:01, 12:34:09), za każdym razem do sufitu 800 s. Znaczniki czasu 504 w logach Vercela to czas STARTU requestu, stąd błędne "11:44:34, w planningu" powyżej.
- Naprawy: deadline 60 s na wywołania sandboxa w `checkPhaseDone`/`stopPhaseCommand`/`teardownSandbox` (`sandbox/sandbox-deadline.ts`), watchdog martwego silnika w reconcile (`lib/run-stall-watchdog.ts`, próg 20 min od `createdAt` najnowszego running stepu, `status=failed` + powód + cancel), drain ignorujący stepy starsze niż sufit inwokacji (`lib/workflow-step-drain.ts`, 20 min) plus log warn przy niekonwergującym claimie `cancelling`.
- Otwarte: dlaczego sandbox przestał odpowiadać (nowy log `sandbox_phase_check_deadline_exceeded` poda `sandboxId` przy następnym razie).
