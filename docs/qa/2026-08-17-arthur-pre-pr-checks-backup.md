# Arthur tenant: Pre-PR checks backup (2026-08-17)

Kopia konfiguracji **Pre-PR checks** z dashboardu Arthura
(`https://ai-workflow-arthur-dashboard.vercel.app/checks`), zrobiona zanim
Filip usunął te checki. Trzy repozytoria, 17 komend łącznie. Wartości pól
zczytane 1:1 z DOM (base64), potwierdzone ręcznie przez Filipa dla komend
uciętych wizualnie.

Opis strony: "Commands run inside the sandbox for changed repositories after
implementation and before branch push / PR creation. Failed checks trigger up
to 3 agent fix cycles, then block publication."

## 1. arthur-ai/arthur-engine (GITHUB)

```
1. cd genai-engine && uv run black --check src && uv run isort src --profile black --check && uv run autoflake --remove-all-unused-imports --in-place --check --recursive --quiet src
2. cd genai-engine && uv sync --frozen --group dev --group linters
3. cd genai-engine && uv run mypy src
4. cd genai-engine && GENAI_ENGINE_SECRET_STORE_KEY=changeme_secret_store_key uv run pytest tests/ -m unit_tests
5. cd genai-engine/ui && yarn install --immutable --inline-builds
6. cd genai-engine/ui && yarn check
7. cd genai-engine/ui && yarn test:run
```

Uwaga: komenda 4 zawiera inline env var `GENAI_ENGINE_SECRET_STORE_KEY=changeme_secret_store_key`.
To wartość-placeholder ("changeme_..."), nie prawdziwy sekret, ale odtwarzając
checki wpisz ją dokładnie tak, jak wyżej.

## 2. ArthurAI/unify-frontend (GITLAB)

```
1. yarn lint:ci
2. yarn check-upsolve-css
3. yarn typecheck
4. yarn test
```

## 3. ArthurAI/arthur-scope (GITLAB)

```
1. cd scope/app_plane && uv sync --frozen && uv pip install -r ../lint_requirements.txt
2. ./scripts/openapi_client_utils.sh generate python && ./scripts/openapi_client_utils.sh install python
3. cd scope/app_plane/app && uv run black . --check
4. cd scope/app_plane/app && uv run python -m mypy . --strict --ignore-missing-imports --exclude clients/python --exclude alembic_app_db --exclude alembic_ts_db --exclude tests --implicit-reexport --explicit-package-bases
5. python scripts/check_alembic_single_head.py
6. cd scope/app_plane && ./local-dev/run_tests.sh -n 4
```

---

## Kontekst: dlaczego to backupowaliśmy

Trzy runy padły dziś (2026-08-17) na definicji 1 (wbudowany ticket workflow,
cały Codex: exec gpt-5.6-luna, planning gpt-5.6-sol). Wszystkie przeszły czysto
trigger -> prepare -> planning -> implementation, wywaliły się dopiero w ogonie:

- **UP-4846** (`wrun_01M07J263M41YJFZBTM9W4PQ17`): padł na "Run pre-PR checks" po
  431 s. WORKFLOW ERROR: "The current agent phase could not be completed. (The
  Pre-PR repair process could not be launched.)". Metadata obserwacji checks:
  `failureKind: "provider_error"`, `exitCode: null`, `stderrBytes/stdoutBytes/
  structuredOutputBytes: 0`, `@openai/codex 0.144.6`. Czyli agent Codex napraw
  pre-PR w ogóle się nie odpalił (0 bajtów), błąd po stronie providera.
- **UP-4857** (`wrun_01M07PNSXF82QZRH5831THX9QA`): to samo, checks ->
  dependency_unavailable.
- **UP-4847** (`wrun_01M07Q7D6RWDHKDX976A10K07A`): INNA przyczyna. Checks
  przeszły (759 s ok), padł na "Finalize workspace" -> workspace_gate: "The
  checks could not be started. (Applicable pre-publication checks have not
  passed for this Run Workspace.)". Ten ticket ma też wcześniejszy SUCCESS z
  PR #2135 (`wrun_01M078967Q2WPHZ6FTK889WZYX`). Usunięcie checków tego NIE
  naprawi (to nie jest problem pre-PR checks).

Surowego komunikatu HTTP od OpenAI nie widać ani w MCP, ani w sanitized LOGS
dashboardu (agent nie wyprodukował bajtów); byłby tylko w logach workera Arthura
na Vercelu Blazity, do których ta sesja nie ma dostępu.
