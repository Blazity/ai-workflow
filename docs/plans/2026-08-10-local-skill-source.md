# Skille z własnego deploymentu

Plan wykonawczy. Wejście dla `/opus-orchestration`.

## Problem

Skille można dziś wziąć wyłącznie z GitHuba, przez jedną organizacyjną instalację GitHub App
na deployment. To ma dwie konsekwencje, obie bolą przy klonach dla klientów.

Tenant, którego instalacja stoi w organizacji klienta, nie przeczyta katalogu skilli
leżącego w repozytorium naszej organizacji, nawet jeśli to repozytorium jest źródłem
jego własnego deploymentu. Tenant obsługiwany wyłącznie przez GitLaba nie przeczyta
żadnego katalogu skilli, bo GitLab nie jest wspierany jako źródło w ogóle.

Efekt jest taki, że wiedza specyficzna dla klienta, czyli jedyna rzecz odróżniająca ten
produkt od gotowych narzędzi SaaS do recenzji, nie ma jak do niego dojechać.

## Rozwiązanie

Z perspektywy operatora tenanta: katalog `skills/` w repozytorium, z którego zbudowany jest
jego deployment, jest źródłem skilli. Nic nie jest pobierane z zewnątrz, nic nie wymaga
autoryzacji między organizacjami, a wersją skilla jest wersja deploymentu. Każdy klon niesie
swoje skille, a zmiana skilla to zwykła zmiana w repozytorium i redeploy.

Ścieżka GitHubowa zostaje bez zmian: jest nadal poprawnym sposobem współdzielenia skilli
między organizacjami.

## User stories

1. Jako operator tenantu chcę trzymać skille w repozytorium swojego deploymentu, żeby nie
   zależeć od dostępu naszej instalacji GitHub App do cudzej organizacji.
2. Jako operator tenantu na GitLabie chcę w ogóle móc używać skilli.
3. Jako operator chcę widzieć w dashboardzie, które skille pochodzą z deploymentu, a które
   z GitHuba, żeby wiedzieć, co zmieni redeploy, a co odświeżenie.
4. Jako właściciel produktu chcę, żeby wdrożenie tej zmiany nie unieważniło ani jednego
   przypiętego profilu.

## Decyzje implementacyjne

**Skille lokalne przechodzą tą samą drogą, co GitHubowe.** Są importowane do tej samej
tabeli artefaktów, dostają ten sam `artifactHash` liczony z tej samej zawartości, i są
przypinane w profilu tak samo. Różni je wyłącznie to, skąd bierze się treść. Dzięki temu
materializacja w sandboxie, weryfikacja integralności i przypinanie wersji pozostają
nietknięte.

**Kanoniczna postać źródła GitHubowego jest zamrożona.** `artifactHash` liczy się po
`stableJson`, w którym `source` uczestniczy w całości, więc dopisanie do niego pola
dyskryminującego zmieniłoby hash każdego istniejącego artefaktu i rozpięło każdy profil,
który go przypina. Wariant GitHubowy zachowuje dokładnie cztery dotychczasowe pola w tej
samej kolejności semantycznej. Rozróżnienie wariantów odbywa się po zbiorze obecnych pól,
a nie po znaczniku wewnątrz hashowanej struktury. Znacznik rodzaju żyje w kolumnie bazy,
poza hashem.

**Źródłem lokalnym jest katalog `skills/` w korzeniu repozytorium.** Ta nazwa nie jest
dowolna: to pierwszy z siedmiu katalogów, których szuka dziś importer GitHubowy, więc ten
sam układ pozostaje czytelny dla obu ścieżek. Wariant lokalny opisuje ścieżka wewnątrz
katalogu oraz skrót zawartości; nie ma w nim commita, bo nie ma repozytorium do wskazania.

**Pliki muszą trafić do bundla funkcji.** Nitro pakuje wyłącznie JavaScript, a warstwa
workflow emituje osobne funkcje kroku, przepływu i webhooka obok fallbacku, z których każda
dostaje własny katalog roboczy. Katalog skilli kopiuje się więc do każdej z nich tym samym
hookiem kompilacji, który dziś rozwozi pliki konfiguracyjne YAML. Runtime czyta je względem
katalogu roboczego procesu.

**Odświeżenie znaczy co innego dla obu wariantów.** Skill GitHubowy odświeża się przez
ponowne pobranie z domyślnej gałęzi. Skill lokalny zmienia się wyłącznie przez redeploy, więc
próba odświeżenia go musi to powiedzieć wprost, zamiast udawać, że coś zrobiła.

## Seamy i decyzje testowe

| Seam | Obserwowane zachowanie | Prior art |
|---|---|---|
| kanoniczny ładunek hasha | dla niezmienionego źródła GitHubowego hash jest identyczny co do bajtu przed i po zmianie | `apps/worker/src/harness-profiles/skill-artifact.ts:200-217` |
| czytnik katalogu skilli | dla katalogu na dysku zwraca te same artefakty, które importer GitHubowy zwróciłby dla tej samej treści | `apps/worker/src/harness-profiles/github-skills.ts` i jego test obok |
| hook kompilacji | po budowie każdy katalog funkcji niesie katalog skilli | hook YAML w `apps/worker/nitro.config.ts` |

## Domknięte po red teamie

Oba punkty poniżej były przez chwilę odłożone jako "wykrywanie, nie działanie", po czym
zostały zrobione w tym samym branchu. Opis zostaje, bo tłumaczy, po co te dwa mechanizmy
istnieją.

Rozjazd przypięcia jest widoczny bez klikania: edytor profilu odpytuje listę skilli
deploymentu, ale wyłącznie wtedy, gdy draft przypina choć jeden skill lokalny, i rozróżnia
trzy stany. Przypięcie zgodne z deploymentem. Przypięcie do skilla, który w deploymencie ma
inną treść, gdzie lekarstwem jest odświeżenie i publikacja. Przypięcie do skilla, którego
deployment już nie wozi, gdzie lekarstwem jest przywrócenie katalogu albo zdjęcie przypięcia.
Nieudane pobranie listy nie rysuje ostrzeżenia, bo brak odpowiedzi znaczy "nie wiem", a nie
"rozjazd".

Podmiana źródła jest powiedziana wprost: krok przeglądu importu nazywa każde przypięcie,
które wybrany skill zastąpi, razem z jego dotychczasowym źródłem, i przypomina, że skille
dopasowywane są po nazwie z `SKILL.md`, która nie musi odpowiadać nazwie katalogu. Operacja
nie jest blokowana, przestaje być tylko ukryta.

**Rozjazd przypięcia nie jest widoczny bez kliknięcia odświeżania.** Odkrywanie zwraca skrót
artefaktu, jaki wyprodukowałby import, ale jedynym miejscem, które o to pyta, jest okno
dodawania skilla. Edytor profilu nigdy nie porównuje przypiętych skrótów z tym, co niesie
bieżący deployment, więc po cofnięciu wdrożenia profil wygląda zdrowo i dalej wysyła agentowi
treść z wycofanej wersji. Dane do wykrycia tego istnieją, brakuje wyłącznie porównania.

**Import lokalnego skilla po cichu zdejmuje przypięty skill GitHubowy o tej samej nazwie.**
Scalanie usuwa z draftu wpis o zbieżnej nazwie albo skrócie, co dotąd trafiało wyłącznie
w ponowny import tego samego skilla i było zgodne z intencją. Po dodaniu drugiego źródła ta
sama reguła podmienia źródło skilla bez słowa, a nazwa pochodzi z front mattera, więc nie
musi odpowiadać nazwie katalogu.

## Pułapki czekające na etap 4b, znalezione na bramce 4a

**Proxy dashboardu nie przepuści odkrywania lokalnego bez nowego handlera.** Przepuszcza dziś
tylko odkrywanie i import GitHubowy, a jego jedyny pomocnik mutacji jest wyłącznie POST-owy,
więc dopisanie akcji do unii nie wystarczy. Odkrywanie lokalne nie ma czego przyjąć w ciele,
więc albo dostaje własny handler odczytu, albo trasa lokalna przyjmuje POST bez ciała wbrew
swojej naturze. To decyzja do podjęcia na starcie 4b, nie w trakcie.

**Historia użytkownika o widocznym źródle przypiętego skilla nie ma dziś ścieżki danych.**
Obiekt wersji profilu niesie manifest, a odwołanie do skilla w manifeście to wyłącznie hash
artefaktu i nazwa. Źródło widać dopiero w zapisie manifestu runu, czyli po fakcie. Pokazanie
w edytorze profilu, który skill pochodzi z deploymentu, wymaga poszerzenia kontraktu wersji
profilu, a nie tylko zmiany komponentu. Etap 4b musi to policzyć w swój zakres.

## Wycofane: rzekoma kolizja nazw skilli

Wcześniejsza wersja tego planu twierdziła, że profil przypinający dwa skille o tej samej
nazwie materializuje je pod jedną ścieżką w sandboxie i drugi nadpisuje pierwszy bez śladu.
To nieprawda i zapisałem to bez sprawdzenia. Walidacja manifestu odrzuca zarówno duplikat
nazwy, jak i duplikat hasha artefaktu, przy każdym parsowaniu draftu, czyli na każdej ścieżce
zapisu profilu. Kolizja nie dociera do sandboxa, więc nie ma czego zgłaszać ani czym
podpierać dodatkowej walidacji w czytniku. Osobny ticket.

## Out of scope

- Autorstwo skilli w dashboardzie. Dashboard nadal tylko dołącza, nie tworzy treści.
- Import z GitLaba jako zdalnego źródła. Wariant lokalny odblokowuje tenantów GitLabowych
  bez niego.
- Migracja istniejących skilli GitHubowych na lokalne. Obie ścieżki żyją równolegle.

## Założenia

1. **Katalog skilli jest mały wobec limitu bundla.** Trzy skille klienta to około 140 KB,
   a kopiowane są do każdej funkcji. Przy kilkudziesięciu skillach warto to zmierzyć ponownie.
2. **Skrót zawartości wystarcza za wersję.** Skill lokalny nie ma commita, więc dwa różne
   deploymenty z identyczną treścią dają ten sam artefakt. To jest pożądane, bo artefakty są
   adresowane treścią, ale znaczy też, że rollback deploymentu nie zmienia przypięcia.
3. **Żaden istniejący wiersz artefaktu nie ma pustego źródła GitHubowego**, więc migracja
   może domyślnie oznaczyć wszystkie istniejące wiersze jako GitHubowe.

## Etapy

| # | Etap | Seam | Zakres plików | Tier | Sceptyk | TDD | Delegacja | DoD |
|---|------|------|---------------|------|---------|-----|-----------|-----|
| 1 | Kontrakt źródła: wariant lokalny obok GitHubowego, z zamrożoną postacią kanoniczną | kanoniczny ładunek hasha | `apps/shared/contracts/harness-profiles.ts`, `apps/worker/src/harness-profiles/skill-artifact.ts` (+testy obok) | opus | tak | tak | nie | test pinujący dowodzi, że dla niezmienionego wejścia GitHubowego `artifactHash` równa się zapisanemu w teście literałowi; drugi test dowodzi, że artefakt lokalny o tej samej treści plików ma hash INNY niż GitHubowy, bo źródło jest częścią tożsamości; `pnpm --filter worker test harness-profiles` zielone |
| 2 | Trwałość: rodzaj źródła w bazie, kolumny GitHubowe dopuszczają brak, migracja | brak (schemat) | `apps/worker/src/db/schema.ts`, nowa migracja w `apps/worker/drizzle/` | opus | nie | nie | nie | migracja stosuje się na czystej bazie i na bazie z istniejącymi wierszami; wszystkie istniejące wiersze wychodzą oznaczone jako GitHubowe z nienaruszonymi kolumnami; numer migracji nie koliduje z `origin/main` |
| 3 | Czytnik katalogu z deploymentu plus rozwiezienie plików do funkcji | czytnik katalogu skilli | `apps/worker/src/harness-profiles/local-skills.ts` (nowy, +test), `apps/worker/nitro.config.ts` | opus | tak | tak | nie | test dowodzi, że czytnik odrzuca to samo, co odrzuca importer GitHubowy: zły wzorzec nazwy, opis poza zakresem długości, plik ponad limit, przekroczony rozmiar artefaktu; test dowodzi, że katalog bez `SKILL.md` jest pomijany, a nie wywala importu; hook kompilacji ma test albo jawnie udokumentowaną weryfikację ręczną z wynikiem |
| 4 | Wystawienie: odkrywanie i import lokalnych, rozróżnienie w dashboardzie, odświeżanie mówi prawdę | brak (API i UI) | `apps/worker/src/routes/api/v1/harness-skills/`, `apps/worker/src/routes/api/v1/harness-profiles/[id]/skills/refresh.post.ts`, dashboard: edytor profilu | sonnet | tak | nie | tak | odkrywanie zwraca skille z deploymentu bez konfiguracji GitHuba; próba odświeżenia skilla lokalnego zwraca czytelny komunikat, że zmienia go redeploy, zamiast błędu providera; dashboard pokazuje, z którego źródła pochodzi każdy przypięty skill |

Etapy są sekwencyjne. Pierwotnie zakładałem, że 2 i 3 pobiegną równolegle, ale etap 1 pokazał
sprzężenie, którego plan nie widział: obiekty przenoszące artefakt na zewnątrz są przypięte do
wariantu GitHubowego, a czytają je miejsca spoza zakresu etapu 1. Poszerzenie ich pociąga
zawężenie w miejscu zapisu artefaktu, czyli dokładnie tam, gdzie etap 3 zapisuje rodzaj źródła
wprowadzony przez etap 2. Przy budżecie dwóch godzin dziennie równoległość nie jest tu wartością,
a kolizja na tym samym pliku jest realna.

**Decyzja advisora do QUESTION z etapu 1.** Obiekty wyjściowe artefaktu zostają przypięte do
wariantu GitHubowego do końca etapu 1 i poszerza je etap 3, razem z zawężeniem w miejscu zapisu
i w kontrakcie kanarka. Odrzucone: poszerzanie ich już w etapie 1, bo zostawiłoby w drzewie
obsługę wariantu, którego nic jeszcze nie produkuje, oraz nadanie wariantowi lokalnemu pól
fantomowych, bo to ucisza kompilator dokładnie tam, gdzie ma on wskazać miejsca wymagające
obsługi.

**Korekta granicy etapów 2 i 3, po znalezisku z etapu 2.** Pierwotny podział zakładał, że
zmiana schematu jest sprawdzalna w izolacji. Nie jest: rozluźnienie nullowalności kolumny
natychmiast rozjeżdża typy w każdym miejscu, które czyta z niej źródło, a te miejsca leżały
poza zakresem etapu 2. Zapisany DoD tego etapu wymagał zielonego typechecku, więc plan był
wewnętrznie sprzeczny.

Rozstrzygnięcie: etap 2 dokłada jedno miejsce, w którym gwarancja bazy przekracza granicę
systemu typów, czyli funkcję odwzorowującą wiersz artefaktu na źródło z kontraktu. Wywołania
w miejscach odczytu używają jej zamiast czytać kolumny wprost. Wariant lokalny nie jest tam
jeszcze produkowany, bo nic go nie zapisuje: dokłada go etap 3 razem z czytnikiem katalogu.
Odrzucone: rozsypanie kilkunastu zawężeń po dwóch plikach, bo zaklepywałoby decyzję należącą
do etapu 3, oraz przepuszczenie czerwonego drzewa przez granicę commita, bo na tym branchu
pracują równolegle inne osoby.

**Decyzja advisora: źródło pozostaje częścią tożsamości artefaktu.** Ten sam zestaw plików
wzięty z GitHuba i z deploymentu daje dwa różne hashe, więc przeniesienie skilla między
źródłami wymaga ponownego przypięcia w profilu. To nie jest wybór, tylko konsekwencja: `source`
zawsze uczestniczył w hashu, a wyjęcie go stamtąd samo w sobie przeliczyłoby wszystkie
istniejące artefakty.
