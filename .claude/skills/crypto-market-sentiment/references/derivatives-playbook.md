# Analiza derywatów krypto (MCP krypto-kal / Coinalyze)

## Spis treści
1. Pobieranie danych
2. Wskaźniki do policzenia
3. Kwadrant cena/OI
4. Klasyfikacja fazy rynku
5. Ryzyko squeeze (punktacja)
6. Przewaga longów czy shortów
7. Zakres ruchu ±
8. Scenariusze i oczekiwania
9. Analiza sesyjna (Azja / Europa / USA)

---

## 1. Pobieranie danych

**Symbole.** `coinalyze_future_markets(base_asset="XRP")` zwraca symbole. Punkt odniesienia: kontrakt USDT perpetual na Binance (`<ASSET>USDT_PERP.A`, np. `BTCUSDT_PERP.A`). Kody innych giełd: `coinalyze_exchanges`. Dla obrazu całego rynku można sumować OI i likwidacje z kilku giełd (`aggregate=true`), ale wtedy podaj, które giełdy weszły do sumy.

**Czas.** Znaczniki `t` to UNIX w sekundach UTC (początek interwału). Ostatnia świeca jest zwykle niedomknięta. Przelicz godziny na czas użytkownika, gdy opisujesz wydarzenia (np. publikację danych makro).

**Zestaw zapytań (dla każdego aktywa):**

| Cel | Narzędzie | Interwał / limit |
|---|---|---|
| Reżim (trend, faza) | `coinalyze_ohlcv_history` | `daily`, 90 |
| Taktyka | `coinalyze_ohlcv_history` | `4hour`, 60 |
| Lewar | `coinalyze_open_interest_history` | `daily` 90 i `4hour` 60 |
| Koszt lewaru | `coinalyze_funding_rate_history` | `4hour` 42-60 lub `daily` 60 |
| Nastroje kont | `coinalyze_long_short_ratio_history` | `4hour` 30-60 |
| Kaskady | `coinalyze_liquidation_history` | `4hour` 30-60 i `daily` 60 |
| Stan bieżący | `coinalyze_current` | `open_interest`, `funding_rate`, `predicted_funding_rate` |
| Sesje (Azja/Europa/USA) | OHLCV, OI, likwidacje | `2hour`, 168 (14 dni); patrz sekcja 9 |

Limit to 40 wywołań na minutę, a każdy symbol liczy się osobno. Przy kilku aktywach rozłóż zapytania w czasie.

**Pola odpowiedzi:** OHLCV: `o,h,l,c`, `v` (wolumen), `bv` (wolumen kupna taker), `tx`, `btx`. OI: `o,h,l,c`. Funding: `o,h,l,c` w procentach. L/S: `r` (ratio), `l` i `s` (% long i short). Likwidacje: `l` (longi), `s` (shorty).

**Jednostki:** sprawdź, czy `v` jest w jednostkach aktywa czy w USD (porównaj sumę z ostatnich 24h ze znanym wolumenem dobowym). Wskaźniki względne są niezależne od jednostek.

## 2. Wskaźniki do policzenia

- **Trend ceny:** układ szczytów i dołków na 4h i dziennym (wyższe czy niższe szczyty), pozycja względem średnich z zamknięć (np. 20 i 50 dni), zakres konsolidacji, poziomy wsparcia (dołki testowane ≥2 razy) i oporu.
- **Zmiana OI:** od lokalnego szczytu ceny i w ostatnich 24h, w %. Szczyty OI przy kolejnych odbiciach: rosnące = lewar odbudowuje się, malejące = uczestnictwo słabnie.
- **Funding względnie:** percentyl bieżącego funding w rozkładzie ostatnich 30 dni oraz liczba okresów ujemnych. Na Binance poziom bazowy to zwykle ok. 0,01% za 8h - to "neutralne", nie "byczo". Ważny jest dryf: rosnący razem z OI = tłok po stronie longów; spadek do zera lub poniżej = longi uciekają, shorty płacą.
- **Udział kupujących taker:** `bv / v` dla każdej świecy i średnio z okna. Poniżej ok. 48% przez wiele świec = trwała przewaga sprzedających. Sumaryczny "CVD" ≈ Σ(2·bv − v). Zestaw znak CVD z kierunkiem ceny.
- **Likwidacje:** suma i stosunek longów do shortów na świecę. Oceniaj **względem własnej historii aktywa**, np. świece powyżej 90-95 percentyla z ostatnich 30-60 dni to kaskady. Nie stosuj kwot bezwzględnych między aktywami.
- **Long/short kont:** poziom i zmiana w czasie (stan, nie przepływ). Zestaw z funding i taker flow.
- **Wolumen zdarzeń:** skoki wolumenu i ich godziny; zestaw z kalendarzem makro, żeby ocenić, czy ruch był reakcją na dane i czy został utrzymany.
- **Zmienność:** odchylenie standardowe dziennych zwrotów logarytmicznych z 30 dni oraz ATR(14) w %.

## 3. Kwadrant cena / OI (jak czytać zmianę OI)

| Cena | OI | Znaczenie | Uwaga |
|---|---|---|---|
| ↑ | ↑ | Nowy kapitał na longach, trend potwierdzony | Ryzyko przegrzania, gdy OI rośnie szybciej niż cena lub funding skacze |
| ↑ | ↓ | Domykanie shortów (squeeze) | Ruch bywa słaby i wygasa, gdy shorty się skończą |
| ↓ | ↑ | Nowe shorty (albo pułapka na longi) | Buduje paliwo pod short squeeze, jeśli cena zaraz zawróci |
| ↓ | ↓ | Long unwinding, czyszczenie lewaru | Zwykle krótsze; zdrowe, jeśli OI spada wolniej niż w panice |

Dodatkowo: **cena stoi, OI rośnie** = po jednej stronie ktoś dokłada pozycje, a ruch jeszcze nie przyszedł; zbierz dowody, po której (funding, taker flow, L/S).

## 4. Klasyfikacja fazy rynku

Wybierz jedną fazę i uzasadnij dwoma-trzema wskaźnikami. Jeśli sygnały są mieszane, napisz "przejście między X a Y".

| Faza | Cechy |
|---|---|
| **Akumulacja / dno** | Cena płaska lub lekko rosnąca po spadku, malejąca zmienność, OI stopniowo rośnie lub stabilny, funding neutralny lub ujemny, likwidacje głównie longów już za nami, rosnący wolumen kupna na spadkach |
| **Trend wzrostowy (markup)** | Wyższe szczyty i dołki, cena powyżej średnich, OI rośnie razem z ceną, funding dodatni ale umiarkowany, taker buy > 50% |
| **Dystrybucja / szczyt** | Cena testuje opór wielokrotnie, OI wysokie lub rośnie bez wzrostu ceny, funding rośnie, coraz niższe udziały kupujących, słabnący wolumen na wzrostach |
| **Trend spadkowy (markdown)** | Niższe szczyty i dołki, cena poniżej średnich, malejące szczyty OI przy odbiciach, taker sell dominuje, likwidacje longów przy spadkach |
| **Kapitulacja** | Gwałtowny spadek, skok likwidacji longów (kaskada), OI spada gwałtownie, funding ujemny, wolumen ekstremalny; po niej często odbicie V |
| **Konsolidacja / kompresja** | Wąski zakres, spadająca zmienność i wolumen, OI stabilne; ryzyko gwałtownego wybicia rośnie z długością kompresji i poziomem OI |

## 5. Ryzyko squeeze (punktacja)

Policz osobno dla **long squeeze** i **short squeeze**. Każdy spełniony warunek to 1 punkt, razem max 6. Interpretacja: 0-1 niskie, 2-3 umiarkowane, 4-6 wysokie. To heurystyka z małej próby - zapisz, które punkty zaliczone.

**Long squeeze (kaskada likwidacji longów)**
1. Funding w górnych 20% rozkładu 30 dni lub rosnący razem z OI
2. OI blisko lokalnego maksimum lub rośnie szybciej niż cena
3. Konta mocno long (L/S kont wyraźnie powyżej mediany 30 dni)
4. Cena tuż pod oporem testowanym ≥2 razy, brak wybicia na wolumenie
5. Taker buy < 48% przy rosnącej cenie (wzrost bez popytu agresywnego)
6. Odrzucenie od oporu (knot, zamknięcie poniżej) albo pierwsze świece z rosnącymi likwidacjami longów

**Short squeeze (kaskada likwidacji shortów)**
1. Funding ujemny lub w dolnych 20% rozkładu 30 dni
2. OI rośnie przy spadającej lub stojącej cenie (nowe shorty)
3. Dominacja shortów w L/S (ratio poniżej mediany 30 dni) albo malejące ratio przy stojącej cenie
4. Cena stoi na wsparciu testowanym ≥2 razy, spadek wyhamował
5. Taker sell wysoki, ale cena nie spada (absorpcja)
6. Wybicie powyżej lokalnego oporu na wolumenie albo pierwsze świece z rosnącymi likwidacjami shortów

**Sygnały, że kaskada właśnie trwa:** likwidacje jednej strony powyżej 90-95 percentyla, OI spada gwałtownie razem z ceną (long) lub cena rośnie z OI w dół (short), funding skacze w przeciwną stronę.

**Rozróżnik:** OI spada razem z ceną = czyszczenie lewaru, zwykle krótsze. OI rośnie mimo spadku ceny = weszli nowi agresywni shortujący, presja może trwać dłużej.

**Poziomy wyzwalacza:** wyznacz z danych ceny: najbliższy opór/wsparcie i ekstrema ostatnich dni. Klastry likwidacji daje tylko model `coinalyze_liquidation_heatmap_estimate` (interwał `4hour`, limit 500+): podawaj je jako ESTIMATE, nigdy jako zmierzone dane.

## 6. Przewaga longów czy shortów

Nie opieraj wniosku na jednym wskaźniku. Zbierz w tabelę i wskaż większość:

| Wskaźnik | Przechył longowy gdy | Przechył shortowy gdy |
|---|---|---|
| L/S kont | ratio wysokie i rośnie | ratio niskie i spada |
| Funding | dodatni i rośnie | ujemny |
| OI + cena | oba rosną | OI rośnie, cena spada |
| Taker flow | buy > sell | sell > buy |
| Likwidacje | więcej shortów wypłukanych | więcej longów wypłukanych |

Zwróć uwagę na **rozbieżności**: np. dużo kont long (L/S), ale ujemny taker flow i neutralny funding wskazuje rynek podzielony, w którym są też znaczące shorty. L/S kont mierzy liczbę kont, a nie wielkość pozycji; jeśli dostępne jest ratio top traderów (pozycje), porównaj je z ratio kont.

## 7. Zakres ruchu ±

1. Oblicz σ = odchylenie standardowe dziennych zwrotów logarytmicznych z 30 dni.
2. Zakres 1-dniowy ≈ cena × (1 ± σ) obejmuje mniej więcej 2/3 dni; ±2σ około 95%. Zakres 7-dniowy ≈ σ·√7.
3. Porównaj z ATR(14) w % jako kontrolę.
4. Zaznacz, że kryptowaluty mają **grube ogony**: dni skrajne zdarzają się częściej, niż sugeruje rozkład normalny.
5. Skoryguj kierunek i szerokość o kontekst: kompresja zmienności przy wysokim OI i zbliżającej się publikacji makro sugeruje szerszy zakres i ruch gwałtowniejszy po wybiciu niż zwykle. Po dużym ruchu i spadku OI zmienność zwykle maleje.
6. Podaj też typowy dzień, impuls (ok. 2σ) i dzień skrajny na bazie historii aktywa z ostatnich 90 dni (największe dzienne ruchy).

Zakres to miara zmienności, nie prognoza kierunku.

## 8. Scenariusze i oczekiwania

Przedstaw trzy scenariusze w tabeli: **bazowy, bycza kontynuacja, niedźwiedzia kontynuacja**. Dla każdego: warunek wejścia (poziom ceny i zamknięcie świecy 4h/dziennej), wskaźniki potwierdzające (OI, taker flow, funding), cele orientacyjne (najbliższe poziomy z danych), i co go unieważnia. Przy każdym dodaj jakościową wagę (np. "najbardziej prawdopodobny", "mniej prawdopodobny") wraz z uzasadnieniem, a nie liczbą procentową.

**Oczekiwania rynku co do kursu** wyprowadź z danych: funding i jego dryf, przechył OI, przepływy taker, ukształtowanie L/S. Jeśli użytkownik pyta o prognozy analityków, możesz je wyszukać, ale traktuj jako słabe źródło i zaznacz to.

---

## 9. Analiza sesyjna (Azja / Europa / USA)

Cel: ustalić, **w której sesji rynek rośnie, w której spada, gdzie jest płynność i kiedy wypadają likwidacje**. To odpowiada na pytania: kto napędza trend, czy ruch ma poparcie w płynnych godzinach i kiedy jest największe ryzyko nagłego ruchu.

### Dane

Najpierw `speculation_context` (`core: ["<AKTYWO>"]`, `extra: 0`): udział sesji w wolumenie, sezonowość otwarć i rytm open interest są tam już zmierzone (patrz SKILL.md, Krok 2b). Nie licz ich drugi raz.

Resztę pobierz z Coinalyze na interwale `1hour`, `limit=336` (14 dni): OHLCV, open interest i likwidacje (funding wystarczy z `4hour`). Jeśli limity zapytań są ograniczeniem, zacznij od 7 dni (`limit=168`).

Przypisanie świec: przelicz początek świecy (UTC) na czas Europe/Warsaw i przypisz go do sesji z tabeli w SKILL.md. Granice o :30 zaokrąglaj w dół do pełnej godziny (świeca 13:00 → nakładka, 17:00 → USA); świecę 12:00 licz do otwarcia Europy.

### Metryki na sesję (dla każdej doby, potem średnio z okna)

- **Zwrot sesji:** `close ostatniej świecy / open pierwszej − 1`. Sumuj lub uśredniaj zwroty z 14 dni osobno dla każdej sesji i porównaj, która sesja zbiera większość ruchu netto. Zwróć uwagę na rozdźwięk (np. "wzrost w Azji, oddawany w USA").
- **Zakres sesji:** `(high − low) / open`, średnio. Pokazuje, kiedy rynek jest najbardziej zmienny.
- **Udział wolumenu:** wolumen sesji / wolumen doby. Wskazuje, gdzie jest płynność.
- **Udział kupujących taker:** `Σbv / Σv` w sesji i `Σ(2·bv − v)` jako CVD sesji. Zestaw ze zwrotem: zwrot dodatni przy ujemnym CVD = wzrost bez popytu agresywnego (kruchy).
- **Zmiana OI w sesji:** `OI close ostatniej / OI open pierwszej − 1`. Zestaw z kwadrantem cena/OI (sekcja 3) osobno dla każdej sesji.
- **Likwidacje w sesji:** suma longów i shortów, i udział w dobowej sumie. Wskaż, w której sesji zwykle wypadają kaskady.
- **Funding na granicach sesji:** wartości z okien rozliczeń (na Binance co 8h: 00:00, 08:00, 16:00 UTC) - czy funding rośnie w jednej sesji i resetuje się w innej.

### Jak czytać wzorce

| Wzorzec | Interpretacja |
|---|---|
| Wzrost w Azji, oddany w Europie/USA | Ruch na cienkiej płynności bez potwierdzenia; typowa pułapka na longi; sprawdź, czy OI rośnie w Azji i spada w USA |
| Spadek w Azji, odbicie w USA | Popyt instytucjonalny/amerykański absorbuje podaż; sprzyja fazie akumulacji |
| USA dominuje zwrotem, wolumenem i dodatnim CVD | Zdrowy trend z płynnym poparciem |
| USA sprzedaje po danych makro | Reakcja na zmianę oczekiwań stóp; zestaw z wynikiem publikacji i rentownościami |
| Kaskady likwidacji koncentrują się w jednej sesji | To okno największego ryzyka squeeze; zaznacz je jako czas zwiększonej czujności |
| Największe wolumeny w nakładce Europa/USA | Płynność najwyższa, ruchy z tego okna są najbardziej wiarygodne |
| Cienka płynność w Azji + wysokie OI | Podatność na nagłe świece (knoty) w nocy czasu europejskiego |

### Ocena "bieżącej sesji"

Określ, w której sesji jesteśmy (na podstawie godziny z kontekstu, przeliczonej na UTC), i porównaj jej dotychczasowy przebieg z typowym profilem tej sesji z 14 dni (zwrot, zakres, udział kupujących). Odchylenie (np. dużo większy wolumen niż zwykle w Azji) to sygnał, że coś się zmienia - zestaw z wiadomościami.

### Powiązanie z kalendarzem makro

Dla każdej nadchodzącej publikacji z kalendarza zaznacz **w której sesji krypto wypadnie** (np. CPI o 8:30 ET = 12:30 UTC = Europa/nakładka) i jak w ostatnich 14 dniach zachowywał się rynek w tych godzinach (średni zakres, kierunek likwidacji). Pokazuje to, jak gwałtowna może być reakcja.

### Ograniczenia

- Sesje w krypto się nakładają i nie mają twardych granic - to uproszczenie do celów porównawczych.
- Podział opiera się na godzinie UTC, nie na tożsamości uczestników; zachowanie "Azji" to zachowanie rynku w godzinach azjatyckich, a nie dowód, że kupują konkretni gracze.
- 14 dni to niewielka próba - jedno wydarzenie (np. duża publikacja) potrafi zdominować statystykę sesji. Zaznacz dni wyjątkowe i, jeśli zniekształcają wynik, policz też z ich pominięciem.
- Dane Coinalyze dotyczą wybranych giełd; premie regionalne (np. koreańska) i przepływy ETF w godzinach USA nie są w MCP - jeśli mają znaczenie, wskaż je jako do sprawdzenia w sieci.
