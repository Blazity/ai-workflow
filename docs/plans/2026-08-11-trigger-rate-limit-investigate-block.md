# Trigger rate limit + blok Investigate

Źródło: transkrypcja spotkania 2026-08 (trial klienta od poniedziałku, ~7 userów, decyzja go/no-go w piątek). Dwa niezależne featury w jednym sprincie: (A) konfigurowalny limit startów workflow per trigger, (B) blok Investigate (Jira + Slack context search -> teoria z dowodami -> decyzja człowieka). **Priorytet: A jest krytyczne na poniedziałek ("definitely required"), B może poślizgnąć się o kilka dni.**

Wersja 2 - po pre-mortem sceptyka (10 znalezisk, triage niżej w "Założeniach").

## Problem

- A: dziś 100 ticketów na boardzie = 100 jobów = 100x koszt; atak lub pętla na triggerze wypala tokeny. Limit istnieje tylko dla custom webhooków (60/min per endpoint, `apps/worker/src/webhook-trigger/rate-limit.ts:9`).
- B: ticket przychodzący z boardu/Zendeska nie dostaje żadnej investigacji kontekstu - nie wiemy, czy to duplikat, known issue czy realny bug, więc albo lecimy PR na ślepo, albo człowiek szuka ręcznie po Jirze i Slacku.

## Rozwiązanie

- A: user ustawia na węźle triggera "max N startów na minutę/godzinę/dzień/miesiąc"; nadmiarowe starty są odrzucane i widoczne jako licznik odrzuceń, zamiast stawać się runami. Licznik nabija WYŁĄCZNIE realny nowy start (nie kandydat odrzucony przez guard duplikatu/already-claimed).
- B: nowy blok `investigate` w grafie: wyciąga keywords z ticketu (LLM), przeszukuje Jirę (podobne tickety) i wskazane kanały Slacka (history + dopasowanie lokalne), składa teorię z dowodami (false_positive / known_issue / real_bug / feature_request / question / insufficient_data) i przekazuje ją dalej w grafie - typowo do `human_question`, gdzie człowiek decyduje o PR.

## User stories

1. Jako operator workflow chcę ustawić limit startów per trigger, żeby flood ticketów nie wypalił budżetu tokenów.
2. Jako operator chcę widzieć liczbę odrzuconych startów, żeby wiedzieć, że limit działa i czy nie jest za ciasny.
3. Jako operator chcę, żeby istniejące workflow bez konfiguracji działały jak dotychczas (unlimited), żeby wdrożenie niczego nie złamało.
4. Jako triage'er ticketów chcę dostać teorię z dowodami (podobne tickety Jiry, wątki Slacka), żeby zdecydować, czy ticket zasługuje na PR.
5. Jako triage'er chcę, żeby tickety niekodowe (pytania o funkcjonalność) były odfiltrowane bez tworzenia PR.
6. Jako operator chcę, żeby ticket z żywym lub skończonym runem nie konsumował limitu przy każdym pollu, żeby limit mierzył realne nowe starty.

## Decyzje implementacyjne

### A: rate limit

- Konfiguracja w parametrach węzła triggera (decyzja Q1): `rateLimitMax: number` + `rateLimitWindow: "minute" | "hour" | "day" | "month"` na typach `trigger_ticket_ai`, `trigger_pr_*`, `trigger_schedule`, `trigger_webhook`. Oba opcjonalne; brak = unlimited (Q3). Opcjonalny globalny default z env `TRIGGER_RATE_LIMIT_MAX` + `TRIGGER_RATE_LIMIT_WINDOW`: stosowany TYLKO gdy węzeł nie ma własnych parametrów (default, nie sufit; parametry węzła wygrywają z env zawsze). Domyślnie env nieustawione = nic się nie zmienia dla istniejących workflow (story 3).
- Egzekwowanie: wspólny moduł `apps/worker/src/lib/trigger-rate-limit.ts`, mirror `webhook-trigger/rate-limit.ts`: fixed window, SQL upsert `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`, czas przekazywany jawnie jako parametr (testowalność, `rate-limit.test.ts:38-51`).
- **KOLEJNOŚĆ GUARDÓW (fix pre-mortem #1):** check limitu w dispatcherze stoi ZA guardami duplikatów i already-claimed/already-running, a PRZED faktycznym startem runu. Kandydat odrzucony przez guard duplikatu NIE konsumuje limitu. Poller Jiry (`routes/cron/poll.get.ts:484`) co minutę wrzuca wszystkie tickety z kolumny AI - bez tej kolejności backlog sam utrzymywałby się powyżej limitu w każdym oknie.
- Klucz licznika: `(definition_id, node_id, window_start)` - limit per węzeł triggera. **Wiele węzłów tego samego typu (fix pre-mortem #6):** tam, gdzie dispatcher rozwiązuje definicję po typie, nie po węźle (`store.ts:496`, dotyczy Jiry/PR), stosuj NAJMNIEJSZY (najbardziej restrykcyjny) skonfigurowany limit spośród węzłów tego typu w definicji. Webhook/schedule znają node_id z własnego wiersza configu - klucz pełny.
- Punkty egzekwowania: 4 dispatchery wokół `claimSubjectRun` (`lib/dispatch.ts:154`): `dispatchTicket` (Jira, `lib/dispatch.ts:57`), `dispatchAcceptedTrigger` (PR, `lib/dispatch-trigger.ts:443`), `startAdmittedOccurrence` (schedule, `schedule-trigger/dispatch-schedule-trigger.ts:325`), `dispatchWebhookDelivery` (webhook, `webhook-trigger/dispatch-webhook-trigger.ts:213`).
- Przekroczenie (Q2): drop + licznik odrzuceń. Schedule: skip occurrence (spójne z `overlap_policy: skip`). Jira/PR: drop z licznikiem. **Webhook (decyzja advisora po pre-mortem #2):** egzekwowanie zostaje w `dispatchWebhookDelivery` (async, po 202) - delivery dostaje terminalny outcome `"rejected"` z reason `rate_limited` (istniejący pattern, `dispatch-webhook-trigger.ts:264-272`). Świadomie NIE 429 na POST: Zendesk deaktywuje targety webhooków po serii odpowiedzi 4xx, więc flood 429 zabiłby integrację klienta gorzej niż dropnięte tickety. Istniejące limity endpointu (600/min ingress, 60/min inbox) zostają bez zmian jako niezależna warstwa; limit węzła jest dodatkowy - opisane w description pola w UI.
- Nowe tabele: `trigger_rate_limits` (PK `(definition_id, node_id, window_start)`) + `trigger_rejection_counters` (dzienny upsert per `(definition_id, node_id, reason)`, retencja 30d, sweep w cronie - mirror `rejection-counters.ts:24-46`).
- Widoczność (Q8 + fix pre-mortem #4): licznik odrzuceń musi być REALNIE widoczny dla wszystkich 4 typów triggerów - odczyt `trigger_rejection_counters` w istniejącej powierzchni telemetrii/konfiguracji węzła triggera w dashboardzie (nie nowy ekran, ale nie "tylko baza").
- Zakres (Q11): tylko triggery automatyczne. Manual dispatch (`manual-dispatch/service.ts:487`) i restarty z approvals (`approvals/dispatch.ts:80`) bez limitu.
- Semantyka okna (fix pre-mortem #8): fixed window, miesiąc = kalendarzowy UTC; na granicy okna możliwy burst 2x limit - jedno zdanie w description pola w UI.

### B: blok Investigate

- Nowy typ bloku `investigate` (kategoria action, `allowsFailurePort: true`): `shared/contracts/domain.ts:253-290` (unia typów), `workflow-graph.ts:42-80` (`BLOCK_TYPE_SPECS`) + `BLOCK_PARAM_KEYS`.
- Parametry: `providers: { jira: boolean, slack: boolean }`, `slackChannels: string[]` (lista channel IDs, Q9; pusta = Slack pominięty), `slackLookbackDays: number` (default 30 - fix pre-mortem #5), `jiraJqlTemplate?: string`, `maxResults: number` (default 10), `model?: string` (mirror parametru `call_llm`).
- Pipeline wewnątrz bloku (decyzja Q4 - retrieval + teoria w jednym bloku):
  1. Ekstrakcja keywords z ticketu przez LLM (decyzja Q6) - `generateStructured` z `apps/worker/src/lib/llm.ts:73`. Prompt produkuje keywords po angielsku ORAZ w języku ticketu (fix pre-mortem #9). Ticket bez summary i description -> blok zwraca od razu `classification: "insufficient_data"`, puste evidence, ZERO calli retrieval.
  2. Retrieval: Jira - nowa metoda adaptera (obok `searchTickets`, `jira.ts:271`) zwracająca `{ key, summary, status, url }[]` (tniemy do `maxResults`). Slack - nowy moduł `lib/slack-search.ts`: `conversations.history` per kanał z listy, z `oldest = now - slackLookbackDays`, paginacja z twardym capem 3 strony (~300 wiadomości) na kanał, lokalny case-insensitive match keywords, top N trafień; permalink przez `chat.getPermalink` dla top N (N <= maxResults <= 10, koszt pomijalny - fix ataku na założenie 6).
  3. Teoria: drugi `generateStructured` - prompt z ticketem + dowodami -> `{ classification, theory, evidenceRefs }`.
- Degradacja per provider (Q10): awaria Jiry/Slacka (w tym kanał bez bota / `not_in_channel`) -> provider pominięty, `partial: ["jira" | "slack"]` w output; awaria LLM -> blok pada (failure port).
- **Terminacja flow (fix pre-mortem #3):** graf z `investigate` MUSI kończyć się mutacją ticketa (label/transition) albo `human_question` - inaczej ticket zostaje w kolumnie AI i poller odpala investigate w pętli co minutę (2 cale LLM/min/ticket). Blok sam ticketa NIE mutuje. Wymóg idzie do: description bloku w rejestrze, DoD etapu 5 (test/ walidacja) i checklisty pre-trial. Klasyfikacje `question`/`known_issue` bez dalszej ścieżki kodowej powinny prowadzić do odpowiedzi na ticket + transition, nie do PR (story 5).
- Output: `statusOutput` z `{ classification, theory, evidence: [...], partial: string[] }` - kontrakt w `block-registry.ts:211`, zgodny z `expectOutputConformsToRegistry` (`blocks/test-support.ts`).
- LLM: ten sam stos co `call_llm` (`blocks/call-llm.ts` + `lib/llm.ts`) - Anthropic/Codex po `resolveLlmProvider`, timeout 4 min górny bound.

## Seamy i decyzje testowe

- **Rate limit: moduł `trigger-rate-limit.ts` na PGlite** - mirror `rate-limit.test.ts`: prawdziwe migracje na in-memory PGlite (`src/db/test-db.ts:14`), czas jako parametr. Obserwujemy: dozwolone/odrzucone starty na granicy okna, niezależność kluczy. (potwierdzony Q7, tdd: tak)
- **Dispatchery: test poziomu dispatcher/route** - mirror asercji 429 + licznik w `[endpointId].post.test.ts:485`. Obserwujemy: przekroczony limit = brak runu + licznik; guard duplikatu NIE konsumuje limitu (kolejność guardów). (tdd: tak)
- **Investigate executor: `vi.mock` adapterów + `vi.mock` lib/llm** - mirror `post-ticket-comment.test.ts:8-14`. Obserwujemy: składanie keywords (dwujęzyczne), insufficient_data bez retrieval, degradację per provider, kontrakt outputu. (potwierdzony Q7, tdd: tak)
- **Pure functions retrieval**: budowa JQL z template, scoring/match keywords w historii Slacka, obliczanie `oldest` - czyste funkcje, testy jednostkowe bez mocków.

## Out of scope

- Guardrails (blokady plików/akcji agenta) - osobny ticket w backlogu.
- Rename BlazeBot -> workflow i migracja memory - osobna praca.
- Queue/defer przekroczonych startów (odrzucone w Q2).
- Dedykowany ekran rate limitu w dashboardzie (Q8; licznik ląduje w istniejących powierzchniach).
- Guard "nie redispatchuj ticketu po sukcesie bez zmiany ticketa" na poziomie `dispatchTicket` - ryzykowny globalnie; mitigacja przez wymóg terminacji flow (powyżej). Kandydat do osobnego ticketu, jeśli pętla wyjdzie w praktyce.
- Zendesk jako natywny provider Investigate (v1: ticket wchodzi webhookiem, kontekst z Jiry/Slacka).
- Multi-tenant credentials per repo/org (dziś globalne env, `adapters.ts:44-48`).

## Założenia (z triage pre-mortemu)

1. **Bot Slacka musi być zaproszony na kanały z listy configu** - to warunek wstępny triala, nie tylko dokumentacja: punkt checklisty pre-trial (niżej) z weryfikacją na realnym kanale klienta. Kanał bez bota = degradacja `partial`, ale `human_question` może nie pokazywać pola partial - do pokazania w teorii ("Slack: nie sprawdzono").
2. **Webhook: silent drop zamiast 429** - decyzja advisora (uzasadnienie w sekcji A): Zendesk deaktywuje targety po serii 4xx. Ryzyko: ticket ginie po cichu; mitigacja: widoczny licznik odrzuceń (wymóg w etapie 3).
3. **Klonowanie workflow = świeży licznik** (klucz `(definition_id, node_id)`): w tygodniu triala user eksperymentuje klonami i limit "resetuje się" przy klonie. Akceptowane świadomie - alternatywa (klucz stabilny cross-definicji) nie istnieje w modelu danych.
4. **Model dla Investigate**: default z rejestru modeli jak w `call_llm`. Koszt: 2 cale LLM per run bloku; przy limicie N startów/dzień z feature A sufit kosztu to N x 2 cale - rekomendacja trzymać default tani, ale nie najtańszy (klasyfikacja false_positive vs real_bug napędza decyzję człowieka).
5. **Trzy limity na webhooku** (600/min ingress, 60/min inbox, węzeł): user ustawiający węzeł 100/min dostanie cięcie na 60/min inbox. Akceptowane; opisane w description pola.
6. **Fixed window + miesiąc UTC**: burst 2x na granicy okna akceptowany; komunikat w UI (decyzje A). Odrzucam rolling window: koszt złożoności nieproporcjonalny do ryzyka.
7. **Interakcja obu featurów:** rate limit (A) maskuje pętlę investigate (B) - przy wdrożeniu B na grafach bez limitu pętla jest nieograniczona. Rekomendacja: template investigate wychodzi z ustawionym limitem domyślnym w docs, nie w kodzie.

## Etapy

| # | Etap | Seam | Zakres plików | Tier | Sceptyk | TDD | Delegacja | DoD |
|---|------|------|---------------|------|---------|-----|-----------|-----|
| 1 | A1: kontrakt parametrów + moduł rate limit + migracja | `checkAndIncrementTriggerRate` na PGlite | `apps/shared/contracts/workflow-graph.ts` (param keys triggerów), `apps/worker/src/workflow-definition/schema.ts` (literaly triggerów), `apps/worker/src/db/schema.ts`, `apps/worker/drizzle/0044_*.sql`, `apps/worker/src/lib/trigger-rate-limit.ts`(+.test.ts) | sonnet | nie | tak | nie | `pnpm --filter worker test -- trigger-rate-limit` zielone (granica okna, niezależność kluczy, min-limit multi-node helper); `pnpm --filter worker typecheck` zielone |
| 2 | B1: providerzy retrieval (Jira ext + Slack history) | pure fns (JQL build, keyword match, oldest) + mock adapterów | `apps/worker/src/adapters/issue-tracker/jira.ts`(+.test), `types.ts`, `apps/worker/src/lib/slack-search.ts`(+.test), `apps/worker/src/adapters/messaging/chatsdk.ts` | sonnet | nie | tak | nie | targeted testy jira/slack-search zielone (lookback `oldest`, cap paginacji 3 strony, match dwujęzyczny, permalink); typecheck zielony |
| 3 | D: dashboard - pola rate limit triggerów + config investigate + licznik odrzuceń + env | brak (UI z opisu) | `apps/dashboard/**/config-fields.tsx`, `apps/dashboard/**/blocks.ts` (CAŁE te pliki - jeden właściciel), `apps/worker/env.ts`, endpoint/API odczytu `trigger_rejection_counters` jeśli nie istnieje | sonnet | nie | nie | nie | `pnpm --filter ai-workflow-dashboard test` i `typecheck` zielone; pola renderują się dla 4 typów triggerów i investigate; licznik odrzuceń widoczny dla każdego typu triggera; description pól zawiera: semantykę fixed window (burst 2x), interakcję 3 limitów webhooka |
| 4 | A2: enforcement w 4 dispatcherach + liczniki | testy dispatcherów (mirror `[endpointId].post.test.ts`) | `apps/worker/src/lib/dispatch.ts`, `lib/dispatch-trigger.ts`, `schedule-trigger/dispatch-schedule-trigger.ts`, `webhook-trigger/dispatch-webhook-trigger.ts`(+testy), `routes/cron/poll.get.ts` (sweep liczników) | sonnet | tak | tak | nie | targeted testy zielone: limit odrzuca nowy start; guard duplikatu/already-claimed NIE konsumuje limitu; unlimited bez zmian; webhook rejected-outcome z licznikiem; typecheck |
| 5 | B2: blok investigate end-to-end | executor + `vi.mock` adapterów/llm | `apps/shared/contracts/domain.ts`, `apps/shared/contracts/workflow-graph.ts` (spec bloku), `apps/worker/src/workflow-definition/block-registry.ts`, `schema.ts` (literal investigate), `apps/worker/src/workflows/blocks/investigate.ts`(+.test) | opus | tak | tak | nie | `investigate.test.ts` zielone: keywords dwujęzyczne; insufficient_data bez retrieval; degradacja per provider; kontrakt output zgodny z rejestrem; description bloku zawiera wymóg terminacji flow; `pnpm --filter worker test -- block-registry schema` zielone; typecheck |

Zależności: fala 1 = etapy 1, 2, 3 równolegle (rozłączne pliki; nazwy parametrów i typu bloku zamrożone tym planem). Fala 2 = etapy 4 i 5 równolegle (4 po 1; 5 po 1 i 2 - dotyka `workflow-graph.ts` i `schema.ts` po zwolnieniu przez A1).

## Checklista pre-trial (przed poniedziałkiem)

1. Bot Slacka zaproszony na kanały z configu investigate - weryfikacja na realnym kanale (jeden ręczny run na środowisku klienta).
2. Jeden end-to-end run na środowisku klienta: ticket -> investigate -> teoria -> human_question (dogfooding, nie test integracyjny).
3. Graf demo z investigate MA ustawiony limit rate limitu i ścieżkę terminacji (label/transition/human_question) dla każdej klasyfikacji.
4. Smoke: flood test na triggerze z limitem (np. 20 szybkich ticketów) - odrzucenia widoczne w liczniku w UI.
