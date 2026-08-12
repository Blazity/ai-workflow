# AI Workflow Remote MCP: projekt architektury

**Data:** 2026-08-11  
**Status:** zatwierdzony kierunek do zaplanowania, bez implementacji  
**Zakres:** wewnętrzny dogfooding, pipeline release Artur/Arthur AI i dedykowane deploymenty klientów

## 1. Cel i kryterium sukcesu

AI Workflow udostępnia na każdym workerze stateless Remote MCP pod kanonicznym adresem `https://<worker-host>/mcp`. Agent podłączony z Claude Code, Codex lub innego zgodnego klienta może wykonać cały cykl pracy bez dashboardu i bez ręcznego czytania logów:

1. znaleźć, utworzyć i edytować ticket, dodać komentarz lub bezpiecznie zmienić status;
2. znaleźć runy ticketa, obserwować ich stan, trace i wynik oraz uzyskać deterministyczną diagnozę;
3. utworzyć workflow, edytować draft z kontrolą wersji, walidować graf z branchami i loopami, publikować, wycofywać oraz uruchamiać;
4. zarządzać harness profiles, skillami i przypięciami do bloków workflowu;
5. czytać memory oraz wykonywać kontrolowane, audytowalne aktualizacje i usunięcia;
6. uruchamiać i pobierać wyniki automatycznych testów dogfoodingowych.

Sukces oznacza, że ten sam kontrakt MCP przechodzi testy kontraktowe na wewnętrznym workerze, w preview release Artur i po wdrożeniu na dedykowany worker klienta. Dashboard nie jest częścią ścieżki krytycznej.

## 2. Stan zastany i wynikające ograniczenia

Analiza repozytorium wskazuje następujący stan:

- `apps/worker` jest workerem Nitro/Vercel z Durable Workflow DevKit, Neon Postgres/Drizzle, Vercel Sandbox i adapterami integracji. To tutaj działa `/api/v1/*`, wykonanie workflowów i dostęp do danych.
- `apps/dashboard` jest oddzielnym deploymentem Next.js i wywołuje workera serwer-serwer. MCP nie powinno zależeć od dashboardu.
- `apps/shared/contracts` zawiera współdzielone kontrakty domenowe.
- Better Auth `1.6.20` obsługuje sesje bearer, organizacje i zewnętrzny SSO przez `@better-auth/sso`. Obecnie AI Workflow jest klientem OIDC, a nie authorization serverem dla zewnętrznych klientów MCP.
- `/api/v1/*` wymaga ważnej sesji. `requireDashboardActor()` wiąże użytkownika z organizacją wskazaną przez `DASHBOARD_ORG_SLUG`; role to `owner`, `admin`, `member`.
- Workflow definitions mają draft revision, wersję wdrożoną, walidację, publish/deploy, rollback, restore i graf v2 obsługujący branche oraz loopy.
- Harness profiles mają organizację, draft, niezmienne opublikowane wersje, capability catalog oraz import/refresh skilli.
- Memory ma limity i kontrolę wersji w store, ale publiczne API nie zapewnia jeszcze pełnego bezpiecznego update flow.
- Run observability ma sanitizację execution logów i dane do diagnozy, ale nie ma wspólnego append-only audit logu dla wszystkich mutacji MCP.
- Release jest dwuetapowy: source workflow `prepare-artur-release.yml` i `sync-artur-release.yml` tworzy kompletny snapshot w repozytorium docelowym; repo docelowe waliduje, publikuje, czeka na deploymenty Vercel, wykonuje smoke testy i zapisuje `release-manifest.json`. Istniejące pliki i repo używają pisowni `Artur`; dokument biznesowy może mówić Arthur AI, ale automatyzacja zachowuje istniejące nazwy.
- Wewnętrznym celem dogfoodingu jest istniejący worker `ai-workflow-app`. Deployment `ai-workflow-demo` jest wyłączony z zakresu.

Nie zakładamy nazw istniejących sekretów ani nazw środowisk innych niż te odczytane z repo/deployment metadata. Każda nowa konfiguracja opisana niżej jest jawnie nową propozycją.

## 3. Rozważone warianty

### Wariant A — MCP osadzone w workerze (wybrany)

Endpoint `/mcp` działa w `apps/worker`, korzysta bezpośrednio z istniejących application services, tej samej bazy, adapterów i Better Auth. Jest stateless i ma osobne granice policy/audit/idempotency.

Zalety: najcieńsza warstwa, brak token passthrough, brak nowego service-to-service secretu, wspólne transakcje i naturalne wejście do obecnego snapshot release. Koszt: MCP współdzieli blast radius i skalowanie workera, więc wymaga limitów, timeoutów oraz feature flagi.

### Wariant B — osobne `apps/mcp`

Osobny deployment wywoływałby worker przez HTTP. Daje niezależne skalowanie, ale dubluje autoryzację, RBAC, idempotency i audyt; dodaje deployment, sekrety i ryzyko rozjazdu kontraktów. Odrzucony na tym etapie.

### Wariant C — generowana fasada MCP nad REST/OpenAPI

Najszybszy do uzyskania wielu endpointów, ale nie modeluje właściwie preview/confirm, CAS, trace’ów, granic zaufania ani semantyki workflowu. Odrzucony jako niewystarczająco bezpieczny.

## 4. Architektura docelowa

```text
Claude Code / Codex / klient MCP
        │ OAuth 2.1 + PKCE / client_credentials dla smoke
        ▼
https://<dedicated-worker>/mcp  (Streamable HTTP, stateless)
        │
        ├── MCP transport + schema validation + bounded output
        ├── OAuth token verification + actor/tenant context
        ├── RBAC/scope policy + rate limits
        ├── safe mutation coordinator (CAS + preview/confirm)
        ├── idempotency store + append-only audit
        │
        └── cienkie adaptery narzędzi
                ├── issue-tracker application service
                ├── run registry / run observability
                ├── workflow-definition store / manual dispatch
                ├── harness-profile store / skills
                ├── memory store
                └── dogfood test runner
```

### 4.1 Transport

- Stabilny protokół: MCP `2025-11-25`.
- Transport: wyłącznie Streamable HTTP pod `/mcp`; bez przestarzałego HTTP+SSE.
- `POST /mcp` obsługuje JSON-RPC. `GET /mcp` i `DELETE /mcp` zwracają `405`, ponieważ serwer nie utrzymuje sesji transportowej ani server-initiated notifications.
- Każde żądanie jest samowystarczalne. Nie przechowujemy `Mcp-Session-Id`, co usuwa problem routingu sesji pomiędzy instancjami Vercel i przygotowuje migrację do planowanej wersji protokołu bez sesji.
- Maksymalny request body, czas wykonania i maksymalny rozmiar wyniku są ustawione per deployment. Duże logi, trace’y i listy zawsze używają cursor pagination.
- Odpowiedzi zawierają `requestId`, `serverVersion`, `contractHash` i bezpieczny `traceId` w `_meta` z własnym reverse-DNS namespace; żadnych tokenów ani sekretów.

MCP `2025-11-25` wymaga od HTTP resource servera RFC 9728, audience binding i zabrania token passthrough. Streamable HTTP zastępuje stary transport HTTP+SSE. Źródła: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

### 4.2 OAuth

Worker zostaje jednocześnie OAuth Authorization Serverem i MCP Resource Serverem:

- `@better-auth/oauth-provider@1.6.20` rozszerza istniejące Better Auth bez osobnego systemu kont.
- Interaktywni użytkownicy używają Authorization Code + PKCE S256. Agent dziedziczy `userId`, organizację i rolę użytkownika, który udzielił zgody.
- `client_credentials` jest dozwolone wyłącznie dla wcześniej utworzonych confidential clients używanych przez smoke/dogfood automation. Każdy taki klient ma stałą organizację i najmniejszy zestaw scope’ów.
- Publiczne klienty Claude Code/Codex są pre-rejestrowane lub rejestrowane przez DCR zgodnie z polityką deploymentu. Niezaufana anonimowa rejestracja jest domyślnie wyłączona na deploymentach klientów.
- Canonical resource/audience to dokładnie `https://<worker-host>/mcp`; token dla innego hosta, ścieżki lub deploymentu jest odrzucany.
- `/.well-known/oauth-protected-resource/mcp` zwraca RFC 9728 metadata. `401` z `/mcp` zawiera `WWW-Authenticate` z `resource_metadata` i minimalnym scope’em. Authorization Server metadata i OIDC discovery są wystawiane przez Better Auth handler również na well-known paths wymaganych dla issuerów z path component.
- CORS ujawnia `WWW-Authenticate` tylko do jawnie dopuszczonych originów; callback URIs są porównywane dokładnie.
- Worker nigdy nie przekazuje tokenu MCP do Jira, GitHuba, GitLaba ani providera modeli. Używa wyłącznie credentiali danego deploymentu.

Better Auth OAuth Provider deklaruje OAuth 2.1, PKCE, JWT/JWKS, discovery, DCR i resource-server helper dla MCP: [Better Auth OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider).

### 4.3 Tenant isolation

Podstawową granicą klienta jest dedykowany deployment: osobny worker host, baza i credentiale integracji. Obrona warstwowa pozostaje obowiązkowa:

- narzędzia nie przyjmują `tenantId` ani `organizationId` od modelu;
- kontekst tenant/actor jest wyprowadzany wyłącznie ze zweryfikowanego tokenu i członkostwa w `DASHBOARD_ORG_SLUG` danego deploymentu;
- każde nowe MCP query i tabela zawiera `organization_id`; odczyt i zapis zawsze filtruje po nim;
- dla istniejących globalnie wyglądających stores facade MCP sprawdza deployment organization przed wywołaniem, a migracje do pełnego org scoping są częścią etapów domenowych;
- cache, idempotency key i confirmation token są namespacowane przez deployment, organizację, aktora, client i tool.

### 4.4 Warstwy kodu

1. **Transport** mapuje H3 request/response na SDK MCP; nie zawiera logiki domenowej.
2. **Request context** weryfikuje token, audience, membership, role i scope; tworzy niezmienny `McpActorContext`.
3. **Tool registry** rejestruje Zod input/output schema, annotations i deleguje do facade domenowej.
4. **Policy** jest jedynym miejscem mapowania tool → scopes → roles → mutation class.
5. **Safety coordinator** obsługuje CAS, preview/confirm i canonical payload hash.
6. **Idempotency** gwarantuje exactly-once visible outcome dla powtórzeń mutacji w określonym oknie.
7. **Audit** zapisuje zredagowane metadata niezależnie od sukcesu operacji.
8. **Application services** pozostają źródłem prawdy; MCP nie replikuje reguł Jira, workflow lifecycle, harness ani memory.

## 5. Autoryzacja, RBAC i bezpieczne mutacje

### 5.1 Scope’y

| Scope | Znaczenie |
|---|---|
| `mcp:read` | capabilities, tickety, runy, workflowy, profile, skills, memory metadata/content po redakcji |
| `tickets:write` | create/edit/comment/labels/transition |
| `runs:dispatch` | preflight i uruchomienie workflowu |
| `runs:control` | cancel/replay |
| `workflows:write` | create i draft edits |
| `workflows:publish` | publish, rollback, enable/archive |
| `harness:write` | profile drafts, skills i assignments |
| `memory:write` | update memory |
| `memory:delete` | hard delete memory |
| `dogfood:run` | uruchomienie mutation-canary suite |

### 5.2 Mapowanie roli

| Operacja | member | admin | owner | service client |
|---|---:|---:|---:|---:|
| Odczyt danych po redakcji | tak | tak | tak | według scope |
| Ticket write, dispatch | nie | tak | tak | według scope |
| Workflow/harness draft | nie | tak | tak | domyślnie nie |
| Publish/rollback/run control | nie | tak | tak | wyłącznie jawny scope |
| Memory update | nie | tak | tak | domyślnie nie |
| Memory delete | nie | nie | tak | nie |
| Mutation dogfood suite | nie | tak | tak | tak, ograniczona do canary fixtures |

Autoryzacja wymaga jednocześnie roli i scope’u. Scope nie podnosi roli, a rola nie zastępuje scope’u.

### 5.3 Klasy mutacji

**Klasa R — bezpośrednia, odwracalna:** create/update draft, komentarz, labels, dispatch po udanym preflight. Wymaga `idempotencyKey` i odpowiedniego `expectedRevision`, `expectedVersion`, `expectedStatusId` lub `expectedContentDigest`.

**Klasa C — preview/confirm:** transition ticketa, publish/rollback/archive workflowu, cancel/replay runu, publish profilu, import/refresh skilla zmieniający aktywny artefakt, memory update i memory delete. Preview zwraca deterministyczny diff/skutki i jednorazowy `confirmationToken` ważny 5 minut. Confirm musi przesłać ten token oraz ten sam `idempotencyKey`.

Confirmation token jest związany z: deploymentem, `organizationId`, `actorId`, `clientId`, nazwą toola, canonical hash inputu, aktualną wersją zasobu i czasem wygaśnięcia. Jest jednorazowy. Zmiana stanu po preview powoduje `CONFLICT`, a nie automatyczne wykonanie na nowym stanie.

### 5.4 Idempotency

Tabela `mcp_idempotency_keys` ma unikalność `(organization_id, actor_subject, client_id, tool_name, idempotency_key)`. Rekord przechowuje input hash, stan `started|completed|failed`, bezpieczny outcome oraz expiry 24h.

- ten sam klucz i ten sam payload zwraca poprzedni wynik;
- ten sam klucz i inny payload zwraca `IDEMPOTENCY_CONFLICT`;
- timeout po niejednoznacznym wyniku jest rozstrzygany przez odczyt domenowy przed retry;
- read tools nie wymagają klucza.

### 5.5 Audit log

Append-only `mcp_audit_events` zachowuje przez 365 dni, z możliwością zmiany okresu per deployment:

- request/trace ID, czas, server version i contract hash;
- actor subject, client ID, organization ID, role i użyte scope’y;
- tool, mutation class, target references, outcome/error code, latency;
- hash inputu i outputu, hash idempotency key oraz confirmation ID;
- zredagowane metadata skutku, nigdy access/refresh tokens, client secretów, pełnych komentarzy, logów ani treści memory.

Retention job usuwa tylko rekordy starsze niż skonfigurowany okres i sam generuje metrykę, nie audit event per row.

## 6. Ochrona przed prompt injection i wyciekiem danych

Treść ticketa, komentarze, attachment metadata, logi, trace attributes, skill files i memory są traktowane jako `external_untrusted`, nawet jeżeli pochodzą z wewnętrznego systemu.

- Surowa treść nigdy nie trafia do tool description, błędu systemowego ani instrukcji serwera.
- Wyniki mają rozdzielone pola `data`, `trust`, `contentDigest`, `truncated`, `redactions` i cursor.
- Domyślnie zwracane są summary i strukturalne evidence. Pełne komentarze/log chunks wymagają jawnego parametru, uprawnienia i limitu.
- Sanitizer usuwa znane sekrety, auth headers, token-like values i kontrolne znaki przed serializacją oraz przed logowaniem.
- `runs.diagnose` jest deterministycznym klasyfikatorem nad zredagowanymi zdarzeniami. Nie uruchamia ukrytego LLM, który mógłby wykonać instrukcję z logu.
- Żadna mutacja nie przyjmuje całego wcześniejszego wyniku jako opaque payload. Każdy target i zmiana przechodzi Zod schema, canonicalization, policy i CAS.
- URL-e pobierane przez skill discovery/import podlegają allowliście hostów, blokadzie private IP/redirect SSRF i limitom rozmiaru.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) opisują ryzyko dla klienta, ale nigdy nie zastępują kontroli serwerowej.

## 7. Wspólny kontrakt narzędzi

Każde narzędzie zwraca:

```ts
type McpEnvelope<T> = {
  data: T;
  meta: {
    requestId: string;
    traceId: string;
    serverVersion: string;
    contractHash: string;
    trust: "system" | "tenant" | "external_untrusted";
    truncated: boolean;
    redactions: number;
    nextCursor?: string;
  };
};
```

Błędy używają stałych kodów: `UNAUTHENTICATED`, `INSUFFICIENT_SCOPE`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `CONFIRMATION_REQUIRED`, `CONFIRMATION_EXPIRED`, `RATE_LIMITED`, `DEPENDENCY_UNAVAILABLE`, `INTERNAL_ERROR`. Message jest bezpieczny dla modelu; szczegół trafia tylko do zredagowanych logów z `requestId`.

Listy przyjmują `limit` w zakresie `1..100` i opaque `cursor`. Identyfikatory są stringami z limitami długości. Timestamps są UTC ISO-8601. Wersje i revisions są liczbami całkowitymi, a digests mają postać `sha256:<hex>`.

## 8. Katalog MCP

Poniższe nazwy są publicznym, wersjonowanym kontraktem. Input pomija `organizationId`; kontekst pochodzi z tokenu.

### 8.1 System

| Tool | Input | Output / uwagi |
|---|---|---|
| `system.capabilities` | `{}` | protocol/server version, contract hash, deployment class, enabled domains, read scopes |
| `system.schemas` | `{name: "workflow-v2"|"harness-profile"|"tool-catalog"}` | versioned JSON Schema i digest |

### 8.2 Tickety

| Tool | Input | Output / mutacja |
|---|---|---|
| `tickets.search` | `{query, limit?, cursor?}` | summary ticketów; external untrusted |
| `tickets.get` | `{ticketKey, includeComments?, commentsLimit?}` | pola, status, labels, zredagowane komentarze i content digest |
| `tickets.create` | `{projectKey, summary, description?, issueType, labels?, idempotencyKey}` | Klasa R; utworzony ticket |
| `tickets.update` | `{ticketKey, fields, expectedUpdatedAt, idempotencyKey}` | Klasa R; allowlista edytowalnych pól |
| `tickets.comment` | `{ticketKey, body, idempotencyKey}` | Klasa R; comment ID i timestamp |
| `tickets.update_labels` | `{ticketKey, add?, remove?, expectedLabelsDigest, idempotencyKey}` | Klasa R; wynikowy zbiór labels |
| `tickets.preview_transition` | `{ticketKey, targetStatusId, expectedStatusId, idempotencyKey}` | diff i confirmation token |
| `tickets.confirm_transition` | `{confirmationToken, idempotencyKey}` | Klasa C; nowy status |
| `tickets.list_runs` | `{ticketKey, status?, limit?, cursor?}` | run summaries powiązane z ticketem |

### 8.3 Runy, trace i wyniki

| Tool | Input | Output / mutacja |
|---|---|---|
| `runs.list` | `{workflowId?, ticketKey?, status?, createdAfter?, limit?, cursor?}` | run summaries |
| `runs.get` | `{runId}` | bieżący status, workflow/version, attempt summary, result/error summary |
| `runs.get_attempt` | `{runId, attemptId}` | step/block statuses i zredagowane outcomes |
| `runs.trace` | `{runId, attemptId?, level?: "summary"|"detailed", cursor?, limit?}` | uporządkowane spans/events, bez surowych sekretów |
| `runs.result` | `{runId}` | typed final output, artifacts/references i failure classification |
| `runs.diagnose` | `{runId, depth?: "summary"|"full"}` | deterministyczna diagnoza, evidence refs i bezpieczne next actions |
| `runs.preview_cancel` | `{runId, expectedStatus, idempotencyKey}` | skutek i confirmation token |
| `runs.confirm_cancel` | `{confirmationToken, idempotencyKey}` | Klasa C |
| `runs.preview_replay` | `{runId, attemptId?, expectedStatus, idempotencyKey}` | preflight replay i token |
| `runs.confirm_replay` | `{confirmationToken, idempotencyKey}` | Klasa C; nowy run/attempt ID |

MCP nie utrzymuje subskrypcji. Agent obserwuje run przez polling `runs.get`; odpowiedź zawiera `pollAfterMs` i terminal flag. To działa poprawnie na stateless Vercel i w pierwszym slice nie wymaga kolejki eventów.

### 8.4 Workflowy

| Tool | Input | Output / mutacja |
|---|---|---|
| `workflows.list` | `{state?, limit?, cursor?}` | definicje i wersje |
| `workflows.get` | `{workflowId, version?: "draft"|number}` | graph v2 i lifecycle metadata |
| `workflows.create` | `{name, description?, definition?, idempotencyKey}` | Klasa R; draft revision 1 |
| `workflows.save_draft` | `{workflowId, definition, expectedDraftRevision, idempotencyKey}` | Klasa R; pełna schema v2 wspiera branche i loopy |
| `workflows.validate` | `{definition}` lub `{workflowId, revision}` | errors/warnings ze ścieżkami w grafie; bez zapisu |
| `workflows.preview_publish` | `{workflowId, expectedDraftRevision, expectedDeployedVersion, idempotencyKey}` | walidacja, diff wersji i token |
| `workflows.confirm_publish` | `{confirmationToken, idempotencyKey}` | Klasa C; immutable deployed version |
| `workflows.restore_draft` | `{workflowId, sourceVersion, expectedDraftRevision, idempotencyKey}` | Klasa R |
| `workflows.preview_rollback` | `{workflowId, targetVersion, expectedDeployedVersion, idempotencyKey}` | diff i token |
| `workflows.confirm_rollback` | `{confirmationToken, idempotencyKey}` | Klasa C |
| `workflows.set_lifecycle` | preview/confirm dla `{workflowId, action: "enable"|"disable"|"archive", expectedVersion}` | Klasa C |
| `workflows.dispatch_preflight` | `{workflowId, nodeId?, input, expectedDeployedVersion}` | resolved trigger/target, validation i estimated scope |
| `workflows.dispatch` | `{workflowId, nodeId?, input, expectedDeployedVersion, preflightDigest, idempotencyKey}` | Klasa R; run ID i polling hint |

Branch i loop nie są osobnymi imperative tools. Są typowanymi węzłami/krawędziami `workflow-v2`; walidator sprawdza osiągalność, dozwolone cykle, exit condition, max iterations i bindings przed zapisem/publikacją.

### 8.5 Harness profiles i skille

| Tool | Input | Output / mutacja |
|---|---|---|
| `harness.list_profiles` | `{state?, limit?, cursor?}` | profile summaries |
| `harness.get_profile` | `{profileId, version?: "draft"|number}` | manifest i capabilities |
| `harness.create_profile` | `{name, base?, idempotencyKey}` | Klasa R |
| `harness.save_draft` | `{profileId, manifest, expectedDraftRevision, idempotencyKey}` | Klasa R |
| `harness.validate` | `{manifest}` lub `{profileId, revision}` | errors/warnings/capability gaps |
| `harness.preview_publish` / `harness.confirm_publish` | preview z profile/revisions; confirm z tokenem | Klasa C |
| `harness.capabilities` | `{agentKind?, refresh?: false}` | cached capability catalog |
| `skills.search_remote` | `{provider, repository, query?, ref?, limit?, cursor?}` | allowlisted discovery, bez zapisu |
| `skills.list_local` | `{query?, limit?, cursor?}` | skonfigurowane lokalne źródła |
| `skills.preview_import` / `skills.confirm_import` | source/ref/path/profile target + CAS; token | Klasa C, SSRF/content limits |
| `skills.preview_refresh` / `skills.confirm_refresh` | `{skillId, expectedDigest, targetProfileRevision, idempotencyKey}`; token | Klasa C |
| `harness.assign_profile` | `{workflowId, nodeId, profileId, profileVersion, expectedDraftRevision, idempotencyKey}` | Klasa R; atomowy patch węzła grafu |
| `harness.unassign_profile` | `{workflowId, nodeId, expectedDraftRevision, idempotencyKey}` | Klasa R |

### 8.6 Memory

| Tool | Input | Output / mutacja |
|---|---|---|
| `memory.list` | `{scope?, repository?, limit?, cursor?}` | metadata, version, provenance i digest |
| `memory.get` | `{memoryId, includeContent?: true}` | zredagowana treść, provenance, version i digest |
| `memory.preview_update` | `{memoryId, operation: "replace"|"merge", content, expectedVersion, expectedContentDigest, idempotencyKey}` | deterministic diff, policy warnings i token |
| `memory.confirm_update` | `{confirmationToken, idempotencyKey}` | Klasa C; nowa wersja/digest |
| `memory.preview_delete` | `{memoryId, expectedVersion, expectedContentDigest, reason, idempotencyKey}` | skutek i token |
| `memory.confirm_delete` | `{confirmationToken, idempotencyKey}` | Klasa C; tylko owner |

Memory content przechodzi secret scanning oraz kontrolę rozmiaru przed preview. Audit przechowuje wyłącznie hash/diff statistics, nie treść.

### 8.7 Dogfood i diagnostyka systemowa

| Tool | Input | Output / mutacja |
|---|---|---|
| `dogfood.list_suites` | `{}` | wersjonowane suite’y i wymagane scopes |
| `dogfood.run` | `{suite: "readonly"|"mutation-canary", fixtureSet, idempotencyKey}` | async test run ID; mutation suite tylko na canary fixtures |
| `dogfood.get` | `{testRunId}` | status, checks, timings, zredagowane evidence, artifact refs |
| `dogfood.list` | `{status?, limit?, cursor?}` | historia testów dla deploymentu |

`mutation-canary` tworzy zasoby ze znacznikiem run ID, nie dotyka normalnych ticketów/workflowów/memory i sprząta je idempotentnie. Cleanup failure jest widoczny jako osobny check i alert.

## 9. Zasoby MCP

Mały zestaw read-only resources ogranicza powtarzanie dużych schematów w tool calls:

- `ai-workflow://schemas/workflow-definition/v2`;
- `ai-workflow://catalog/workflow-blocks`;
- `ai-workflow://catalog/harness-capabilities`;
- `ai-workflow://contracts/tools/<contractHash>`.

Resources przechodzą ten sam auth/tenant policy co tools. Prompts MCP nie są publikowane w pierwszej wersji, aby serwer nie wprowadzał instrukcji konkurujących z host agentem.

## 10. Model danych MCP

Nowe tabele są częścią `apps/worker/src/db/schema.ts` i każda ma `organization_id`:

- `mcp_idempotency_keys`: klucz, payload hash, state, safe response, expiry;
- `mcp_confirmation_intents`: tool/target/input hash, expected state, actor/client, expires, consumed timestamp;
- `mcp_audit_events`: append-only metadata audytu;
- `mcp_dogfood_runs` i `mcp_dogfood_checks`: stan asynchronicznych suite’ów.

OAuth Provider dodaje własne tabele do `auth-schema.ts` zgodnie ze schematem dokładnie tej samej wersji pakietu co Better Auth. Migracje są expand-only w release wprowadzającym MCP. Stary kod może działać z nowym schematem; rollback aplikacji nie wymaga rollbacku bazy.

## 11. Obserwowalność i operacje

### 11.1 Metryki i logi

- liczba/latency/error rate per tool, bez `ticketKey` i treści jako metric labels;
- 401/403/409/429, idempotency replay/conflict, confirmation expired/consumed;
- długość i redaction count odpowiedzi, dependency latency i timeout;
- dogfood suite pass/fail/cleanup failure;
- OAuth authorize/token failures bez logowania code/token/client secret.

W3C `traceparent` jest przyjmowany z allowlistą formatu; MCP request span jest rodzicem spanów application service i integracji. `runs.trace` czyta tylko trace należące do organizacji.

### 11.2 Health

- `/health` pozostaje prostym liveness.
- nowy `/api/v1/system/mcp-readiness` jest wewnętrznym/deployment smoke endpointem i sprawdza feature flagę, schema floor, OAuth signing/JWKS, DB oraz contract hash bez ujawniania sekretów.
- `system.capabilities` jest autoryzowanym MCP-level readiness/capability check.

### 11.3 Feature flags i limity

Nowe, jawnie proponowane env vars (nie są traktowane jako już istniejące):

- `MCP_ENABLED` — kill switch, domyślnie `false` poza dogfood;
- `MCP_SERVER_VERSION` — SemVer buildu, walidowany przy starcie;
- `MCP_AUDIT_RETENTION_DAYS` — domyślnie `365`;
- `MCP_MAX_REQUEST_BYTES`, `MCP_MAX_RESULT_BYTES` i `MCP_TOOL_TIMEOUT_MS` — bounded defaults;
- `MCP_READ_RATE_LIMIT_PER_MINUTE` i `MCP_MUTATION_RATE_LIMIT_PER_MINUTE` — per tenant/actor/client/tool, domyślnie odpowiednio `120` i `20`;
- `MCP_ALLOW_PUBLIC_DCR` — domyślnie `false`; wewnętrzny dogfood może jawnie dopuścić wyłącznie public clients z PKCE S256 oraz bezpiecznymi HTTPS/loopback redirect URIs, a deploymenty klientów startują od pre-registration;
- `MCP_DOGFOOD_FIXTURE_PREFIX` — izolowany prefix canary.

Sekrety OAuth smoke client nie dostają nazwy w specyfikacji jako „istniejące”. Pipeline ma osobny krok discovery/configuration i tworzy nowe GitHub Environment secrets dopiero po potwierdzeniu polityki repo docelowego.

## 12. Wersjonowanie i kompatybilność

- `MCP_SERVER_VERSION` używa SemVer niezależnie od calendar version release Artur.
- `serverInfo.version`, `system.capabilities` i release manifest pokazują tę samą wersję.
- `contractHash` jest SHA-256 canonical JSON wszystkich nazw, input/output schemas, annotations i error codes.
- Zmiany addytywne narzędzi i optional fields są minor; naprawy bez zmiany kontraktu patch; usunięcie/zmiana znaczenia toola lub required field wymaga major.
- Deprecation trwa minimum dwa kolejne release’y Artur i jest raportowana w capabilities oraz tool metadata.
- Worker wspiera stabilny MCP `2025-11-25`. Wersja `2026-07-28` zostanie dodana dopiero po statusie stable i przejściu macierzy klientów; stateless design minimalizuje zakres migracji.
- Release manifest zapisuje minimalny DB schema revision i kompatybilny zakres product release.

## 13. Test strategy

### 13.1 Unit

- schema validation i canonical hashing;
- role + scope matrix, audience i organization binding;
- idempotency replay/conflict/concurrent start;
- preview token: expiry, one-use, actor/client/payload/state binding;
- sanitizer i injection fixtures dla ticketów, logów, skill files i memory;
- mapping errors z application services do publicznych MCP codes;
- deterministic run diagnosis.

### 13.2 Integration z PGlite

- OAuth schema i issuance/verification flow;
- wszystkie nowe tabele z org isolation;
- transactionality mutacja + idempotency + audit;
- cross-tenant IDs zawsze wyglądają jak `NOT_FOUND`;
- CAS conflicts oraz retry po ambiguous dependency response;
- retention i canary cleanup.

### 13.3 MCP contract

- initialize dla `2025-11-25`, tools/list i resources/list;
- snapshot canonical schemas i contract hash;
- POST content types, batch rejection zgodnie z SDK/spec, 405 GET/DELETE;
- 401 challenge i oba well-known discovery flows;
- klient testowy wykonuje OAuth PKCE i service client flow;
- każdy tool ma annotations zgodne z server policy.

### 13.4 Adapter/domain

- Jira create/update/comment/transition: expected state, rate limit, retry i read-after-error;
- workflow branches/loops: poprawny graf, niedozwolony cykl, missing exit, max iterations;
- harness import SSRF, size, digest i profile revision conflicts;
- memory secret rejection/redaction i content size;
- run trace pagination i result terminal/non-terminal.

### 13.5 End-to-end

Macierz: internal dogfood, destination preview, destination production, customer canary. Dla każdego:

1. discovery → OAuth → initialize;
2. read-only suite;
3. mutation-canary suite w izolowanych fixtures;
4. dispatch canary workflow → poll → trace → result → diagnose;
5. cleanup i audit assertion.

Release blokuje się przy każdym błędzie auth, contract hash, org isolation, mutation cleanup lub terminal result.

## 14. Fazy delivery

### Faza 1 — wewnętrzny deployment i dogfooding

1. Dodać MCP foundation pod feature flagą do `apps/worker`.
2. Wdrożyć pierwszy vertical slice i OAuth na `ai-workflow-app`.
3. Najpierw scopes read-only, potem `runs:dispatch` dla wybranej grupy.
4. Uruchamiać scheduled i manual dogfood Action; auditować wszystkie calls.
5. Po co najmniej 7 dniach bez cross-tenant/security failure rozszerzyć o ticket mutations, workflow authoring, harness i memory w osobnych domain increments.

### Faza 2 — GitHub Action w release pipeline Artur

Source repo:

- CI generuje `mcp-contract.json`, hash i wykonuje unit/contract tests.
- `prepare-artur-release.yml` waliduje, że release notes zawierają MCP version/compatibility, gdy contract hash się zmienił.
- `sync-artur-release.yml` kopiuje implementację i contract snapshot jako część istniejącego immutable snapshotu; nie wdraża klienta bezpośrednio.

Destination repo:

- zachować istniejące `validate-artur-release.yml` i `publish-artur-release.yml` jako ownership repo docelowego;
- dodać reusable composite/Node Action `mcp-release-smoke`, wywoływane po uzyskaniu worker preview URL i ponownie po production deployment;
- Action wykonuje discovery, service OAuth, initialize, read-only smoke i opcjonalny mutation-canary;
- `release-manifest.json` dostaje sekcję `mcp` z endpointem `/mcp`, server SemVer, protocol versions, contract hash, schema floor, smoke run ID i wynikiem.

Nie wprowadzamy nazwy sekretu w source repo. Implementacja Action przyjmuje named inputs; konkretne mapowanie do GitHub Environment secrets jest definiowane i reviewowane w destination repo.

### Faza 3 — publikacja wersjonowanego artefaktu

Ponieważ MCP jest częścią workera, artefaktem nie jest lokalny package do instalacji w Claude/Codex. Publikujemy niemutowalny `ai-workflow-mcp-manifest.json` jako asset GitHub Release oraz część release manifestu. Zawiera:

- MCP SemVer, source/destination commit SHA;
- protocol versions i canonical endpoint path;
- contract snapshot/hash;
- DB/auth schema floor;
- supported AI Workflow/Artur release range;
- build provenance i smoke evidence.

Build failuje, jeśli wygenerowany kontrakt różni się od committed snapshot bez zmiany SemVer.

### Faza 4 — rollout na deploymenty klientów

1. Preflight inventory każdego deploymentu: worker URL, Better Auth URL, organization slug, DB revision, Vercel project link i dostępna polityka secrets — bez przyjmowania wspólnych nazw.
2. Expand migrations i deployment z `MCP_ENABLED=false`.
3. Utworzenie/rotacja klienta smoke w danym tenantcie; interaktywni klienci pozostają consent-based.
4. Enable read-only dla canary administratorów, uruchomienie smoke.
5. Enable dispatch i mutations per scope; memory delete jako ostatnie.
6. Każdy klient ma oddzielny endpoint, audience, OAuth clients, DB i audit retention.

### Faza 5 — smoke, obserwowalność, rollback i kompatybilność

- Publikacja wymaga zielonych preview i production smoke oraz zgodnego contract hash.
- Alerty: error rate, auth failures, idempotency conflicts, cleanup failure, audit write failure i run terminal timeout.
- Audit write failure dla mutacji jest fail-closed; dla read tools może być fail-closed również na customer deploymentach, konfigurowane polityką, domyślnie fail-closed.
- App rollback używa poprzedniego immutable Vercel deploymentu/commit SHA. `MCP_ENABLED=false` jest natychmiastowym kill switchem.
- DB rollout jest expand/contract; nowe tabele pozostają po app rollbacku. Contract migrations/destructive cleanup następują dopiero po upływie okna kompatybilności dwóch release’ów.
- Jeżeli nowa wersja MCP nie przechodzi smoke, release nie taguje artefaktu i nie promuje deploymentu klienta.

## 15. Pierwszy vertical slice

### 15.1 Zakres

`OAuth → tickets.get → tickets.list_runs → runs.get/runs.trace/runs.result/runs.diagnose → workflows.dispatch_preflight → workflows.dispatch → polling runs.get`

Slice celowo nie zawiera ticket mutation, authoringu workflowu, harness ani memory. Buduje jednak wspólny fundament security/audit/idempotency, żeby kolejne domeny nie tworzyły równoległych mechanizmów.

### 15.2 Planowane pliki

**Dependencies/config/auth**

- Modify `apps/worker/package.json`: dokładnie zgodne wersje `@modelcontextprotocol/sdk` i `@better-auth/oauth-provider` z lockfile; startowo zweryfikowane `1.30.0` i `1.6.20`.
- Modify `pnpm-lock.yaml`: lock dependencies.
- Modify `apps/worker/env.ts` i `apps/worker/env.test.ts`: nowe MCP settings i bezpieczne defaults.
- Modify `apps/worker/src/auth.ts`, `auth.test.ts`, `auth-instance.ts`: OAuth Provider, scopes, consent route config i service-client grant policy.
- Modify `apps/worker/src/db/auth-schema.ts` i test: tabele wygenerowane przez OAuth Provider tej samej wersji.
- Create kolejna wolna migracja Drizzle po aktualnym journal state; numer jest wyznaczany w momencie implementacji, ponieważ worktree już zawiera niezatwierdzoną migrację `0045_local_skill_source.sql` użytkownika.

**MCP foundation**

- Create `apps/worker/src/mcp/contracts.ts`: envelope, public error codes, cursors i common schemas.
- Create `apps/worker/src/mcp/request-context.ts`: token verification, audience, org membership i actor context.
- Create `apps/worker/src/mcp/policy.ts`: tool/scope/role/mutation matrix.
- Create `apps/worker/src/mcp/audit-store.ts`: append-only writes i retention query.
- Create `apps/worker/src/mcp/idempotency-store.ts`: begin/complete/fail/replay.
- Create `apps/worker/src/mcp/sanitize-result.ts`: bounded/redacted envelope.
- Create `apps/worker/src/mcp/server.ts`: SDK server factory, version i registry.
- Create `apps/worker/src/mcp/transport.ts`: H3 Streamable HTTP adapter, 401/405/content negotiation.
- Create `apps/worker/src/routes/mcp.post.ts`, `mcp.get.ts`, `mcp.delete.ts`.
- Create `apps/worker/src/routes/.well-known/oauth-protected-resource/mcp.get.ts` oraz OAuth AS metadata forwarding routes wymagane przez issuer path.

**Slice tools**

- Create `apps/worker/src/mcp/tools/tickets.ts`: `tickets.get`, `tickets.list_runs` przez issue tracker i run queries.
- Create `apps/worker/src/mcp/tools/runs.ts`: `runs.get`, `runs.trace`, `runs.result`, `runs.diagnose` przez istniejący run registry/observability/sanitizer.
- Create `apps/worker/src/mcp/tools/workflows.ts`: dispatch preflight i idempotent dispatch przez `manual-dispatch/service.ts`.
- Create `apps/worker/src/mcp/run-diagnosis.ts`: deterministyczne reguły i evidence refs.
- Create `apps/worker/src/mcp/tool-catalog.ts` i committed `apps/worker/src/mcp/contracts/mcp-contract.json`.

**Dogfood/release**

- Create `apps/worker/scripts/mcp-smoke.ts`: real MCP client flow, nie bezpośrednie importy serwera.
- Create `.github/actions/mcp-release-smoke/action.yml` i `run.ts`/bundled artifact zgodnie z istniejącą polityką actions.
- Create `.github/workflows/mcp-dogfood.yml`: internal deployment smoke; wszystkie URL/credential values jako inputs/environment mappings, bez zgadywania sekretów.
- Modify destination-owned release workflows dopiero w repo docelowym; source plan dokumentuje oczekiwany patch, ale nie udaje lokalnego pliku.

### 15.3 Testy slice

- `request-context.test.ts`: valid user, wrong audience, expired token, missing org, cross-deployment token, service client scopes.
- `policy.test.ts`: member read, admin dispatch, missing scope, service client least privilege.
- `audit-store.test.ts`: success/failure entries, redaction, org isolation i retention boundary.
- `idempotency-store.test.ts`: replay, payload conflict, concurrent duplicate, ambiguous failure.
- `sanitize-result.test.ts`: injection strings pozostają data, secrets redacted, bounds i cursor.
- `transport.test.ts`: initialize, tools/list, content types, 401 challenge, POST, 405 GET/DELETE, no session ID.
- `oauth-metadata.test.ts`: exact resource/audience, AS discovery i PKCE S256 metadata.
- `tickets.test.ts`: ticket adapter result, untrusted marking, list runs tenant filter.
- `runs.test.ts`: nonterminal/terminal result, trace pagination, sanitized logs, cross-org not found.
- `run-diagnosis.test.ts`: dependency auth, sandbox timeout, validation failure, missing evidence i unknown fallback.
- `workflows.test.ts`: preflight digest, deployed version conflict, idempotent duplicate dispatch, forbidden member.
- `mcp-contract.test.ts`: snapshot/hash oraz annotations vs policy.
- `mcp-smoke.test.ts`: fake OAuth/resource server negative paths; live script jest uruchamiany na preview/internal.

### 15.4 Kryteria akceptacji slice

1. Claude Code i Codex mogą dodać `https://<internal-worker>/mcp`, przejść OAuth PKCE i zobaczyć tylko scope’y zgodne z consent/rolą.
2. Agent pobiera rzeczywisty ticket, jego runy, jeden run, paginowany trace, wynik i diagnozę bez dashboardu; żadna odpowiedź ani log nie zawiera seeded secrets.
3. Admin wykonuje preflight i dispatch istniejącej opublikowanej wersji workflowu. Retry z tym samym kluczem zwraca ten sam run ID; inny payload z tym kluczem zwraca `IDEMPOTENCY_CONFLICT`.
4. Member może czytać, ale dispatch dostaje `FORBIDDEN`; brak scope’u daje `INSUFFICIENT_SCOPE`; ID z innej organizacji wygląda jak `NOT_FOUND`.
5. Agent polluje `runs.get` do terminal state i pobiera `runs.result`; timeout klienta nie przerywa workflowu.
6. Każdy call tworzy zredagowany audit event. Awaria audytu blokuje dispatch.
7. `pnpm --filter worker test`, `typecheck`, contract test i live internal smoke przechodzą; committed contract hash zgadza się z `/mcp` i manifestem.
8. `MCP_ENABLED=false` zwraca kontrolowane `404/disabled` bez wpływu na `/api/v1`, webhooks, cron i dashboard.
9. Internal deployment pozostaje stateless; dwa kolejne poll calls mogą trafić do różnych instancji i zwracają spójny stan.
10. Release Action potrafi wykonać discovery → service token → initialize → slice smoke i zwrócić JSON evidence gotowe do dołączenia do release manifestu.

## 16. Kolejność rozszerzania po slice

Każdy increment ma osobny TDD/review gate, ale używa tego samego fundamentu:

1. ticket create/update/comment/labels/transition;
2. workflow create/draft/validate/publish/rollback, wraz ze scenario tests branch/loop;
3. harness profiles, skill discovery/import/refresh i assignments;
4. memory list/get/update/delete;
5. dogfood suite registry, async results i cleanup;
6. customer rollout automation i compatibility enforcement.

## 17. Decyzje wyłączone z zakresu

- Brak osobnego MCP deploymentu i brak lokalnego npm package instalowanego w Claude/Codex.
- Brak zależności od dashboardu i brak nowych ekranów UI.
- Brak legacy HTTP+SSE.
- Brak token passthrough.
- Brak generatywnej diagnozy po stronie MCP w pierwszej wersji.
- Brak wspólnej bazy lub wspólnego OAuth clienta pomiędzy klientami.
- Brak obsługi `ai-workflow-demo`.

## 18. Ryzyka i świadome kompromisy

- Wspólny worker upraszcza bezpieczeństwo i reuse, ale zwiększa wspólny blast radius; feature flag, rate limit, timeout i per-tool circuit breaker są warunkiem rollout.
- Pełna org isolation części istniejących stores może wymagać migracji domenowych; MCP nie może maskować tego samym sprawdzeniem na wejściu.
- DCR poprawia UX klientów agentowych, ale zwiększa powierzchnię abuse/SSRF; customer deployments startują od pre-registration, a DCR włączają jawnie.
- Polling jest mniej efektywny od event stream, ale jest prostszy, deterministyczny i zgodny ze stateless Vercel. Streaming można dodać addytywnie po pomiarach.
- Preview/confirm dodaje drugi round trip, ale jest wymagany dla zmian wpływających na system zewnętrzny, wykonywanie kodu lub przyszły kontekst agentów.

## 19. Rozstrzygnięte założenia

- Dogfooding odbywa się na wewnętrznym `ai-workflow-app`, nie na demo.
- Publiczny endpoint każdego dedykowanego workera to `/mcp`.
- Interaktywny agent działa w imieniu użytkownika; service client jest tylko dla automatyzacji smoke/dogfood.
- Audit retention wynosi domyślnie 365 dni i nie zawiera pełnych payloadów.
- Stabilny protokół startowy to MCP `2025-11-25` i wyłącznie Streamable HTTP.
- Pierwszy vertical slice kończy się rzeczywistym dispatch i terminalnym wynikiem runu.
