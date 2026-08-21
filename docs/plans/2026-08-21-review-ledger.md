# Review ledger: wątki review na PR/MR jako jednostki pracy ze stanem

## Context

Test z 21.08.2026 (docs/qa/2026-08-21-gitlab-mr-comments-multi-round-verification.md, AWP-107 / MR !11) pokazał, że komentarze z MR docierają do agentów i są adresowane (8/8 w 3 rundach), ale mechanizm jest ślepy: przy każdym runie agent dostaje płaską listę WSZYSTKICH notek (także rozwiązanych i własnych bota), porównanie "co zrobione, a co nie" wykonuje sam model, a kod pilnuje tylko dwóch wyjść awaryjnych (bramka `no_change_needed` z PR #325 i guard "Agent reported success but made no commits"). Skutki: (1) po zaadresowaniu wszystkiego kolejny re-trigger kończy się czerwonym runem zamiast czystym "nic do zrobienia"; (2) słaby model (Haiku, runda 3) omija bramkę zwracając `status: "ready"` z planem "No implementation needed" i mapując nowe prośby na sąsiednie zdania, łapie to dopiero finalize; (3) reviewer nie dostaje żadnej odpowiedzi per komentarz; (4) u Arthura komentarz niczego nie uruchamia (brak webhooka), a gdy uruchomi, nie ma gwarancji enumeracji.

Cel: każdy otwarty wątek review ma tożsamość, dostaje od agenta dyspozycję z weryfikowalnym dowodem, bot odpowiada w wątku (z SHA, gdy coś zmienił), a stan wątku w VCS jest jedynym rejestrem (zero własnej bazy). Plan przeszedł pre-mortem sceptyka (10 ustaleń, wszystkie wbudowane poniżej; dwa oznaczone jako decyzje produktowe w "Assumptions").

## Problem (z perspektywy użytkownika)

Reviewer komentuje MR i nie wie, czy bot zauważył komentarz, czy uznał go za załatwiony, ani gdzie. Operator widzi czerwone runy "made no commits", które raz znaczą "wszystko już zrobione", a raz "model się wymigał". Oba wyglądają identycznie.

## Solution (z perspektywy użytkownika)

Po każdym runie każdy otwarty wątek na MR ma jeden z czterech losów, widoczny w samym wątku:
- **actionable**: bot pushuje commit, odpowiada "Addressed in `<sha>`: ..." i **rozwiązuje** wątek;
- **already_addressed**: bot odpowiada cytatem z pliku i linią, gdzie to już jest, i **zostawia wątek otwarty** (człowiek zamyka albo odpowiada "nie, chodziło o coś innego");
- **question**: bot odpowiada, wątek zostaje otwarty;
- **out_of_scope**: bot uzasadnia, wątek zostaje otwarty.

Wątek, w którym ostatni wpis to odpowiedź ledgera, jest "u człowieka": nie bramkuje i nie dostaje kolejnej dyspozycji, dopóki człowiek nie dopisze. Niezadowolony reviewer dopisuje albo reotwiera i wątek wraca do kolejki. Run bez otwartych wątków `actionable` kończy się czysto (`no_change_needed`) i mimo to odpowiada w wątkach. Run, w którym model podał dowód nieistniejący w pliku albo pominął wątek, dostaje jeden retry z listą braków, a potem pada z nazwami wątków w błędzie, w komentarzu Jira i w jednej notce na MR.

## User stories

1. Jako reviewer komentuję MR i dostaję w wątku odpowiedź bota z SHA commita oraz zamknięty wątek, żeby bez czytania diffu widzieć, co zostało zrobione.
2. Jako reviewer, gdy bot uważa, że mój komentarz jest już załatwiony, dostaję w wątku cytat i lokalizację, a wątek zostaje otwarty, żebym to ja zdecydował.
3. Jako reviewer, gdy zadam pytanie albo poproszę o coś poza zakresem, dostaję odpowiedź w wątku, a wątek zostaje otwarty.
4. Jako reviewer, gdy run padnie, widzę na MR jedną notkę "run padł na X, wątki bez rozstrzygnięcia: ...", a nie ciszę nieodróżnialną od martwego webhooka.
5. Jako operator widzę, że run bez pracy do wykonania kończy się `no_change_needed`, a nie FAILED; a run, w którym model skłamał o dowodzie albo pominął wątek, pada z listą wątków.
6. Jako zespół Arthura, komentarz na MR (po uruchomieniu webhooka) sam startuje pętlę naprawczą.
7. Jako maintainer mam jeden interfejs wątków dla GitHuba i GitLaba i jedną flagę, którą wracam do starego zachowania bez redeployu.

## Implementation decisions

**Moduł 1: Review thread feed (pogłębienie szwu `VCSAdapter`).** `listReviewThreads(prId)` zwraca wątki nierozwiązane: `{ threadId, alias, source: "human" | "bot" | "third_party", resolvable, awaitingHuman, filePath?, line?, notes: [{ author, body, createdAt, isLedgerReply }] }`.
- `source`: nasz bot przez `vcs-bot-identity`; `third_party` gdy konto ma flagę bota u providera (GitLab `user.bot`, GitHub `type: "Bot"`); reszta `human`.
- `awaitingHuman = true`, gdy ostatnia notka w wątku to odpowiedź ledgera (marker). Takie wątki są w feedzie jako kontekst, ale nie są jednostkami pracy.
- `alias` to `T1..Tn` nadawane przez kod w stabilnej kolejności (po `createdAt` pierwszej notki); model operuje wyłącznie aliasami, mapowanie alias → `threadId` żyje po stronie kodu.
- Limit: feed zwraca najwyżej 20 jednostek pracy (najstarsze pierwsze) i flagę `truncated` z liczbą pominiętych; pominięte trafiają do następnego runu.
- GitLab: `MergeRequestDiscussions.all` (dyskusje indywidualne i wątki; `resolvable` z flagi dyskusji). GitHub: GraphQL `pullRequest.reviewThreads { id isResolved comments }` dla inline plus REST `issues.listComments` dla ogólnych jako wątki `resolvable: false`. Stare `getPRComments`/`PRComment` zostają do etapu 5, potem usunięte.

**Moduł 2: Disposition contract.** Do outputu agenta decydującego dochodzi `reviewThreads: [{ alias, disposition, reply, evidence? }]`, `evidence = { filePath, quote }` obowiązkowe dla `already_addressed`, `reply` obowiązkowy dla `question` i `out_of_scope`. Agent decydujący: planning agent w grafie ticketu, fix agent w lekkiej pętli. W promptcie: "`already_addressed` znaczy obecne na gałęzi TERAZ; jeśli powstanie dopiero w tym runie, to `actionable`". Schemat w dwóch kopiach (zod strict + JSON string dla Codex), test pilnuje zgodności pól.

**Moduł 3: Review ledger (czysta logika, nowy szew).**
- `verifyDispositions(workItems, dispositions, readFile)` → `{ accepted, rejected: [{ alias, reason }] }`. Odrzuca: jednostkę pracy bez dyspozycji, dyspozycję z nieznanym aliasem, `already_addressed` bez dowodu, dowód z cytatem nieobecnym w pliku (porównanie po normalizacji białych znaków), a dla wątków inline dowód spoza `filePath` wątku albo dalej niż 40 linii od `line` wątku. `already_addressed` na wątku `source: "bot"` jest odrzucane (bot nie ocenia sam siebie; dla wątku bota dozwolone tylko `actionable`, `question`, `out_of_scope`).
- `resolveReviewGate({ workItems, verification, research, retryUsed })` → `"proceed" | "no_change" | "retry" | "fail"`: `proceed` gdy ≥1 zaakceptowana `actionable`; `no_change` gdy `workItems.length > 0`, zero odrzuceń, zero `actionable` i research nie deklaruje zapisów; `no_change` także gdy `workItems.length === 0` i spełnione są dzisiejsze warunki `resolveNoChangeAction` (ta ścieżka nie zmienia się); `retry` gdy są odrzucenia i retry nieużyty; `fail` po retry.
- Moment weryfikacji: dowody `already_addressed` sprawdzane na drzewie gałęzi w chwili decyzji (przed implementacją). Po implementacji, przed publikacją, drugi przebieg tylko dla `already_addressed`: jeśli cytat zniknął (implementacja przepisała plik), odpowiedź w wątku degraduje się do "zmienione w `<sha>`, proszę o ponowne spojrzenie", bez cytatu. Żadne odrzucenie po implementacji nie wyrzuca wykonanej pracy.
- Ten sam moduł produkuje treść notatki korygującej (lista odrzuconych aliasów z powodami), treść błędu końcowego i treść notki awaryjnej na MR.

**Moduł 4: Thread settler (nowa metoda na `VCSAdapter`).** `settleReviewThread({ prId, thread, body, resolve, snapshotAt })`:
- Przed zapisem odświeża wątek. Jeśli po `snapshotAt` pojawiła się ludzka notka, odpowiada bez resolve. Jeśli w wątku jest już marker ledgera dla tego `threadId`, a od tamtej pory nie było ludzkiej notki, nic nie robi (idempotencja kluczowana `threadId`, SHA jest treścią, nie kluczem).
- Marker: `<!-- ai-workflow:ledger:<threadId> -->` w komentarzu HTML (jak `AI_WORKFLOW_COMMENT_MARKER`).
- GitLab: notka w dyskusji (dla notki indywidualnej: POST do jej `discussion_id`, wynik spike'u z etapu 0 decyduje, czy to tworzy wątek) + `PUT resolved=true` tylko gdy `resolve && resolvable`. GitHub: `createReplyForReviewComment` + GraphQL `resolveReviewThread` (inline, po node id z feedu) albo zwykły komentarz z cytatem (ogólne).
- Wątki `resolvable: false` nigdy nie są rozwiązywane; ich stan "u człowieka" wynika wyłącznie z markera w tej samej dyskusji, bez reguł czasowych globalnych dla MR.
- Dodatkowo `postRunFailureNote(prId, body)`: jedna ogólna notka na MR, z markerem `<!-- ai-workflow:ledger-failure:<runId> -->` (idempotentna per run).

**Moduł 5: Publish guard.** W `summarize` publishera brak zmian jest OK wtedy i tylko wtedy, gdy run miał ≥1 jednostkę pracy, weryfikacja nie ma odrzuceń i zero dyspozycji to `actionable`. Run bez wątków (zwykły ticket) zachowuje dzisiejszy guard bez zmian. Brak zmian przy `actionable` = błąd z listą aliasów.

**Moduł 6: Settle jako funkcja runtime.** `settleReviewThreads(ctx, adapter, { headSha? })` wołana z trzech miejsc: (a) `finalize_workspace` po udanej publikacji (graf ticketu i lekka pętla, obie przez niego przechodzą), (b) terminal `no_change_needed` w grafie ticketu, (c) ścieżka awaryjna runu z otwartymi jednostkami pracy (`postRunFailureNote`). Jedna faza, sekwencyjnie, najwyżej 20 wątków, każdy błąd settlera ląduje w `settled[].error` bez cofania publikacji i bez czerwienienia runu. `actionable` → "Addressed in `<headSha>`: `<reply>`" + resolve; `already_addressed` → cytat + lokalizacja, bez resolve; `question`/`out_of_scope` → `reply`, bez resolve. `headSha` liczony w finalize po wszystkich commitach (także auto-fixach checków). Bez nowego typu bloku.

**Flaga.** `REVIEW_LEDGER_ENABLED` (env, domyślnie `false`). Wyłączona: feed i prompt jak dziś, `resolveNoChangeAction` jak dziś, brak settle. Włączona: wszystko powyżej. Stary kod usuwany dopiero po dwóch tygodniach z flagą włączoną u Arthura (osobny PR).

**Prompt.** Sekcja remediation renderuje jednostki pracy z aliasami, źródłem, plikiem/linią i pełną treścią notek; wątki `awaitingHuman` osobno jako kontekst "czeka na człowieka, nie dysponuj"; instrukcja dyspozycji i zasada "TERAZ vs w tym runie". "Resolution Check" pomijany, gdy są jednostki pracy (jak dziś).

**Trigger.** Bez nowego triggera: `trigger_pr_review` już parsuje GitHub review/comment i GitLab MR `note` z filtrem echa bota, a szablon builtin pętli naprawczej ma węzeł `trigger-review`. Test w etapie 5 potwierdza, że odpowiedź settlera (z markerem) nie przechodzi przez filtr echa także jako review thread reply, inaczej ledger napędzałby sam siebie.

**Metryki.** Log strukturalny `review_ledger` per run: liczba jednostek pracy, dyspozycje per typ, odrzucenia, `truncated`, settle errors; zdarzenie `review_ledger.reopened`, gdy feed widzi wątek z markerem ledgera i nowszą ludzką notką (to licznik "model skłamał o already_addressed").

## Seams and test decisions

| Szew | Obserwowane zachowanie | Prior art | TDD |
| --- | --- | --- | --- |
| `VCSAdapter.listReviewThreads` | wątki rozwiązane wykluczone; `source` bot/human/third_party; `awaitingHuman` po markerze; aliasy stabilne; limit 20 + `truncated` | `gitlab.ts:1044`, `github.ts:473`, `lib/vcs-bot-identity.ts:10-45` | tak |
| `review-ledger.verifyDispositions` | brak dyspozycji → rejected; nieznany alias → rejected; cytat nieobecny → rejected; cytat spoza pliku/okna wątku inline → rejected; `already_addressed` na wątku bota → rejected; komplet poprawnych → accepted | nowy szew, potwierdzony w Q4 | tak |
| `review-ledger.resolveReviewGate` | zero jednostek pracy → dzisiejsza logika; `actionable` → `proceed`; same nie-actionable bez odrzuceń → `no_change`; odrzucenia → `retry` raz, potem `fail` | `agent.ts:2181-2198`, `workflows/agent-no-change.test.ts` | tak |
| `VCSAdapter.settleReviewThread` | marker per `threadId`; powtórne wywołanie bez nowej ludzkiej notki nic nie robi; ludzka notka po snapshot → odpowiedź bez resolve; `resolvable:false` nigdy resolve | `gitlab.ts:886`, `gitlab.ts:840`, `github.ts:133` | tak |
| publisher `summarize` | (jednostki pracy, brak odrzuceń, brak actionable, brak zmian) → ok; (actionable, brak zmian) → błąd z aliasami; (brak jednostek pracy, brak zmian) → błąd jak dziś | `sandbox/trusted-workspace-publisher.ts:774-791` | tak |
| prompt remediation | jednostki pracy z aliasami i bez "Resolution Check"; `awaitingHuman` jako kontekst; bez wątków → jak dziś | `sandbox/context.ts:560-575`, `sandbox/context.test.ts` | tak |
| echo filter triggera | notka settlera z markerem nie tworzy dostawy `trigger_pr_review` (GitLab note, GitHub review comment) | `lib/trigger-events.ts:214,254,423` | tak |

## Out of scope

- Tabela ledgera w dashboardzie (trace pokazuje JSON outputu bloków).
- Rejestracja webhooka GitLaba u Arthura (osobny krok ops, sekret gotowy).
- Debounce / okno koalescencji komentarzy.
- Przeprojektowanie wycofywania OUTDATED wątków reviewera (AIW-236); ledger je tylko omija.
- E2E na GitHubie; adresowanie wątków `third_party` (CodeRabbit, skanery): w v1 wyłącznie kontekst.
- Atrybucja commit ↔ wątek; podsumowanie edytowane w miejscu; DB, migracje.

## Assumptions

1. **Wątki bota na równi z ludzkimi (Q3), z jednym wyjątkiem:** ledger nie przyjmuje `already_addressed` na wątku bota (bot nie zamyka własnych wniosków bez commita). Rozwiązanie wątku bota po `actionable` z commitem to prawdziwe "naprawione", inne niż retirement OUTDATED; `retireSupersededDiscussions` pomija `entry.resolved` (`gitlab.ts:846`), więc ścieżki się nie gryzą.
2. **`already_addressed` nie rozwiązuje wątku (zmiana względem Q1).** Decyzja produktowa do potwierdzenia: Q1 brzmiało "bot resolve + reopen", ale przy `already_addressed` w pętli nie ma człowieka, a rozwiązany wątek znika z feedu, więc błąd modelu zacierałby się sam. Resolve zostaje tylko przy `actionable` z commitem. Jeśli użytkownik woli resolve wszędzie, zmienia się jedna stała w module 6 i jeden test.
3. **Notka awaryjna na MR przy padniętym runie (user story 4).** Decyzja produktowa: więcej szumu na MR, ale bez tego reviewer nie odróżnia padniętego runu od martwego webhooka (historyczny stan u Arthura). Przyjęta, jedna notka per run, idempotentna.
4. **Bez debounce.** Pending trigger + czysty `no_change` wystarczą funkcjonalnie; koszt: run no-op zajmuje slot dispatchu (3 sloty na prodzie). Metryka `review_ledger` z `workItems = 0 && trigger = pr_review` pokaże skalę; jeśli > 20% runów z triggera, dołożymy opóźnienie w `trigger_pr_review` osobnym PR-em.
5. **Dowód czytany z klonu gałęzi w workspace'ie** w fazie decyzji (`preserveAcrossBlocks: true`), przez port odczytu plików sandboxa; fallback `git show HEAD:<path>` w klonie. Drzewo = HEAD gałęzi roboczej w chwili decyzji; po implementacji drugi przebieg na drzewie publikowanym (moduł 3).
6. **Ścieżka `no_change` w grafie ticketu zostaje** (komentarz Jira, Slack, status), tylko warunek wejścia zmienia się na wynik bramki ledgera, a przed nią woła się settle.
7. **Oba adaptery w v1**, weryfikacja na żywo tylko na GitLabie; dla GitHuba kształt GraphQL (node id wątku, `resolveReviewThread`) potwierdzony w etapie 0 jednym zapytaniem do prawdziwego PR-a w repo testowym, nie tylko fixture'em.
8. **Budżet runów per PR:** `trigger_pr_review` ma mieć to samo ograniczenie co `maxFixAttemptsPerPr` w `trigger_pr_checks_failed`; jeśli go nie ma (sprawdzane w etapie 0), dochodzi pole w block-registry i odbicie w docs/workflow-workspace/index.html (wtedy etap 5 rośnie o to).
9. **Limit 20 jednostek pracy** jest arbitralny; przekroczenie jest jawne (`truncated`) i trafia do następnego runu.

## Stages

| # | Stage | Seam | File scope | Tier | Skeptic | TDD | Delegation | DoD |
|---|-------|------|------------|------|---------|-----|------------|-----|
| 0 | Spike (bez kodu produkcyjnego): na MR w `ai-workflow-integration-test` sprawdzić przez `glab api`, czy POST notki do `discussion_id` notki indywidualnej tworzy wątek resolvable; na PR testowym GitHuba jedno zapytanie GraphQL `reviewThreads` + `resolveReviewThread`; sprawdzić, czy `trigger_pr_review` ma limit prób per PR | kontrakt | `docs/plans/2026-08-21-review-ledger-spike.md` | sonnet | nie | nie | nie | Notatka z trzema odpowiedziami tak/nie i surowymi odpowiedziami API; wynik wpisany do Assumptions 2/7/8 przed startem etapu 1 |
| 1 | Kontrakty: `ReviewThread`, `ReviewThreadDisposition`, `ReviewLedgerState` w `ctx`, nowe metody na `VCSAdapter` (adaptery: `throw notImplemented`), pola `reviewThreads` w obu kopiach schematów research i agent, flaga `REVIEW_LEDGER_ENABLED` w env | kontrakt (zamraża interfejs dla 2a/2b/3/4/6) | `adapters/vcs/types.ts`, `sandbox/agents/types.ts`, `sandbox/agents/types.test.ts`, `lib/env.ts` (lub plik flag) | sonnet | nie | tak | nie | `cd apps/worker && pnpm build:shared && pnpm vitest run src/sandbox/agents/types.test.ts` zielone; test zgodności pól zod vs JSON; `pnpm tsc --noEmit` w apps/worker czyste |
| 2a | GitLab: `listReviewThreads` + `settleReviewThread` + `postRunFailureNote` | thread feed, settler | `adapters/vcs/gitlab.ts`, `adapters/vcs/gitlab.test.ts` | opus | nie | tak | nie | `pnpm vitest run src/adapters/vcs/gitlab.test.ts` zielone: rozwiązany wykluczony; systemowa wykluczona; `source` bot/human/third_party; `awaitingHuman` po markerze; aliasy stabilne; limit 20 + `truncated`; settle idempotentne po `threadId`; ludzka notka po snapshot → bez resolve; `resolvable:false` bez resolve |
| 2b | GitHub: `listReviewThreads` (GraphQL reviewThreads + REST ogólne) + `settleReviewThread` (reply + `resolveReviewThread`) + `postRunFailureNote` | thread feed, settler | `adapters/vcs/github.ts`, `adapters/vcs/github.test.ts` | opus | nie | tak | nie | `pnpm vitest run src/adapters/vcs/github.test.ts` zielone z przypadkami jak 2a plus: ogólny komentarz jako `resolvable:false`; node id wątku niesiony z feedu do resolve |
| 3 | Review ledger: `verifyDispositions`, `resolveReviewGate`, treść notatki korygującej, błędu końcowego i notki awaryjnej | verifier, gate | `workflows/review-ledger.ts`, `workflows/review-ledger.test.ts` | opus | tak | tak | nie | `pnpm vitest run src/workflows/review-ledger.test.ts` zielone: wszystkie przypadki z tabeli szwów (11 scenariuszy), w tym okno 40 linii i zakaz `already_addressed` na wątku bota |
| 4 | Publish guard zawężony do runów z jednostkami pracy | publisher | `sandbox/trusted-workspace-publisher.ts`, `sandbox/trusted-workspace-publisher.test.ts` | sonnet | tak | tak | nie | `pnpm vitest run src/sandbox/trusted-workspace-publisher.test.ts` zielone: 3 przypadki z tabeli szwów; przypadek "brak wątków + brak zmian" nadal czerwony |
| 6 | Settle runtime: `settleReviewThreads` + `postRunFailureNote` jako helper, wpięty w `finalize_workspace`; output `settled[]`; błędy per wątek bez czerwienienia | settler w runtime | `workflows/review-ledger-settle.ts`, `workflows/review-ledger-settle.test.ts`, `workflows/blocks/finalize-workspace.ts`, `workflows/blocks/finalize-workspace.test.ts` | opus | tak | tak | nie | `pnpm vitest run src/workflows/review-ledger-settle.test.ts src/workflows/blocks/finalize-workspace.test.ts` zielone: 4 dyspozycje → 4 wywołania z właściwym `resolve` (tylko `actionable`); błąd jednego wątku → `settled[].error`, publikacja nietknięta, blok ok; `headSha` z drzewa po wszystkich commitach; bez `ctx` ledgera blok zachowuje się jak dziś |
| 5 | Wiring ścieżek agentów za flagą: `fetch-pr-context` → `listReviewThreads` (output z licznikami per source i `truncated`), `context.ts` renderuje aliasy i `awaitingHuman`, `agent.ts` woła ledger zamiast `resolveNoChangeAction` (retry z notatką, fail z listą, settle przed terminalem `no_change`, notka awaryjna przy fail), `fix-agent.ts` przekazuje wątki i zbiera dyspozycje, drugi przebieg weryfikacji przed publikacją, log `review_ledger`; test filtra echa dla notki settlera | prompt remediation, gate w runtime, echo filter | `workflows/agent.ts`, `workflows/blocks/fetch-pr-context.ts`, `workflows/blocks/fix-agent.ts`, `sandbox/context.ts`, `sandbox/context.test.ts`, `workflows/agent-no-change.test.ts`, `workflows/blocks/fetch-pr-context.test.ts`, `lib/trigger-events.test.ts` | opus | tak | tak | nie | `pnpm vitest run src/sandbox/context.test.ts src/workflows/agent-no-change.test.ts src/workflows/blocks/fetch-pr-context.test.ts src/lib/trigger-events.test.ts` zielone; context.test: aliasy, brak "Resolution Check", sekcja `awaitingHuman`; agent-no-change.test: `retry` → `fail` z listą aliasów, `no_change` z settle, flaga off = stare zachowanie bajt w bajt; trigger-events.test: notka z markerem ledgera odrzucona jako echo |
| 7 | Weryfikacja e2e na naszym prodzie (flaga on), GitLab, repo `ai-workflow-integration-test`: runda A (1 actionable + 1 already_addressed), runda B (pytanie + out_of_scope), runda C (bez nowych komentarzy), runda D (reviewer dopisuje w wątku `already_addressed`), runda E (wymuszony fail przez padające checki); aktualizacja docs/qa | całość | `docs/qa/2026-08-XX-review-ledger-e2e.md` + assets | sonnet | nie | nie | tak (zrzuty, tabela) | A: actionable z SHA + resolved, already_addressed z cytatem + otwarty; B: obie odpowiedzi, oba otwarte; C: `no_change_needed`, zero nowych notek; D: wątek wraca jako jednostka pracy, `review_ledger.reopened` w logu; E: jedna notka awaryjna na MR z listą aliasów; dokument z linkami do runów i zrzutami |

Kolejność: 0 → 1 → (2a ∥ 2b ∥ 3 ∥ 4) → 6 → 5 → 7. Zakresy plików rozłączne; 2a/2b/3/4 po zamrożeniu kontraktu w 1; 6 po 2a/2b (adaptery) i 1; 5 po 3 i 6 (importuje oba); 7 po 5.

## Verification (całość)

1. Jednostkowo: komendy z DoD, każda osobno (bez pełnych suit lokalnie; szeroko przez CI na PR do `main`).
2. Typy: `cd apps/worker && pnpm tsc --noEmit`.
3. Flaga off na naszym prodzie przez pierwszy deploy (deploy i flaga to dwa kroki, zob. pamięć o awarii 12.08); włączenie flagi = osobny krok po `/cron/poll` 200.
4. E2E etap 7 przez MCP `workflows_dispatch_preflight` + `workflows_dispatch` (def 14 / def 30) i `glab api` do komentarzy; dowody w docs/qa jak 21.08.
5. Po merge: release do Arthura procedurą `artur-release` z flagą off; włączenie u Arthura po rundzie obserwacji metryki `review_ledger` u nas; `trigger-review` w definicji pętli naprawczej i webhook to kroki ops po wydaniu.

## Rollback

Flaga `REVIEW_LEDGER_ENABLED=false` przywraca dzisiejszą ścieżkę bez redeployu kodu (zmiana env + redeploy Vercela). Markery w wątkach są nieszkodliwe dla starej ścieżki (wchodzą do promptu jak każda notka bota).

## Pułapki

- Dwie ręcznie utrzymywane kopie schematu outputu agenta (`types.ts:180-198` zod, `:201-298` JSON): zmiana w jednej bez drugiej psuje Codex strict mode.
- `neon-http` bez transakcji: ledger celowo nie pisze do DB.
- Unikalność nazw stepów WDK: settle to jeden step na blok, nie step per wątek; sufiks fazy `-no-change-retry` (`agent.ts:4678`) zostaje unikalny.
- Sufit 300 s na inwokację: settle sekwencyjnie, maks 20 wątków, bez retry w pętli; resztę dokańcza następny run (wątki zostają otwarte).
- GitHub `resolveReviewThread` wymaga GraphQL node id wątku, nie REST id komentarza.
- Model nigdy nie widzi surowych `threadId`; każdy błąd "nieznany alias" to błąd kodu mapującego, nie modelu.
- Odpowiedź settlera musi nieść marker bota, inaczej `trigger_pr_review` uruchomi run na własnej odpowiedzi.

## Wyniki etapu 0 (spike, 2026-08-21)

Szczegóły i surowe odpowiedzi API: `docs/plans/2026-08-21-review-ledger-spike.md`.

- **Assumption 2 rozstrzygnięte: TAK.** Odpowiedź do zwykłej notki GitLaba (POST do jej `discussion_id`) przestawia `individual_note` na `false`, a notki stają się `resolvable: true`; `PUT resolved=true/false` działa. Settler na GitLabie: najpierw reply, potem resolve, w tej kolejności, bez fallbacku na ogólną notkę.
- **Assumption 7 rozstrzygnięte: TAK.** GitHub GraphQL `reviewThreads` daje `id` (`PRRT_...`) i `isResolved`; REST `node_id` komentarza (`PRRC_...`) siedzi w `thread.comments.nodes[].id`, nie jest id wątku. `resolveReviewThread`, `unresolveReviewThread` i REST `/replies` działają.
- **Assumption 8 rozstrzygnięte: NIE ma limitu.** `trigger_pr_review` (`block-registry.ts:470-516`) nie ma pola limitu, a `prAutofixCapReached` (`dispatch-trigger.ts:520-524`) zwraca false dla każdego triggera poza `trigger_pr_checks_failed`. Dochodzi etap 5b.

| # | Stage | Seam | File scope | Tier | Skeptic | TDD | Delegation | DoD |
|---|-------|------|------------|------|---------|-----|------------|-----|
| 5b | Limit runów per PR dla `trigger_pr_review`: pole `maxRunsPerPr` w block-registry (domyślnie 5, wzorzec `maxFixAttemptsPerPr`), `prAutofixCapReached` uogólnione na oba triggery, odbicie pola w docs/workflow-workspace/index.html | dispatch cap | `workflow-definition/block-registry.ts`, `lib/dispatch-trigger.ts`, `lib/dispatch-trigger.test.ts`, `docs/workflow-workspace/index.html` | sonnet | tak (dispatch to inwariant bezpieczeństwa) | tak | nie | `pnpm vitest run src/lib/dispatch-trigger.test.ts` zielone: 6. dostawa `trigger_pr_review` na ten sam PR odbita jako cap; `trigger_pr_checks_failed` zachowuje się jak dziś; `index.html` ma nowe pole w kontrakcie runtime |

Etap 5b startuje po etapie 1 (nie zależy od kontraktu ledgera, ale trzyma jedną kolejkę bramek) i ma zakres rozłączny z 2a/2b/3/4/6/5.
