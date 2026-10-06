# Dopasowanie postów do ruchu rynku

Cel: ustalić, czy post wyprzedził ruch, go wywołał, czy rynek poruszył się z innego powodu.

## Dane do pobrania

| Co | Narzędzie | Parametry |
|---|---|---|
| Aktywo (perpetual) | `coinalyze_ohlcv_history` | `5min`, okno od 30 min przed pierwszym postem do 1h po ostatnim; `from`/`to` w sekundach UNIX |
| Lewar | `coinalyze_open_interest_history`, `coinalyze_liquidation_history` | `5min` lub `1hour` |
| Ropa | `yahoo_history` | `BZ=F` (Brent, kontrakt grudniowy od 1.10), `CL=F` (WTI), `5m` |
| Dolar i euro | `yahoo_history` | `DX-Y.NYB`, `EURUSD=X`, `5m` |
| Rentowności | `yahoo_history` | `ZN=F` (kontrakt 10Y), `ZB=F` (30Y), `5m`; `^TNX` nie notuje w nocy |
| Spot kontrolnie | `kraken_ticker`, `kraken_ohlc` | `XBTUSD`, `ETHUSD` itd. |

Znaczniki czasu to UNIX UTC (początek świecy). Czas posta zaokrąglij w dół do 5 minut, aby znaleźć świecę. Narzędzia bywają wolne lub wygasać; ogranicz liczbę symboli w jednym wywołaniu.

## Metryki

Dla każdego posta:
- **Zwrot świecy posta i 3 kolejnych** (w %): `c/o − 1`.
- **Wolumen względem normy:** wolumen świecy podzielony przez medianę 12 poprzednich świec. Powyżej 3x to impuls.
- **Udział kupujących taker:** `bv/v` w świecy impulsu.
- **Likwidacje** w godzinie impulsu (strona longów lub shortów).
- **Ropa, DXY, ZN w tych samych świecach:** czy ruch zaczął się na ropie lub obligacjach, a dopiero potem w krypto.

## Klasyfikacja relacji czasowej

| Wynik | Znaczenie |
|---|---|
| **Przed postem** | Ruch zaczął się przed godziną publikacji; informacja była już wyceniona lub post opisuje to, co już było widać |
| **Po poście** | Ruch w świecy posta lub 1-2 kolejnych z wolumenem powyżej 3x; prawdopodobna reakcja, ale nadal skorelowana, nie dowiedziona |
| **Brak reakcji** | Zwrot w granicach szumu (np. poniżej 0,15% BTC) i zwykły wolumen |
| **Niewyjaśniony ruch** | Impuls bez pasującego posta w oknie 15 minut przed; oznacz jako lukę w pokryciu |

Przy kilku postach w krótkim czasie nie przypisuj ruchu pojedynczemu postowi.

## Typowe wzorce

- **Ropa → rentowności → dolar → krypto:** kanał z końca września 2026. W impulsie ropa i obligacje zwykle ruszają pierwsze, krypto kilka minut później.
- **Wyciek lub plotka:** ruch przed oficjalnym potwierdzeniem; sprawdź, czy agencja potwierdziła po godzinie i czy cena cofnęła ruch.
- **Spóźniony nagłówek:** wiadomość o spadku ropy, gdy ropa rośnie od ponad godziny; źródło opisuje wcześniejszy ruch.
- **Skok i cofnięcie:** impuls po nagłówku, wypłukanie jednej strony, powrót ceny; ocenia się po zamknięciu świec 15-60 minut później.

## Przykład (1.10.2026, dane z krypto-kal)

- 06:45 UTC Reuters: "Oil dips as recovering Gulf exports ease supply fears". Brent rósł od minimum $96,56 (ok. 05:00 UTC) do ok. $98,4, więc nagłówek był spóźniony.
- 07:05-07:25 UTC: wolumen ropy i kontraktów na obligacje wzrósł, DXY i rentowności w górę, o 07:15-07:25 BTC spadł o ok. 0,8% (wolumen ponad 3x normy). W żadnym z 7 postów z vaultu nie było pasującego komunikatu, więc ruch pozostał **niewyjaśniony** (luka w pokryciu: brak kont rynkowych lub komunikatu, który wywołał ruch).
- 07:30 UTC Reuters o wycofaniu wojsk USA z Iraku: świeca BTC +0,33%, ale to odbicie po impulsie, więc brak dowodu reakcji.
