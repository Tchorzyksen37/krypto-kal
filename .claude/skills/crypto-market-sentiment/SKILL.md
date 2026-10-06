---
name: "crypto-market-sentiment"
description: Briefing o nastroju rynku krypto w dwóch etapach - makro USA (S&P 500, Nasdaq, Dow, rentowności obligacji, dolar, ropa, Bliski Wschód, kalendarz Fed/inflacja/rynek pracy/płace) oraz analiza derywatów przez MCP krypto-kal (Coinalyze - cena, open interest, funding, long/short, likwidacje) z oceną fazy rynku, ryzyka squeeze, przewagi longów lub shortów i zakresu ruchu +/-, a także rozbiciem zachowania rynku na sesje azjatycką, europejską i amerykańską (która sesja napędza ruch i kiedy pojawia się presja). Używaj ZAWSZE, gdy użytkownik pyta o nastrój lub sentyment rynku krypto, trend BTC/ETH/XRP/altcoinów, "co się dzieje na rynku", ryzyko long lub short squeeze, czy rynek jest przegrzany, wpływ makro (Fed, CPI, payrolls, ropa, dolar, yields) na krypto, albo prosi o poranny, dzienny lub tygodniowy przegląd rynku - nawet jeśli nie wspomni o skillu ani o MCP. English triggers - crypto market sentiment, market briefing, squeeze risk, funding rate and open interest analysis, macro impact on crypto.
---

# Crypto market sentiment briefing

Skill składa jeden spójny obraz z dwóch warstw: **makro** (skąd bierze się apetyt na ryzyko) i **mikrostruktura derywatów** (jak wygląda pozycjonowanie w samej kryptowalucie). Sam wykres ceny nie mówi, czy ruch jest zdrowy, a samo makro nie mówi, kiedy rynek jest podatny na squeeze - dopiero zestawienie obu warstw daje użyteczną ocenę.

## Zasady nadrzędne

- **Data i świeżość.** Bierz dzisiejszą datę z kontekstu rozmowy. Do każdej liczby dopisz, z kiedy pochodzi (dzień, w miarę możliwości godzina). Szukaj informacji z ostatnich 24-48h; stare wyniki wyszukiwania często pokazują nieaktualne ceny.
- **Nie zgaduj liczb z pamięci.** Ceny, rentowności, kursy, terminy publikacji i wyniki danych makro pobieraj przez wyszukiwanie. Jeśli nie da się ustalić wartości, napisz to wprost zamiast wstawiać przybliżenie.
- **Rozróżniaj fakt od interpretacji.** Dane z narzędzi to fakty, ocena fazy, ryzyka i scenariuszy to Twój osąd - oznacz to w raporcie.
- **Scenariusze warunkowe zamiast prognoz punktowych.** Format "jeśli X, to Y" z poziomami cenowymi i wskaźnikami potwierdzającymi. Nie podawaj pewnych przewidywań ani sygnałów kup/sprzedaj.
- **Jedna linijka zastrzeżenia** na końcu: analiza danych, nie porada inwestycyjna. Bez długich disclaimerów.
- **Język odpowiedzi** = język użytkownika.
- **Uczciwość co do niepewności.** Jeśli wskaźniki są sprzeczne (np. neutralny funding, ale mocno long konta), powiedz to i wyjaśnij, co ta sprzeczność oznacza, zamiast wybierać wygodną narrację.

## Krok 0: ustal zakres

- Aktywo: jeśli użytkownik podał (np. XRP), analizuj je **plus BTC** jako barometr całego rynku. Jeśli nie podał, użyj BTC i ETH.
- Horyzont: domyślnie krótkoterminowy (1-7 dni) z kontekstem 30-90 dni. Jeśli użytkownik prosi o poranny brief, skróć makro do tego, co się zmieniło w ciągu doby.
- Zakres: jeśli prosi tylko o część (np. "sam kalendarz" albo "tylko derywaty XRP"), wykonaj tylko tę część. Nie rób pełnego raportu, gdy pytanie jest wąskie.

## Krok 1: makro (wyszukiwanie w sieci)

Przeczytaj `references/macro-checklist.md` - zawiera listę tematów, sugerowane zapytania i co z każdego wyciągnąć. Tematy:

1. Indeksy USA (S&P 500, Nasdaq, Dow): kierunek, tendencja z kilku sesji, co wywołuje presję (stopy, rentowności, dane, wyniki spółek, geopolityka, sektor AI).
2. Bliski Wschód: bieżąca sytuacja i jej kanał wpływu na ropę, inflację i apetyt na ryzyko.
3. Ropa (Brent i WTI): cena, zmiana w ostatnich dniach, prognozy instytucji.
4. Kalendarz: nadchodzące posiedzenia Fed i publikacje (inflacja, rynek pracy, płace, aktywność) w ciągu 14 dni.
5. Dolar (DXY i główne pary) oraz rentowności obligacji USA (2Y, 10Y, 30Y) i ich zmiana.
6. Sentyment krypto z zewnątrz: Fear & Greed Index, przepływy ETF, dominacja BTC (jeśli dostępne).

7. Kontekst sesyjny: co działo się na rynkach azjatyckich (Nikkei, Hang Seng, decyzje banków centralnych regionu), europejskich (DAX, STOXX 600, dane strefy euro, EBC/BoE) i amerykańskich, oraz w której sesji wypadają nadchodzące publikacje.

Kończ ten etap krótkim wnioskiem: **czy makro sprzyja ryzyku (risk-on), jest neutralne, czy je dławi (risk-off)** i który czynnik dominuje.

## Krok 2: krypto (MCP krypto-kal)

Przeczytaj `references/derivatives-playbook.md` - zawiera procedurę pobierania danych, wzory, tabele interpretacji, klasyfikację fazy i punktację ryzyka squeeze.

Skrót procedury:

1. Znajdź symbole: `coinalyze_future_markets` (parametr `base_asset`), giełdy: `coinalyze_exchanges`. Punktem odniesienia jest zwykle kontrakt USDT perpetual na Binance (sufiks `.A`).
2. Pobierz dla każdego aktywa: OHLCV, open interest, funding rate, long/short ratio, likwidacje - na interwale dziennym (reżim, 90 dni) i 4h (taktyka, ok. 60 świec). W razie potrzeby 1h dla ostatnich 24-48h.
3. Policz wskaźniki według playbooka, sklasyfikuj fazę, oceń ryzyko long i short squeeze, wyznacz zakres ruchu ±.

Narzędzie ma limit 40 wywołań na minutę i każdy symbol liczy się osobno - grupuj symbole w jednym wywołaniu i nie powtarzaj zbędnych zapytań.

## Krok 2b: podział na sesje (Azja / Europa / USA)

Krypto handluje się całą dobę, ale kapitał i zmienność zmieniają charakter w ciągu dnia: w Azji dominuje inny typ uczestników niż w Europie i w USA, a największe dane makro trafiają w godziny amerykańskie. Rozbicie na sesje pokazuje, **która sesja napędza trend, kiedy pojawia się presja sprzedaży i kiedy wypadają likwidacje**, co pozwala ocenić, czy ruch ma solidne podstawy (np. popyt w USA) czy jest wątły (np. wzrost tylko na cienkiej płynności w Azji).

Zdefiniuj sesje w UTC (i podaj przeliczenie na czas lokalny użytkownika):

| Sesja | UTC | CEST (lato) | Charakter |
|---|---|---|---|
| Azja | 00:00-08:00 | 02:00-10:00 | Tokio, Hongkong, Singapur, Korea; często cieńsza płynność, ruchy wyznaczają lokalni gracze i decyzje banków centralnych regionu |
| Europa | 08:00-14:00 | 10:00-16:00 | Londyn i Frankfurt; wzrost płynności, reakcja na dane europejskie |
| USA | 14:00-22:00 (plus przejście 22:00-24:00) | 16:00-24:00 | Wall Street, dane amerykańskie i wystąpienia Fed, największe wolumeny i przepływy instytucjonalne |
| Nakładka Europa/USA | 12:00-16:00 | 14:00-18:00 | Najwyższa płynność; publikacje o 8:30 ET (12:30 UTC), otwarcie akcji (13:30 UTC latem, 14:30 UTC zimą), dane o 10:00 ET |

Godziny zmieniają się wraz ze zmianą czasu (USA i Europa przechodzą na czas zimowy w różnych terminach - jesienią z rozbieżnością kilku tygodni). Sprawdź, czy dzień analizy nie wypada w okresie takiej rozbieżności, i w razie potrzeby przesuń granice o godzinę.

Szczegółowa procedura (dane 2h, wzory, jak interpretować) jest w `references/derivatives-playbook.md`, sekcja "Analiza sesyjna". W etapie makro dodaj też kontekst sesyjny (indeksy azjatyckie i europejskie, decyzje banków, publikacje w danej sesji) - patrz `references/macro-checklist.md`.

## Krok 3: synteza i raport

Przeczytaj `references/report-template.md` i trzymaj się tej struktury. Zacznij od werdyktu w 3-4 zdaniach (nastrój, faza, główne ryzyko, która sesja napędza ruch), a szczegóły dawaj niżej. Tabele stosuj do kalendarza i do scenariuszy, resztę pisz zwięzłą prozą.

Jeśli użytkownik chce zapisać wynik (np. w Obsidianie), przygotuj plik `.md` z frontmatter (`tags`, `data`, `aktywo`) i sekcją "Do sprawdzenia" z brakującymi danymi.

## Pułapki i kontrola jakości

- **Coinalyze ≠ Coinglass.** Dane z jednej giełdy (Binance) będą się różnić od agregatów Coinglass. Zaznacz, jaki zakres obejmują dane, i nie mieszaj wartości z obu źródeł w jednym wskaźniku bez zastrzeżenia.
- **Niedomknięta świeca.** Ostatnia świeca w danych jest zwykle w trakcie tworzenia - traktuj ją jako sygnał wstępny, nie potwierdzenie.
- **Jednostki.** Wolumen z Coinalyze bywa w jednostkach aktywa bazowego, nie w USD. Sprawdź, porównując z znanym wolumenem dobowym, zanim podasz kwoty w dolarach. Wskaźniki względne (udział kupujących, zmiana %) są bezpieczniejsze.
- **Long/short kont to stan, nie przepływ.** Ratio kont liczy konta, nie wielkość pozycji, i samo w sobie nie dowodzi, że longi są dalej otwierane. Patrz na jego zmianę w czasie i zestawiaj z funding i taker flow.
- **Mała próba.** Progi wyznaczone z kilku epizodów to heurystyki. Mów o tym wprost.
- **Brak danych opcji i heatmapy likwidacji w MCP.** Jeśli te dane byłyby potrzebne do oceny, wskaż je jako brakujące i zasugeruj sprawdzenie w Coinglass, zamiast zgadywać.
- **Sprzeczne źródła makro.** Gdy dwa źródła podają różne liczby, podaj widełki i źródła.
