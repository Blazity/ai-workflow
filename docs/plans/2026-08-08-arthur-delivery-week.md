# Tydzień dostawy dla Arthura: harmonogram, wygaszanie recenzji, prywatne skille

Plan wykonawczy na tydzień 2026-08-10, budżet ~2h dziennie (~10h łącznie).
Wejście dla `/opus-orchestration`.

## Problem

Arthur ma dostać jeden prywatny workflow recenzji Post-PR, który zna specyfikę ich
trzech repozytoriów. Dziś ta dostawa jest zablokowana z trzech niezależnych stron.

Recenzja nawarstwia się między pushami: każdy run publikuje nowy komplet komentarzy
inline, a żaden nie wygasza poprzedniego. Zmierzone na `Blazity/ai-workflow-prod` PR #33:
cztery runy opublikowały 6, 6, 9 i 7 komentarzy, a pull request pokazał 21 żywych
komentarzy przy najnowszym commicie. Developer, który wypchnie poprawkę, widzi swoją
poprawkę recenzowaną obok każdej wcześniejszej rundy tej samej recenzji. To jest dokładnie
ta skarga ("a lot of noise for very low signal"), z powodu której Arthur w ogóle szuka
alternatywy, i to ta sama skarga, którą ich własny zespół proponuje rozwiązać kupnem
CodeRabbita.

Wiedza o ich repozytoriach istnieje, ale nie w produkcie. Trzy przewodniki recenzji
przygotowane przez Artura Sidwę leżą jako załączniki na Slacku od 31 lipca i nikt ich
nie przekonwertował na skille, które agent mógłby załadować.

Workflow nie umie wystartować z harmonogramu. Trigger istnieje w ~80%, ale nic go nie
odpala, więc żaden cykliczny przypadek użycia nie jest możliwy.

## Rozwiązanie

Z perspektywy użytkownika po tym tygodniu:

Recenzent Arthura ocenia kod ich trzech repozytoriów wiedząc, co w każdym z nich jest
naprawdę ryzykowne, a co i tak łapie CI, więc nie marnuje komentarza na rzecz, którą
zablokuje pipeline. Pull request pokazuje recenzję swojej aktualnej głowicy: komentarze
z poprzedniego pushu są zwinięte i podpisane, którą wersją kodu zostały zastąpione, więc
zostają czytelne w historii, ale przestają konkurować o uwagę. Workflow można uruchomić
cyklicznie z harmonogramu, a ponowiony tick planera nie tworzy drugiego runu.

## User stories

1. Jako recenzujący developer w Arthurze chcę widzieć komentarze dotyczące kodu, który
   właśnie wypchnąłem, żeby nie przeglądać rund recenzji sprzed trzech commitów.
2. Jako developer chcę móc wrócić do wygaszonej rundy komentarzy, żeby sprawdzić, czy
   uwaga została faktycznie zaadresowana, a nie tylko zniknęła.
3. Jako recenzujący w `arthur-scope` chcę, żeby agent znał konwencje wielotenantowości
   i migracji tego repozytorium, żeby jego uwagi dotyczyły realnego ryzyka, a nie stylu.
4. Jako operator workflow chcę uruchomić definicję cyklicznie z harmonogramu, żeby
   przypadki użycia niezwiązane z ticketem ani pull requestem w ogóle były możliwe.
5. Jako operator chcę mieć pewność, że powtórzony tick planera albo restart workera nie
   uruchomi tego samego harmonogramu dwa razy.
6. Jako operator chcę zobaczyć w edytorze, kiedy wypada następne uruchomienie, żeby
   zweryfikować konfigurację przed wdrożeniem.

## Decyzje implementacyjne

**Wygaszanie recenzji poprzedniej głowicy.** Port adaptera VCS zyskuje jedną operację:
"wygaś recenzje, które ten system opublikował dla wcześniejszych głowic tego pull requesta".
Wywołuje ją ścieżka publikacji, po potwierdzonej publikacji bieżącej rundy, nigdy przed:
nieudane wygaszanie nie może zabrać recenzji, która właśnie powstała.

Wybór rundy do wygaszenia opiera się na rekordach publikacji tego pull requesta o głowicy
innej niż bieżąca i o stanie `published`. Klucze idempotencji są dziś liczone per głowica,
więc wiązanie "poprzednia głowica → obecna" powstaje przez zapytanie o `(provider, repository,
prNumber)` z wykluczeniem bieżącego `headSha`, a nie przez nowy klucz.

Realizacja różni się per provider i to jest świadome. GitLab dostaje resolve dyskusji:
zapisujemy `discussion.id` przy publikacji, więc identyfikator już mamy.

GitHub ma dwa warianty i wybór między nimi rozstrzyga dwudziestominutowy spike w etapie 0.
Wariant podstawowy to resolve wątku: identyfikator węzła wątku nie musi być zapisany przy
publikacji, bo da się go odpytać po numerycznym identyfikatorze komentarza, który mamy.
Wariant zapasowy, gdy odpytanie okaże się niewykonalne, to zwinięcie treści przez REST.
Różnica nie jest kosmetyczna: zwinięcie zostawia wątek otwartym, więc licznik konwersacji
nie spada, a repozytorium wymagające rozwiązania wszystkich konwersacji przed mergem
pozostaje zablokowane, tylko bez widocznej treści blokady. Dlatego zwijanie jest zapasem,
nie planem.

Wygaszamy wyłącznie to, co rozpoznajemy jako swoje po markerze osadzonym w treści przy
publikacji. Komentarz, którego markera nie ma, nie jest ruszany nawet gdy jego identyfikator
znajduje się w naszej bazie.

**Dispatch harmonogramu.** Brakujące ogniwo między istniejącym ewaluatorem cron a istniejącym
inboxem okazji. Odczytuje harmonogramy, których watermark pozostał w tyle, pyta ewaluator
o należną okazję, przyjmuje ją w inboxie i dopiero po przyjęciu startuje run, notując wynik
jako rozpoczęty, pominięty, przy limicie albo błędny. Kolejność jest odwracalna tylko w jedną
stronę: przyjęcie okazji przed startem runu daje co najwyżej run, który się nie zaczął;
odwrotna kolejność daje run bez śladu, czyli duplikat po kolejnym ticku.

Uruchamiany z istniejącego ticka planera co minutę, obok odzyskiwania zawieszonych dostaw
webhooka. Jedno przejście obsługuje wszystkie należne harmonogramy, a nie jeden na tick.

**Skille recenzji.** Trzy dokumenty źródłowe stają się trzema skillami, po jednym na
repozytorium. Każdy dostaje nagłówek metadanych, w którym opis nazywa swoje repozytorium
wprost, bo wybór skilla jest model-invoked i to opis jest jedynym mechanizmem wyboru.
Prompt recenzenta dostaje zdanie kierujące go do skilla pasującego do recenzowanego
repozytorium: to nie jest gwarancja, tylko podniesienie prawdopodobieństwa, i tak jest
zaprojektowany produkt.

To zdanie trafia do konfiguracji bloku recenzenta w definicji workflow Arthura, a nie do
wbudowanego promptu domyślnego. Ta różnica jest istotna operacyjnie: wbudowane prompty są
zamrożone w migracji i pilnowane bramką dryfu, więc ich edycja bez towarzyszącej migracji
nie zmienia zachowania żadnego runu, a jedynie wywala testy. Workflow klienta nie podlega
temu mechanizmowi, bo prompt jest częścią definicji.

Słowniki dotkliwości zostają zunifikowane do czterech poziomów, które rozumie kontrakt
wyniku recenzji. Dokument frontendowy używa dziś trzech innych nazw, dwa pozostałe nie mają
sekcji dotkliwości w ogóle. Mapowanie na decyzję maszynową zostaje bez zmian, natomiast
kalibracja jest konserwatywna: poziom blokujący dostaje tylko to, co dokument źródłowy
nazywa wprost blokującym, ponieważ przy jednym recenzencie próg zgody wynosi jeden i każda
uwaga tego poziomu blokuje merge.

## Seamy i decyzje testowe

| Seam | Obserwowane zachowanie | Prior art |
|---|---|---|
| ewaluator okazji cron | dla konfiguracji, strefy, watermarku i chwili "teraz" wskazuje należną okazję albo jej brak; bez wejścia-wyjścia i bez zegara | `apps/worker/src/schedule-trigger/occurrence.ts`, własny test obok |
| dispatch harmonogramu | należna okazja daje dokładnie jeden run; powtórzony tick nie daje żadnego; brak wolnych miejsc daje zapis "przy limicie", nie run | `apps/worker/src/webhook-trigger/dispatch-webhook-trigger.ts:1-358` + test obok |
| port wygaszania w adapterze VCS | publikacja dla głowicy B wygasza wątki otwarte przez ten system na głowicy A i nie dotyka żadnych innych | dwa adaptery: `apps/worker/src/adapters/vcs/github.ts:516`, `apps/worker/src/adapters/vcs/gitlab.ts:524` |

Skille nie mają seamu w kodzie. Wybór skilla jest model-invoked przez pole opisu
(`apps/worker/src/sandbox/harness-runtime.ts:370-373`, zero mechanizmu wyboru per
repozytorium), więc etap treści dostaje sceptyka, ale nie może dostać TDD.

## Out of scope

- AIW-224, spike walidacji przez przeglądarkę. Research bez terminu, poza budżetem tygodnia.
- AIW-75, weryfikacja evals i obserwowalności. Wymaga dostępu do tenanta Arthura, a w tym
  tygodniu testujemy wyłącznie u siebie.
- Podbicie pinów wersji CLI harnessu. Dotyka każdego runu i zasługuje na własny cykl testowy,
  nie na doklejenie do tygodnia z dostawą dla klienta.
- Wieloinstalacyjny dostęp GitHub App. Nowy feature produktowy, osobny ticket.
- Linkowanie recenzji między repozytoriami (recenzent widzi dziś każde repozytorium
  w izolacji). Życzenie ze spotkania, nie ticket.
- Endpoint MCP do tworzenia workflow przez agenta. Osobny ticket, backlog.
- Wygaszanie komentarzy z rund, które nigdy nie osiągnęły stanu opublikowanego.

## Założenia

1. **Identyfikator węzła wątku na GitHubie da się odpytać po identyfikatorze komentarza,
   którego mamy.** Resolve wątku istnieje wyłącznie w GraphQL, a worker nie ma dziś klienta
   GraphQL, ale wątki pull requesta wystawiają identyfikator bazodanowy swoich komentarzy,
   więc mapowanie z tego, co zapisujemy, na to, czego potrzebuje resolve, powinno zamknąć
   się w jednym zapytaniu bez zmiany ścieżki publikacji i bez nowej kolumny. Rozstrzyga to
   spike w etapie 0. Jeśli teza padnie, wariantem zapasowym jest zwijanie treści przez REST,
   ze świadomością, że nie zamyka wątku i nie odblokowuje mergea.
2. **Skille lądują w kliencki forku, świadomie tylko na czas testu u nas.** Import skilli
   chodzi przez jedną organizacyjną instalację GitHub App (`apps/worker/env.ts:39`, `:411`),
   a fork stoi w organizacji Blazity, podczas gdy instalacja tenanta Arthura stoi w ich
   organizacji. Na naszym środowisku zadziała, u klienta nie. Docelowe umiejscowienie jest
   świadomie odłożone i nie blokuje tego tygodnia.
3. **Zdanie w promptcie recenzenta wystarczy do wyboru skilla per repozytorium.** Nic tego
   nie egzekwuje. Kryterium akceptacji ticketu mówi "każde repozytorium ładuje tylko swoją
   wiedzę", a mechanizm jest probabilistyczny.
4. **Inbox okazji jest kompletny i dispatch niczego w nim nie musi dodawać.** Zweryfikowane
   przez odczyt `occurrence-store.ts`, ale nie przez uruchomienie: żaden test nie przechodzi
   dziś pełnej ścieżki od ticka do runu.
5. **Konserwatywna kalibracja dotkliwości nie osłabi wartości recenzji na tyle, żeby
   Arthur uznał ją za bezużyteczną.** Kalibrujemy w dół, żeby nie blokować nadgorliwie,
   ale nie mamy pomiaru, gdzie leży granica. To założenie jest groźniejsze, niż wygląda,
   bo trzy niezależne decyzje tego planu pchają recenzję w tę samą stronę: mniej komentarzy
   (wygaszanie), niższe poziomy (kalibracja) i niepewne załadowanie wiedzy o repozytorium
   (wybór skilla). Cichy recenzent obok gadatliwego konkurenta czyta się jako zepsuty, nie
   jako precyzyjny. Dlatego etap 4a mierzy wartość różnicowo, a nie liczbą komentarzy.

## Linia cięcia

Kolejność porzucania, gdy budżet się kończy. Sprawdzenie w środę wieczorem.

1. **Etap 1 wypada pierwszy, w całości**, jeśli w środę wieczorem etapy 2 i 3 nie są na
   gałęzi integracyjnej. Harmonogram obsługuje operatora, nie Arthura: żaden argument
   przeciw konkurencji nie zawiera słowa "cron". Odzyskany czas idzie na etap 4.
2. **Etap 3 redukuje się do jednego repozytorium** (`arthur-scope`, największy dokument
   i najwięcej ryzyka w treści), jeśli konwersja przekroczy trzy godziny.
3. **Etap 2 nie wypada nigdy.** To jedyna pozycja, która adresuje skargę klienta wprost.
   Gdyby zabrakło czasu, wypada w nim GitHub, a zostaje GitLab: dwa z trzech repozytoriów
   Arthura stoją na GitLabie.

## Etapy

| # | Etap | Seam | Zakres plików | Tier | Sceptyk | TDD | Delegacja | DoD |
|---|------|------|---------------|------|---------|-----|-----------|-----|
| 0 | Higiena i trzy spike'y: rozwiązać kolizję numeru migracji, domknąć niezacommitowaną pracę, podmienić klucz Anthropic, rozstrzygnąć resolve wątku na GitHubie (20 min), rozstrzygnąć hostowanie skilli dla tenanta klienta (30 min) | brak | `apps/worker/drizzle/` (przenumerowanie), bez innych zmian w kodzie | opus | nie | nie | nie | **kolizja migracji rozwiązana**: gałąź harmonogramu i `main` obie niosą numer 0042 dla różnych migracji, więc migracja harmonogramu jest przenumerowana za tę z `main`, dziennik drizzle spójny, a migracje stosują się na czystej bazie w kolejności; `git status` czysty na `apps/`; typecheck workera zielony; po ≤5 min od podmiany klucza katalog możliwości nie niesie znacznika nieudanego odświeżenia; spike GitHuba kończy się jednozdaniowym werdyktem "resolve wykonalny / niewykonalny, bo …"; spike hostowania kończy się wskazaniem miejsca albo jawnym "brak ścieżki, temat na osobny ticket" |
| 1 | Dispatch harmonogramu: funkcja dispatchu + wpięcie w tick planera | dispatch harmonogramu | `apps/worker/src/schedule-trigger/dispatch-schedule-trigger.ts` (+test), `apps/worker/src/routes/cron/poll.get.ts` | opus | tak | tak | nie | test dowodzi, że **dwie równoległe** próby przyjęcia tej samej okazji dają jeden run, a nie dwa, i że opiera się to na ograniczeniu unikalności w bazie, nie na kolejności wywołań (jeśli ograniczenia nie ma, etap je dodaje); brak wolnych miejsc daje zapis "przy limicie" bez runu; dispatch biegnie **po** odzyskiwaniu dostaw webhooka, w osobnym `try/catch`, a test dowodzi, że rzucający dispatch nie przerywa odzyskiwania; `pnpm --filter worker test schedule-trigger` zielone |
| 2 | Wygaszanie recenzji poprzedniej głowicy: port + dwa adaptery + wywołanie | port wygaszania w adapterze VCS | `apps/worker/src/adapters/vcs/types.ts`, `github.ts`, `gitlab.ts`, `apps/worker/src/workflows/pr-external-resources.ts` (+testy obok) | opus | tak | tak | nie | test dowodzi, że publikacja dla głowicy B wygasza to, co opublikowaliśmy na głowicy A, w obu adapterach; że komentarz bez naszego markera nie jest ruszany nawet gdy jego identyfikator jest w naszej bazie; że nieudana publikacja bieżącej rundy nie wygasza niczego; `pnpm --filter worker test pr-external-resources adapters/vcs` zielone |
| 3 | Konwersja trzech przewodników na skille + zdanie kierujące w konfiguracji bloku recenzenta | brak (treść) | nowy katalog skilli poza `apps/` | opus | tak | nie | tak | dla każdego z trzech repozytoriów wypisane **5 konkretnych reguł przeniesionych z dokumentu źródłowego wraz z cytatem**, każda oznaczona jako blokująca albo nie; walidacja metadanych (wzorzec nazwy, opis 1-1024 znaków, poniżej 1 MB, dotkliwości wyłącznie z czterech dozwolonych poziomów) jest warunkiem wstępnym, nie dowodem |
| 4a | Cienki test wartości: jeden Post-PR review z zasianym defektem, na jednym repozytorium | brak (operacyjny) | bez zmian w kodzie | opus | nie | nie | nie | PR z celowo zasianym realnym defektem (wielotenancyjność albo migracja) daje **co najmniej jedną uwagę poziomu blokującego ze wskazaniem pliku i linii**, a ten sam PR przejechany bez skilla tej uwagi **nie** daje; drugi push na ten sam PR zostawia komentarze tylko bieżącej głowicy i licznik żywych wątków spada |
| 4b | Domknięcie: harmonogram i pętla | brak (operacyjny) | bez zmian w kodzie | opus | nie | nie | nie | harmonogram odpala run dokładnie raz; pętla recenzja→poprawka→recenzja przejechana raz na `reviewed-ticket-workflow`, z odnotowanym wyjściem po wyczerpaniu prób |

Etapy 1, 2 i 3 mają rozłączne zakresy plików i biegną równolegle, ale lądują na jednej
gałęzi integracyjnej, na której testowane są etapy 4a i 4b. Rozłączność plików nie czyni
pracy równoległą: wąskim gardłem jest jedna osoba przy bramkach recenzenta i sceptyka,
dlatego bramka sceptyka dla etapu 3 jest jednorundowa i nie ma prawa blokowania, bo to
treść, a nie kod.

Rozkład na dni, nie na sumę godzin: etap 0 w poniedziałek rano, etapy 1-3 od poniedziałku,
**etap 4a we wtorek** na cienkim wycinku etapu 2 (wystarczy jeden provider), etap 4b
w czwartek. **Piątek zostaje pusty jako bufor.** Wcześniejsza wersja tego planu wydawała
10 godzin z 10 i sprawdzała wszystkie założenia w ostatniej godzinie tygodnia.
