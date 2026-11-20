# Implementierungsplan: Octopus-Tageswerte für Charts

Ziel: Pro Kennzahl eine feste ID und pro abgeschlossenem Berliner Kalendertag
einen historischen Punkt. Quelle sind die vorhandenen Octopus-Tageswerte unter
`history.JJJJ.MM.TT.octopus`. Es werden keine Kosten neu berechnet.

| Serie (relativ zur Instanz) | Quelle im Tagesordner | Einheit |
| --- | --- | --- |
| `octopus.daily.consumption` | `dailyConsumption` | kWh |
| `octopus.daily.cost` | `totalCost` | € brutto |
| `octopus.daily.tariff.<slot>.consumption` | Verbrauch des Tariffensters, z. B. GO oder STANDARD | kWh |
| `octopus.daily.tariff.<slot>.cost` | Kosten desselben Tariffensters | € brutto |
| `octopus.daily.enwg.<st/nt/ht>.consumption` | verfügbarer §14a-Verbrauch | kWh |
| `octopus.daily.enwg.<st/nt/ht>.costGross` | zugehörige Bruttokosten | € brutto |

Tarifnamen aus den Tagesdaten übernehmen, nicht auf GO und STANDARD beschränken.
Kein Netto-, Grundgebühr-, Vergleichs- oder Inexogy-Tagesexport. Bestehende
Tagesordner und der bisherige 15-Minuten-Export bleiben unverändert.

1. Für InfluxDB, SQL und History verifizieren, wie einzelne Punkte am selben
   Zeitstempel sicher ersetzt oder entfernt und Fehler erkannt werden.
2. Separaten Tagesexport-Schalter (Standard: aus) für das bisherige Datenbankziel
   ergänzen. Serien einmal registrieren; historische Punkte mit dem Beginn des
   Verbrauchstags in Europe/Berlin schreiben, ohne einen weiteren Punkt zur
   aktuellen Uhrzeit zu erzeugen.
3. Bei Aktivierung vorhandene Tage innerhalb der lokalen Aufbewahrungsfrist in
   begrenzten Paketen nachtragen, ohne API-Abruf oder Neuberechnung. Anschließend
   neue oder korrigierte Tageswerte nach der Verarbeitung abgleichen.
4. Pro Ziel, Serie und Tag erfolgreiche Exporte persistent verfolgen. Unverändertes
   überspringen, Änderungen am ursprünglichen Zeitstempel ersetzen, ungültig
   gewordene Punkte entfernen. Fehlende Werte nicht als null Euro oder null kWh
   exportieren; echte Nullwerte erhalten. Fehlgeschlagene Exporte erneut versuchen.
5. Abnahme: Chartwerte gegen Tagesordner prüfen; keine Duplikate nach Intervall
   oder Neustart. Nachtrag, Tarifwechsel, §14a ein/aus, fehlende Preise,
   Datenbankausfall, Korrekturen und beide Zeitumstellungen testen. Bei Umsetzung
   Einstellungen und Beispiel-IDs in README und WIP-Changelog dokumentieren.
