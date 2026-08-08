# AIW-238: Webhook triggers per-endpoint, not a global singleton

## Problem

A tenant can only have ONE enabled workflow that owns a `trigger_webhook` block across the whole org. Enabling a second one returns `409 "Its trigger is already handled by the enabled definition ..."`. This blocks running, say, a Zendesk support-ticket workflow and a Sentry error-alert workflow at the same time, even though each already has its own distinct receiver URL. Verified in prod: with Zendesk (def 15) enabled, enabling Sentry (def 16) 409s.

## Solution

From the operator's point of view: enabling a second (third, ...) webhook-trigger workflow just works. Each webhook workflow keeps its own endpoint URL, and a delivery to endpoint A starts a run on definition A while a delivery to endpoint B starts a run on definition B, with no cross-talk. Nothing changes for the genuinely-shared source triggers (Jira ticket, GitHub PR events): those stay one-enabled-definition-per-type, and trying to enable a second still 409s.

## User stories

1. Jako operator chcę włączyć osobny workflow dla Zendesku i osobny dla Sentry jednocześnie, żeby oba źródła miały automatyzację bez wyłączania jednego dla drugiego.
2. Jako operator chcę, żeby dostawa z danego źródła trafiła dokładnie do workflow przypisanego do jej endpointu, żeby nie było pomyłkowego routingu między webhookami.
3. Jako operator nadal chcę, żeby system nie pozwolił na dwa włączone workflow dla tego samego współdzielonego triggera źródła (Jira ticket, PR), żeby uniknąć podwójnego przetwarzania tego samego zdarzenia.
4. Jako operator chcę, żeby istniejący stan na prodzie sam się naprawił po wdrożeniu (bez ręcznego czyszczenia bazy), żeby oba webhooki dało się od razu włączyć.

## Decyzje implementacyjne

**Podział polityki.** Jedno źródło prawdy: `trigger_webhook` jest jedynym triggerem "per-endpoint"; wszystkie pozostałe (`trigger_ticket_ai`, `trigger_pr_created`, `trigger_pr_merged`, `trigger_pr_ready`, `trigger_pr_review`, `trigger_pr_updated`, `trigger_pr_checks_failed`, `trigger_plan_approved`) pozostają singletonami per typ. Reprezentacja: predykat `isPerEndpointTrigger(type)` (lub zbiór `SINGLETON_TRIGGER_TYPES` = wszystkie triggery poza webhook) w jednym miejscu, używany przez oba egzekwatory.

**Dwa poziomy egzekwowania singletona (oba do zmiany).**
- Kod (friendly precheck): `assertNoTriggerOverlap` liczy `arrayOverlaps` na `triggerTypes`. Ma filtrować listę do samych singletonów, zanim odpali zapytanie. Webhook nigdy nie liczy się jako overlap.
- DB (race-safe binding): tabela `workflow_definition_triggers` z `trigger_type` jako PRIMARY KEY. Kod wpisuje binding przy enable/deploy (ścieżki rzucające `TRIGGER_TAKEN_MESSAGE`). Dla `trigger_webhook` binding NIE ma być wpisywany (bo jego unikalność jest per-endpoint w `webhook_trigger_endpoints`, nie per-type).

**Routing DO PRZEPISANIA (kluczowa poprawka po pre-mortemie).** Wbrew pierwotnemu założeniu, webhook delivery NIE routuje się czysto per-endpoint. `resolveLiveWebhookTarget` (`routes/webhooks/custom/[endpointId].post.ts:333`) i `ensureStillDispatchable` (`:309`, wpięte w cron drain przez `poll.get.ts:241`) wołają `getEnabledWorkflowDefinitionForTrigger(db, "trigger_webhook")` i bramkują `live.definition.id !== endpoint.definitionId` (`:334`). Ten per-type single-owner JEST obecnym mechanizmem anty-cross-talk. Przy dwóch enabled webhookach `getEnabledWorkflowDefinitionForTrigger` (przez `readTriggerBinding`/`healMissingTriggerBinding`, gdzie `candidates.length===2` → null) zwróci null i ODRZUCI dostawy do OBU endpointów. Dlatego routing trzeba przepisać: dla webhooka pobierać definicję wprost po `endpoint.definitionId`, sprawdzać `enabled + deployed (current)` tej konkretnej definicji, i usunąć bramkę per-type ownera. To samo w `config.get.ts:60` (badge active/inactive) i `test-delivery.post.ts:81`. Nowy helper (kontrakt E1): `getEnabledDeployedDefinition(db, definitionId) → { definition, current } | null`. Po tym webhook nie zależy od `workflow_definition_triggers` w ogóle.

**Heal do wyłączenia dla webhooka.** `healMissingTriggerBinding` (`store.ts:584`) i `enabledDefinitionsDeclaringTrigger` (`:612`) czerpią kandydatów z kolumny `trigger_types` i re-insertują binding, gdy dokładnie jeden webhook jest enabled. Po usunięciu bindingów migracją, przy jednym enabled webhooku heal by je NATYCHMIAST re-insertował (walka z migracją). Dlatego `getEnabledWorkflowDefinitionForTrigger`/heal muszą pomijać `trigger_webhook` (webhook nie jest już nigdy pytany tą drogą po przepisaniu routingu, ale trzeba jawnie wykluczyć, żeby heal nie ożywił wierszy).

**Migracja danych.** Migracja usuwa istniejące wiersze `trigger_webhook` z `workflow_definition_triggers`. Bezpieczne dopiero PO tym, jak kod (E1) przestaje je czytać i re-insertować. `trigger_types` (denormalizowana kolumna) zostaje bez zmian, overlap-check i heal po prostu filtrują z niej webhook.

**Race-safety.** Singletony nadal chroni PK `workflow_definition_triggers.trigger_type` + `retryOnUniqueViolation`/`isUniqueViolation`. Webhook nie potrzebuje DB-guardu (wiele dozwolone), więc pominięcie insertu jest bezpieczne. neon-http nie ma transakcji, więc bez `db.transaction()`.

## Seamy i decyzje testowe

| Seam | Obserwowane zachowanie | Prior art |
|------|------------------------|-----------|
| `assertNoTriggerOverlap` + binding insert/heal w `store.ts`, przez pglite w `store.test.ts` | Drugi webhook-workflow enable → OK; drugi `trigger_ticket_ai` → 409 | `store.test.ts`, `store.ts:662` (assertNoTriggerOverlap), `:1217` (call site), `:584` (heal), `:612` (enabledDefinitionsDeclaringTrigger) |
| Delivery route: `resolveLiveWebhookTarget` / `ensureStillDispatchable` przez `[endpointId].post.ts` (+ HTTP-level test) | Delivery na endpoint A → run def A, endpoint B → run def B; dostawa na endpoint wyłączonej definicji → odrzucona | `routes/webhooks/custom/[endpointId].post.ts:333`, `:309`, `:334` (owner gate do usunięcia) |
| `webhook_trigger_endpoints` lookup | endpointId → `{definitionId, nodeId}` | `webhook-trigger/endpoint-store.ts:187` |

## Out of scope

- Zmiana routingu/ownership dla triggerów źródeł (ticket, PR) - zostają singletonami.
- UI dashboardu do zarządzania wieloma webhookami (o ile recon E1 nie wykaże twardego założenia "jeden webhook"). Jeśli wykaże, to osobny ticket.
- Limit liczby jednoczesnie włączonych webhooków (brak limitu, każdy ma własny endpoint).

## Założenia

- **~~Zał. 1~~ (OBALONE przez pre-mortem, wcielone w plan):** webhook routing JEDNAK czytał `workflow_definition_triggers` przez `getEnabledWorkflowDefinitionForTrigger` w `resolveLiveWebhookTarget`/`ensureStillDispatchable`. Dlatego E2 przepisuje routing na `endpoint.definitionId`. Bez tego feature by się rozbił (obie dostawy odrzucone).
- **Zał. 2:** Dashboard nie zakłada dokładnie jednego enabled webhook-workflow (lista/filtr/panel). Rekomendacja: E2 robi szybki grep po stronie dashboardu; jeśli zakłada, zgłoś jako follow-up, nie rozszerzaj tego planu.
- **Zał. 3:** Poza wymienionymi (routing, overlap, heal), `trigger_types` nie jest używane do innego per-type single-ownera dla webhooka. E1 potwierdza greppem `getEnabledWorkflowDefinitionForTrigger` / `readTriggerBinding` / `"trigger_webhook"` przed zamknięciem zakresu.

## Etapy

| # | Etap | Seam | Zakres plików | Tier | Sceptyk | TDD | Delegacja | DoD |
|---|------|------|---------------|------|---------|-----|-----------|-----|
| E1 | Polityka + store: `isPerEndpointTrigger` (jedno źródło prawdy), filtr w `assertNoTriggerOverlap`, wykluczenie webhooka z insert/sync bindingów i z `healMissingTriggerBinding`/`enabledDefinitionsDeclaringTrigger`; nowy helper `getEnabledDeployedDefinition(db, definitionId)`; grep potwierdzający wszystkie czytniki `"trigger_webhook"` / `getEnabledWorkflowDefinitionForTrigger` | assertNoTriggerOverlap + binding/heal | `apps/worker/src/workflow-definition/store.ts` | opus | tak | nie | nie | `pnpm --filter worker typecheck` czysto; grep: webhook nie jest insertowany ani healowany do `workflow_definition_triggers`; helper wyeksportowany z sygnaturą dla E2 |
| E2 | Routing rewrite: `resolveLiveWebhookTarget` i `ensureStillDispatchable` routują po `endpoint.definitionId` (helper z E1), usunięcie bramki per-type ownera (`:334`); to samo w `config.get.ts:60` i `test-delivery.post.ts:81`; szybki grep dashboardu (Zał.2) | delivery route | `apps/worker/src/routes/webhooks/custom/[endpointId].post.ts`, `.../webhook/config.get.ts`, `.../webhook/test-delivery.post.ts` | opus | tak | nie | nie | typecheck czysto; brak wywołań `getEnabledWorkflowDefinitionForTrigger("trigger_webhook")` na ścieżce dostawy; przegląd że dostawa na wyłączoną definicję nadal odrzucona |
| E3 | Migracja `0042`: `DELETE FROM workflow_definition_triggers WHERE trigger_type = 'trigger_webhook'` + wpis w `meta/_journal.json` | - | `apps/worker/drizzle/0042_*.sql`, `apps/worker/drizzle/meta/_journal.json` | sonnet | nie | nie | nie | Format zgodny z 0041; journal spójny; jedno stwierdzenie SQL (bez transakcji) |
| E4 | Testy po fakcie: (store) dwa webhook enable OK, drugi `trigger_ticket_ai` → 409; (route/HTTP) delivery A→run def A, B→run def B, delivery na wyłączoną definicję odrzucona | pglite `store.test.ts` + route test | `apps/worker/src/workflow-definition/store.test.ts`, `apps/worker/src/routes/webhooks/custom/[endpointId].post.test.ts` | opus | tak | nie | nie | `cd apps/worker && pnpm exec vitest run src/workflow-definition/store.test.ts src/routes/webhooks/custom/` zielone; oba scenariusze pokryte |

Kolejność i współbieżność: **E1 pierwszy** (zamraża `isPerEndpointTrigger` + sygnaturę `getEnabledDeployedDefinition`). **E3 równolegle z E1** (rozłączne pliki: drizzle vs store; kontrakt "webhook wykluczony" ustalony w planie), ale wdrożenie migracji na prod dopiero po zmergowaniu E1+E2. **E2 po bramce E1** (potrzebuje helpera). **E4 po E1+E2**. E1/E2 rozłączne z E4 plikowo, ale E4 zależy od zachowania obu.

## Rollout (poza tabelą, robi advisor po merge + deployu)

Po zmergowaniu i deployu worker na prod: włączyć oba webhooki (def 15 Zendesk + def 16 Sentry) jednocześnie, wygenerować dostawę na każdy endpoint (Zendesk ticket + Sentry error) i potwierdzić, że każda odpala run właściwej definicji, oba PR-y otwierają się niezależnie. To bezpośrednia realizacja odpowiedzi usera "włącz oba i przetestuj dokładnie".
