# Runbook: migracja tenanta Arthur na Repository scripts

Status: runbook operatora. Napisany 2026-08-21, po dostarczeniu Repository scripts
na branchu `feat/repository-scripts` (opis rozwiązania i decyzje projektowe w
[`2026-08-21-repository-scripts.md`](./2026-08-21-repository-scripts.md), kontrakt
configu w [`docs/repository-scripts.md`](../repository-scripts.md), diagnoza
poprzedniego systemu w
[`2026-08-19-repository-checks-and-autofix-loop.md`](./2026-08-19-repository-checks-and-autofix-loop.md)).

Punkt wyjścia: konfiguracja checków tenanta Arthur jest dziś (wersja 12,
wyłączona 2026-08-19) pusta: "No pre-PR checks configured. The gate is disabled."
Stary silnik nie potrafił obsłużyć ich toolchainu (brak `uv` w sandboxie
node24, brak przekazywania zmiennych środowiskowych do komend, brak osobnego
budżetu czasu na długie suity) i klient dostawał dwanaście wersji configu w
dwa dni, zanim ktoś wyłączył bramkę całkowicie. Ten runbook prowadzi migrację
z "checki wyłączone" do działającej konfiguracji Repository scripts dla
trzech repozytoriów Arthura: `arthur-engine`, `genai-engine`, `ui` (jedna
grupa GitLab, projekt GitLab 54848372 dla rejestru npm repozytorium `ui`).

Nie zawiera: doboru, które definicje workflow Arthura mają w ogóle nasłuchiwać
bloków skryptów (sekcja 7, poza zakresem, osobna rozmowa z klientem).

---

## 1. Warunki wstępne

### 1.1 Który deploy niesie funkcję

Repository scripts to zmiana w **obu** aplikacjach na branchu
`feat/repository-scripts`:

- **Worker** (`Blazity/ai-workflow-arthur`, deployment
  `https://ai-workflow-arthur.vercel.app`): niesie nowy schemat configu
  (`repoScriptsConfigSchema`, `apps/worker/src/pre-pr-checks/config.ts:282-291`),
  silnik grup z `extends`, rozwiązywanie `env` przez allowlistę operatora
  (`apps/worker/src/pre-pr-checks/runner.ts:580-607`), fazę setup jako
  widoczny podkrok tworzenia workspace
  (`apps/worker/src/workflows/blocks/prepare-workspace.ts:646-693`) i osobny
  budżet czasu checków (`PRE_PR_CHECK_BATCH_MAX_MINUTES`,
  `apps/worker/src/pre-pr-checks/runner.ts:109`).
- **Dashboard** (`https://ai-workflow-arthur-dashboard.vercel.app`): niesie
  ekran `/scripts` (`apps/dashboard/app/(cockpit)/scripts/page.tsx`,
  `apps/dashboard/components/cockpit/screens/repository-scripts.tsx`), który
  jako jedyny umie autorować nazwane grupy, `env` i limity czasu.

### 1.2 Dwie reguły kolejności (obie na dowodzie z tego repo)

1. **Worker przed zapisem jakiegokolwiek grupowanego configu.** Stary,
   zdeployowany dziś worker zna tylko kształt sprzed tej funkcji: płaski
   `commands: string[]` pod `.strict()` schematem
   (`prePrCheckConfigSchema`, `apps/worker/src/pre-pr-checks/config.ts:21-36`).
   `.strict()` odrzuca każde nieznane pole, a `groups`, `env`, `gateGroups`,
   `commandTimeoutMinutes`, `batchTimeoutMinutes` nie istnieją w tamtym
   schemacie w ogóle, przy braku wymaganego `commands`. Zapis grupowanego
   configu na stary worker kończy się 400 z komunikatem walidacji, nie
   cichym zignorowaniem pól. Ta kolejność jest też zapisana wprost jako
   założenie projektowe: "najpierw release workera z nowym schematem, dopiero
   potem zapis configu z `env` (stary worker ma `.strict()` i wywali parse
   configu z nieznanym polem)"
   (`docs/plans/2026-08-21-repository-scripts.md`, sekcja Assumptions, punkt 5).
2. **Dashboard przed autorowaniem grupowanego configu przez UI.** Ekran
   `/scripts` to jedyne miejsce w produkcie, które renderuje edytor grup,
   `extends` i pola `env` z walidacją nazw względem allowlisty
   (`repository-scripts.tsx:995-1010`). Stary ekran (płaska lista komend, bez
   pojęcia grupy) nie ma jak przedstawić tego kształtu; nie próbuj autorować
   grup ręcznym JSON-em przez stary ekran ani przez `curl` przeciwko staremu
   workerowi z tego samego powodu co punkt 1.

**Kolejność deploy: worker najpierw, dashboard drugi, dopiero potem sekcja 4
(zapis configu).** Odstęp między nimi jest bezpieczny: stary config (płaski
`commands`) nadal się wczytuje przez nowy worker, bo `repoScriptsConfigSchema`
normalizuje starą płaską postać do `groups.checks` bez migracji
(`apps/worker/src/pre-pr-checks/config.ts:191-264`, `docs/repository-scripts.md:191-222`).

---

## 2. Zmienne środowiskowe operatora na workerze

Wszystkie trzy ustawia się jako zmienne środowiskowe projektu Vercel workera
`ai-workflow-arthur` (dashboard Vercel projektu, albo `vercel env add` jeśli
CLI jest do niego podpięte). **Każda z nich wymaga redeployu workera, żeby
zacząć działać** - to jest pułapka odnotowana wprost w dokumentacji configu:
zmiana `PRE_PR_CHECKS_ALLOWED_ENV` "nie dociera do niczego, dopóki worker nie
zostanie zredeployowany. Dodanie nazwy w dashboardzie hostingu i natychmiastowa
ponowna próba zapisu odtwarza to samo odrzucenie, z tym samym komunikatem,
bo działający deployment nadal trzyma starą listę" (`docs/repository-scripts.md:100-107`).
To samo dotyczy odwrotnego kierunku: usunięta z allowlisty nazwa nadal działa
aż do redeployu.

1. **`PRE_PR_CHECKS_ALLOWED_ENV`** musi zawierać `GITLAB_UNIFY_FRONTEND_TOKEN`
   (jeśli ustawiasz więcej niż jedną nazwę: lista rozdzielona przecinkami, bez
   spacji, dokładnie tak jak czyta ją
   `apps/worker/src/pre-pr-checks/runner.ts:580-587`). To jedyna nazwa
   wymagana przez ten runbook: `arthur-engine` i `genai-engine` nie potrzebują
   żadnej zmiennej (instalator `uv` nie wymaga tokenu).
2. **`GITLAB_UNIFY_FRONTEND_TOKEN`** jako sama wartość, osobna zmienna
   środowiskowa workera. Nazwa nie jest naszym wyborem: pochodzi z
   `.yarnrc.yml` repozytorium `ui`, gdzie ich prywatny rejestr npm GitLaba jest
   już tak skonfigurowany po stronie klienta.
3. **`PRE_PR_CHECK_BATCH_MAX_MINUTES`**: opcjonalne, domyślnie 60
   (`apps/worker/src/pre-pr-checks/runner.ts:109`). Ustaw je tylko, jeśli
   chcesz zmienić domyślny budżet dla WSZYSTKICH tenantów tego workera (to
   zmienna globalna, nie per-tenant); per-repo/per-config wygrywa
   `batchTimeoutMinutes` w samym configu (sekcja 3.4). Dwie rzeczy do
   zapamiętania przy szacowaniu:
   - To budżet **całego runu**, nie pojedynczego batcha: trzy repozytoria
     Arthura ciągną z tej samej puli minut po kolei, a trzecie jest
     ograniczone tym, co zostawiły pierwsze dwa (`docs/repository-scripts.md:154-159`).
   - To budżet **osobny** od budżetu czasu trwania runu (nie jest z niego
     odejmowany), więc całkowity czas życia slotu dispatchu to budżet trwania
     runu **plus** ten pułap (`docs/repository-scripts.md:178-184`). Przy
     domyślnym budżecie trwania 30 minut i domyślnym pułapie checków 60 minut,
     run może legalnie zająć slot dispatchu na 90 minut. To liczba, którą
     trzeba brać pod uwagę przy planowaniu wielkości puli równoległych runów,
     nie budżet trwania osobno.

---

## 3. Docelowa konfiguracja

### Krok 1 (do wykonania, operator): pobrać dokładną listę komend z historii

Nie zgaduj listy komend. Historia configu Arthura jest dostępna przez
`GET /api/v1/pre-pr-checks` (worker, `apps/worker/src/routes/api/v1/pre-pr-checks.get.ts:1-19`,
zwraca `{ current, versions }` z pełną historią wersji) albo przez panel
historii wersji w ekranie `/scripts` (`repository-scripts.tsx:168,364-401`,
przycisk "Confirm restore" na starszej wersji). Dowody zebrane 2026-08-19
(`docs/plans/2026-08-19-repository-checks-and-autofix-loop.md:65-96`) pokazują
fragmenty historii pod nazwami repozytoriów `unify-frontend`, `arthur-scope` i
`arthur-engine`, łącznie około siedemnastu komend, z instalacją wymieszaną
między checkami:

```
# fragment "unify-frontend" (najpewniej repo ui, do potwierdzenia)
yarn lint:ci
yarn check-upsolve-css
yarn typecheck
yarn test

# fragment "arthur-scope" (najpewniej repo genai-engine, do potwierdzenia)
cd scope/app_plane && uv sync --frozen && uv pip install -r ../lint_requirements.txt
./scripts/openapi_client_utils.sh generate python && ./scripts/openapi_client_utils.sh install python
cd scope/app_plane/app && uv run black . --check
cd scope/app_plane/app && uv run python -m mypy . --strict --ignore-missing-imports ...
python scripts/check_alembic_single_head.py
cd scope/app_plane && ./local-dev/run_tests.sh -n 4

# fragment "arthur-engine"
curl -LsSf https://astral.sh/uv/install.sh | sh
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh
```

**Nie zakładaj mapowania nazw.** `unify-frontend` i `arthur-scope` to etykiety
z płaskiego configu sprzed tej funkcji, nie potwierdzone jeden do jednego z
`ui`/`genai-engine`. Potwierdź faktyczne `provider`+`repoPath` każdego wpisu z
surowego JSON-a wersji (pole `repoPath` w `GET /api/v1/pre-pr-checks`), a nie
z etykiety w prozie. Jeśli chcesz punkt odniesienia bez zgadywania, ekran
`/scripts` pobiera pełną listę repozytoriów Arthura z `/api/repositories`
(`repository-scripts.tsx:1052`) i pozwala wybrać repozytorium z tej listy
zamiast wpisywać `repoPath` ręcznie, co eliminuje literówki w namespace.

Z pobranej historii wydziel per repozytorium: (a) komendy, które są
instalacją/przygotowaniem (`uv sync`, `uv pip install`, `yarn install`, `pip
install`, cokolwiek generującego klienta OpenAPI) - trafiają do `setup`; (b)
resztę komend pogrupuj wedle sensu na `test` i `lint` (patrz TODO w sekcjach
3.1-3.3 poniżej). `docs/repository-scripts.md:257-260` formułuje regułę wprost:
komenda, która wygląda jak krok instalacyjny, należy do `setup`, nigdy do
`commands`/grupy.

### 3.1 `arthur-engine` (Python, `uv`)

```json
{
  "provider": "gitlab",
  "repoPath": "<namespace>/arthur-engine",
  "setup": [
    "curl -LsSf https://astral.sh/uv/install.sh | sh",
    "if [ -f \"$HOME/.bash_profile\" ]; then PROFILE=\"$HOME/.bash_profile\"; elif [ -f \"$HOME/.bash_login\" ]; then PROFILE=\"$HOME/.bash_login\"; else PROFILE=\"$HOME/.profile\"; fi; echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> \"$PROFILE\"",
    "uv --version",
    "uv sync --frozen"
  ],
  "groups": {
    "lint": { "commands": ["TODO: z Kroku 1 - komendy black/mypy/lint dla arthur-engine"] },
    "test": { "commands": ["TODO: z Kroku 1 - komenda uruchamiająca testy arthur-engine"] }
  },
  "gateGroups": ["lint", "test"],
  "commandTimeoutMinutes": 15
}
```

Cztery pierwsze linie `setup` to preset `uv` z
`docs/repository-scripts.md:226-260` co do litery: instalator do
`~/.local/bin` bez roota, dopisanie PATH do WŁAŚCIWEGO pliku profilu w
kolejności `.bash_profile` -> `.bash_login` -> `.profile` (nigdy tworząc
`.bash_profile` na siłę, bo to przesłoniłoby istniejący `.profile`), i
`uv --version` jako weryfikacja, że PATH faktycznie działa dla NASTĘPNEJ
komendy (każda komenda leci przez świeżą login shell). `uv sync --frozen` jest
krokiem instalacyjnym z historii Arthura, więc ląduje w `setup`, nie w
`groups` - to jest dokładnie ta zmiana względem starego configu, gdzie
instalacja siedziała jako check numer jeden i psuła każdy kolejny check
z niezwiązanego powodu (`docs/plans/2026-08-19-repository-checks-and-autofix-loop.md:76-86`).

### 3.2 `genai-engine` (Python, `uv`)

Ten sam preset `setup` co `arthur-engine` (kopia identyczna, bo to ten sam
brakujący toolchain w tym samym obrazie sandboxa), plus komendy instalacyjne
i testowe specyficzne dla `genai-engine` z Kroku 1. Jeśli historia (fragment
"arthur-scope" powyżej) faktycznie należy do tego repozytorium, `setup`
dodatkowo obejmuje `uv pip install -r lint_requirements.txt` i ewentualnie
krok generowania klienta OpenAPI (`openapi_client_utils.sh generate/install`)
- też instalacyjny, więc też `setup`, nie `groups`.

```json
{
  "provider": "gitlab",
  "repoPath": "<namespace>/genai-engine",
  "setup": [
    "curl -LsSf https://astral.sh/uv/install.sh | sh",
    "if [ -f \"$HOME/.bash_profile\" ]; then PROFILE=\"$HOME/.bash_profile\"; elif [ -f \"$HOME/.bash_login\" ]; then PROFILE=\"$HOME/.bash_login\"; else PROFILE=\"$HOME/.profile\"; fi; echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> \"$PROFILE\"",
    "uv --version",
    "TODO: z Kroku 1 - uv sync / uv pip install / generowanie klienta OpenAPI dla genai-engine"
  ],
  "groups": {
    "lint": { "commands": ["TODO: z Kroku 1 - black/mypy dla genai-engine"] },
    "test": { "commands": ["TODO: z Kroku 1 - run_tests.sh dla genai-engine"] }
  },
  "gateGroups": ["lint", "test"],
  "commandTimeoutMinutes": 15
}
```

### 3.3 `ui` (yarn, prywatny rejestr npm GitLaba)

```json
{
  "provider": "gitlab",
  "repoPath": "<namespace>/ui",
  "setup": [
    "yarn install --immutable"
  ],
  "env": ["GITLAB_UNIFY_FRONTEND_TOKEN"],
  "groups": {
    "lint": { "commands": ["TODO: z Kroku 1 - np. yarn lint:ci, yarn check-upsolve-css"] },
    "test": { "commands": ["TODO: z Kroku 1 - np. yarn typecheck, yarn test"] }
  },
  "gateGroups": ["lint", "test"],
  "commandTimeoutMinutes": 15
}
```

`env: ["GITLAB_UNIFY_FRONTEND_TOKEN"]` jest **tylko na tym repozytorium**:
`arthur-engine` i `genai-engine` nie deklarują `env` w ogóle (pole domyślnie
puste, `apps/worker/src/pre-pr-checks/config.ts:238` `env: z.array(...).default([])`).
Nazwa musi być SCREAMING_SNAKE_CASE i pasować do
`/^[A-Z][A-Z0-9_]*$/` (`apps/worker/src/pre-pr-checks/config.ts:105-107`) -
`GITLAB_UNIFY_FRONTEND_TOKEN` pasuje bez zmian. Zmienna trafia też do fazy
`setup`, nie tylko do grup: `runRepositorySetup` przekazuje `repo.env` do tego
samego batcha co komendy setupu
(`apps/worker/src/workflows/blocks/pre-pr-checks.ts:500`), więc `yarn install`
w `setup` widzi token tak samo jak `yarn test` w `groups`.

### 3.4 `gateGroups`: jawnie, nie przez pominięcie

Wszystkie trzy repozytoria mają `gateGroups: ["lint", "test"]` napisane
wprost, mimo że w tym przypadku to i tak wszystkie zadeklarowane grupy (co
pominięcie `gateGroups` dałoby za darmo, `docs/repository-scripts.md:139-144`).
Powód: pominięcie oznacza "wymagaj KAŻDEJ grupy zadeklarowanej na tym
repozytorium", więc dodanie później czwartej grupy (np. `format` z
`prettier --write` i `restoreTree: false`, wygodnej do ręcznego odpalenia
przez `run_scripts`) automatycznie wciągnęłoby ją do bramki publikacji i
zostawiłoby workspace brudny po jej uruchomieniu, co bramka czystości karze
głośną porażką (`docs/repository-scripts.md:125-131`). Jawna lista odsprzęga
"co istnieje jako grupa" od "co blokuje PR" i jest bezpieczna względem takich
dodatków.

### 3.5 Budżet czasu (`batchTimeoutMinutes`, na poziomie configu, nie repo)

```json
{
  "repositories": [ /* trzy wpisy powyżej */ ],
  "batchTimeoutMinutes": 60
}
```

Pole `batchTimeoutMinutes` siedzi na samym configu, obok `repositories`, nie
wewnątrz repozytorium (`apps/worker/src/pre-pr-checks/config.ts:81-83`).
Punkt odniesienia z kodu: "suita klienta trwa około dziewiętnastu minut, co
to dwie trzecie domyślnego trzydziestominutowego budżetu runu"
(komentarz przy `PRE_PR_CHECK_BATCH_MAX_MINUTES`,
`apps/worker/src/pre-pr-checks/runner.ts:100-107`) - to opis dokładnie tego
tenanta i dokładnie tego problemu (stąd ten cały pułap w ogóle istnieje).
Ta liczba dotyczy jednego repozytorium Python; z dwoma repozytoriami Python w
tym configu (`arthur-engine`, `genai-engine`) plus `ui`, a budżet jest **na
cały run, dzielony po kolei między repozytoria**
(`docs/repository-scripts.md:154-159`), domyślne 60 minut może być ciasne,
jeśli oba repozytoria Python faktycznie zbliżają się do dziewiętnastu minut
każde. **Nie zgaduj tej liczby ostatecznie tutaj**: ustaw 60 jako start,
zmierz realny czas z pierwszego uczciwego runu weryfikacyjnego (Krok 5b,
suma `durationMs` w `results[]` per repozytorium) i podnieś
`batchTimeoutMinutes` w configu, jeśli suma trzech repozytoriów zbliża się do
pułapu. Górna granica twarda to 180 (`apps/worker/src/pre-pr-checks/config.ts:291`,
`docs/repository-scripts.md:147-152`), bo to sandbox, nie preferencja.

---

## 4. Ścieżka zapisu

Autoruj przez ekran `/scripts` w dashboardzie Arthura (repozytoria wybierane z
listy `/api/repositories`, żeby uniknąć literówki w `repoPath`), albo wprost
`PUT` na `/api/v1/pre-pr-checks` workera z ciałem `{ "config": { ... } }`
(worker: `apps/worker/src/routes/api/v1/pre-pr-checks.put.ts:66-99`; ekran
`/scripts` woła to samo przez `PUT /api/pre-pr-checks` dashboardu,
`repository-scripts.tsx:223-232`).

Zapis przechodzi dwie bramki:

1. **Walidacja schematu** (`repoScriptsConfigSchema.safeParse`,
   `pre-pr-checks.put.ts:74-84`): odrzuca nieznane pola, złe nazwy grup,
   nieznane referencje w `extends`/`gateGroups`, cykle w `extends`, pustą
   `gateGroups: []`. Komunikat błędu wskazuje dokładny problem
   (`describePrePrCheckIssues`, `apps/worker/src/pre-pr-checks/config.ts:39-43`).
2. **Walidacja allowlisty `env` w momencie zapisu**
   (`describeDisallowedEnvNames`, `pre-pr-checks.put.ts:35-64`): sprawdza
   każdą nazwę w `env` każdego repozytorium względem
   `PRE_PR_CHECKS_ALLOWED_ENV` **workera obsługującego to żądanie w tej
   chwili**. To kontrola grzecznościowa, nie jedyna: prawdziwe egzekwowanie
   jest ponownie przy starcie batcha (`resolveRepoEnv`,
   `runner.ts:589-607`, wołane z `runner.ts:734-740`), więc zawężenie
   allowlisty PO zapisie i tak zablokuje run, nawet jeśli zapis kiedyś
   przeszedł.

**Jeśli redeploy z Kroku 2.1 nie wylądował**, zapis configu z
`env: ["GITLAB_UNIFY_FRONTEND_TOKEN"]` na repozytorium `ui` kończy się 400 z
komunikatem w tym kształcie (`pre-pr-checks.put.ts:59-64`):

```
Invalid config: these environment variable names are not allowlisted on this
worker: <namespace>/ui (GITLAB_UNIFY_FRONTEND_TOKEN). Either remove the name
from the repository's env list, or have an operator add it to
PRE_PR_CHECKS_ALLOWED_ENV on the worker and redeploy. Names only are shown
here; no value is ever read or returned by this endpoint.
```

Rozpoznasz to po treści: nazwuje dokładnie repozytorium i zmienną, nigdy jej
wartość. Jeśli to widzisz mimo że dodałeś `GITLAB_UNIFY_FRONTEND_TOKEN` do
`PRE_PR_CHECKS_ALLOWED_ENV`, wróć do Kroku 2: redeploy workera się nie
wykonał albo trafił na inny deployment niż ten, który odpowiada na zapis.

---

## 5. Sekwencja weryfikacji

Od najtańszego do najdroższego. Nie przeskakuj do (e), dopóki (a)-(d) nie
przejdą - to dokładnie ten porządek, który poprzedni system pomijał, i
dokładnie dlatego "zielony run" w wersji 11 configu Arthura nie sprawdzał
niczego (dwa repozytoria bez fazy setup i zero wpisu dla `arthur-engine`;
`docs/plans/2026-08-19-repository-checks-and-autofix-loop.md:59-63`).

### (a) Ważność tokenu, przed zapisem configu

Najtańszy test: metadane rejestru npm GitLaba dla projektu 54848372, z
tokenem i bez.

```bash
# bez tokenu - oczekiwany 401 (albo 404 udający 401, GitLab bywa niejednoznaczny)
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://<gitlab-host>/api/v4/projects/54848372/packages/npm/<nazwa-pakietu>"

# z tokenem - oczekiwany 200
curl -s -o /dev/null -w '%{http_code}\n' \
  --header "PRIVATE-TOKEN: $GITLAB_UNIFY_FRONTEND_TOKEN" \
  "https://<gitlab-host>/api/v4/projects/54848372/packages/npm/<nazwa-pakietu>"
```

`<gitlab-host>` i `<nazwa-pakietu>` to lookup: odczytaj z `.yarnrc.yml`
repozytorium `ui` (host rejestru i dokładny schemat nagłówka auth, GitLab
akceptuje zarówno `PRIVATE-TOKEN` jak i `Authorization: Bearer`, ale
`.yarnrc.yml` mówi który typ tokenu jest zapisany). Kontrast 401/404 bez
tokenu vs 200 z tokenem to test ważności tokenu bez odpalania jakiegokolwiek
runu.

### (b) Jeden ręczny run na definicji z blokiem skryptów

Wybierz istniejącą definicję Arthura, która ma węzeł `run_scripts`,
`run_pre_pr_checks` albo `run_checks`
(`apps/worker/src/workflow-definition/block-registry.ts:866-949` - trzy typy
bloków silnika skryptów). Odpal ręcznie, poczekaj na fazę checków, otwórz
szczegóły runu (widok trace/run details w dashboardzie,
`apps/dashboard/components/cockpit/screens/trace.tsx`) i sprawdź `results[]`
w outpucie węzła:

- **Liczba wpisów w `results[]` musi być większa od zera** i musi
  odpowiadać liczbie faktycznie skonfigurowanych komend (nie licząc `setup`,
  które raportuje się osobno). Zero wpisów przy zielonym statusie to
  dokładnie objaw "zielony run nic nie sprawdza"
  (`docs/plans/2026-08-19-repository-checks-and-autofix-loop.md:59-63`).
- Każdy wpis ma `command` (prawdziwa treść komendy z configu, nie placeholder),
  `exitCode` (liczba, nie `null`), `durationMs` (> 0), `group` (nazwa
  `lint`/`test`), `timedOut` (`false` dla przechodzącej komendy) - kształt
  zdefiniowany w `apps/worker/src/pre-pr-checks/runner.ts:161-176`.
- `groupStatuses[]` pokazuje `passed` dla `lint` i `test` na wszystkich
  trzech repozytoriach, nie `not_run`/`skipped` (`runner.ts:192-210`).

To jest właściwa weryfikacja "commands actually ran", nie sam status węzła.

### (c) Podkrok setupu widoczny przy tworzeniu workspace

W tym samym runie, w fazie tworzenia workspace (przed fazą implementacji),
powinien być widoczny osobny podkrok instalujący `uv` dla `arthur-engine` i
`genai-engine` oraz `yarn install` dla `ui`, zanim jakikolwiek check
wystartuje. To zamierzone zachowanie: setup "leci raz na sandbox, jako
widoczny podkrok tworzenia workspace, a nie wewnątrz pierwszego batcha
checków" (`docs/repository-scripts.md:60-67`), bo bramka odpala setup tylko
gdy definicja faktycznie zawiera blok silnika skryptów
(`definitionRunsScripts`,
`apps/worker/src/workflows/blocks/prepare-workspace.ts:652-656`). Jeśli setup
padnie, cały blok `prepare_workspace` kończy się z nazwaną komendą
(`verifyRepositorySetup`, `prepare-workspace.ts:657-693`) - run stopuje na
starcie, nie po dwudziestu minutach pracy agenta przeciwko niesprawdzonemu
workspace.

### (d) Obserwacje postępu podczas długiego batcha

Odpal run na repozytorium, którego suita realnie trwa kilka minut (albo
tymczasowo wydłuż jedną komendę testową), i w trakcie trwania fazy checków
otwórz zakładkę "Metadata" w widoku runu
(`apps/dashboard/components/cockpit/screens/workflow-replay.tsx:28,1080`).
Zamiast cichego "RUNNING" bez żadnej treści, powinny pojawiać się kolejne
obserwacje `script_progress` co najwyżej co około 30 sekund
(`PROGRESS_OBSERVATION_MIN_INTERVAL_MS = PHASE_POLL_TICK_MAX_MS = 30_000`,
`apps/worker/src/workflows/blocks/pre-pr-checks.ts:226`,
`apps/worker/src/workflows/blocks/poll-phase.ts:15`), każda z `phase`
(`"setup"` albo `"checks"`), `repo`, `elapsedMs`, `ceilingMs` (`null` dla
setupu - setup jest rozliczany z budżetu trwania runu, nie z pułapu checków),
`boundMs` i liczbą `commands`
(`RepositoryScriptsProgressObservation`, `pre-pr-checks.ts:197-215`;
`emitRepositoryScriptsProgress`, `pre-pr-checks.ts:236-253`; wołane z pętli
pollującej przez `onTick: reportProgress` dla obu faz,
`pre-pr-checks.ts:884-933`). Obserwacja jest zapisywana trwale w momencie
emisji (`observations.flush?.()`, `pre-pr-checks.ts:250`), nie tylko
buforowana do końca węzła, więc jest czytelna, zanim run się skończy. Ten sam
mechanizm obsługuje fazę setupu z Kroku (c) (obserwacje są przekazywane do
`runRepositorySetup` przez `execution?.observations`,
`apps/worker/src/workflows/blocks/prepare-workspace.ts:680-682`, i dalej do
batcha setupu, `pre-pr-checks.ts:457,500`) - nie trzeba odpalać dwóch osobnych
runów, żeby potwierdzić oba.

### (e) Celowo padająca komenda, komentarz w Jirze

Zepsuj świadomie jeden krok, dowolnie: komendę w `setup` (literówka w URL
instalatora `uv`) albo zwykłą komendę w grupie `test`/`lint` (np. wymuszony
`exit 1`). Obie ścieżki dają dziś ten sam gwarantowany kształt komentarza,
jeśli run faktycznie kończy się porażką: **dokładnie jeden** wzbogacony
komentarz na tickecie, z tą samą treścią niezależnie od tego, czy padła
komenda setupu, czy zwykły check.

Mechanizm: każda porażka runu przechodzi przez `failureExit`
(`apps/worker/src/workflows/agent.ts:4744-4790`), która buduje komentarz
funkcją `repositoryScriptsFailureComment`
(`apps/worker/src/workflows/agent.ts:3175-3223`, wołana z `agent.ts:4767-4786`)
i wysyła go raz, przez `commentFailure`/`postFailureReasonCommentStep`
(`agent.ts:2020-2042`). Ta funkcja odzyskuje NAJŚWIEŻSZY zapisany output
bloku skryptów z historii kroków runu
(`recoverLatestRepositoryScriptsFailureFromSteps`, `agent.ts:2974-2990`) dla
KAŻDEJ porażki, której faza należy do zamkniętego zbioru
`{"checks", "pre-pr-checks", "run_scripts", "run_checks",
"run_pre_pr_checks"}` (`REPOSITORY_SCRIPTS_FAILURE_PHASES`,
`agent.ts:3008-3018`) - a to obejmuje zarówno porażkę setupu (rzuconą wprost z
tworzenia workspace: kategoria błędu `"checks"`, faza `"setup"`,
`prepare-workspace.ts:689-693`), jak i porażkę bramki publikacji przy
padniętym checku (`finalize-workspace.ts` rzuca z `category: "checks", phase:
"pre-pr-checks"`, gdy `publication.failureKind === "pre_pr_gate"`,
`apps/worker/src/workflows/blocks/finalize-workspace.ts:129-133`). Innymi
słowy: jeśli w tym runie zdążył zadziałać jakikolwiek blok skryptów przed
porażką, jego ostatni zapisany wynik trafia do komentarza automatycznie - nie
trzeba niczego dodatkowo okablowywać w grafie, żeby to dostać (patrz też
sekcja 7).

Komentarz ma stały kształt (`repositoryScriptsFailureComment`,
`agent.ts:3175-3223`):

1. **`reason`** - to samo zdanie, które niesie nagłówek runu, lista runów i
   powiadomienie Slack (AIW-254, komentarz przy funkcji).
2. **Nagłówek klasy**, jedno z czterech zdań wybrane wedle tego, co faktycznie
   zawiodło (`repositoryScriptFailureClass`, `agent.ts:3098-3109`; dokładne
   teksty w `agent.ts:3039-3044`): `"Repository scripts failed."` (zwykła
   padająca komenda), `"Repository scripts could not be started."`
   (setup/env/infrastruktura), `"0 commands executed - no entry matched the
   changed repositories."` (nic nie pasowało do zmienionych repozytoriów),
   `"CHECKS BUDGET SPENT."` (pułap czasu z sekcji 3.5 wyczerpany).
3. **Zdanie silnika**, `scripts.summary`, zawsze, jeśli istnieje.
4. **Do pięciu zwykłych padających komend** w formacie
   `<repo>: <komenda> (exit <N>)` plus ogon outputu
   (`renderRepositoryScriptFailure`, `agent.ts:3112-3118`); wpisy z przyczyną
   TERMINALNĄ (setup/env/budget/przerwany batch, każdy z osobnym nagłówkiem
   typu `SETUP FAILED for`/`ENVIRONMENT UNAVAILABLE for`/`CHECKS BUDGET SPENT
   before`, `REPOSITORY_SCRIPT_PHASE_HEADINGS`, `agent.ts:3055-3062`) są
   pokazywane ZAWSZE, poza tym limitem - limit pięciu dotyczy tylko zwykłych
   padających komend (`selectRepositoryScriptFailures`, `agent.ts:3133-3139`,
   `REPOSITORY_SCRIPT_FAILURES_SHOWN = 5`, `agent.ts:3072`). Powyżej pięciu:
   jedno zdanie z liczbą pominiętych i wskazaniem, gdzie przeczytać resztę
   ("The full list is on the scripts block's `failures` output, in the run
   details view.", `agent.ts:3077-3079`).
5. **Atrybucja zabrudzenia drzewa**, osobno pliki zmodyfikowane przez skrypty
   tego runu i pliki już zmodyfikowane wcześniej (cudza, niedokończona praca
   agenta), każde na osobnej linii (`renderRepositoryScriptDrift`,
   `agent.ts:3153-3163`).

Sprawdź w treści komentarza: nazwę repozytorium, treść komendy, kod wyjścia i
ogon outputu - to jest dowód, że test (e) faktycznie coś zweryfikował, nie
sam fakt, że jakiś komentarz się pojawił.

### (f) Zielony run na zdrowym repozytorium

Dopiero po (a)-(e): pełny run na niezmodyfikowanym stanie trzech repozytoriów
powinien przejść `lint` i `test` na wszystkich trzech, z `results[]`
niepustym (patrz (b)) i `groupStatuses` samym `passed`.

### Co znaczy "budżet checków wyczerpany" i który knob kręcić

Jeśli którykolwiek krok weryfikacji zwróci błąd z frazą w stylu "CHECKS
BUDGET SPENT before <provider>:<repoPath>" (`formatPrePrCheckFailures`,
faza `"budget"`, `runner.ts:1591-1596`), to znaczy że suma czasu checków na
wcześniejszych repozytoriach w tym runie wyczerpała `batchTimeoutMinutes`
zanim doszło do repozytorium wymienionego w komunikacie - każde repozytorium,
do którego run nie dotarł, dostaje status `not_run`
(`docs/repository-scripts.md:172-176`). Knob do kręcenia to
`batchTimeoutMinutes` w configu (sekcja 3.5), nie
`PRE_PR_CHECK_BATCH_MAX_MINUTES` na workerze (to globalny fallback dla
tenantów bez własnej wartości). **Edycja tej liczby w trakcie trwającego runu
nic nie zmienia w żadną stronę** - sandbox jest tworzony z limitem życia
`jobTimeout + batchTimeoutMinutes` ustalonym raz, na starcie
(`docs/repository-scripts.md:161-170`); żeby skrócić już trwający run, trzeba
go anulować, nie edytować liczbę.

---

## 6. Rollback

Zapisz pusty config: `{ "repositories": [] }` (stała `emptyRepoScriptsConfig`,
`apps/worker/src/pre-pr-checks/config.ts:86`) tą samą ścieżką co sekcja 4
(`PUT /api/v1/pre-pr-checks` albo ekran `/scripts`, zapisz pustą listę
repozytoriów i potwierdź). `repositories.length === 0` jest dokładnie
warunkiem, przy którym bramka publikacji uznaje, że nic nie ma zastosowania,
i przepuszcza run bez checków
(`apps/worker/src/workflows/workspace-gate.ts:133-138`) - to jest stan, w jakim
tenant jest dzisiaj (wersja 12).

**Run w locie zachowuje swój opublikowany pułap.** Sandbox danego runu został
utworzony z limitem życia policzonym z `batchTimeoutMinutes` obowiązującym w
momencie startu (`docs/repository-scripts.md:161-170`); zapis rollbacku nie
cofa ani nie zmienia tego, co już trwa - dotyczy tylko runów startujących po
zapisie. Jeśli trzeba natychmiast zatrzymać trwający run z powodu, który
rollback configu nie adresuje, to osobna operacja (anulowanie runu), nie ten
zapis.

---

## 7. Poza zakresem

**Które definicje workflow Arthura mają w ogóle nasłuchiwać bloków skryptów
to osobna decyzja z klientem, nie część tego runbooka.** To NIE jest pytanie
o to, czy padająca komenda trafi na tykiet z pełnym szczegółem - to (Krok 5e)
dzieje się automatycznie na każdej porażce runu, niezależnie od okablowania
grafu, bo `failureExit` buduje wzbogacony komentarz dla każdej porażki
scriptsowej fazy, nie tylko dla tych, które akurat czyta jakiś dedykowany
węzeł. Poza zakresem jest za to to, co okablowanie grafu FAKTYCZNIE
rozstrzyga:

- **Czy run w ogóle kończy się porażką, gdy skrypty padają.** `run_scripts` i
  `run_pre_pr_checks` same z siebie nie rzucają błędu wykonania na padającą
  komendę - zwracają zwykły status `ok`/`skipped` z `output.ok: false`
  (`apps/worker/src/workflow-definition/block-registry.ts:866-928`). Graf,
  który branchuje na `ok`/`anyFailed` i prowadzi porażkę do gałęzi, która
  niczego nie rzuca (np. cichej remediacji), nigdy nie wywołuje `failureExit`
  i nigdy nie dostaje komentarza. To jest decyzja autora definicji, nie
  configu.
- **Czy definicja w ogóle ma blok mintujący bramkę publikacji.** Sam
  `run_pre_pr_checks` mintuje `gate`; `run_scripts` deliberately nie
  (`docs/repository-scripts.md`, sekcja Field reference). Definicja zbudowana
  wyłącznie z `run_scripts` nigdy nie zaspokoi Finalize, a komentarz o tym
  dostaje własną notatkę (`NO_GATE_BLOCK_NOTE`, `agent.ts:3084-3087`),
  doklejaną gdy przyczyna porażki zaczyna się od
  `"No repository scripts gate was recorded for this Run Workspace"`
  (`WORKSPACE_GATE_NOT_RECORDED_PREFIX`,
  `apps/worker/src/workflow-definition/interpreter.ts:162-163`) i żaden węzeł
  w planie nie jest typu `run_pre_pr_checks`
  (`agent.ts:4777-4779`). Sam brak zapisanej bramki ma dziś dwa uczciwe
  warianty zamiast jednego generycznego "checks could not be started": "the
  scripts themselves may have passed" gdy nic nie wskazuje na porażkę
  skryptów (`WORKSPACE_GATE_NOT_RECORDED_MESSAGE`, `interpreter.ts:123-125`),
  albo "the scripts reported failures" gdy `finalize_workspace` wie, że
  ostatni blok skryptów faktycznie padł
  (`WORKSPACE_GATE_NOT_RECORDED_AFTER_FAILURE_MESSAGE`,
  `interpreter.ts:156-158`, ustalane przez
  `recoverScriptsFailedFromSteps(steps)` w `finalize-workspace.ts:187`).
- **Które definicje produkcyjne Arthura mają blokować publikację na
  czerwonym checku, a które mają tylko raportować.**

Ten runbook kończy się na: config zapisany, zmienne środowiskowe działają,
komendy faktycznie się wykonują i są widoczne w `results[]`, długi batch
raportuje postęp zamiast milczeć, a padająca komenda (setupu albo zwykła)
gwarantowanie ląduje w komentarzu na tickecie z pełnym szczegółem, jeśli run
w ogóle dochodzi do porażki. Powyższe trzy punkty ustala się z klientem
osobno, po tym jak ten runbook potwierdzi, że silnik w ogóle działa na ich
repozytoriach.
