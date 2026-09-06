# Neon cost-cut plan (2026-08-18)

Cel: zejść z rachunku Neona (lipiec **$122,73**, z czego **$122,67 to compute**) do
groszy i docelowo na Free / najniższy tier, **bez migracji** na Railway, bez ryzyka dla runów.

## Wykonano (2026-08-18)

- **Floor 1 CU → 0,25 CU na wszystkich 3 autoryzowanych compute** (potwierdzone w konsoli, każdy `.25 ↔ 8 CU`, max sam zjechał 9→8, nieszkodliwe):
  - internal `ai-workflow-postgres` / `ep-jolly-hill-a250q4ge`
  - Arthur `ai-workflow-arthur-postgres` / `ep-royal-truth-aschl9r4`
  - `outbound-tool` (`delicate-king-85126839`) / `ep-long-pine-asy9z508` (był SUSPENDED, więc i tak już usypia)
- **Autosuspend** zostaje 5 min (minimum planu Launch, nie da się niżej z UI).
- **Cron cadence: PR [#305](https://github.com/Blazity/ai-workflow/pull/305) ZMERGOWANY** (squash → main `94b6036e`, auto-deploy Vercel `dpl_3zpN9ncr...` BUILDING→production): `/cron/poll` `* * * * *`→`*/15`, `/cron/harness-capabilities` `*/5`→`*/30`. Zweryfikowane przed merge: **zero żywych schedule-triggerów na prodzie** (deployed defs 2/11/12/14/23/25/28 = ticket/PR/webhook, żaden zegarowy), więc oba warunkowe zgrzyty z analizy (`grace < 15 min` = cichy skip, okres = 15 min = Nyquist) są bezprzedmiotowe. `*/15` = czysta latencja backstopu.
- **Plan Launch jest managed by Vercel** (billing page: „Neon subscription managed by Vercel" → Vercel Integrations → Neon Database → Settings). Downgrade NIE z konsoli Neona. Free nie zmieści 6 projektów (limit ~1 projekt na Free).

**Zostaje:** flip deployu na READY (potwierdzić `/cron/poll`→200); Arthur dostaje cron przez release runbook 2026.08.4; obserwacja CU-h ~doba; downgrade/konsolidacja przez Vercela (decyzja Jakuba, draft w `docs/qa/2026-08-18-jakub-neon-cost-update.md`); housekeeping (martwy `dropsy-search-app-postgres`, 7 idle branchy `ai-workflow-demo/*` — Filip kasuje, integracja Vercel↔Neon je odtwarza).

## Diagnoza (dowody)

- Faktura lipiec: **1 157,267 CU-hours = $122,67**, storage $0,06. Koszt to w 99,95% **compute awake-time**.
- 1157 CU-h / 744 h zegarowych = **~1,55 CU non-stop** → compute obudzony 24/7 i nie schodzi nisko.
- Org `org-snowy-sun-21208716` (Vercel: Blazity, plan **Launch**) ma **6 projektów**, każdy to osobny compute:
  | Projekt | Storage | Branche | Aktywny | Uwaga |
  |---|---|---|---|---|
  | `ai-workflow-postgres` (internal, `small-leaf-75509146`) | 92 MB | 8 (7 idle `ai-workflow-demo/*`) | tak | **floor 1 CU** |
  | `ai-workflow-arthur-postgres` (Arthur) | 46 MB | 1 | tak | ten sam kod = ten sam poll |
  | `iberion-content-bot-db` | 85 MB | 1 | tak | inny produkt, wlicza się do rachunku |
  | `issue-triage-workflow-db` | 31 MB | 1 | dzień temu | j.w. |
  | `outbound-tool` | 36 MB | 1 | tak | j.w. |
  | `dropsy-search-app-postgres` | 33 MB | 1 | **rok temu** | martwy, do kasacji |
- `ai-workflow-postgres` compute: **autoscale `1 ↔ 9 CU` (min 1!)**, **scale-to-zero 5 min**, tylko branch `main` Active, reszta Idle (uśpione, nie palą).
- Kod: `apps/worker/vercel.json` cron `/cron/poll` = `* * * * *` (co minutę, ~25 zapytań/tick, **brak early-exitu** przed dotknięciem DB) + `/cron/harness-capabilities` = `*/5`. Sterownik `neon-http` → **każde zapytanie budzi Neon**. Dispatch jest event-driven z webhooków (jira/gitlab/github wołają tę samą logikę), więc poll to tylko **backstop**.

**Sedno:** poll co minutę nie daje bazie zasnąć (autosuspend 5 min nigdy nie dobiega), a gdy jest obudzona, floor 1 CU trzyma ją drogo. Dwie gałki naprawiają 90% problemu.

## Dźwignie (kolejność = impact/łatwość)

1. **Floor 1 CU → 0,25 CU** na KAŻDYM aktywnym compute (branch `main` każdego projektu, nie sam default, bo default nie propaguje na istniejące). Setting, zero kodu, ~4x taniej za czas obudzenia. **Największy natychmiastowy win.**
2. **Scale-to-zero 5 min → minimum planu (celuj 60 s)** na tych compute, żeby baza usypiała szybko po aktywności.
3. **Kod: cofnij kadencję crona.** `/cron/poll` `* * * * *` → `*/15` (albo `*/10`), `/cron/harness-capabilities` `*/5` → `*/30`. Przy autosuspend 5 min interwał musi być **wyraźnie > 5 min**, żeby baza w ogóle zasnęła (dispatch i tak leci z webhooków, backstop 15 min jest OK). Jeśli uda się autosuspend zejść do 60 s, wtedy `*/5` wystarczy.
4. **Housekeeping:** skasuj martwy `dropsy-search-app-postgres`; wyczyść 7 idle branchy `ai-workflow-demo/*` (nie kosztują w idle, ale to bałagan i mogą budzić); zdecyduj czy `iberion-content-bot-db` / `issue-triage-workflow-db` / `outbound-tool` są jeszcze potrzebne.
5. **Downgrade planu** Launch → Free/najniższy, **dopiero po** potwierdzeniu niskiego zużycia.

Oczekiwany efekt na projekt (floor 0,25 + awake ~20-33%): **~30-45 CU-h/mies** zamiast ~730-1130. Nasze dwa (internal + Arthur) → ~$6-10/mies łącznie zamiast dziesiątek.

## Kolejność wykonania (WAŻNE)

1. **Najpierw ściąć zużycie** (gałki 1+2 na Neonie, 3 w kodzie) → deploy.
2. **Obserwować CU-h ~dobę** (Neon → project → Monitoring / org Billing usage) aż spadnie pod target.
3. **Potem** housekeeping (4) i **na końcu** downgrade planu (5). Downgrade przed cięciem zużycia = Free od razu zawiesi bazę.

## Kto co robi

- **Ja (kod):** PR na `apps/worker/vercel.json` z nową kadencją crona (`*/15` poll, `*/30` harness). Idzie do internal od razu po merge; do Arthura przez release runbook (2026.08.4). Opcjonalnie mały early-exit w pollu, gdy nic do roboty (i tak budzi DB, ale mniej zapytań).
- **Ty / ja za Twoją zgodą (Neon settings, dotyka prod DB):** floor 0,25 CU + autosuspend min na compute `main` każdego naszego projektu. To zmiana ustawień żywej bazy, więc chcę wyraźne „tak" zanim klikam na prodzie.
- **Ty (billing):** downgrade planu przez Vercel (subskrypcja jest „managed by Vercel"), po weryfikacji zużycia.

## Ryzyka / rollback

- Floor 0,25 CU: max zostaje 9 CU, więc podczas ciężkiego runu compute i tak podskoczy; 0,25 dotyka tylko idle/lekkich okresów. Bezpieczne dla bazy 92 MB. Rollback = podnieś floor.
- Autosuspend 60 s: dodaje ~kilkaset ms cold-startu na pierwszym zapytaniu po uśpieniu. Akceptowalne.
- Poll `*/15`: backstop dispatchu wolniejszy do 15 min, ale realtime i tak jest z webhooków. Schedule-triggery i sweeps lecą co 15 min zamiast co 1 min, do sprawdzenia czy któryś wymaga większej precyzji (`evaluateScheduleTriggers` w pollu).

## Do potwierdzenia

- Czy przez Vercel-managed Neon **Free w ogóle jest dostępny**, czy najniższy to Launch (wtedy cel = minimalizacja usage-based na Launch, co i tak daje ~$3-6/mies).
- Limity Free: cap 0,25 CU (i tak tam celujemy), miesięczny budżet CU-h, i limit projektów (6 projektów może się nie zmieścić → konsolidacja/kasacja).
- Minimalny autosuspend na Launch (czy 60 s jest dostępne, czy fixed 5 min).
- Czy `iberion` / `issue-triage` / `outbound-tool` są nasze i czy je ruszamy.
