# Research: systemy pamięci (memory) dla AI Workflow / Blazebot

**Data:** 2026-07-21
**Autor:** research pod spotkanie (Filip)
**Zakres:** tylko memory. Self-hosting jest w osobnym dokumencie i tu tylko go dotykam tam, gdzie się zazębia.
**Cel:** odpowiedzieć na trzy pytania: (1) czy file system dla artefaktów pamięci wystarczy, czy potrzebujemy czegoś osobnego (szczególnie przy wielu repozytoriach), (2) czy i jak połączyć pamięć z **Atlasem** (Blazity/atlas, nasz standard `.ai/` dla coding-agentów), (3) jakie systemy pamięci da się utrzymać w dłuższym czasie (ochrona przed sprzecznościami, indeksowanie, logowanie).

---

## 0. TL;DR (do przeczytania przed spotkaniem)

**Gdzie jesteśmy:** nasza jedyna pamięć to plik `blazebot/memory/<TICKET>.md` commitowany do repo klienta. To jest pamięć robocza jednego ticketa (ciągłość między re-runami tego samego zadania). Nie ma pamięci między ticketami, między repo, ani wyszukiwania semantycznego.

**Odpowiedź 1 (file system):** dla pamięci *o repo* (konwencje, komendy testów, pułapki CI) plik w repo jest OK i tak robi cała branża, ale jako plik czytany, nie jako śmietnik uczenia. Dla pamięci *nagromadzonej* (lekcje między ticketami, wiedza między repo) plik przestaje wystarczać. Trigger, który to przesądza, mamy już teraz: **multi-repo** (blok "Human decisions" duplikuje się do każdego repo) i planowany **similar-ticket search** oraz **self-improvement loop** z roadmapy. Odpowiedź brzmi: hybryda, nie "albo albo". Ważna obserwacja z rynku: **ani Claude Code, ani Codex nie commitują swojej auto-pamięci do repo klienta**, trzymają ją poza repo. My robimy dokładnie odwrotnie.

**Odpowiedź 2 (Atlas):** tak, i to jest najlepsza część tej analizy. Atlas to nasz własny standard plus CLI (`@blazity-atlas/core`), który scaffolduje w repo katalog `.ai/` (pamięć, słownik, plany, research, decyzje/ADR, werdykty review) czytany spójnie przez Claude/Codex/Cursor. Atlas jest **substratem i formatem** pamięci w repo, którego Blazebot dziś nie ma (mamy ad-hoc `blazebot/memory/`). Nasze fazy research/implement/review mapują się niemal 1:1 na artefakty Atlasa (`research/`, `plans/`, `results/`), a `pathAliases` Atlasa **już celują w nasz layout** (`docs/superpowers/plans` -> `plans`, `docs/superpowers/specs` -> `research`). Atlas świadomie **nie robi** wyszukiwania semantycznego ("nic nie opuszcza repo"), więc warstwa cross-repo/semantyczna to komplement, który dokłada Blazebot na wierzchu, a nie coś, co zastępuje Atlas.

**Odpowiedź 3 (maintainable):** to nie kwestia wyboru biblioteki, tylko wdrożenia kilku wzorców: bi-temporalne znakowanie faktów, invalidacja zamiast kasowania, deduplikacja, konsolidacja epizodów w wiedzę, retrieval hybrydowy (wektor + słowa kluczowe + graf), i provenance przy każdym zapisie (kto/skąd/kiedy). Warto zauważyć, że Atlas część tego robi już na poziomie plików (skill `atlas-compact`: dedup, relokacja, kasowanie treści sprzecznej z repo, sterowane `atlas doctor`). Jeśli mamy sięgać po gotowca na warstwę indeksu: **Mastra** (natywny TS) albo **Redis Agent Memory Server** (agnostyczny, REST/MCP, ma konsolidację), z **Mem0** i **Graphiti** jako alternatywami zależnie od tego, czy ważniejsza jest prostota czy audytowalna historia w czasie.

**Jedno zdanie na spotkanie:** obecny plik w repo zostawiamy jako pamięć roboczą ticketa, wiedzę trwałą (o repo, między ticketami, decyzje ludzi) przenosimy do **struktury Atlasa** (Blazebot czyta `.ai/memory` i `.ai/LANGUAGE.md`, a zapisuje research/plany/werdykty i lekcje w `.ai/`), a od siebie dokładamy tylko jedną warstwę, której Atlas z definicji nie ma: indeks semantyczny cross-repo do "similar-ticket search", zbudowany z zacommitowanych artefaktów Atlasa.

---

## 1. Co mamy dzisiaj (audyt bez upiększania)

Jeden plik na ticket, na repo: `blazebot/memory/<TASK_ID>.md`, commitowany do repo klienta i lądujący w PR. Dwóch autorów:

1. **Agent (Claude/Codex)** czyta go na starcie fazy i nadpisuje na końcu. Sekcje: Progress, Decisions Made, Blockers, Files Touched, Prior Sessions. Definicja w `apps/shared/contracts/default-prompts.ts:91`.
2. **Worker deterministycznie** (nie model) wstawia blok `Human decisions` z Q&A z dashboardu, ograniczony markerami, z zabezpieczeniem przed rozjechaniem markerów (`defangMarkers`) i idempotentnym upsertem. Kod: `apps/worker/src/lib/human-decisions-memory.ts`, `apps/worker/src/sandbox/write-human-decisions-memory.ts`.

**Do czego to naprawdę służy:** ciągłość między re-runami tego samego ticketa (po feedbacku z PR, po CI, po clarification). To jest, w języku z sekcji 2, pamięć krótkoterminowa/epizodyczna, scoped do jednego ticketa. Dobry prymityw, ale najwęższy możliwy wycinek.

**Czego nie ma (i to są dokładnie pytania na spotkanie):**

- **Pamięci między ticketami i między repo.** Design multi-repo (`docs/plans/2026-07-01-aiw-45-multi-repo-support-design.md:40`) wprost wpisuje "no cross-repo memory/KB" jako non-goal. Przy wielu repo blok `Human decisions` **duplikuje się do każdego repo** i zaczyna się rozjeżdżać.
- **Indeksowania i wyszukiwania semantycznego.** Markdown nie ma wyszukiwania po podobieństwie. Roadmapa (`docs/SPEC.md:651`) ma odłożone "Similar-ticket search", a `SPEC.md:648` "Self-improvement feedback loop, shared endpoint capturing review corrections across runs". To są zalążki prawdziwej pamięci długoterminowej.
- **Ochrony przed sprzecznościami, provenance, logowania operacji na pamięci.** Nadpisujemy plik, nie wersjonujemy faktów, nie wiemy "dlaczego agent sądzi X".
- **Spójności z Atlasem.** Mamy `blazebot/memory/` (ad-hoc), a nasze repo ma już `CONTEXT.md` (de facto słownik domenowy, czyli odpowiednik `.ai/LANGUAGE.md`), `docs/plans/`, `docs/superpowers/plans|specs/` i świeżo `docs/research/`. To są dokładnie te ścieżki, które Atlas absorbuje przez `pathAliases`. Innymi słowy: jesteśmy o krok od Atlasa, ale zamiast jego standardu używamy własnych, rozjechanych konwencji.

---

## 2. Czym w ogóle jest "memory" dla agenta (po ludzku)

**Model językowy jest bezstanowy.** Każde wywołanie widzi tylko tokeny, które mu wkleisz, i zaraz potem zapomina. "Pamięć" to maszyneria, która pozwala agentowi przenosić wiedzę między wywołaniami i między uruchomieniami bez wklejania jej od nowa. Letta nazywa to zamianą bezstanowego modelu w stanowego agenta ([letta.com](https://www.letta.com/blog/agent-memory/)).

**Dlaczego "damy większy kontekst" nie załatwia sprawy:**

- **Context rot (gnicie kontekstu).** Jakość spada, zanim dobijesz do limitu tokenów. Badanie Chroma z lipca 2025 na 18 modelach: każdy pogarsza się wraz z długością wejścia, nierównomiernie, z klifami dokładności (model z oknem 200K potrafi tracić dokładność już przy 50K), i z efektem "środek jest ignorowany" ([morphllm.com](https://www.morphllm.com/context-rot), [redis.io](https://redis.io/blog/context-rot/)).
- **Koszt i opóźnienie** rosną z liczbą tokenów przy każdym wywołaniu.
- **Bezstanowość między uruchomieniami.** Nowy sandbox startuje pusty. Nic nie przetrwa, jeśli tego trwale nie zapiszesz.

**RAG to nie to samo co memory** (częste pomylenie). RAG to *tylko odczyt*, bezstanowe wyszukiwanie z ustalonej bazy ("co jest w tym dokumencie?"). Memory to *odczyt i zapis*, stanowe: agent zapisuje, aktualizuje i odczytuje własne doświadczenie ("czego się nauczyłem?"). RAG to biblioteka podręczna, memory to mózg. W praktyce używa się obu ([mem0.ai](https://mem0.ai/blog/rag-vs-ai-memory), [vectorize.io](https://vectorize.io/articles/agent-memory-vs-rag)).

**Taksonomia (branża się na niej zgadza), z przykładami dla nas:**

| Typ | Po ludzku | Przykład w Blazebocie | Dom w Atlasie |
|---|---|---|---|
| **Krótkoterminowa / robocza** | Notatnik w bieżącym oknie kontekstu | Rozmowa i pliki wczytane w tym uruchomieniu ticketa | poza `.ai/` (zmienny status, do issue trackera) |
| **Długoterminowa: epizodyczna** | *Co się wydarzyło* | "Na TICKET-412 recenzent odrzucił moje podejście do auth z powodu X" | `.ai/results/`, potem `.ai/memory/lessons.md` |
| **Długoterminowa: semantyczna** | *Fakty i wiedza* | "To repo używa pnpm, Drizzle, i wymaga `pnpm test` przed PR" | `.ai/memory/stack.md`, `architecture.md`, `product.md` |
| **Długoterminowa: proceduralna** | *Jak coś zrobić* | "Sprawdzony przepis na dodanie migracji w tym repo" | `.ai/memory/lessons.md`, `.ai/skills/` |

**Fundamentalne systemy badawcze (skrótowo, do kontekstu):** MemGPT/Letta (traktowanie LLM jak systemu operacyjnego: okno kontekstu to RAM, zewnętrzny magazyn to dysk, agent "stronicuje" dane) ([letta.com](https://www.letta.com/blog/agent-memory/)); Stanford "Generative Agents" (strumień pamięci plus retrieval punktowany przez recency x importance x relevance, plus okresowa refleksja) ([ar5iv 2304.03442](https://ar5iv.labs.arxiv.org/html/2304.03442)); MemoryBank (zapominanie wg krzywej Ebbinghausa) ([arxiv 2305.10250](https://arxiv.org/pdf/2305.10250)); A-MEM (agentowa pamięć w stylu Zettelkasten: notatki linkują się i ewoluują) ([arxiv 2502.12110](https://arxiv.org/abs/2502.12110)); Reflexion (agent słownie reflektuje nad porażką) ([arxiv 2303.11366](https://arxiv.org/html/2303.11366)); Voyager (biblioteka umiejętności jako pamięć proceduralna, zapisywana jako kod); CoALA (ramka scalająca to w working + episodic + semantic + procedural) ([arxiv 2309.02427](https://arxiv.org/abs/2309.02427)).

**Operacje każdego systemu pamięci:** zapis (encode: ADD/UPDATE/DELETE/NOOP), przechowanie, indeksowanie, odczyt, aktualizacja, zapominanie/konsolidacja.

**Kluczowa decyzja: hot path vs background.** *Hot path*: agent zapisuje pamięć w locie, zanim odpowie (dostępna od razu, ale dokłada opóźnienie). *Background*: osobny proces asynchronicznie wyciąga pamięć po fakcie (bez opóźnienia, można deduplikować, ale następna tura może widzieć nieaktualny stan) ([LangChain docs](https://docs.langchain.com/oss/python/deepagents/memory)).

**Co z tego jest ważne akurat dla nas (agent na ticketach):**

- **Semantyczna, per repo, to najwyższa wartość.** Trwałe fakty o repo: menedżer pakietów, komendy testów/lint, konwencje, pułapki CI. Dziś odkrywamy je od zera przy każdym tickecie, to czysto marnowane tokeny i główny dokładacz context rot. Z natury cross-ticket, per repo. **W Atlasie to dokładnie `.ai/memory/stack.md` i `architecture.md`.**
- **Proceduralna (przepisy, w stylu Voyager), wysoka wartość.** Sprawdzone recepty. Zapisywane **po tym, jak run przejdzie review**. **W Atlasie to `.ai/memory/lessons.md`.**
- **Epizodyczna między ticketami, średnia wartość.** "Co próbowano i odrzucono", żeby faza research nie powtarzała ślepych uliczek. Wzorzec Reflexion mapuje się na naszą fazę review.
- **Krótkoterminowa/robocza już jest** (plik per ticket), zostawiamy, ale zgodnie z regułą Atlasa **nie** wrzucamy zmiennego statusu do `.ai/memory/`.

Rekomendacja od strony zapisu: **zapis w tle, bramkowany wynikiem review.** Nasz pipeline (research, implement, review) daje czysty punkt konsolidacji: po przejściu review promujemy zweryfikowane epizody do pamięci semantycznej/proceduralnej per repo, zamiast pisać hałaśliwie w locie.

---

## 3. Pytanie 1: czy file system wystarczy?

### Jak robią to realne coding-agenty

Dwa wzorce dominują. Prawie wszyscy używają **commitowanego pliku markdown** na reguły pisane przez człowieka, a coraz więcej dokłada **warstwę "memory"** zapisywaną przez agenta, przy czym ta druga niemal zawsze żyje **poza repo**.

| Narzędzie | Reguły od człowieka (gdzie, scope) | Pamięć generowana (gdzie, scope) |
|---|---|---|
| **Claude Code** | Hierarchia `CLAUDE.md`: org, user, projekt (commit), local (gitignored). Importy `@path`. | Auto-memory w `~/.claude/projects/.../memory/`, **lokalnie na maszynie, per repo, NIE commitowana** ([docs](https://code.claude.com/docs/en/memory)) |
| **OpenAI Codex** | `AGENTS.md` (commit, repo/org), zagnieżdżone | "Memories" w `~/.codex/memories/`, **lokalnie**, osobno od `AGENTS.md` ([docs](https://developers.openai.com/codex/memories)) |
| **Cursor** | `.cursor/rules/*.mdc` (commit) plus reguły usera | "Memories" per projekt per user (stan w 2.1.x niepewny) |
| **Windsurf** | `.windsurf/rules/` (commit) plus globalne | "Memories" per workspace, nie commitowane |
| **Cline** | `.clinerules` (commit) | "Memory Bank": metodyka, ustrukturyzowane pliki w repo czytane na starcie każdego zadania |
| **Aider** | `CONVENTIONS.md` (commit, read-only) | Brak auto-memory, zamiast tego "repo map" regenerowana co run |
| **GitHub Copilot** | `.github/copilot-instructions.md` (commit) | "Copilot Spaces": zewnętrzny store spinający **wiele repo** plus docs, z uprawnieniami ([docs](https://docs.github.com/en/copilot/concepts/context/spaces)) |
| **Sourcegraph/Cody** | czyta `AGENTS.md` | Zewnętrzny indeks semantyczny setek tysięcy repo ([blog](https://sourcegraph.com/blog/how-cody-provides-remote-repository-context)) |
| **Devin** | czyta `AGENTS.md` | "DeepWiki": auto-wiki per repo, wektorowo indeksowana, wystawiona jako MCP ([Cognition](https://cognition.com/blog/deepwiki)) |

**Wniosek, który uderza:** commitowany plik markdown jest uniwersalny dla reguł pisanych przez człowieka. Ale *nauczona/nagromadzona* pamięć niemal zawsze żyje **poza repo**. **Ani Claude Code, ani Codex nie wrzucają swojej auto-pamięci do repo klienta**, a my robimy dokładnie to. (Uwaga: Atlas świadomie idzie w commitowany plik, ale z dyscypliną: `.ai/memory/` to *stabilna* wiedza, nie surowy dziennik uruchomień. To różnica między "plik jako standard" a "plik jako śmietnik".)

### Plik w repo: plusy i minusy

**Plusy:** wersjonowany i recenzowalny (jest w diffie PR, da się cofnąć), podróżuje z kodem, zero infrastruktury i prawie zero kosztu, czytelny i edytowalny przez człowieka ([dev.to](https://dev.to/imaginex/ai-agent-memory-management-when-markdown-files-are-all-you-need-5ekk)).

**Minusy** ([Zep](https://blog.getzep.com/markdown-is-not-agent-memory/), [dev.to](https://dev.to/anajuliabit/the-memorymd-problem-why-local-files-fail-at-scale-58ae)): zaśmieca repo klienta, konflikty merge przy współbieżności, brak dzielenia między repo/ticketami, duplikacja (nasz blok "Human decisions" w każdym repo), ryzyko sekretów/PII w historii gita ([GitGuardian](https://blog.gitguardian.com/ai-and-secrets-in-git-history/)), brak zapytań semantycznych.

### Multi-repo, czyli nasz konkretny ból

Dwie rodziny wzorców: (A) zostać przy plikach i dołożyć warstwę koordynacji (dla monorepo Atlas ma template `monorepo`; dla wielu osobnych repo zespoły budują centralne "meta-repo" z manifestem repo, [meta-repo pattern](https://seylox.github.io/2026/03/05/blog-agents-meta-repo-pattern.html)); (B) zewnętrzny indeks/RAG po wielu repo (Sourcegraph, Devin DeepWiki, Copilot Spaces).

**Co się psuje, gdy pamięć jest per repo, a zadanie obejmuje kilka repo:** wiedza z repo A jest niewidoczna w repo B, blok "Human decisions" trzeba duplikować i się rozjeżdża, nie ma jednego miejsca na "co się zmieniło we wszystkich repo dla tego ticketa".

### Werdykt

**File system wystarcza (i to jest właśnie dyscyplina Atlasa), gdy:** pamięć trwała jest ustrukturyzowana i utrzymywana (nie surowy dziennik), korpus per repo jest sensowny, a klient akceptuje commitowane artefakty AI.

**Osobny magazyn/indeks jest potrzebny dodatkowo, gdy:** zadanie obejmuje wiele repo, chcemy uczenia między ticketami, wyszukiwania semantycznego ("similar-ticket search"), albo mamy wymagania współbieżności/PII.

**Środek, na który zbiegła się branża i który u nas realizuje Atlas:** cienki, commitowany, ustandaryzowany layer w każdym repo (`.ai/`), plus *nagromadzona, przekrojowa* pamięć/indeks w warstwie zewnętrznej, której Atlas świadomie nie robi. To jest odpowiedź: nie plik *albo* store, tylko Atlas jako format w repo **plus** indeks Blazebota na wierzchu.

---

## 4. Pytanie 2: Atlas (Blazity), czy i jak połączyć

### Czym jest Atlas (potwierdzone z repo Blazity/atlas)

Atlas to **standard plus instalowalny CLI** (`@blazity-atlas/core`, MIT, npm). `atlas init` scaffolduje w repo katalog `.ai/` commitowany do gita, dający coding-agentom (Claude/Codex/Cursor) jeden wspólny, maszynowo sprawdzalny kontekst AI. Wejściem jest `AGENTS.md`, a `.ai/config.json` jest **źródłem prawdy o lokalizacjach artefaktów** (agent rozwiązuje ścieżki przez `artifactRoot`, `paths`, `pathAliases`).

Artefakty w `.ai/`:

- **`LANGUAGE.md`**: słownik domenowy (u nas dziś rolę tę pełni `CONTEXT.md`).
- **`memory/`**: `stack.md`, `architecture.md`, `product.md`, `lessons.md`. README wprost: "stabilne memory produktu/architektury/stacku/lekcji. Zmienny status zadania trzymaj w issue trackerze, nie tutaj."
- **`plans/`**, **`research/`**: datowane plany i design-doki (to dokładnie wyjścia naszych faz research i planowania).
- **`decisions/adrs/`**: ADR-y (decyzje z odrzuconymi opcjami i uzasadnieniem).
- **`results/`**: artefakty review z werdyktem (pass / conditional pass / fail, dowody, ryzyka).
- **`skills/`**: `atlas-setup`, `atlas-review`, `atlas-compact`.

Dwa skille kluczowe dla nas:

- **`atlas-review`**: brama procesowa, 5 trybów (intake/plan/review/gate/postmortem), werdykt pass/conditional/fail z dowodami, 9 pytań rdzenia ("jaki realny workflow to poprawia", "skąd wiemy, że działa", "co może pójść źle", "kto jest właścicielem", "co powinien sprawdzić człowiek"). To **mapuje się 1:1 na naszą fazę review**.
- **`atlas-compact`**: utrzymanie kontekstu, sterowane advisories z `atlas doctor`. Kubełkuje treść (komendy i reguły -> instrukcje root, trwałe detale -> `memory/`, decyzje -> ADR, terminy -> `LANGUAGE.md`, duplikaty -> jedna kanoniczna lokalizacja, **treść sprzeczna z repo -> kasowana**). To jest realna, plikowa odpowiedź na "ochronę przed sprzecznościami" i utrzymywalność.

Podział bram (ADR-0001 Atlasa): **strukturalne** (CLI `doctor`, deterministyczne, kontrakt exit 0/1/2 do CI) i **procesowe** (skillowe werdykty w `results/`). **Execution gates (testy/evale/policy przed merge) są jawnie odłożone "poza Core, dopóki nie powstanie produkt, który je przejmie".** To jest wprost zaproszenie dla Blazebota.

Ważne granice Atlasa: **brak RAG/embeddingów/indeksu semantycznego, "nic nie opuszcza repo", per repo.** Plus reguła higieny: dokumentacja zapisuje potrzeby/decyzje/powody, nie osoby ani wewnętrzny proces, bez nazwisk, prywatnych terminów i absolutnych ścieżek lokalnych (to od razu adresuje część ryzyka PII z sekcji 5).

### Jak połączyć Blazebota z Atlasem (konkretnie)

Blazebot i Atlas to dwie połowy tej samej rzeczy, robione w tej samej organizacji. Atlas mówi **gdzie i w jakim formacie** żyje trwały kontekst AI w repo oraz daje bramy i utrzymanie plików. Blazebot to **agent, który te artefakty produkuje i konsumuje**. Połączenie:

1. **Blazebot pisze przez `.ai/config.json`, nie do `blazebot/memory/`.** Research -> `.ai/research/<data>-<ticket>.md`, plan -> `.ai/plans/<data>-<ticket>.md`, werdykt review -> `.ai/results/<data>-<ticket>.md` w formacie `atlas-review`. Ścieżki rozwiązujemy przez config, więc respektujemy `pathAliases` (klient może mieć swój layout).
2. **Blazebot czyta pamięć Atlasa jako kontekst na starcie runu:** `.ai/memory/stack.md` + `architecture.md` + `product.md` + `.ai/LANGUAGE.md` + ADR-y. To kończy odkrywanie faktów o repo od zera co ticket (największy zwrot z sekcji 2).
3. **Po przejściu review Blazebot promuje lekcje do `.ai/memory/lessons.md`** (to jest "self-improvement loop" z roadmapy, ale w commitowanym, recenzowalnym pliku Atlasa), a przy rozroście utrzymuje je skillem `atlas-compact`.
4. **Zmienny status per ticket NIE idzie do `.ai/memory/`** (reguła Atlasa). Zostaje jako stan przejściowy runu albo, jeśli ma być trwały i widoczny, jako property na tickecie w issue trackerze. Tu ląduje też pojedynczy autorytatywny zapis "Human decisions", co **od razu naprawia duplikację w multi-repo** (jeden zapis przy tickecie zamiast kopii w każdym repo). Techniczna opcja: Jira issue property (JSON do 32 KB, zapis po REST, przenośne między Cloud a Data Center).
5. **Blazebot może odpalać `atlas doctor` jako bramę strukturalną** w pipelinie (frozen exit 0/1/2) i przejąć rolę "produktu z execution gates", którą Atlas świadomie zostawił pustą (ADR-0001). To spójna historia produktowa: Atlas daje format i bramy procesowe, Blazebot dokłada egzekucję.

### Czego Atlas nie zrobi (i co dokłada Blazebot)

Atlas jest per repo i bez indeksu semantycznego. Więc **cross-repo i "similar-ticket search" to warstwa Blazebota na wierzchu**: indeks (wektor + słowa kluczowe) budowany z **zacommitowanych artefaktów Atlasa** wielu repo. Źródłem prawdy zostaje git (recenzowalne, cofalne), indeks jest jednorazowym, odtwarzalnym cache. To czysta komplementarność, nie konkurencja: Atlas = substrat, Blazebot = pipeline zapisu plus indeks odczytu.

### Ryzyka połączenia

- **Wersje/drift Atlasa:** `.ai/config.json` ma `atlasVersion` i lockfile; Blazebot musi rozwiązywać ścieżki przez config, nie hardkodować `.ai/`, i tolerować klientów bez Atlasa (fallback do obecnego zachowania).
- **Klient nie ma Atlasa:** Blazebot powinien działać też bez `.ai/` (degradacja do trybu obecnego), a opcjonalnie proponować `atlas init`.
- **Managed skille Atlasa są plikami zarządzanymi** (byte-compare, `doctor --fix` przywraca drift). Blazebot nie może ich edytować w repo klienta.
- **Multi-repo dalej wymaga decyzji:** Atlas per repo nie deduplikuje decyzji między repo. Dedup rozwiązujemy przez issue tracker (punkt 4) albo centralny/meta workspace Atlasa.

---

## 5. Pytanie 3: jakie systemy pamięci są utrzymywalne

To nie jest wybór biblioteki, tylko wdrożenie kilku wzorców. Najpierw wzorce (bo to one decydują o "maintainable"), potem narzędzia. Uwaga: warstwę plikową część z tego już realizuje Atlas (`atlas-compact` + `doctor`); poniższe dotyczy głównie warstwy indeksu, którą Blazebot dokłada.

### 5a. Wzorce utrzymywalności

**Sprzeczności i nieaktualność.** Naiwny store po tygodniu ma "auth używa JWT" i "auth używa sesji" naraz. Dojrzałe systemy robią pamięć **świadomą czasu** i **nie nadpisują po cichu**:

- **Bi-temporalne grafy wiedzy (Zep/Graphiti):** każdy fakt ma czas zdarzenia i czas przyjęcia plus interwały ważności na krawędziach ([Zep paper arXiv:2501.13956](https://arxiv.org/abs/2501.13956), [Neo4j](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)).
- **Invalidacja, nie kasowanie:** stary fakt oznaczany jako wygasły, ale trzymany. Historia zostaje. To wprost wspiera nasz wymóg logowania. (Atlas na poziomie plików robi to inaczej: `atlas-compact` kasuje treść sprzeczną z repo, ale git trzyma historię, więc audyt jest w gicie.)
- **Operacje sterowane LLM (Mem0):** ADD / UPDATE / DELETE / NOOP na wyciągniętych faktach ([Mem0 paper arXiv:2504.19413](https://arxiv.org/html/2504.19413v1)). Prościej, ale DELETE kasuje na twardo (traci audyt poza gitem).
- **Rozwiązywanie encji / dedup:** rozpoznać, że "payments API" i "PaymentService" to ten sam byt. Embedding proponuje merge, LLM potwierdza.

**Konsolidacja i zapominanie.** Refleksja syntetyzuje epizody w trwałe lekcje (episodic -> semantic), np. AWS Bedrock AgentCore generuje refleksje między-epizodowe z poziomem pewności ([AgentCore docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/episodic-memory-strategy.html)). Do tego TTL/decay i scoping (user/session/agent/repo). U nas naturalny punkt konsolidacji to "po review", a scope to repo.

**Indeksowanie i retrieval.** Wektor (podobieństwo znaczeniowe, ślepy na dokładne tokeny i czas), słowa kluczowe/BM25 (dokładne trafienia: kody błędów, ID ticketów), graf (relacje i czas). **Hybryda wygrywa** (BM25 + wektory, Reciprocal Rank Fusion) ([Denser.ai](https://denser.ai/blog/hybrid-search-for-rag/)). Reranking podnosi precyzję kosztem 100 do 300 ms.

**Provenance i logowanie.** Przy każdym rekordzie: źródło (run ID, ticket, PR, autor agent/człowiek), wersja, tombstone zamiast twardego kasowania. Logujemy każdą **operację** (decyzję ADD/UPDATE/DELETE i wejścia), nie tylko stan końcowy, żeby odpowiedzieć "dlaczego agent sądzi X" ([provenance survey arXiv:2606.04990](https://arxiv.org/abs/2606.04990)). Narzędzia typu LangSmith traktują pamięć jak first-class ([LangChain](https://www.langchain.com/resources/agent-observability)).

**Tryby awarii:** zatrucie pamięci / prompt injection do pamięci (groźne, bo rozłączone w czasie: treść ticketa lub komentarza PR to u nas niezaufane wejście, [WorkOS](https://workos.com/blog/ai-agent-memory-poisoning)); niekontrolowany wzrost i degradacja przez nietrafny retrieval (context rot, przycinać/capować/rerankować); wyciek PII między scope'ami. Atlas adresuje częściowo trzy z nich przez reguły higieny dokumentacji plus `atlas-compact`.

**Checklista maintainable memory:** znakuj fakty bi-temporalnie, invaliduj zamiast kasować, wykrywaj konflikty przy zapisie, deduplikuj encje, konsoliduj epizody w wiedzę (refleksja + TTL/budżet), scopuj per repo, retrieval hybrydowy, provenance przy każdym zapisie, loguj każdą operację, traktuj wejście jako niezaufane, capuj kontekst przy odczycie.

### 5b. Konkretne narzędzia (na warstwę indeksu)

| System | Backend + indeks | Self-host | Licencja | Konflikty | Dojrzałość | Język |
|---|---|---|---|---|---|---|
| **Mem0** | Wektor (Qdrant, pgvector, Redis) + opc. graf | Tak (Docker) | Apache-2.0 | LLM: ADD/UPDATE/DELETE/NOOP | Wysoka | Python + TS SDK |
| **Letta (MemGPT)** | Postgres + pgvector | Tak (Docker) | Apache-2.0 | Agent sam edytuje bloki | Wysoka | Serwer Python, SDK TS/Py |
| **Graphiti (Zep OSS)** | Graf: Neo4j/FalkorDB/Neptune | Tak | Apache-2.0 | Bi-temporalna invalidacja | Wysoka | Tylko Python (OSS) |
| **Cognee** | Hybryda graf+wektor (embedded) | Tak | Apache-2.0 | Re-run pipeline "cognify" | Rosnąca | Python |
| **LangMem / LangGraph store** | BaseStore + Postgres/pgvector | Tak | MIT | LLM manager | Pre-1.0 | Python |
| **Mastra memory** | Postgres/pgvector, LibSQL, Upstash, Mongo | Tak | Apache-2.0 core | Working memory = szablon agenta, lekkie | Rosnąca szybko | **TypeScript natywnie** |
| **Redis Agent Memory Server** | Redis + RedisVL | Tak | Apache-2.0 | Dedup + summarization + konsolidacja w tle | Wczesna/preview | Serwer Python, REST + MCP |
| **LlamaIndex memory blocks** | Dowolny vector store | Tak | MIT | Eksmisja wg priorytetu | Dojrzałe | Python + TS |
| **pgvector / Mongo (DIY)** | Postgres / Mongo Atlas | Tak | PostgreSQL / SSPL | Budujesz sam | Bardzo dojrzałe | Dowolny |

**Shortlist pod self-hostowalny produkt w TS/Node:**

1. **Mastra memory:** natywny TypeScript (bez sidecara w Pythonie), Apache-2.0, self-host na Postgres/pgvector.
2. **Redis Agent Memory Server:** agnostyczny językowo (REST/MCP z Node), Apache-2.0, self-host na Redisie, ma dedup + summarization + konsolidację w tle.
3. **Mem0 (OSS self-host):** realne TS SDK, LLM-owe rozwiązywanie konfliktów, najbardziej sprawdzone adopcyjnie.

Jeśli priorytetem jest **temporalna, audytowalna historia**, najlepszym modelem jest **Graphiti**, ale to usługa w Pythonie za API plus Neo4j/FalkorDB.

**Zazębienie z self-hostingiem:** plan `docs/ON-PREM-AWS.md` zakłada **RDS Postgres** i **ElastiCache Redis**. pgvector na tym Postgresie albo Redis Agent Memory Server na tym Redisie **nie dokładają nowej zależności**, a Graphiti (Neo4j/FalkorDB) tak. Argument, żeby domknąć research memory razem z self-hostingiem.

---

## 6. Rekomendacja: proponowany kierunek dla Blazebota

Nie "wywalamy plik i wstawiamy graf". Robimy dwie warstwy: **Atlas jako format/substrat w repo** i **Blazebot jako pipeline zapisu plus indeks cross-repo na wierzchu**.

**Model docelowy (warstwy wg scope, kluczowane per (org, repo, ticket)):**

1. **Robocza ticketa:** zostaje jako stan przejściowy runu; zmienny status ewentualnie do issue trackera. Nie do `.ai/memory/`.
2. **Semantyczna per repo (najwyższa wartość):** Blazebot **czyta** `.ai/memory/{stack,architecture,product}.md` i `.ai/LANGUAGE.md` na starcie. Koniec odkrywania faktów o repo co ticket.
3. **Epizodyczna/proceduralna między ticketami (self-improvement loop):** po review Blazebot promuje lekcje do `.ai/memory/lessons.md`, utrzymywane `atlas-compact`.
4. **Human decisions (naprawa duplikacji):** jeden autorytatywny zapis przy tickecie (issue property), nie kopia w każdym repo.
5. **Indeks cross-repo (to, czego Atlas nie robi):** wektor + słowa kluczowe budowany z zacommitowanych artefaktów Atlasa, do "similar-ticket search". Git = źródło prawdy, indeks = odtwarzalny cache.

**Zapis:** w tle, bramkowany review, z provenance i logiem operacji. **Wyjścia faz** (research/plan/review) piszemy w formacie Atlasa, przez `.ai/config.json`.

**Sugerowana kolejność (od największego zwrotu):**

- **Etap 0 (szybki):** naprawić duplikację "Human decisions" w multi-repo (jeden zapis przy tickecie).
- **Etap 1 (największy zwrot):** Blazebot czyta `.ai/memory` + `.ai/LANGUAGE.md`, jeśli repo ma Atlasa (fallback bez Atlasa). Tnie marnowane tokeny co ticket.
- **Etap 2:** Blazebot pisze research/plan/werdykt review do `.ai/` przez config, w formacie `atlas-review`. Fazy Blazebota zaczynają produkować artefakty Atlasa.
- **Etap 3:** promocja lekcji do `.ai/memory/lessons.md` po review (self-improvement loop).
- **Etap 4:** indeks cross-repo z artefaktów Atlasa (similar-ticket search). Wybór narzędzia (Mastra / Redis Agent Memory / Mem0 / Graphiti) spójny z on-prem.

---

## 7. Otwarte pytania na spotkanie

- Czy Blazebot ma **wymagać** Atlasa w repo, czy działać oportunistycznie (używa `.ai/`, gdy jest, z fallbackiem)? Rekomendacja: oportunistycznie, z opcją proponowania `atlas init`.
- Czy chcemy, żeby Blazebot **przejął rolę "execution gates"**, którą Atlas świadomie zostawił pustą (ADR-0001)? To spójna historia produktowa Blazity.
- Zmienny status i "Human decisions" do issue trackera (Jira issue property) czy do struktury Atlasa? (Atlas mówi: zmienny status do trackera.)
- Priorytet warstwy indeksu: prostota (Mem0/Mastra) czy audytowalna historia bi-temporal (Graphiti)?
- Ryzyko zatrucia pamięci treścią ticketów/komentarzy: jaki poziom bramkowania wiarygodności przy zapisie do `.ai/`?
- Kto jest właścicielem `.ai/` w repo klienta, skoro Blazebot i ludzie piszą do tego samego (kolizje, review)?

---

## 8. Źródła (wybrane, pełne linki w treści)

**Atlas (Blazity):** repo [github.com/Blazity/atlas](https://github.com/Blazity/atlas); artefakty i reguły z `.ai/config.json`, `.ai/memory/README.md`, `AGENTS.md`, skille `atlas-review` i `atlas-compact`, ADR-0001 (podział bram) w repo.

**Fundamenty:** Letta [agent memory](https://www.letta.com/blog/agent-memory/); CoALA [arXiv:2309.02427](https://arxiv.org/abs/2309.02427); Generative Agents [arXiv:2304.03442](https://ar5iv.labs.arxiv.org/html/2304.03442); A-MEM [arXiv:2502.12110](https://arxiv.org/abs/2502.12110); Reflexion [arXiv:2303.11366](https://arxiv.org/html/2303.11366); Context Rot [Redis](https://redis.io/blog/context-rot/).

**Utrzymywalność:** Zep/Graphiti [arXiv:2501.13956](https://arxiv.org/abs/2501.13956), [Neo4j](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/); Mem0 [arXiv:2504.19413](https://arxiv.org/html/2504.19413v1); hybrid retrieval [Denser.ai](https://denser.ai/blog/hybrid-search-for-rag/); provenance [arXiv:2606.04990](https://arxiv.org/abs/2606.04990); memory poisoning [WorkOS](https://workos.com/blog/ai-agent-memory-poisoning).

**Coding-agenty:** Claude Code [memory docs](https://code.claude.com/docs/en/memory); Codex [memories](https://developers.openai.com/codex/memories); Copilot Spaces [docs](https://docs.github.com/en/copilot/concepts/context/spaces); Devin DeepWiki [Cognition](https://cognition.com/blog/deepwiki); Sourcegraph [cross-repo context](https://sourcegraph.com/blog/how-cody-provides-remote-repository-context); "markdown to nie pamięć" [Zep](https://blog.getzep.com/markdown-is-not-agent-memory/).

**Frameworki:** Mem0 [repo](https://github.com/mem0ai/mem0); Letta [repo](https://github.com/letta-ai/letta); Graphiti [repo](https://github.com/getzep/graphiti); Cognee [repo](https://github.com/topoteretes/cognee); Mastra [docs](https://mastra.ai/docs/memory/semantic-recall); Redis Agent Memory Server [repo](https://github.com/redis/agent-memory-server); LlamaIndex [memory](https://developers.llamaindex.ai/python/examples/memory/memory/).
