# Szablon raportu (po polsku)

Trzymaj się tej kolejności. Krótko: werdykt na górze, szczegóły niżej. Każda godzina podana w UTC i w czasie polskim.

---

## Werdykt (3 zdania)

Jeden z: **brak nowych katalizatorów** / **katalizator niepotwierdzony** / **katalizator potwierdzony, nie wyceniony** / **katalizator potwierdzony, wyceniony** / **sprzeczne źródła**. Dodaj najważniejszy powód i jedno zdanie o związku z pozycją użytkownika (opisowo, bez poleceń).

## Przejrzane źródła

Skąd i do kiedy: vault (`raw/x/<data>`, ostatni `fetched_at`), narzędzia X (jeśli były), wyszukiwanie w sieci, przeglądarka. Liczba postów i konta. Jeśli któreś narzędzie nie odpowiedziało, napisz to.

## Zdarzenia

| Czas UTC / PL | Źródło (kategoria) | Twierdzenie (parafraza) | Pewność | Reakcja rynku | Związek z pozycją |
|---|---|---|---|---|---|

Reakcja rynku: relacja czasowa (przed/po/brak) i liczby (zwrot świecy, wolumen względem normy, Brent/DXY/ZN w tych samych świecach).

## Niewyjaśnione ruchy

Ruchy rynku bez pasującego posta w oknie: czas, skala, co się działo na ropie, dolarze i obligacjach, hipotezy oznaczone jako niepotwierdzone.

## Sprzeczności

Gdzie źródła się różnią lub nagłówek jest sprzeczny z ceną (np. spóźniony nagłówek). Kto co twierdzi.

## Luki w pokryciu

Co nie zostało sprawdzone i dlaczego: konta wyłączone, posty w innych językach, Truth Social, limit budżetu, brak narzędzia, brak drugiego źródła.

## Co obserwować w najbliższych godzinach

2-4 punkty z progami (np. komunikat Białego Domu, Brent powyżej X, kontrakt ZN poniżej Y) i wydarzenia z kalendarza, które mogą zmienić obraz.

*Analiza informacji, nie porada inwestycyjna.*

---

## Jeśli użytkownik prosi o zapis w wiki (Ingest)

1. Przeczytaj `CLAUDE.md` w vaultcie i `wiki/log.md` (ostatni ingest).
2. Przetwórz tylko pliki `raw/x/` nowsze od ostatniego wpisu. Każdy czytaj raz.
3. Wiele postów o tym samym zdarzeniu = jedna strona w `wiki/events/YYYY-MM-DD-slug.md`. Reakcję rynku dołącz z narzędzi rynkowych.
4. Uaktualnij strony `actors/`, `people/`, `places/`, `themes/`, `markets/`, `sources/`; wszystko po angielsku, z `[[slug]]`, cytatem źródła i pewnością.
5. Dopisz wpisy do `wiki/timeline.md` (najnowsze na górze) i `wiki/index.md`.
6. Zakończ wpisem w `wiki/log.md`: data, liczba i zakres źródeł, strony utworzone i zaktualizowane, trzy zdania podsumowania.
7. Nie edytuj `raw/`. Sugestie zmian w `x-accounts.json` zapisz w `wiki/sources/<konto>.md`, nie zmieniaj pliku.
