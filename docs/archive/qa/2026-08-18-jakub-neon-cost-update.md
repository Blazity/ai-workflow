# Wiadomość do Jakuba: koszt Neona (2026-08-18)

Draft do wklejenia (Filip wysyła sam). Kontekst: wcześniej Filip pisał do Jakuba o dostępie
do Railway (pod migrację bazy). Ten update odpuszcza Railway i raportuje, że koszt zbity na
samym Neonie.

## Draft (Polski, paste-ready)

```
Cześć Jakub, update w sprawie bazy i kosztów Neona (i odpuszczam pomysł migracji na Railway).

Kontekst: rachunek Neona za lipiec to $122,73, z czego $122,67 (99,95%) to compute. Powód:
worker odpala poll co minutę, więc baza nigdy nie schodzi do zera (5-minutowy autosuspend nie
ma szans zadziałać) i stoi obudzona 24/7 na floorze 1 CU. Railway odpuszczam: moja rola w
waszym workspace nie ma uprawnień do tworzenia projektów, a przede wszystkim to niepotrzebne,
bo problem rozwiązuje się na samym Neonie.

Co zrobiłem:
- Floor autoscale 1 CU -> 0,25 CU na trzech naszych bazach (internal, Arthur, outbound-tool).
  To od razu tnie koszt obudzonej bazy 4x.
- PR #305 (zmergowany, deployuje się na internal): poll co minutę -> co 15 min, harness co 5 ->
  co 30 min. Dzięki temu baza faktycznie usypia między webhookami (dispatch i tak leci z
  webhooków, poll to tylko backstop). Zero schedule-triggerów na prodzie, więc to czysta
  latencja backstopu, nic się nie psuje. Arthur dostanie tę samą zmianę przez release 2026.08.4.

Efekt: z ~$120-155/mies schodzimy do ~$10-18/mies (~88% w dół). Storage to grosze.

Do decyzji po Twojej stronie (billing):
- Plan Launch jest "managed by Vercel" (Integrations -> Neon Database -> Settings), nie zmienię
  go z konsoli Neona. Chcesz, żebym tam ruszał, czy bierzesz to na siebie?
- Free realnie się nie zmieści: limit projektów (Free ~1 projekt), a mamy 6 (internal, Arthur,
  iberion, issue-triage, outbound-tool + martwy dropsy). Realnie zostajemy na Launch z
  przyciętym usage, co i tak daje te ~$10-18.
- Do sprzątnięcia, jak dasz zielone: martwy projekt dropsy-search-app-postgres (compute aktywny
  rok temu) i decyzja, czy iberion / issue-triage jeszcze żyją.

Dopnę downgrade albo konsolidację, jak powiesz, że OK.
```

## Liczby (dla nas, gdyby Jakub dopytał)

- Stawka compute ~$0,106/CU-h (lipiec: $122,67 / 1157,267 CU-h).
- Było (floor 1, poll co minutę, obie bazy 24/7): ~$120-155/mies (lipiec $123 z Arturem żywym
  tylko ~9 dni; pełny miesiąc obu ≈ $155).
- Teraz (floor 0,25, poll jeszcze co minutę do wejścia deployu): ~$30-39/mies. Żyje od zaraz
  (to ustawienie Neona, niezależne od kodu).
- Po deployu #305 (floor 0,25 + poll */15 -> baza śpi ~2/3 czasu, awake ~33% przez sztywny
  5-min autosuspend na Launchu): ~$13/mies za obie + narzut na budzenia z webhooków -> ~$10-18.
