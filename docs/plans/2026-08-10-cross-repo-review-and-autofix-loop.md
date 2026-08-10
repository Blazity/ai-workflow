# Cross-repo review i pętla autofix na otwartym PR

Data: 2026-08-10. Źródło: ustalenia ze spotkania tygodniowego (transkrypcja), grilling z userem 2026-08-10, pre-mortem sceptyka (10 znalezisk, triaż poniżej).

## Problem

Jeden ticket rozkłada się dziś na wiele repozytoriów i produkuje osobny PR w każdym z nich. Recenzent AI ogląda każdy PR w izolacji: nie wie, że powstały z jednej zmiany, nie umie powiedzieć "to wywołanie nie zgadza się z kontraktem, który zmieniłeś w drugim repo", i nie linkuje do PR-a rodzeństwa. Człowiek składa obraz z dwóch zakładek.

Druga rzecz: recenzent tylko mówi. Kiedy zgłosi High, ktoś musi ręcznie wrócić do implementera z tymi uwagami. Na otwartym PR-ze nie ma dziś pętli, która zrobiłaby to sama.

Jest też cichy błąd, który wyjdzie natychmiast po dodaniu widoczności wielu repo: finding nie nosi informacji o repozytorium, a kotwiczenie komentarza idzie po samej ścieżce pliku (`pr-external-resources.ts:581,601`). Recenzent widzący dwa repo i zgłaszający problem w `src/index.ts` repo B dostanie komentarz przyklejony do `src/index.ts` w repo A. To komentarz w złym miejscu, nie brak komentarza, więc jest gorszy od braku funkcji.

## Rozwiązanie

Z perspektywy człowieka czytającego PR:

1. Podsumowanie review w każdym PR-ze wymienia pozostałe PR-y tego samego zadania, z linkami i z SHA, na którym recenzent je czytał.
2. Recenzent ma na dysku repozytoria rodzeństwa (tylko do czytania) i wolno mu zgłosić finding wskazujący plik w innym repo. Taki finding jest oznaczony repozytorium, nie kotwiczy się w cudzym pliku o tej samej nazwie, i jest informacją dla człowieka, nie zadaniem dla automatu.
3. Nowy szablon workflow, który po review otwartego PR-a sam odpala poprawkę, pushuje ją do gałęzi tego PR-a i recenzuje ponownie, do zatwierdzenia albo do wyczerpania prób. Komentarze trafiają na PR raz, po wyjściu z pętli.
4. Check na PR-ze pokazuje status commita, który człowiek widzi, także po tym jak workflow dołożył poprawkę.
5. Push zrobiony przez workflow nie odpala tego samego workflow ponownie.

## User stories

1. Jako reviewer człowiek chcę w komentarzu review widzieć linki do pozostałych PR-ów tego zadania, żeby nie szukać ich ręcznie po organizacjach.
2. Jako reviewer człowiek chcę, żeby recenzent AI wskazał niespójność między repozytoriami (np. frontend woła endpoint w kształcie, którego backend już nie ma), żeby nie łapać tego na integracji.
3. Jako reviewer człowiek chcę, żeby finding o pliku w innym repozytorium był podpisany tym repozytorium i SHA, żeby móc go zweryfikować, a nie zgadywać, co recenzent widział.
4. Jako właściciel zadania chcę, żeby uwagi review dotyczące MOJEGO repo były naprawione automatycznie na gałęzi PR-a, żeby dostać wersję już poprawioną.
5. Jako właściciel zadania chcę widzieć jawną porażkę runu, gdy poprawki nie domknęły uwag po wyczerpaniu prób, żeby wiedzieć, że sprawa wraca do człowieka.
6. Jako właściciel zadania chcę, żeby check na PR-ze odnosił się do najnowszego commita, żeby status nie wyglądał jak brak sprawdzenia.
7. Jako opiekun kosztów chcę twardy limit prób pętli i brak samowywołania po pushu, żeby jeden PR nie generował serii runów.
8. Jako kontrybutor człowiek chcę, żeby workflow nigdy nie pushował do gałęzi PR-a, którego nie otworzył sam.

## Decyzje implementacyjne

### Ścieżki review

Dwie i zostają rozdzielone. Ścieżka A to review wewnątrz runu przed otwarciem PR-a (`reviewed-ticket-workflow`, `templates.ts:799-836`), ma pętlę review → fix → re-review od dawna. Ścieżka B to review otwartego PR-a (`postPrReviewDefinition`, `templates.ts:856-992`), triggerowana zdarzeniem PR-a, bez pętli i bez fix agenta. Cała ta praca dotyczy B. Szablon `post-pr-review` zostaje nietknięty jako plik, ale patrz "Granica zakresu" niżej.

### Dostępność szablonu i wzajemne wykluczenie (rozstrzygnięte faktami)

Nowy szablon wbudowany trafia do istniejących projektów sam: `seedWorkflowDefinitionTemplates` (`workflow-definition/template-seed.ts:18-89`) wstawia idempotentnie jeden wyłączony wiersz startowy per szablon i jest wołany z `scripts/db-migrate.ts:78-83` przy każdym buildzie, czyli przy każdym deployu. Lista szablonów jest czytana z kodu na żądanie (`routes/api/v1/workflow-definitions.get.ts:92-97`), nie z tabeli. Migracja nie jest potrzebna, QA po deployu tylko włącza definicję.

Wykluczenie jest wymuszone schematem, nie kodem: `workflowDefinitionTriggers.triggerType` jest kluczem głównym (`db/schema.ts:762`), a `getEnabledWorkflowDefinitionForTrigger` zwraca dokładnie jedną definicję (`workflow-definition/store.ts:505-517`). Konsekwencja produktowa, którą trzeba nazwać wprost: **włączenie autofixu odbiera binding triggera szablonowi `post-pr-review`**. Nie da się mieć obu naraz na jednym triggerze i nie da się przez to podwójnych runów na jedno zdarzenie.

### Atrybucja repozytorium w findingu

```ts
export interface ReviewResultFinding {
  file: string;
  description: string;
  severity: "Blocker" | "High" | "Medium" | "Nit";
  startLine?: number;
  endLine?: number;
  /** `owner/name`. Brak oznacza repozytorium recenzowanego PR-a. */
  repo?: string;
}
```

Opcjonalność jest wymuszona wstecz: koperty custom agentów przechodzą przez `additionalProperties: true` (`contracts/review-result.ts:49,55`), a stary recenzent zwraca findingi bez tego pola. Normalizacja musi obsłużyć wartość nierozpoznaną (surowa nazwa bez ownera, URL, nazwa nieobecna wśród repozytoriów runu): taka wartość jest traktowana jak brak pola, czyli jak repozytorium recenzowanego PR-a. Inaczej custom agent tenanta, który już dziś zwraca własne `repo`, cicho straci kotwice inline.

### Findingi cross-repo są informacją, nie zadaniem

To odwrócenie pierwotnego założenia po pre-mortemie. Finding z niepustym i obcym `repo`:

- **nie liczy się** do `decision` recenzenta ani do `review-approved`, czyli nie napędza pętli,
- **nie wchodzi** do wejścia `fix_agent.reviewResults`,
- **trafia** do podsumowania z prefiksem repozytorium i SHA.

Bez tego pierwszy realny finding cross-repo daje gwarantowaną porażkę runu: uwaga dotyczy pliku w checkoucie read-only, fix nie może jej naprawić, pętla nie zbiega i kończy się `exhausted` po dwunastu wywołaniach agenta. Findingi cross-repo są jednocześnie najmniej weryfikowalne (obce repo, ruchomy ref) i najtrudniej naprawialne, więc nie mają prawa blokować.

### Wykrycie rodzeństwa

Źródłem prawdy jest `workflowRuns.prs`, jsonb z listą PR-ów jednego runu (`db/schema.ts:317`, typ `RunPullRequest` w `contracts/domain.ts:33-38`). Akcesor odpowiada na pytanie "dla PR-a podaj run, który go otworzył, i pozostałe PR-y tego runu".

Klucz jest miejscem, w którym to najłatwiej zawodzi cicho: GitLab ma `iid` obok `id`, ścieżki z podgrupami nie są `owner/name`, repo można przemianować w trakcie runu. Dlatego wymagany jest test round-trip od pisarza `prs` (`workflows/agent.ts:845-855`) do akcesora, na kształtach GitHuba i GitLaba, a nie test na ręcznie zbudowanym wierszu.

Akcesor zwraca trzy stany, nie dwa: `siblings`, `none` (run znaleziony, jeden PR) i `unknown` (runu nie znaleziono albo zapytanie padło). Rozróżnienie jest nośne, bo wykrycie rodzeństwa jest fail-open, a bramka pushu fail-closed, i obie czytają ten sam akcesor.

### Obserwowalność (nowy warunek)

Fail-open bez logu to nie degradacja, to niewidzialność. Każdy run ścieżki B loguje jednym zdarzeniem: stan akcesora, liczbę dopiętych repozytoriów rodzeństwa z ich SHA, liczbę findingów odrzuconych z kotwiczenia jako cross-repo. QA z limitem 2h dziennie musi umieć odróżnić "run miał jedno repo" od "lookup padł" bez wchodzenia do bazy.

### Kontekst recenzenta

`assembleReviewContext` (`sandbox/context.ts:196`) dostaje sekcję rodzeństwa: repozytorium, ścieżka lokalnego checkoutu, URL PR-a, SHA. Prompt musi jawnie pozwolić na finding wskazujący plik w rodzeństwie i wymagać wypełnienia `repo`, inaczej pole zostanie puste i finding zakotwiczy się w złym pliku.

Konwencję ścieżek checkoutu rodzeństwa **posiada etap dopięcia workspace'u**, a kontekst ją tylko konsumuje. Odwrotna kolejność obiecuje agentowi katalog, którego nie ma, i agent traci minuty na globowanie.

Uwaga na granicę: `assembleReviewContext` to builder po stronie kodu, gate dryfu promptów wbudowanych go nie dotyczy (`prompt-library/builtin-prompt-drift.ts:258-509` chodzi po snapshotach z bazy, nie po katalogu w kodzie). Jeśli okaże się, że instrukcja recenzenta siedzi w `DEFAULT_AGENT_PROMPTS`, zmiana treści wymaga migracji resync (wzór `drizzle/0034_builtin_prompt_resync.sql`) i przejścia gate'u, bo inaczej edycja jest bezskuteczna dla istniejących definicji.

### Checkout rodzeństwa

Ścieżka B ma zapisywalny checkout gałęzi recenzowanego PR-a: `fetch-pr-context.ts:15-32` nadaje `workflowOwnedBranch: pr.headRef`, `prepare-workspace.ts:773-779` podnosi to do `access: "write"`. Rodzeństwo dopina się obok jako `access: "read"`. Ref: gałąź PR-a rodzeństwa gdy otwarty, gałąź domyślna gdy zamknięty, zmergowany albo z forka (gałąź forka nie istnieje w repo docelowym). Rozwiązany SHA jest przypinany i wypisywany w podsumowaniu, żeby finding był falsyfikowalny.

Fail-open dotyczy **całego kanału**, nie tylko lookupu: brak uprawnień tokenu do repo rodzeństwa, repo zarchiwizowane, usunięte, clone albo fetch po timeoucie. Każda z tych rzeczy degraduje do review bez rodzeństwa i loguje powód. Nigdy nie wywraca `prepare`, bo ten kod jest współdzielony z nietkniętą ścieżką `post-pr-review`. Limit twardy: maksymalnie 3 repozytoria rodzeństwa i pominięcie tych, których clone przekracza budżet czasu, bo monorepo rodzeństwa wysadzi sandbox.

### Kształt pętli

Nowy szablon (id `post-pr-autofix`), silnik v2, maxAttempts 2, onExhaust `fail`, publikacja komentarzy dokładnie raz:

```text
trigger-ready / trigger-updated -> create-check -> prepare
prepare -> {security-review, quality-review, requirements-review}
reviews -> review-approved (branch, combinator "all" na decision === approve)
review-approved:true  -> post-review-approved -> complete-success
review-approved:false -> retry (loop)
retry:continue        -> fix -> {security-review, quality-review, requirements-review}
retry:exhausted       -> post-review-exhausted -> exhausted-message -> complete-failure
```

Publikacja jest rozdzielona na dwa path-specific węzły poza regionem pętli. Pierwsza ocena wchodzi do `retry`, żeby zarówno approve, jak i exhaustion miały jeden stabilny owner-output. Pętla niesie trzy review results oraz check jako `steps.retry.output.values.*`; przy zwykłym boundary i przy exhaustion scheduler zapisuje ostatni carry do ownera. Oba terminalne węzły czytają ten sam carry, a ścieżki są wzajemnie wykluczające, więc dokładnie jeden publikuje komentarz na run. To zastępuje pierwotny pomysł jednego `post-review` z dwoma wejściami i omija niebezpieczny fallback child → owner opisany w `v2-scheduler.ts`.

### Check-run po pushu

`create-check` wykonuje się przed pętlą, więc check wisi na SHA z momentu triggera. Po pushu fixa head PR-a się przesuwa i człowiek widzi commit bez żadnego checka. Domknięcie checka musi rozwiązać head ponownie po wyjściu z pętli i zamknąć status na aktualnym commicie.

Kotwice inline tego problemu nie mają: `publishRunOwnedPrReview` pobiera pliki PR-a w momencie publikacji (`pr-external-resources.ts:879`), czyli już po pętli, więc pozycje liczą się względem aktualnego diffu.

### Tłumienie rekurencji

Stan wyjściowy jest łagodniejszy, niż wyglądał: `active_runs.subject_key` jest kluczem głównym na `pr:{provider}:{repoPath}#{prNumber}` (`db/schema.ts:47`, `lib/subject-key.ts:7-12`), a druga rezerwacja tego samego subjectu dostaje `already_claimed` (`lib/dispatch.ts:217-230`). Do tego `trigger_deliveries` dopuszcza najwyżej jeden wiersz pending per subject (`db/schema.ts:114-116`). Czyli push fixa w trakcie runu nie tworzy drugiego runu współbieżnie: zdarzenie parkuje się i wchodzi po zakończeniu, jako jeden następca. Lawiny nie ma, jest łańcuch, w którym każdy run rodzi najwyżej jednego następcę.

To nadal jest do zamknięcia, bo łańcuch kończy się dopiero na runie, który nic nie pushnął, a każde ogniwo to trzy review. Tłumienie po SHA jest lepsze niż po tożsamości i jest wykonalne na istniejącym magazynie: workflow zapisuje pushnięty head (`workflow_owned_branches.published_head_sha` / `pr_published_head_sha`, `db/schema.ts:638,642`, pisane w `workspace-publication.ts:201,240`). Zdarzenie `synchronize`, którego head SHA równa się zapisanemu pushowi workflow, nie tworzy runu. Dopasowanie po bot loginie zostaje jako fallback, nie zamiennik: jest wrażliwe na konfigurację (tenant z PAT-em człowieka wycisza pushy tego człowieka), natomiast zarzut o `something[bot]` jest nietrafiony, bo `normalizeVcsLogin` obcina sufiks `[bot]` (`lib/vcs-bot-identity.ts:34-41`).

Wymagane sprawdzenie w etapie: czy push fix agenta na ścieżce B przechodzi przez `workspace-publication`, które zapisuje `publishedHeadSha`. Ścieżka B nie ma kroku publikacji, więc zapis może wymagać dołożenia po stronie fixa.

### Granica zakresu (poprawka po pre-mortemie)

Zdanie "szablon `post-pr-review` nietknięty" jest prawdziwe formalnie i mylące behawioralnie: etapy dotykające `trigger-events`, `pr-external-resources`, `context` i `prepare-workspace` zmieniają zachowanie także tej ścieżki, bo to kod współdzielony. Dlatego każdy z tych etapów ma w DoD regresję istniejącego scenariusza `post-pr-review`, a domyślną wartością każdej nowej gałęzi jest zachowanie dzisiejsze.

## Seamy i decyzje testowe

| Seam | Obserwowane zachowanie | Prior art |
|---|---|---|
| harness scenariuszowy (`scenarios/harness.ts:44-65`) | graf robi review → fix → re-review, każdy węzeł raz na logiczne przejście, publikacja raz na obu wyjściach | `reviewed-ticket.scenario.test.ts:217-251`, `loop-branch-early-exit.scenario.test.ts:126-190` |
| `partitionReviewFindings` (`pr-external-resources.ts:555`) | finding z obcego repo nie kotwiczy się inline, trafia do podsumowania z prefiksem i SHA | istniejące testy partycjonowania |
| `assembleReviewContext` (`sandbox/context.ts:196`) | prompt zawiera rodzeństwo, jego ścieżki, URL-e i SHA | `context.test.ts:239-265` (ta sama funkcja, kontekst research) |
| `deriveTriggerEvent` (`lib/trigger-events.ts`) | `synchronize` o SHA pushniętym przez workflow nie tworzy runu, push człowieka tworzy | `trigger-events.ts:153,178`, `dispatch-trigger.ts:345-346` |
| akcesor rodzeństwa (nowy, `db/queries`) | trzy stany (`siblings`/`none`/`unknown`), round-trip od pisarza `prs` na GitHubie i GitLabie | `run-detail-read.ts:92,153` |

Wszystkie mają po dwa adaptery (GitHub i GitLab dla publikacji, triggerów i akcesora; research i review dla kontekstu), więc żaden nie jest hipotetyczny.

## Out of scope

- Naprawa AIW-242 (podwójne wykonanie regionu przy spornej granicy). Etap 0 tylko ustala, czy nasz kształt jest dotknięty.
- Pętla self-improvement na ścieżce A. Istnieje i nie dostaje tu testów.
- Dociąganie repozytoriów, których run nigdy nie dotknął.
- Zmiana szablonów `post-pr-review` i `reviewed-ticket-workflow` jako plików.
- Publikacja komentarzy po każdej rundzie pętli.
- Wariant "po wyczerpaniu oddaj człowiekowi bez porażki". Wybrana jest porażka.
- Naprawianie findingów cross-repo automatycznie. Są informacją dla człowieka.

## Założenia

Po triażu pre-mortemu. To niepewności nierozstrzygnięte z userem, każda z przyjętą rekomendacją.

1. **Publikacja komentarzy raz, po pętli.** Koszt: jeśli run umrze w środku pętli (timeout sandboxa, restart workera), nie powstanie żaden komentarz, podczas gdy dziś review byłoby już opublikowane. Przez czas trwania pętli PR ma tylko check in-progress. Przyjęte, bo komentowanie co runda wystawia uwagi, które fix zaraz naprawia. Etap 9 ma to pokryć testem "run umiera w rundzie 2".
2. **maxAttempts 2.** Jedna próba to trzy review plus fix. Ryzyko: dwie próby mogą nie domknąć realnych uwag. Po wyłączeniu findingów cross-repo z kryterium zbieżności to ryzyko jest znacznie mniejsze niż przed pre-mortemem.
3. **`repo` opcjonalne, wartość nierozpoznana traktowana jak brak.** Alternatywa (pole wymagane) wywraca stare snapshoty i koperty custom agentów.
4. **Limit 3 repozytoria rodzeństwa.** Liczba wzięta z realnego kształtu zadań (backend plus frontend, czasem shared). Ryzyko: run dotykający czterech repo dostanie niepełny kontekst, co jest logowane, nie ciche.
5. **Tłumienie po SHA z fallbackiem na bot login.** Ryzyko: tenant z PAT-em człowieka jako bot login nadal wycisza pushy tego człowieka, ale to zachowanie istniejące dla zdarzeń review, nie regresja.
6. **Fail-open dla całego kanału rodzeństwa, fail-closed dla pushu i tłumienia.** Brak rodzeństwa degraduje funkcję, brak bramki pushu psuje czyjeś repo, brak tłumienia mnoży runy.
7. **Bez podłogi severity dla findingów cross-repo, ale i bez wpływu na pętlę.** Zwykła skala w podsumowaniu, zero wpływu na `review-approved` i na zadanie fixa.

### Znaleziska sceptyka odrzucone, z powodem

- **"Nowy szablon nie dojdzie do istniejących projektów, brak migracji"**: nietrafione. `seedWorkflowDefinitionTemplates` (`template-seed.ts:18-89`) jest idempotentne i biegnie z `db-migrate.ts:78-83` przy każdym deployu, wstawiając wyłączony wiersz startowy.
- **"Dwa szablony na to samo zdarzenie dadzą dwa runy"**: nietrafione. `workflowDefinitionTriggers.triggerType` to klucz główny (`db/schema.ts:762`), jedna definicja per typ triggera.
- **"Kotwice inline będą nieaktualne po pushu"**: nietrafione. Pliki PR-a pobierane są w momencie publikacji (`pr-external-resources.ts:879`), czyli po pętli. Część o check-runie była trafiona i weszła do zakresu.
- **"Bot z GitHub Appa nie dopasuje się jako `something[bot]`"**: nietrafione, `normalizeVcsLogin` obcina ten sufiks (`vcs-bot-identity.ts:34-41`).

## Etapy

| # | Etap | Seam | Zakres plików | Tier | Sceptyk | TDD | Delegacja | DoD |
|---|---|---|---|---|---|---|---|---|
| 0 | Bramka STOP: snapshot docelowego grafu B plus scenariusz na OBU wyjściach pętli | harness scenariuszowy | `templates.ts`, `v2-scheduler.ts`, `available-values.ts`, `scenarios/post-pr-autofix.scenario.test.ts`, `scenarios/snapshots/post-pr-autofix-v1.json` | opus | nie | tak | nie | test zielony i asertuje przez `executorRunsOf`: (a) ścieżka approve po jednej poprawce, dokładnie 1 przebieg `fix`, po 2 każdego recenzenta, dokładnie 1 `post-review-approved` i 0 `post-review-exhausted`; (b) ścieżka `exhausted`, dokładnie 2 przebiegi `fix`, dokładnie 1 `post-review-exhausted` i 0 `post-review-approved`. Snapshot deklaruje `schemaVersion: 2` i przechodzi walidację deploymentową. Jeśli region się dubluje: STOP planu, raport do usera, ticket na AIW-242 |
| 1 | Kontrakt findingu z `repo`, normalizacja wartości nierozpoznanych, klasyfikacja obcego repo | kontrakt review | `apps/shared/contracts/review-result.ts`, `apps/worker/src/workflows/review-results.ts` i jego test | sonnet | nie | tak | nie | test zielony i pokrywa: brak pola, repo własne, repo obce, wartość bez ownera, URL, repo nieobecne w runie. `pnpm --filter worker typecheck` i `pnpm --filter dashboard typecheck` czyste |
| 2 | Akcesor rodzeństwa (3 stany) plus test round-trip od pisarza `prs` | akcesor rodzeństwa | nowy plik w `apps/worker/src/db/queries/` i jego test | sonnet | nie | tak | nie | test zielony i zawiera round-trip: wiersz `prs` zapisany ścieżką z `agent.ts:845-855` dla GitHuba i dla GitLaba jest odczytywalny tym akcesorem. Trzy stany rozróżnialne, awaria zapytania daje `unknown`, nie wyjątek |
| 3 | Zapis pushniętego SHA na ścieżce B plus tłumienie `synchronize` po SHA, fallback bot login | `deriveTriggerEvent` | `apps/worker/src/lib/trigger-events.ts`, `apps/worker/src/workflows/workspace-publication.ts` i ich testy | opus | tak | tak | nie | testy zielone: push workflow nie tworzy `trigger_pr_updated`, push człowieka tworzy, brak zapisanego SHA spada na dopasowanie loginu. Regresja: istniejące testy `trigger-events` bez zmian w oczekiwaniach |
| 4 | Repo-aware partycjonowanie, wykluczenie cross-repo ze zbieżności, linki i SHA rodzeństwa w podsumowaniu | `partitionReviewFindings` | `apps/worker/src/workflows/pr-external-resources.ts`, `apps/worker/src/workflows/review-finding-merge.ts` i ich testy | opus | tak | tak | nie | testy zielone: dwa repo z identyczną ścieżką pliku bez kotwicy w obcym PR-ze; finding cross-repo nie zmienia `decision`; podsumowanie zawiera link i SHA brata. Regresja scenariusza `post-pr-review` zielona. Startuje po bramkach 1 i 2 |
| 5 | Dopięcie rodzeństwa read-only, fail-open całego kanału, limit 3, WŁAŚCICIEL konwencji ścieżek | workspace ścieżki B | `apps/worker/src/workflows/blocks/fetch-pr-context.ts`, `apps/worker/src/workflows/blocks/prepare-workspace.ts` i ich testy | opus | tak | tak | nie | testy zielone: gałąź recenzowanego PR-a zostaje `write`, rodzeństwo `read`; brak uprawnień, repo zarchiwizowane i timeout clone degradują do braku rodzeństwa bez wywrócenia `prepare`; czwarte repo pominięte z logiem. Regresja `post-pr-review` zielona. Startuje po bramce 2 |
| 6 | Sekcja rodzeństwa w kontekście recenzenta, konsumpcja konwencji ścieżek z etapu 5 | `assembleReviewContext` | `apps/worker/src/sandbox/context.ts`, `apps/worker/src/sandbox/context.test.ts` | opus | tak | tak | nie | test zielony z nowym przypadkiem `assembleReviewContext` plus rodzeństwo (ścieżka, URL, SHA) i z przypadkiem bez rodzeństwa dającym dzisiejszy prompt. Jeśli instrukcja siedzi w `DEFAULT_AGENT_PROMPTS`: migracja resync plus `pnpm --filter worker exec tsx src/prompt-library/builtin-prompt-drift-gate.ts` bez dryfu. Startuje po bramkach 1 i 5 |
| 7 | Bramka pushowania w `fix_agent` plus odfiltrowanie findingów cross-repo z zadania | `fix_agent` | `apps/worker/src/workflows/blocks/fix-agent.ts` i jego test | opus | tak | tak | nie | test zielony: odmowa dla PR-a bez wpisu w `prs`, odmowa przy stanie `unknown` akcesora, zgoda dla PR-a z wpisem; findingi cross-repo nie trafiają do zadania. Startuje po bramkach 1 i 2 |
| 8 | Domknięcie check-runu na aktualnym head po pętli | check-run | blok `complete_pr_check` i jego test | sonnet | nie | tak | nie | test zielony: head rozwiązany ponownie po pętli, status zamknięty na SHA po pushu fixa, a przy braku pushu na SHA triggera |
| 9 | Szablon `post-pr-autofix`, scenariusze na wysyłanej wersji, obserwowalność | harness scenariuszowy | `apps/worker/src/workflow-definition/templates.ts`, rejestr szablonów, `templates.test.ts`, `scenarios/post-pr-autofix-template.scenario.test.ts` | opus | tak | nie | nie | scenariusz ładujący szablon przez `loadTemplateGraph("post-pr-autofix")` zielony na approve i na exhausted, plus przypadek "run umiera w rundzie 2". Test dowodzi równości grafu szablonu ze snapshotem z etapu 0 (inaczej snapshot się osieroci). Każdy run wykonuje dokładnie jeden z `post-review-approved`/`post-review-exhausted`. `pnpm --filter worker test src/workflow-definition` zielony. Startuje po bramkach 3, 4, 5, 6, 7, 8 |

Równolegle po bramce 0: etapy 1, 2, 3, 8 (rozłączne pliki, brak zależności kontraktowych). Potem 4 i 7 po bramkach 1 i 2, etap 5 po bramce 2, etap 6 po bramkach 1 i 5. Etap 9 zamyka.

## Weryfikacja produkcyjna (poza tabelą, właściciel: człowiek)

Plan jest skończony dopiero, gdy istnieje przebieg z liczbami, nie zielone testy. Minimalny dowód:

1. Ticket dotykający dwóch repozytoriów, PR-y w obu.
2. Review na jednym PR-ze cytujące plik z drugiego, z poprawną atrybucją repo i SHA, i bez kotwicy inline w obcym pliku.
3. Jedna runda fix pushnięta na gałąź PR-a, z komentarzami opublikowanymi raz.
4. Check zielony na commicie po poprawce, nie na commicie z triggera.
5. Brak drugiego runu z `synchronize` po tym pushu.
6. Log runu pokazujący stan akcesora i liczbę repozytoriów rodzeństwa.

Przed testem QA trzeba świadomie zdecydować, który szablon trzyma binding triggera PR-a, bo autofix odbiera go `post-pr-review`.
