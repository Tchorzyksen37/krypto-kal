# Domykanie braków danych (generyczne polecenia)

Uruchom po kroku 2b, przed raportem. Dla każdej kategorii z listy wykonaj polecenie z kolumny "Polecenie"; dopiero gdy nie dało wyniku, zapisz brak w sekcji 6 raportu razem z tym, co próbowałeś. Placeholdery: `<DATA>` = dzisiejsza data, `<AKTYWO>` = analizowane aktywo (BTC, ETH...), `<MIESIĄC>` = bieżący miesiąc i rok, `<NASTĘPNE_FOMC>` = miesiąc najbliższego posiedzenia Fed (z kalendarza).

Zasady: bierz wartość z najnowszego punktu źródła i dopisz jego datę. Jeśli data punktu jest starsza niż 48 h, uznaj to za brak. Dane z wyszukiwarki z innego roku niż bieżący odrzuć. Nigdy nie wstawiaj liczby z pamięci.

| Brak | Polecenie | Jak użyć wyniku |
|---|---|---|
| Fear & Greed | `WebFetch https://api.alternative.me/fng/?limit=7` (wartość, etykieta, znacznik czasu; 7 punktów daje kierunek). Zapasowo `WebSearch "crypto fear and greed index today"` z `allowed_domains: ["alternative.me"]` | wartość + etykieta + zmiana vs 7 dni |
| Przepływy ETF (BTC, ETH) | `WebSearch "spot bitcoin ETF flows <DATA>"` (analogicznie `ether`); zapasowo `WebFetch https://farside.co.uk/btc/` i `.../eth/` | netto z ostatnich 3-5 dni sesyjnych, osobno dzień ostatni; oznacz, że publikacja jest po zamknięciu USA |
| Dominacja BTC | `WebFetch https://api.coingecko.com/api/v3/global` (pole `market_cap_percentage.btc`); zmiana: porównaj z wartością sprzed kilku dni z `WebSearch "bitcoin dominance <DATA>"` | rosnąca dominacja przy spadkach = ucieczka z altów |
| Premia koreańska i amerykańska | Korea: `WebFetch https://api.upbit.com/v1/ticker?markets=KRW-<AKTYWO>` (`trade_price`) oraz `yahoo_quote` dla `KRW=X`; premia = `trade_price / kurs KRW=X / cena globalna (market_view, close) - 1`. USA: `kraken_ticker` lub `WebFetch https://api.exchange.coinbase.com/products/<AKTYWO>-USD/ticker` wobec ceny z Coinalyze | podaj % i godzinę; to sygnał pomocniczy, nie warunek |
| Wycena stóp (FedWatch) | `WebFetch https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html`; jeśli strona dynamiczna nie zwróci liczb: `WebSearch "CME FedWatch <NASTĘPNE_FOMC> probabilities <DATA>"` | prawdopodobieństwa dla najbliższego i następnego posiedzenia; zaznacz, czy źródłem jest CME, czy agregator |
| Konsensus publikacji z kalendarza (CPI, PPI, sprzedaż detaliczna, payrolls...) | dla każdej pozycji z kalendarza: `WebSearch "<publikacja> consensus forecast <MIESIĄC>"`; poprzednią wartość weź z `WebSearch "<publikacja> previous release"` albo ze strony BLS/BEA | uzupełnij kolumny "Poprzednio" i "Prognoza"; przy rozbieżności źródeł podaj widełki |
| Prognozy instytucji dla ropy | `WebSearch "EIA short-term energy outlook <MIESIĄC> Brent forecast"`, `WebSearch "Goldman Sachs Brent forecast <MIESIĄC>"`, `WebSearch "OPEC monthly oil market report <MIESIĄC>"` | źródło + horyzont + wartość; rozrzut między instytucjami |
| Zamknięcia indeksów (nie śróddzienne) | `yahoo_history` z `interval: "1d"`, `limit: 6` dla `^GSPC ^IXIC ^DJI ^VIX DX-Y.NYB ^TNX CL=F BZ=F GC=F`; weź ostatni domknięty słupek (kolumna stanu/otwarcia w nagłówku) | zamknięcie i zmiana z 5 sesji; `yahoo_quote` tylko do bieżącego poziomu z oznaczeniem `fresh`/`stale` |
| Klastry likwidacji | `coinalyze_liquidation_heatmap_estimate` dla `<AKTYWO>USDT_PERP.A`, `interval: "4hour"`, `limit: 500` | zawsze jako ESTIMATE: 2-3 najbliższe klastry nad i pod ceną; nie mieszaj z danymi zmierzonymi |
| Opcje (max pain, wygasania, skew) | `WebFetch https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=<AKTYWO>&kind=option` (open interest per seria; max pain policz z OI calls i puts dla najbliższego wygasania); zapasowo `WebSearch "<AKTYWO> options expiry <DATA> max pain"` | najbliższe duże wygasanie (data, notional) i max pain; dopisz do kalendarza; MCP krypto-kal nie ma danych opcji |
| Rozbicie 14 dni po sesjach | `coinalyze_ohlcv_history`, `coinalyze_open_interest_history`, `coinalyze_liquidation_history` dla `<AKTYWO>USDT_PERP.A`, `interval: "1hour"`, `limit: 336`, `format: "raw"`; policz sekcję 9 playbooka (przypisanie świec do sesji w Europe/Warsaw, zwrot, zakres, udział kupujących, zmiana OI, likwidacje). Obliczenia zrób skryptem w katalogu tymczasowym, nie w repozytorium | wypełnij tabelę sesji w raporcie; dni wyjątkowe oznacz i policz też bez nich |
| Wydarzenia nadchodzące w 14 dniach (rozszerzenie kalendarza) | `WebSearch "economic calendar next week <DATA>"`, `WebSearch "FOMC minutes release date <MIESIĄC>"`, `WebSearch "Treasury auction schedule 10-year 30-year <MIESIĄC>"` | uzupełnij tabelę kalendarza o pozycje, których brakowało |

## Kolejność i koszt

1. Najpierw tanie, deterministyczne źródła (API przez `WebFetch`, narzędzia MCP), potem `WebSearch`.
2. Niezależne polecenia wysyłaj równolegle w jednej turze; limit Coinalyze (40 wywołań na minutę, każdy symbol osobno) obowiązuje dalej.
3. `WebSearch` w trybie `standard`; `extended` tylko, gdy `standard` zwrócił dane z innej daty lub nic.
4. Gdy API zwróci błąd albo format inny niż oczekiwany, nie zgaduj pól: zanotuj błąd w sekcji 6 i przejdź do zapasowego polecenia z tabeli.

## Co zostaje w sekcji 6

Tylko to, czego mimo powyższych poleceń nie dało się ustalić. Format wiersza: `<brak> - próbowano: <polecenie>; wynik: <błąd / dane sprzed X>`. Dodatkowo zawsze wpisz rzeczy z natury niedostępne w MCP (rzeczywiste poziomy likwidacji, zamiary dużych graczy, spoofing w księdze).
