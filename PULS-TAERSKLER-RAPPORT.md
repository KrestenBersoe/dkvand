# PULS-udløb — empirisk nedbørstærskel-rapport

Genereret: 2026-07-20T18:27:20.411Z

## Metode

- **Akkumuleringsmodel**: samme rullende, eksponentielt henfald som resten af
  appen (τ=3 dage, `riskModel.accumulateDecayed()`, delt med `server.js`'
  `antecedentMM`).
- **Hændelseskollaps**: 5 timer (Miljøstyrelsen/IDA
  Spildevandskomitéen 2022-materiale), anvendt direkte på den akkumulerede serie.
- **Datavindue**: 2023-01-01 – 2026-07-15.

## Faktiske gruppeandele (21.600 udløb i alt)

| Gruppe | Andel | Antal |
|---|---|---|
| Gruppe 1 (qualityCode=0, reelle hændelsestal) | 14.4% | 3.106 |
| Gruppe 2 (qualityCode=2, estimeret fra volumen) | 50.1% | 10.816 |
| Uden for scope: qualityCode=1 (verificeret nul) | 32.0% | 6.912 |
| Uden for scope: qualityCode=3 (ingen data) | 3.5% | 766 |

Bemærk: opgavebeskrivelsens antagelse om "~22% gruppe 1" holder ikke —
faktisk andel er 14.4%.

## Resultat

- 2601 udløb fik en DIREKTE udledt tærskel (Opgave A).
- 10816 udløb fik en LÅNT tærskel (Opgave B) — sporbar via `donorOutletIds`.
- 505 udløb blev udeladt (se `meta.excludedOutlets` for navngivne årsager pr. udløb — ingen stille fald-tilbage).

## Integration i den live risikomodel

Disse tærskler bruges rent faktisk af appen, ikke kun en stående beregning:
`scripts/merge-puls-thresholds.js` (Trin 4 i `update-all-data.sh`) fletter
tærsklen ind som `puls-data.json`'s `row[24]` (RETTET 2026-08-20 — stod
oprindeligt på row[13], som en senere udvidelse af update-puls.js's skema
kolliderede med, se filens egen kommentar), for udløb med tillidsgrad
`high`, `medium` eller `borrowed` (IKKE `low` — kun 3-4 hændelser bag
tallet er for usikkert til produktion). `risk-model.js`' og
`dansk-overloeb-kort.html`'s `computeIntensityFactor()` centrerer derefter
den bakterielle/virale risikosigmoide på udløbets EGEN tærskel i stedet for
den tidligere generiske, flade 25mm-antagelse — udløb uden en tilstrækkeligt
sikker tærskel (`low`-tillidsgrad eller slet ingen) falder fortsat tilbage
til den generiske 25mm-model, uændret.

_RETTELSE (2026-08-20): denne rapport blev genereret før 2026-07-30-
kalibreringen, der hævede den generiske fallback fra 5mm til 25mm — teksten
ovenfor er efterfølgende opdateret manuelt til at afspejle det, uden en fuld
gen-kørsel af beregningen. Tallene i tabellerne ovenfor (gruppeandele,
validering) er derimod uændrede og stammer fra den oprindelige kørsel
20. juli 2026 — se afsnittet "Sammenhæng med row[13]/cod-bugfixet" i
samtalen for hvorfor disse tal ikke nødvendigvis matcher den aktuelle,
live `puls-data.json` 1:1._

## Validering

**Intern reproduktion** (Opgave A — IKKE prædiktiv, se begrundelse i output-metadata):
median afvigelse 7 hændelser (n=530).

**Lånevalidering** (Opgave B — den reelle, ærlige måling): median afvigelse
13.8%, gennemsnit 20.1%
(n=530).

## Kendte begrænsninger

1. **Ingen daterede enkelthændelser findes i PULS** — kun ét årligt
   hændelsestal pr. udløb. Al validering er derfor på årligt niveau, ikke
   datopræcision.
2. **Kun ét reelt hændelsesår pr. udløb** — "LatestNormalDischargeYear" er
   samme kalenderår som "LatestDischargeYear", ikke en uafhængig 2. årgang.
   Multi-års-robusthed opnås ved at genanvende samme N på flere års
   nedbørsdata, ikke ved at poole flere års reelle hændelsestal.
3. **SewerStructure-koderne (SE/OS/OF m.fl.) er udokumenterede** — det
   selvforklarende `Type`-fritekstfelt bruges i stedet til
   kloaktype-tie-break.
4. **Peak-kollaps på den akkumulerede (henfaldede) serie** kan i sjældne
   tilfælde tælle en kraftig hændelses langsomt henfaldende hale som en
   selvstændig "ny" peak mere end 5 timer
   efter selve hændelsen — se kommentar i toppen af
   `compute-puls-udloeb-taerskler.js`.
