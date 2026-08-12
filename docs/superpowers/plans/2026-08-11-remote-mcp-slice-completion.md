# Remote MCP — dokończenie pierwszego vertical slice

**Data:** 2026-08-11
**Branch:** `feat/ai-workflow-remote-mcp` (worktree `.worktrees/ai-workflow-remote-mcp`). Baza to dziś `092ba523`, czyli dwanaście commitów za `origin/main`; etap `A0` przenosi branch na `origin/main`.
**Wejście:** `docs/superpowers/specs/2026-08-11-ai-workflow-remote-mcp-design.md`, `docs/superpowers/plans/2026-08-11-ai-workflow-remote-mcp-first-slice.md`
**Ten dokument zastępuje** tamten plan w zakresie Tasków 6-13. Taski 1-5 są zrobione i zielone.

## Problem

Agent w Claude Code albo Codeksie nie ma jak pracować na AI Workflow bez dashboardu. Żeby zobaczyć, czemu run padł, trzeba otworzyć przeglądarkę, znaleźć run, przeklikać się przez trace. Żeby odpalić workflow, trzeba kliknąć w UI. Agent, który ma naprawić problem, jest odcięty od kontekstu, który sam mógłby sobie wziąć.

## Rozwiązanie

Worker wystawia `https://<worker>/mcp`. Agent podłącza ten adres raz, przechodzi OAuth w przeglądarce i od tej pory z poziomu rozmowy: czyta ticket i jego runy, pobiera status, trace, wynik i deterministyczną diagnozę padniętego runu, a jeśli ma rolę i scope, odpala opublikowany workflow i polluje go do końca. Bez dashboardu, bez ręcznego czytania logów, bez kopiowania sekretów.

## Stan zastany (zweryfikowany, nie założony)

Codex dowiózł 9 commitów, 53 pliki, +12 499 linii. Weryfikacja lokalna: `vitest run src/mcp src/db/mcp-foundation-migration.test.ts src/db/auth-schema.test.ts env.test.ts src/auth.test.ts` → **18 plików, 171 testów, exit 0**.

Gotowe i zielone:

- konfiguracja MCP w `env.ts` (wzorzec `z.enum(["true","false"]).transform(...)`, zgodny z repo);
- migracja z tabelami `mcp_audit_events`, `mcp_idempotency_keys`, `mcp_rate_limit_windows`, `oauth_client`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent`;
- Better Auth jako OAuth Authorization Server (`@better-auth/oauth-provider@1.6.20`, peer `better-auth ^1.6.20` spełniony przez zainstalowane `1.6.20`), DCR domyślnie odrzucane;
- strony logowania i zgody pod `/mcp-auth/*` plus RFC 9728 metadata i forwarding discovery — **to jest ponad plan Codexa, plan tego nie przewidywał**;
- `McpActorContext`, `policy.ts`, `audit-store.ts`, `idempotency-store.ts`, `rate-limit-store.ts`, `sanitize-result.ts`, `execute-tool.ts`;
- stateless Streamable HTTP: `POST /mcp` działa, `GET`/`DELETE` zwracają 405, body czytane strumieniowo z twardym limitem.

`McpToolDependencies` ma już `db`, `adapters`, `actor`, `requestId`, `traceId`, `now`, a `transport.ts:105-111` buduje je przez `createAdapters()`. Kontrakt zależności jest zamrożony i nie wymaga zmian.

`contracts.ts:7` (`FIRST_SLICE_TOOLS`) i `policy.ts:53` deklarują komplet dziewięciu narzędzi slice'u, ale `server.ts` rejestruje **tylko** `system.capabilities`. Cały pozostały zakres to wypełnienie zamrożonego już kontraktu.

Brakuje: `mcp/tools/*`, `mcp/run-diagnosis.ts`, `mcp/tool-catalog.ts`, `mcp/contracts/mcp-contract.json`, `scripts/generate-mcp-contract.ts`, `scripts/mcp-smoke.ts`, `routes/api/v1/system/mcp-readiness.get.ts`.

## User stories

1. Jako developer chcę podłączyć `/mcp` w Claude Code i przejść logowanie w przeglądarce, żeby agent działał w moim imieniu, z moją rolą i tylko tymi uprawnieniami, na które się zgodziłem.
2. Jako developer chcę poprosić agenta o ticket i jego runy, żeby nie szukać ich ręcznie w Jirze i dashboardzie.
3. Jako developer chcę, żeby agent pobrał status, trace i wynik konkretnego runu, żeby zdiagnozował padnięcie bez mojego udziału.
4. Jako developer chcę dostać deterministyczną klasyfikację przyczyny padnięcia, żeby agent nie zgadywał i żeby ta sama awaria zawsze nazywała się tak samo.
5. Jako administrator chcę odpalić opublikowany workflow przez agenta, po uprzednim preflighcie, żeby nie wchodzić do dashboardu.
6. Jako administrator chcę, żeby powtórzenie tego samego dispatchu nie odpaliło drugiego runu, nawet gdy pierwsza odpowiedź do mnie nie dotarła.
7. Jako administrator chcę, żeby member mógł czytać, ale nie odpalać, i żeby brak scope'u był rozróżnialny od braku roli.
8. Jako operator chcę widzieć w audycie każdy call, łącznie z odrzuconym, żeby wiedzieć, kto czego próbował.
9. Jako operator chcę, żeby żadna odpowiedź ani log nie zawierały sekretów ani treści, która mogłaby sterować agentem.
10. Jako operator chcę wyłączyć `/mcp` jedną zmienną, bez wpływu na `/api/v1`, webhooki i cron.

## Decyzje implementacyjne

**Rejestracja narzędzi.** Każdy plik `mcp/tools/<domena>.ts` eksportuje `register<Domena>Tools(server, deps)`. `server.ts` woła te funkcje. Dzięki temu etapy pisania narzędzi mają całkowicie rozłączne pliki, a `server.ts` jest dotykany raz, w etapie wiringu. Testy każdej domeny budują własny `McpServer`, rejestrują tylko swoje narzędzia i wołają je przez SDK.

**Każde narzędzie przechodzi przez `executeMcpRead` albo `executeMcpMutation`.** Handler nie woła bezpośrednio adapterów ani bazy poza `operation`. To jest jedyne miejsce, gdzie żyją autoryzacja, rate limit, audyt, idempotencja, timeout i redakcja. Drugi tor jest naruszeniem planu.

**Trust.** `sanitize()` w `execute-tool.ts` domyślnie znaczy dane jako `external_untrusted`. Narzędzie, którego wynik pochodzi wyłącznie z konfiguracji deploymentu, nadpisuje `envelope.meta.trust` po fakcie, tak jak robi to dziś `system.capabilities`.

**Terminalność runu ma jedną definicję i jest nią `awaiting` włącznie.** Repo jest niespójne: `run-detail-read.ts:23` liczy `awaiting` jako terminalny, `run-observability/store.ts:309-313` nie. MCP wybiera wariant z `run-detail-read`, bo `awaiting` znaczy, że run czeka na człowieka, więc agent ma przestać pollować, a nie kręcić się w pętli do timeoutu. Rozstrzyga to jedna eksportowana funkcja `isTerminalRunStatus` w `contracts.ts`, zamrożona w etapie `A4`, żeby `tickets.list_runs` i `runs.get` nie odpowiadały na to pytanie niezależnie.

**Brak replaya jest stanem, nie pustką.** `getRunReplay` nigdy nie zwraca `null`: oddaje `availability` w wariantach `not_captured`, `expired` albo `available`, a przy pozostałych zwraca puste `attempts` i `snapshot: null` (`run-observability/store.ts:966-1024`). `runs.trace` przekazuje ten wariant dalej zamiast udawać, że run nie ma zdarzeń. Warto wiedzieć, że sprawdzenie organizacji w tym module przepuszcza runy z `organizationId = NULL` (`store.ts:930`), co jest kolejnym potwierdzeniem Założenia 1.

**Diagnoza jest czystą funkcją.** `run-diagnosis.ts` nie dotyka bazy ani adapterów, nie wykonuje żadnego LLM. Zamrożony kontrakt:

```ts
export type RunDiagnosisCategory =
  | "succeeded" | "running" | "awaiting_input" | "cancelled"
  | "never_started" | "no_workflow_matched" | "stopped_without_reason"
  | "dependency_auth" | "dependency_unavailable"
  | "sandbox_timeout" | "workspace_unavailable" | "workspace_gate"
  | "validation_failed" | "budget_exhausted" | "engine_error"
  | "step_failed"
  | "unknown";

export type RunDiagnosis = {
  category: RunDiagnosisCategory;
  confidence: "high" | "low";
  evidenceRefs: string[];   // stabilne referencje do attemptId/blockId, nigdy treść
  nextActions: string[];    // stała lista fraz, nie tekst generowany
};

export function diagnoseRun(input: {
  status: "success" | "running" | "failed" | "blocked" | "awaiting";
  error: { code?: string; message?: string } | null;
  steps: ReadonlyArray<{
    stepId: string;
    name: string;
    status: string;
    error?: { code?: string; message?: string } | null;
  }>;
}): RunDiagnosis;
```

Sygnatura celowo powtarza kształt, który realnie oddaje `RunDetail`/`RunStep` (`apps/shared/contracts/domain.ts:162-179`), żeby etap `B2` nie musiał budować stratnego adaptera.

Reguły są uporządkowane, pierwsza pasująca wygrywa, a brak dopasowania daje `unknown` z `confidence: "low"`. Nigdy nie zwraca treści logu.

Dwa ustalenia z implementacji, które zmieniły ten kontrakt. Po pierwsze, `RunError.code` w tym systemie **nie jest taksonomią przyczyn**, tylko identyfikatorem korelacyjnym `AIW-DIAG-` (`lib/overview/sanitize-run-detail.ts:60-68`), więc żadna kategoria przyczynowa nie może dostać `confidence: "high"` z kodu błędu. Wysoką pewność dają wyłącznie sygnały strukturalne: status runu i status kroku. Reguły oparte na treści komunikatu kotwiczą się na `startsWith` względem zdań generowanych przez sam system (`workflow-definition/failure-message.ts`, `interpreter.ts:88`), nigdy na tekście, na który ma wpływ ktoś z zewnątrz, i zawsze dają `confidence: "low"`. Po drugie, doszła kategoria `awaiting_input`: pierwotna lista nie miała jej wcale, więc run zaparkowany w oczekiwaniu na człowieka spadał do `unknown` z akcją „obejrzyj trace ręcznie", co sugeruje awarię tam, gdzie stan jest doskonale znany. Jest to jednocześnie najczęstsze pytanie, jakie agent zada o stojący run.

**Dwie warstwy idempotencji dispatchu muszą się zgadzać.** `dispatchManualWorkflow` (`manual-dispatch/service.ts:94`) ma własną idempotencję: `requestId` plus `payloadHash`, ten sam hash zwraca zapisany wynik, inny daje konflikt. `executeMcpMutation` ma swoją, na `mcp_idempotency_keys`. Trzy rzeczy muszą być prawdą naraz, bo inaczej warstwy się rozjeżdżają:

1. **`requestId` wyprowadzany jest z tożsamości leasingu MCP, nie z surowego klucza.** Klucz MCP wygasa po 24 h i jest odzyskiwany, a wiersz w `manual_dispatch_requests` nie wygasa nigdy. Wyprowadzenie `requestId` z samego `(organizationId, actorSubject, clientId, tool, idempotencyKey)` znaczy, że po odzyskaniu klucza agent dostanie `status: "started"` z `runId` sprzed doby, bez nowego runu i bez błędu. Dlatego materiałem jest `leaseId` przydzielony przez `beginMcpMutation`, który jest nowy po każdym odzyskaniu.
2. **Nieterminalne wyniki nie trafiają do `completeMcpMutation`.** `dispatchManualWorkflow` legalnie zwraca `status: "recovering"` bez `runId` z co najmniej sześciu miejsc (`service.ts:162, 321, 402, 428, 452, 465, 476`); run startuje dopiero z crona odzyskującego. Utrwalenie takiej odpowiedzi zamraża ją na 24 h: agent w nieskończoność dostaje „nie udało się", podczas gdy run pracuje na jego tickecie. `recovering` zwalnia leasing i wraca do agenta jako wynik retryowalny z `pollAfterMs`.
3. **Błędy przejściowe nie są utrwalane jako terminalne, a ponowienie musi dostać nowy leasing.** Zweryfikowane w kodzie i sprzeczne z pierwotnym założeniem: `markManualDispatchFailed` ustawia wiersz `manual_dispatch_requests` na `failed` dla **każdego** kodu, łącznie z `at_capacity` (`service.ts:296-312`), a `listRecoverableManualDispatches` filtruje po `pending|reserved|prepared|candidate_started` (`store.ts:236-251`), więc cron nigdy takiego żądania nie ponowi. Wniosek: po chwilowym braku mocy ten konkretny `requestId` jest martwy na zawsze i jedyną drogą ponowienia jest **nowy** `requestId`. To czyni punkt 1 nie higieną, tylko warunkiem działania: leasing MCP zwolniony po błędzie przejściowym musi przy ponowieniu wydać nowy `leaseId`, bo z niego wyprowadzany jest `requestId`. Gdyby ponowienie dostawało ten sam `leaseId`, agent zostałby z kluczem, który już nigdy nie odpali runu. Utrwalane jako `failed` są wyłącznie kody trwałe (walidacja, brak uprawnień, nieaktualna wersja); `safeReplayMessage` (`idempotency-store.ts:59-72`) i tak degraduje utrwalony błąd do gołego „Conflict" z `retryable: false`.

Rozjazd tych warstw jest głównym ryzykiem etapu B3 i każdy z tych trzech punktów ma własny test.

**Korekta po bramce A2: `active_runs` nie jest zabezpieczeniem przed podwójnym dispatchem.** Zakładałem, że nawet gdy warstwa MCP przepuści ponowienie, rezerwacja subjectu je zatrzyma. Nie zatrzyma: `release()` kasuje wiersz w chwili **zakończenia** runu (`adapters/run-registry/postgres.ts:400-413`), więc jest to zamek współbieżności, a nie idempotencji. Odtworzony przebieg: dispatch startuje, po 30 s wyścig zwraca `TIMEOUT` z radą „ponów tym samym kluczem", invocation zamarza, run kończy się w 200 s i zwalnia rezerwację, agent ponawia w 301 s, leasing już wygasł, klucz zostaje przejęty i powstaje drugi realny run na tym samym tickecie.

Wynikają z tego dwie reguły, które zastępują wcześniejsze:

- **Kryterium zwolnienia leasingu to nie `retryable`, tylko „czy wiemy na pewno, że efekt nie wylądował".** Zwolnić wolno wyłącznie przy błędach powstałych, zanim serwis dispatchu mógł cokolwiek uruchomić (`at_capacity`, `active_run`, `deployment_changed`, `invalid_input`, `not_eligible`). Każdy inny przypadek, łącznie z „nie wiem", utrwala leasing. Cena pomyłki w jedną stronę to drugi run na cudzym tickecie, w drugą tylko konieczność użycia nowego klucza.
- **Timeout utrwala leasing jako terminalny, zamiast zostawiać go w stanie `started`.** Inaczej po wygaśnięciu leasingu wiersz jest przejmowalny, mimo że dispatch mógł wystartować. Odtwarzany błąd terminalny jest `retryable: false` i kieruje do `runs.get` oraz do nowego klucza, bo ponawianie tego samego klucza nigdy już nie zmieni stanu, a obiecywanie postępu daje 24-godzinny livelock.

**Leasing mutacji wygasa szybciej niż odpowiedź.** Dziś jedno `expiresAt` (24 h, `execute-tool.ts:21`) rządzi i odzyskiwaniem porzuconego leasingu, i czasem życia odpowiedzi do odtworzenia. Przy przegranym wyścigu z `MCP_TOOL_TIMEOUT_MS` (30 s) wiersz zostaje w `state = 'started'`, a invocation jest już zamrożony, więc `completeMcpMutation` nigdy nie poleci: ten sam ticket jest nie do odpalenia przez MCP przez dobę. Te dwa czasy zostają rozdzielone: leasing bez postępu jest odzyskiwalny po kilku minutach, utrwalona odpowiedź żyje dalej 24 h.

**Preflight jest wiążący.** `workflows.dispatch` przyjmuje `preflightDigest` i `expectedDeployedVersion`. Digest liczony jest z wyniku preflightu kanonicznym hashem. Niezgodność wersji daje `CONFLICT`, nie cichy dispatch na nowej wersji.

**Paginacja nie może kłamać o kompletności.** Dwa konkretne sposoby, w jakie by skłamała, i co je blokuje:

- `runs.trace` używa istniejącego kursora z `getRunReplay` (base64url), a nie własnego. Ale `sanitizeMcpData` przy przekroczeniu limitu bajtów podmienia całe `data` na `{ digest, truncated: true }` i **zostawia poprawny `nextCursor`** (`sanitize-result.ts:176-184`). Agent dostałby wtedy pustą stronę pierwszą, poszedł za kursorem i zdiagnozował run z trace'u bez tej właśnie strony, na której zwykle jest pierwsza nieudana próba, w dodatku bez ścieżki wyjścia, bo ten sam kursor zawsze zwróci tę samą za dużą stronę. Rozmiar strony jest więc wyprowadzany z budżetu bajtów, a ciała payloadów są przycinane przed sanitizacją, żeby strona nigdy nie wpadła w globalne obcięcie.
- `tickets.list_runs` opakowuje `listRunsForTicket`, które **nie ma LIMIT-u w SQL** i liczy `totals` po całym zbiorze (`runs-read.ts:616-631`). Obcięcie tablicy po fakcie dałoby kopertę, w której `totals.runCount` mówi 63, a tablica ma 20 pozycji, przy `truncated: false`, bo ta flaga reaguje wyłącznie na limit bajtów. Slice nie wystawia `totals` liczonych po zbiorze szerszym niż zwrócona strona, limit trafia do zapytania, a informacja o obcięciu siedzi w `data`, nie tylko w `meta`.

**Contract hash.** `MCP_CONTRACT_HASH` żyje dziś w `sanitize-result.ts`. Etap kontraktu przenosi jego wyliczanie do `tool-catalog.ts` nad kanonicznym JSON-em nazw, schematów i annotacji, a `sanitize-result.ts` go tylko reeksportuje. Snapshot w `mcp/contracts/mcp-contract.json` jest commitowany, a test pilnuje, że wygenerowany kontrakt jest z nim identyczny.

## Seamy i decyzje testowe

| Seam | Obserwowane zachowanie | Prior art |
|---|---|---|
| **S1 — `POST /mcp` (zewnętrzny, najwyższy)** | pełny cykl klienta: initialize, tools/list, tools/call, 401 z `WWW-Authenticate`, 405 na GET/DELETE, kształt i redakcja koperty | `src/mcp/transport.test.ts` (już istnieje i przechodzi), `src/db/test-db.ts:14` |
| **S2 — `register<Domena>Tools(server, deps)` (wewnętrzny)** | macierz rola × scope × kod błędu i mapowanie błędów domenowych na publiczne kody, bez transportu | `src/mcp/execute-tool.test.ts`, `src/mcp/policy.test.ts` |
| **S3 — istniejące serwisy (reuse)** | że MCP nie duplikuje reguł domenowych; w testach podstawiany jest fake adaptera | `adapters/issue-tracker/types.ts:24` (fake w `jira.test.ts`), `manual-dispatch/service.ts:94` |

Zero nowych seamów tam, gdzie repo już je ma. S3 jest realny, bo adapter ma dwie implementacje.

**Kody błędów rozszerzone o `TIMEOUT`.** Spec projektowa (§7) wymienia zamkniętą listę bez tego kodu. Rozszerzam ją świadomie, bo sens kodów w kopercie polega na tym, że agent decyduje bez czytania prozy, a mutacja przerwana timeoutem wymaga innej akcji niż niedostępna zależność: `DEPENDENCY_UNAVAILABLE` znaczy „backend leży, ponów później", podczas gdy prawda brzmi „dispatch prawdopodobnie właśnie działa, sprawdź stan". Podanie tego pierwszego byłoby tym samym błędem, który naprawiamy przy nieudanym audycie mutacji, tylko pod inną nazwą. `TIMEOUT` jest retryowalny, jego komunikat mówi wprost, że operacja mogła już wylądować, i ten sam kod trafia do audytu, żeby operator odróżnił „timeout, stan nieznany" od porażki utrwalenia wyniku. Zmiana wchodzi przed etapem `C2`, czyli zanim kontrakt zostanie zamrożony w `mcp-contract.json`. Zasięg tej jednej wartości to **trzy pliki, nie jeden**: `contracts.ts` (unia) plus dwa wyczerpujące switche, `transport.ts` (`statusFor`, gdzie `TIMEOUT` mapuje się na **504**, bo 503 kolidowałoby z `DEPENDENCY_UNAVAILABLE` i skasowało dodawaną właśnie różnicę) i `idempotency-store.ts` (`safeReplayMessage`, przypadek wyłącznie kompilacyjny, bo ścieżka timeoutu nigdy nie utrwala leasingu jako nieudanego).

## Out of scope

- Mutacje ticketów, authoring workflowów, harness i memory. To osobne inkrementy z własnym planem.
- `.github/actions/mcp-release-smoke` i wpięcie w pipeline release'u Artura (Taski 11-12 planu Codexa). Wchodzą dopiero po ręcznym dogfoodingu.
- Deploy na `ai-workflow-app`, tworzenie klientów OAuth i akceptacja dogfoodingowa (Task 13). To bramka człowieka.
- `ai-workflow-demo`.
- Dodanie `organization_id` do `workflowRuns` i `workflowDefinitions`.

## Założenia

1. **Jeden deployment to jedna organizacja.** Tylko 5 z 34 tabel ma `organization_id`; `workflowRuns` i `workflowDefinitions` go nie mają. `fetchRunDetailFromDb` filtruje wyłącznie po `runId` (`run-detail-read.ts:98-103`), `listRunsForTicket` wyłącznie po `ticketKey` (`runs-read.ts:616-620`), natomiast `getRunReplay` **wymaga** zgodności organizacji (`run-observability/store.ts:977-981`). Izolacja tenanta stoi więc wyłącznie na bramce aktora w `request-context.ts:47` i tak jest zapisana, zamiast udawać izolację na poziomie wierszy. Praktyczna konsekwencja, o której narzędzia muszą mówić prawdę: `runs.trace` może zwrócić `not_captured` dla runu, który `runs.get` normalnie pokazuje, bo replay bywa nieprzypięty do organizacji. To jest znane ograniczenie, nie błąd do obejścia fake'em w teście.
2. **Branch jest przestarzały i wymaga rebase'u; migracja dostaje numer 0047.** Zweryfikowane na `origin/main` (`533b514f`, dwanaście commitów przed lokalnym `main`): numery `0044_workflow_run_prs_lookup`, `0045_schedule_occurrence_run_cancelled` i `0046_local_skill_source` są **już zmergowane**. Samo przenumerowanie pliku nie wystarcza z dwóch powodów. Po pierwsze, snapshot MCP ma `prevId` wskazujący na `0043` i nie zna kolumn `source_kind`, `local_path`, `local_content_sha256` w `harness_skill_artifacts`; po merge'u stałby się ostatni w łańcuchu, więc następne `db:generate` wygenerowałoby migrację dokładającą obiekty, które na produkcji już istnieją, i padłoby na `column already exists`. Po drugie, `when` migracji MCP (`1786264177264`) jest wcześniejszy niż wszystkie trzy migracje z `main`, a runner drizzle decyduje o zaaplikowaniu migracji właśnie po `when`, nie po nazwie pliku ani po hashu treści. Dlatego branch jest najpierw rebase'owany na `origin/main`, a migracja i jej snapshot są **regenerowane**, nie przenazywane. Assert `RESERVED_0045_MIGRATION_WHEN` w `src/db/mcp-foundation-migration.test.ts:21,157` pilnuje nieistniejącego już porządku i znika, ale **musi zostać zastąpiony** realnymi niezmiennikami journala, bo jest jedynym miejscem w repo pilnującym względnej kolejności migracji (patrz Założenie 7).

   Korekta po pre-mortemie: pierwotnie napisałem tu, że regeneracja domyka też sprawę indeksu `workflow_runs_prs_gin_idx`. To było nieprawdziwe. Tego indeksu nie ma w żadnym snapshocie, łącznie z nowym `0047`, ani w `schema.ts`; żyje wyłącznie w ręcznie pisanym `drizzle/0044_workflow_run_prs_lookup.sql:1`. Regeneracja była słuszna z dwóch powodów wymienionych wyżej, a nie z tego. Pułapka zostaje otwarta i jest opisana w Założeniu 8.
3. **Rekomendacja „jedna idempotencja zamiast dwóch" została wyprzedzona przez fakty.** `mcp_idempotency_keys` jest już zbudowane, przetestowane i zielone. Cofanie tego byłoby destrukcyjną przeróbką, więc zostaje, a ryzyko przenosi się na deterministyczne wyprowadzenie `requestId` opisane wyżej.
4. **Audyt: wiersz `attempted` zawsze fail-closed, fail-open dotyczy wyłącznie zapisu wyniku.** Pierwotna rekomendacja („całe odczyty fail-open") była zbyt szeroka i tworzyła dziurę: `writeMcpAudit` odpala `pruneMcpAudits` przy **każdym** zapisie (`audit-store.ts:17,21`), a gołe `occurred_at < cutoff` nie trafia w indeks `mcp_audit_events_organization_occurred_at_idx` (`0044_mcp_foundation.sql:135`). Przy dużej tabeli prune degraduje się do skanu i zaczyna timeoutować, więc fail-open na całości znaczyłby, że od pewnego rozmiaru **każdy** odczyt przechodzi bez śladu, a limit 120 odczytów na minutę wystarcza, żeby wepchnąć instancję w ten reżim i enumerować tickety oraz runy niewidocznie. Dlatego: wiersz przedautoryzacyjny `attempted` jest fail-closed także dla odczytów (to jedyny rekord świadczący o próbie), fail-open dotyczy wyłącznie zapisu wyniku i podbija licznik `mcp_audit_write_failed`, a prune wychodzi ze ścieżki requestu do crona.
5. **Klienci OAuth na wewnętrznym deploymencie już istnieją** (potwierdzone przez usera), więc bramka Task 13 nie zaczyna od zera.
6. Nowy kod nie używa `db.transaction()` (neon-http nie ma transakcji) i nie importuje modułów Node poza ciałem `"use step"`.

7. **Kolejność migracji nie ma w repo żadnej bramki i to jest szersze niż MCP.** Runner drizzle aplikuje migrację, gdy `when` z journala przewyższa watermark bazy, natomiast `src/db/test-db.ts:17-19` aplikuje pliki posortowane po nazwie i journala nie czyta. Rozjazd jest cichy: migracja z `when` niższym niż watermark zostaje na produkcji pominięta bez logu, a w testach jest obecna, więc build jest zielony i dopiero runtime zwraca 500 na brakującym obiekcie. Odtworzone na PGlite w pre-mortemie. Etap `A0` zastępuje usunięty assert testem pilnującym trzech niezmienników journala: ściśle rosnące `when`, zgodność kolejności journala z leksykalną kolejnością nazw plików oraz zgodność liczby wpisów z liczbą plików.

8. **Znana pułapka odziedziczona z `origin/main`, świadomie zostawiona otwarta.** Indeks `workflow_runs_prs_gin_idx` istnieje wyłącznie w ręcznie pisanej migracji `drizzle/0044_workflow_run_prs_lookup.sql:1` i jest niewidoczny dla drizzle: nie ma go ani w `schema.ts`, ani w żadnym snapshocie. W dniu, w którym ktoś doda go do `schema.ts`, `db:generate` wyprodukuje `CREATE INDEX`, a `pnpm build` padnie na `already exists` na każdej bazie, która widziała `0044`. To nie jest problem wprowadzony przez MCP i naprawa nie należy do tego slice'u, ale zostaje tu zapisana, żeby nie odkrywać jej po raz drugi.

9. **Lokalne bazy deweloperskie, które odpaliły ten branch przed przenumerowaniem, wymagają ręcznego sprzątnięcia.** Migracja MCP zmieniła `when`, a drizzle rozpoznaje migracje wyłącznie po tym polu, więc taka baza spróbuje zaaplikować `0047` po raz drugi i padnie na `CREATE TABLE "mcp_audit_events"`. Produkcja, deploymenty klientów i snapshot Artura są bezpieczne, bo ich watermark to najwyżej `0046`, a branch nigdy nie trafił na `origin`. Naprawa lokalnej bazy to usunięcie nieaktualnego wiersza z `drizzle.__drizzle_migrations`.

## Etapy

Bramki A i C są sekwencyjne. Fan-out B rusza dopiero po zielonej bramce A i ma w pełni rozłączne pliki.

| # | Etap | Seam | Zakres plików | Tier | Sceptyk | TDD | Delegacja | DoD |
|---|------|------|---------------|------|---------|-----|-----------|-----|
| A0 | Commit WIP transportu, rebase na `origin/main`, regeneracja migracji jako `0047` | — | cały branch (rebase), `apps/worker/drizzle/*`, `drizzle/meta/*`, `src/db/mcp-foundation-migration.test.ts`, `src/db/schema.ts` (rozwiązanie konfliktów), `src/mcp/transport.ts`, `src/mcp/transport.test.ts` | opus | tak | nie | nie | `git log --oneline origin/main..HEAD` pokazuje **dokładnie 11 commitów**: dwa docsowe i dziewięć MCP; `ls drizzle/00*.sql` kończy się na `0047_mcp_foundation.sql`; `pnpm --filter worker exec drizzle-kit generate` **nie produkuje nowej migracji** (dowód, że snapshot zgadza się ze `schema.ts`); `vitest run src/db/mcp-foundation-migration.test.ts src/db/auth-schema.test.ts src/mcp/transport.test.ts` zielone; `git status` czysty |
| A1 | Audyt odrzuconych calli, fail-open tylko na wyniku, prune poza requestem | S2 | `src/mcp/execute-tool.ts`, `src/mcp/execute-tool.test.ts`, `src/mcp/audit-store.ts`, `src/mcp/audit-store.test.ts`, `src/routes/cron/poll.get.ts` | opus | tak | tak | nie | `vitest run src/mcp/execute-tool.test.ts src/mcp/audit-store.test.ts` zielone; `FORBIDDEN`, `INSUFFICIENT_SCOPE` i `RATE_LIMITED` zostawiają wiersz audytu; padnięcie zapisu `attempted` blokuje także odczyt; padnięcie zapisu wyniku odczytu zwraca dane i podbija licznik; `writeMcpAudit` nie woła prune |
| A2 | Rozdzielenie czasu leasingu od czasu życia odpowiedzi | S2 | `src/mcp/idempotency-store.ts`, `src/mcp/idempotency-store.test.ts` | opus | tak | tak | nie | `vitest run src/mcp/idempotency-store.test.ts` zielone; leasing porzucony po timeoucie narzędzia jest odzyskiwalny w minutach, nie po 24 h; leasing zwolniony po błędzie przejściowym wydaje przy ponowieniu **nowy** `leaseId`; utrwalona odpowiedź nadal odtwarzalna przez 24 h; równoległy duplikat nadal dostaje `CONFLICT`; `mcp_idempotency_keys` dostaje sweep retencyjny podpięty do crona, bo dziś każdy nowy klucz zostaje w tabeli na zawsze |
| A3 | Deterministyczny klasyfikator diagnozy | S2 | `src/mcp/run-diagnosis.ts`, `src/mcp/run-diagnosis.test.ts` | sonnet | tak | tak | nie | `vitest run src/mcp/run-diagnosis.test.ts` zielone; pokryte: dependency auth, sandbox timeout, validation failed, workspace gate, cancelled, brak dowodów → `unknown`/`low` |
| A4 | Wspólne fixture'y testowe i typ podsumowania runu | S2 | `src/mcp/test-support.ts`, `src/mcp/contracts.ts` | sonnet | nie | nie | nie | `vitest run src/mcp` zielone; `actorFor`/`depsFor` mają jedno źródło; `McpRunSummary` wyeksportowany z `contracts.ts` |
| B1 | Narzędzia ticketów | S2, S3 | `src/mcp/tools/tickets.ts`, `src/mcp/tools/tickets.test.ts` | sonnet | tak | tak | nie | `vitest run src/mcp/tools/tickets.test.ts` zielone; `tickets.get` znaczy dane jako `external_untrusted`, ticket z wstrzykniętą instrukcją zostaje danymi, `IssueTrackerNotFoundError` → `NOT_FOUND`; `tickets.list_runs` ma limit w zapytaniu, nie wystawia `totals` szerszych niż zwrócona strona i sygnalizuje obcięcie w `data` |
| B2 | Narzędzia runów: status, trace, wynik, diagnoza | S2, S3 | `src/mcp/tools/runs.ts`, `src/mcp/tools/runs.test.ts` | sonnet | tak | tak | tak | `vitest run src/mcp/tools/runs.test.ts` zielone; strona trace'u mieści się w budżecie bajtów, więc nigdy nie wpada w globalne obcięcie zostawiające sam kursor; run nieterminalny nie udaje wyniku; sekrety zredagowane; run bez przypiętego replaya zwraca jawne `not_captured`, a nie pustą listę udającą brak zdarzeń |
| B3 | Preflight i idempotentny dispatch | S2, S3 | `src/mcp/tools/workflows.ts`, `src/mcp/tools/workflows.test.ts` | opus | tak | tak | nie | `vitest run src/mcp/tools/workflows.test.ts` zielone; dwa identyczne dispatche dają ten sam `runId` i dokładnie jedno wywołanie serwisu; inny payload na tym samym kluczu → `IDEMPOTENCY_CONFLICT`; nieaktualna `expectedDeployedVersion` → `CONFLICT`; member → `FORBIDDEN`; `recovering` nie jest utrwalane i wraca jako retryowalne z `pollAfterMs`; `at_capacity` nie zostaje zamrożone jako trwała porażka; odzyskanie klucza po 24 h daje nowy `requestId`, a nie wczorajszy `runId` |
| C0 | Bramka na poziomie transportu, przed wejściem w narzędzie | S1 | `src/mcp/transport.ts`, `src/mcp/transport.test.ts` | opus | tak | tak | nie | `vitest run src/mcp/transport.test.ts` zielone; `tools/call` z nieistniejącą nazwą narzędzia i z argumentami niezgodnymi ze schematem zużywa budżet limitu i zostawia ślad, zamiast przechodzić za darmo; koszt weryfikacji aktora nie jest ponoszony w pełni dla ruchu odrzucanego |
| C1 | Rejestracja narzędzi i test integracyjny przez `/mcp` | S1 | `src/mcp/server.ts`, `src/mcp/server.test.ts` | opus | tak | tak | nie | `vitest run src/mcp/server.test.ts src/mcp/transport.test.ts` zielone; `tools/list` zwraca komplet dziewięciu nazw z `contracts.ts`; annotacje każdego narzędzia zgodne z `policy.ts` |
| C2 | Artefakt kontraktu i endpoint gotowości | S1 | `src/mcp/tool-catalog.ts`, `src/mcp/tool-catalog.test.ts`, `src/mcp/contracts/mcp-contract.json`, `scripts/generate-mcp-contract.ts`, `src/routes/api/v1/system/mcp-readiness.get.ts`, `src/routes/api/v1/system/mcp-readiness.test.ts`, `apps/worker/package.json` | sonnet | nie | tak | nie | `pnpm --filter worker mcp:contract:check` exit 0; `vitest run src/mcp/tool-catalog.test.ts src/routes/api/v1/system/mcp-readiness.test.ts` zielone; hash w `system.capabilities`, w snapshocie i w readiness identyczny; readiness nie ujawnia sekretów |
| C3 | Klient smoke po prawdziwym HTTP | S1 | `apps/worker/scripts/mcp-smoke.ts`, `apps/worker/scripts/mcp-smoke.test.ts` | sonnet | nie | nie | nie | `vitest run scripts/mcp-smoke.test.ts` zielone; skrypt używa klienta MCP po HTTP, nie importuje serwera; ścieżki negatywne (zły audience, wygasły token) pokryte fake'iem; wypisuje JSON evidence bez tokenów |
| D | Bramka CI | — | brak zmian | — | nie | nie | nie | push brancha; `ci.yml` zielone (`typecheck`, `test`, `test:release-notes`, `test:workflow-sdk`) |

**Etap A0 w szczegółach.** Kolejność operacji jest wiążąca, bo rebase na brudnym drzewie albo odmawia startu, albo autostashuje się w konflikt:

1. Zacommitować niezacommitowane zmiany w `transport.ts` i `transport.test.ts` (strumieniowe czytanie body z limitem, drenaż, kod JSON-RPC `-32700`). To jest gotowa i przetestowana praca, nie WIP do wyrzucenia.
2. `git rebase --onto origin/main fb55629b feat/ai-workflow-remote-mcp`. Ten zakres celowo **odcina dwa commity AIW-223** (`9dda9dea`, `fb55629b`), które nie mają nic wspólnego z MCP i żyją dalej na `feat/schedule-cron-trigger`. Nic nie ginie, a PR z MCP zostaje czysty. Rebase interaktywny jest w tym środowisku niedostępny, więc `--onto` z jawnym zakresem jest jedyną poprawną formą.
3. Usunąć `0044_mcp_foundation.sql` wraz z jego snapshotem i wpisem w journalu, a następnie **wygenerować migrację od nowa** z posmergowanego `schema.ts`. Regeneracja, nie przenazwanie: chodzi o to, żeby snapshot znał kolumny `source_kind`, `local_path`, `local_content_sha256` i indeks `workflow_runs_prs_gin_idx`.
4. Usunąć assert `RESERVED_0045_MIGRATION_WHEN` (`src/db/mcp-foundation-migration.test.ts:21,157`), który pilnuje nieistniejącego już porządku, i przepiąć test na nowy numer.

**Kolejność.** `A0` → `A4` → (`A1`, `A2`, `A3` równolegle) → (`B1`, `B2`, `B3` równolegle) → `C1` → (`C2`, `C3` równolegle) → `D`.

`A2` biegnie równolegle z `A1` tylko pod jednym warunkiem: całą logikę odzyskiwania przeterminowanego leasingu implementuje **wewnątrz** `idempotency-store.ts`, korzystając z `now`, które już dostaje, i bez zmiany sygnatury `beginMcpMutation`. `expiresAt` liczone jest dziś po stronie wywołującego (`execute-tool.ts:195`), czyli w pliku należącym do `A1`; przeciąganie nowego parametru przez tę granicę to konflikt. Jeśli executor `A2` uzna, że bez zmiany sygnatury się nie da, `A2` przestaje być równoległy i idzie po `A1`. `A4` idzie przed `A1`, bo wyciąga fixture'y z `execute-tool.test.ts`, który `A1` następnie zmienia; odwrotna kolejność to konflikt na tym samym pliku. Fan-out `B` startuje dopiero po całej bramce `A`, bo wszystkie trzy etapy `B` opierają się na wspólnych fixture'ach z `A4` i na poprawionej semantyce leasingu z `A2`.

Po etapie D praca jest code-complete. Task 13 planu Codexa (deploy na `ai-workflow-app`, włączenie `MCP_ENABLED`, dogfooding na żywych klientach) jest **bramką człowieka** i nie należy do tej orkiestracji.

## Pre-mortem

Sceptyk (opus, świeży kontekst, dostęp do kodu) zgłosił dziesięć znalezisk i wydał REJECT dla pierwotnej wersji planu. Rozstrzygnięcia:

| # | Znalezisko | Los |
|---|---|---|
| 1 | `0046` jest już zajęte na `origin/main`; wolny numer to `0047` | Zweryfikowane osobno i potwierdzone. Plan poprawiony: etap `A0`, Założenie 2 |
| 2 | Snapshot MCP po merge'u cofnąłby zmiany z trzech zmergowanych migracji | Poprawka planu: regeneracja snapshotu po rebasie zamiast przenazwania, z dowodem w DoD `A0` |
| 3 | Nieterminalne `recovering` utrwalane na 24 h | Poprawka planu: decyzja implementacyjna i DoD `B3` |
| 4 | Klucz idempotencji zakleszczony na 24 h po timeoucie | Poprawka planu: nowy etap `A2` |
| 5 | Rozjazd TTL zwraca wczorajszy `runId` | Poprawka planu: `requestId` wyprowadzany z `leaseId`, DoD `B3` |
| 6 | Prune w ścieżce requestu plus fail-open to dziura w audycie | Poprawka planu: Założenie 4 zawężone, prune do crona, `A1` |
| 7 | DoD „cudzy run wygląda jak `NOT_FOUND`" jest niewykonalne | Skreślone jako nieuczciwe. Ograniczenie zapisane wprost w Założeniu 1, DoD `B2` mówi o `not_captured` |
| 8 | Obcięta strona trace'u zostawia ważny kursor | Poprawka planu: rozmiar strony z budżetu bajtów, DoD `B2` |
| 9 | `tickets.list_runs` kłamie przez `totals` po pełnym zbiorze | Poprawka planu: limit w zapytaniu, brak szerszych `totals`, DoD `B1` |
| 10 | Fan-out rozłączny po plikach, ale nie po fixture'ach | Poprawka planu: nowy etap `A4` przed bramką |

Żadne znalezisko nie zostało odrzucone.

## Weryfikacja

Pełne suity lecą wyłącznie na CI. Lokalnie każdy etap uruchamia tylko własne, wąskie pliki testowe wymienione w DoD, plus `pnpm --filter worker typecheck`. Executory pracują w izolowanych kopiach drzewa: równoległe mutowanie jednego worktree'a psuje cudze wyniki testów.

## Korekty wykonawcze z 2026-08-12 (ten rozdział wygrywa z powyższym)

Poniższe rozstrzygnięcia powstały w trakcie wykonania i **zmieniają treść powyższych sekcji**. Kolejność etapów, zakresy plików i dwa DoD są inne, niż zapisano wyżej. Czytając ten dokument bez tego rozdziału wyciągniesz błędne wnioski.

### Kolejność etapów: katalog narzędzi wchodzi przed rejestracją

Pierwotnie `C2` miał zbudować katalog na potrzeby contract hasha. Okazało się, że katalogu potrzebują niezależnie trzy etapy: bramka `C0` (żeby walidować argumenty względem prawdziwych schematów), `C1` (rejestracja) i `C2` (hash). Schematy żyły jako prywatne stałe w modułach narzędzi, więc bez katalogu bramka `C0` mogła sprawdzać tylko strukturę argumentów, co zostawiało otwartą główną klasę probingu: `system.capabilities` ma `z.object({}).strict()`, więc `{"extra":1}` odbijało się od SDK **za darmo**, na jedynym wtedy zarejestrowanym narzędziu. Odrzucona alternatywa: sonda wykrywająca po fakcie, że lej wykonawczy nie został tknięty (rozlicza po wysłaniu odpowiedzi, więc nigdy nie zwróci 429 dla tej klasy, czyli zamyka objaw, nie dziurę).

Nowa kolejność: `B3` -> `C0` (katalog plus bramka) -> `C1` (rejestracja kompletu z katalogu) -> `C2` (hash nad katalogiem plus readiness) -> `D0` -> `D`. `C3` biegnie niezależnie.

`C0` ma więc zakres szerszy niż wiersz w tabeli: `tool-catalog.ts`, `tool-catalog.test.ts`, `transport.ts`, `transport.test.ts`, przeniesienie schematów z `tools/tickets.ts` i `tools/runs.ts`, dwa nowe eksporty w `contracts.ts` (`MCP_UNRECOGNIZED_TOOL`, `McpAuditToolName`) plus przestawienie `McpAuditInput.toolName`, i rozszerzony typ `toolName` w `rate-limit-store.ts`. `C2` **rozszerza** istniejący katalog i jego test, nie tworzy ich od nowa.

### Cztery decyzje o bramce transportu

1. **Kształt odpowiedzi dla klienta nie zmienia się:** zostaje 200 z `isError: true` w kształcie produkowanym przez SDK, bo konsumentem jest agent LLM, który poprawia własne wywołanie, czytając treść błędu jako wynik. Twardy `-32602` odebrałby mu samonaprawę w zamian za czystość protokołu. Status zmienia wyłącznie wyczerpanie budżetu (429, istniejące zachowanie `RATE_LIMITED`).
2. **Sentinel `MCP_UNRECOGNIZED_TOOL` obejmuje wyłącznie nazwy poza katalogiem.** Nazwa znana ze złymi argumentami obciąża kubełek swojego narzędzia i idzie do audytu pod swoją nazwą, bo inaczej agent, który pomylił argumenty, spalałby budżet przeznaczony na wyłapywanie enumeracji, a operator tracił informację, które narzędzie było źle wołane. Wszystkie nierozpoznane nazwy dzielą JEDEN kubełek, bo `toolName` wchodzi do klucza okna `mcp_rate_limit_windows`, więc kubełkowanie po nazwie od klienta fundowałoby świeże okno 120/min każdej zmyślonej nazwie. Okno jest per aktor, nie per organizacja (zweryfikowane).
3. **Rozszerzenie typu, nie rzutowanie.** Audyt notuje próbę, a próba może nazwać narzędzie, którego nie ma, więc typ to mówi. Rzutowanie sentinela na `McpToolName` psułoby cicho każdy przyszły wyczerpujący `switch`.
4. **Inwariant „koszt weryfikacji aktora nie jest ponoszony w pełni" dotyczy ruchu sprzed uwierzytelnienia** (brak tokenu, zepsuty JSON-RPC, brak nazwy). Dla ruchu uwierzytelnionego aktor jest rozwiązywany w całości, bo wiersz audytu bez tożsamości jest dla operatora bezwartościowy, a enumeracja, którą zamykamy, jest robotą klienta, który uwierzytelnienie już przeszedł. `request-context.ts` zostaje nietknięty. Bramka waliduje nazwę względem KATALOGU, nie `FIRST_SLICE_TOOLS`.

### Dwie korekty w warstwie dispatchu

1. **`preflight` NIE przyjmuje `expectedDeployedVersion`** (odstępstwo od Taska 8 planu Codexa i spec par. 8.4, ratyfikowane). Preflight jest krokiem odkrywczym, który tę wersję dopiero podaje, więc wymaganie jej na wejściu było pętlą bez wyjścia. Wiązanie zostaje na dispatchu, gdzie jest server-authoritative.
2. **`recovering` UTRWALA leasing i jest nieretryowalne.** To odwraca decyzję z sekcji „Dwie warstwy idempotencji" (punkt 2), która kazała go zwalniać. Powód: `releaseMcpMutation` robi DELETE wiersza klucza, więc ponowienie tym samym kluczem daje nowy nonce, nowy `leaseId`, nowy `requestId` i **drugi wiersz w `manual_dispatch_requests`**, podczas gdy pierwszy dalej jest podnoszony przez `listRecoverableManualDispatches` z crona co minutę, bez limitu wieku i bez licznika prób. Odtworzony przebieg z dwoma runami: zadyszka Jiry daje `recovering`, cron startuje R1, R1 pada w kilkadziesiąt sekund i zwalnia rezerwację podmiotu, agent ponawia po 60 s dokładnie tak, jak każe mu komunikat, i powstaje R2 na tym samym tickecie. Wariant częstszy: ponowienie trafia na własną osieroconą rezerwację, dostaje `active_run` i agent mówi userowi „ktoś już uruchomił run", co jest nieprawdą. Wybrana strona pomyłki jest zgodna z zasadą z tego planu: druga strona to tylko konieczność użycia nowego klucza.
3. **`at_capacity` dalej ZWALNIA leasing.** Asymetria wobec `recovering` jest celowa i decyduje o niej to, czy wiersz dispatchu po danym błędzie jest żywy (cron go podniesie) czy martwy (`markManualDispatchFailed` ustawia `failed` dla każdego kodu, a cron takiego żądania nigdy nie ponowi).
4. `requestId` wyprowadzany z `leaseId` wymagał przekazania leasingu do operacji, czego `executeMcpMutation` nie robiło. Autoryzowana zmiana dwóch linii w `execute-tool.ts`: `operation: (leaseId: string) => Promise<T>` i `input.operation(decision.leaseId)`. `leaseFor()` już wcześniej wstrzykiwał świeży nonce przy każdym wydaniu, właśnie pod ten przypadek.

### Kody błędów nie docierają do klienta z wnętrza narzędzia

SDK (`server/mcp.js:135-162`) łapie wyjątek handlera i buduje `createToolError(error.message)`, czyli sam tekst, bez `code`, `retryable` i `retryAfterMs`. `writePublicError` w `transport.ts` wkłada te pola do `error.data`, ale to dotyczy wyłącznie błędów SPRZED SDK. Teza „agent decyduje bez czytania prozy, bo kody są w kopercie" była więc niezrealizowana dla wszystkich dziewięciu narzędzi. Objaw, który to zdradził: testy dispatchu czytają zmapowany kod z wiersza audytu w bazie, bo klient go nie widzi. Naprawa: jeden wspólny wrapper przy rejestracji narzędzi w `C1`, nie dziewięć edycji.

### Contract hash miał już dryf, którego plan nie przewidział

`MCP_CONTRACT_HASH` był liczony nad ręcznie pisanym literałem dziesięciu kodów błędów w `sanitize-result.ts:45`, do którego `TIMEOUT` nie trafił, choć unia `McpErrorCode` go ma. Hash ogłaszał więc kontrakt, którego serwer nie realizuje, i ten sam hash szedł do audytu i do `system.capabilities`. Sekcja „Kody błędów rozszerzone o TIMEOUT" mówi o trzech plikach, a zasięg był czteropunktowy. `C2` likwiduje klasę tego błędu: lista kodów dostaje jedną definicję runtime'ową, z której wyprowadzany jest typ, a katalog przestaje być indeksowany przez `satisfies` na literale i staje się wyczerpującym `Record<McpToolName, ...>`, żeby brakujący wpis był błędem kompilacji.

### Decyzja usera o zakresie

Kontrakt dziewięciu narzędzi zostaje **zamrożony**. Nie dokładamy narzędzia do odkrywania workflowów ani triggerów. Znane ograniczenie na bramkę dogfoodingu: `workflows.dispatch_preflight` wymaga `definitionId` i `triggerNodeId`, a żadne narzędzie ich nie podaje (`system.capabilities` zwraca `enabledDomains: ["system"]`), więc agent proszony o „odpal workflow na PROJ-1" musi dostać identyfikatory od człowieka. Follow-up, nie rozszerzanie AIW-239.

### Migracja: 0048, nie 0047

Branch `feat/trigger-rate-limit-investigate` również tworzy migrację 0047 i prawdopodobnie wejdzie pierwszy. Nowy etap `D0` przed pushem: rebase na aktualny `origin/main`, potem **regeneracja** migracji MCP na następny wolny numer. Przenazwanie nie wystarcza z tego samego powodu, który opisuje Założenie 7: drizzle aplikuje po polu `when` z journala, więc plik z `when` niższym niż watermark bazy zostaje na produkcji pominięty bez logu, a w testach jest obecny, bo `db/test-db.ts` sortuje pliki po nazwie i journala nie czyta. Nie wolno nadpisać ich migracji ani zostawić dwóch wpisów 0047.

### Etap C3: inne pliki, niż zapisano

Plan chciał testu w `scripts/mcp-smoke.test.ts`. `vitest.config.ts:6` ogranicza `include` do `["src/**/*.test.ts", "*.test.ts"]`, więc taki plik nigdy by się nie uruchomił, a `apps/worker/scripts/` nie ma ani jednego testu. Logika smoke'a mieszka w `src/mcp/smoke-client.ts` i tam jest testowana, a `scripts/mcp-smoke.ts` jest cienkim wrapperem CLI. `vitest.config.ts` nietknięty.

### Dług i follow-upy zapisane świadomie

- **Odczyty nie egzekwują timeoutu.** `executeMcpRead` podaje operacji `AbortSignal.timeout(...)`, ale nie robi `Promise.race`, a żadna operacja odczytu sygnału nie nasłuchuje (`fetchRunDetailFromDb` i `getRunReplay` go nie przyjmują). Przy zamulonej bazie wywołanie wisi do ubicia funkcji, a w audycie zostaje wiersz `attempted` bez wiersza wynikowego, czyli kształt, który reszta modułu opisuje jako podejrzany. Dotyczy `B1` i `B2`.
- **`initialize`, `ping` i metody nieznane nadal są darmowe i nieaudytowane**, a każde takie żądanie przechodzi pełną weryfikację aktora (token plus trzy zapytania do bazy) bez licznika. Bramka nalicza `tools/call` i `tools/list`.
- **Gdyby ktoś kiedyś zaczął filtrować `tools/list` po polityce, bramka po cichu odtworzy pełny oracle powierzchni**, w tym `workflows.dispatch` dla roli `member`, bo rozróżnienie „nie ma takiego narzędzia" od „są złe argumenty" jest w komunikatach jawne. Dziś nie jest to wyciek tylko dlatego, że `tools/list` i tak oddaje wszystkim pełną listę.
- **Trzy reguły limitu i audytu istnieją w dwóch miejscach** (wybór limitu po klasie mutacji, reguła pierwszej odmowy w oknie, `signalAuditWriteFailure` skopiowane dosłownie): `transport.ts` i `execute-tool.ts`. Zmiana po jednej stronie nie wywali testu po drugiej.
- **Bramka w `transport.ts` jest zszywką**, plik wyrósł z 250 do ponad 550 linii i trzyma teraz obramowanie HTTP, negocjację protokołu, autoryzację, limit, audyt i formatowanie błędów zoda. Naturalna granica to `src/mcp/gate.ts`.
- **Dwa legalne kształty `rejected` bez `attempted`** (throttle oraz odrzucenie w bramce), przy komentarzu `execute-tool.ts:174-177` twierdzącym, że jest jeden. Alert operatora zbudowany z tego komentarza dawałby fałszywy alarm na każdą pomyłkę argumentów agenta.
- **`not_captured` z `runs.trace` zwija cztery różne rzeczywistości** (capture nie wystartował, capture padł, replay należy do innej organizacji, run nie istnieje). Rozdzielenie wymaga powodu ze `run-observability/store.ts`.
- **`evidenceRefs` z `runs.diagnose` żyją w innej przestrzeni nazw niż próbki z `runs.trace`** (`phase:${name}` albo `stepId` z WDK kontra `nodeId`, `id`, `diagnosticId`), a `nextActions` każe agentowi szukać kroku w trace'ie. Naprawa wymaga wspólnej przestrzeni identyfikatorów.
