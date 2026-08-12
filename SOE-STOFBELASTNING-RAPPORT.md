# Sø-stofbelastning — metode, verifikation og kendte begrænsninger

Dokumenterer beregningen bag `lake-substance-load.json` (kvælstof/fosfor/
COD/BOD) og `lake-mfs-load.json` (miljøfremmede stoffer), samt en fejl der
blev fundet og rettet 7. august 2026.

## Datakilder

| Data | Kilde | Script |
|---|---|---|
| N/P/COD/BOD per udløb | PULS' egne felter (`LatestDischargeCod/Bod/Nitrogen/Phosphor` + `LatestNormalDischarge*`) | `update-puls.js` |
| Udløb → sø-tilknytning | ID15-terrænmodel (opstrøms sporing via højdedata) | `scripts/id15/match-lakes-via-id15.js` + `resolve-canal-ambiguity.py` |
| Miljøfremmede stoffer, typetal | Miljøstyrelsen, *"Typetal for miljøfarlige forurenende stoffer i regnbetingede udledninger"* (2022) | `scripts/mst-typetal-mfs.json` |
| Volumen per udløb (bruges til MFS-beregning) | PULS' `LatestDischargeVolume`/`LatestNormalDischargeVolume` | `update-puls.js` |

## Metode

**N/P/COD/BOD**: PULS' egne indberettede mængder (kg/år) summeres direkte
per sø, opdelt på konkretår og normalår. Ingen omregning — tallene er
allerede i kg fra kilden.

**Miljøfremmede stoffer**: MST's nationale typetal (µg/l, gennemsnit for
regnbetingede overløb) ganges med hvert udløbs volumen (m³), klassificeret
efter kloaktype (fælles-/separatkloak, se `SewerStructure`-feltet):

```
belastning (mg) = typetal (µg/l) × volumen (m³)
belastning (kg) = belastning (mg) / 1.000.000
```

Se `scripts/id15/aggregate-lake-mfs-load.js` for fuld implementering.

### Er tallene baseret på fortyndet eller koncentreret spildevand?

**Fortyndet** — bekræftet i Miljøstyrelsens datatekniske anvisning
(DP02, "Regnbetingede udløb", version 4, januar 2024). Både PULS' egne
N/P/COD/BOD-indberetninger og MST's MFS-typetal er baseret på det faktiske
*overløbsvand* (blanding af regn- og spildevand), ikke ufortyndet
spildevand. DP02's Tabel 1 viser fx Tot-N på 43 mg/l i rent spildevand,
men kun 12 mg/l i det faktiske overløbsvand, der ligger til grund for
indberetningerne. Kilde:
https://mst.dk/media/bnkdidho/dta-dp02-rbu-version-4-2024.pdf

## Fejl fundet og rettet (7. august 2026)

**Symptom**: MFS-belastningstal (metaller, PAH, farmaceutiske stoffer
m.fl.) var alle **1.000× for høje**. Opdaget ved brugerinspektion af
Farum Sø, hvor Aluminium viste 1.224.369,6 kg — implausibelt højt.

**Rodårsag**: `aggregate-lake-mfs-load.js` beregnede
`sum.totalMg / 1000` (mg → **gram**) i stedet for `sum.totalMg / 1e6`
(mg → kg), men feltet var navngivet og vist som `belastningKg`.

**Rettelse**: `belastningKg: Math.round(sum.totalMg / 1e6 * 1e6) / 1e6`
(commit 7. august 2026). N/P/COD/BOD-tallene (andet script,
`aggregate-lake-substance-load.js`) var **ikke** ramt af denne fejl — de
summerer allerede-kg PULS-felter uden nogen omregning.

**VIGTIGT ved fremtidige rapporter fra brugere om "for høje tal"**: tjek
altid om `lake-mfs-load.json` reelt er regenereret (`node
scripts/id15/aggregate-lake-mfs-load.js`) og deployet efter en kode-
rettelse — en kode-rettelse alene ændrer intet, før den prækomputerede
JSON-fil er bygget på ny. Se "Diagnosemetode" nedenfor for hvordan man
hurtigt afgør om en visning er den gamle eller nye version.

## Fejl fundet og rettet (10. august 2026) — Saltbæk Vig

**Symptom**: Saltbæk Vig viste 70.332 m³ (konkretår) i
`lake-substance-load.json`, men brugeren (lokalkendskab) bekræftede at
vigen ikke modtager spildevand overhovedet.

**Rodårsag**: alle 9 matchede udløb kom udelukkende via ID15's
højdebaserede opstrøms-sporing (`viaOwnCatchment: 0, viaUpstream: 9`) —
ingen af de øvrige, uafhængige kilder (RBU, navnematch, strømretnings-
bekræftet vandløbsindløb, se badevand-risk.js's `computeVandlobInflowRec()`)
bekræftede noget som helst for denne sø. Saltbæk Vig blev diget af fra
Sejerø Bugt i 1873 og afvandes i dag via afvandingskanaler/pumpestation
UDENOM selve vigen, direkte til havet — en menneskeskabt hydrologi, som
ID15's rene terrænmodel (DEM) strukturelt ikke kan se, da den kun følger
naturlig højdehældning.

**Rettelse**: de 9 PULS-ID'er (1732, 6227, 16200, 18132, 18187, 4886,
10552, 11125, 15015) tilføjet til en ny `MANUAL_ENGINEERED_BYPASS_
EXCLUSIONS`-liste i `resolve-canal-ambiguity.py` (adskilt fra
`MANUAL_GEOMETRY_OVERRIDES`, som omfordeler til en nabosø — her er der
ingen recipient-sø overhovedet, udløbene ekskluderes helt). `id15-lake-
matches.json` (begge kopier) rettet direkte samtidig, og `lake-substance-
load.json`/`lake-mfs-load.json` regenereret — Saltbæk Vig optræder nu
korrekt slet ikke i nogen af de to rapporter (0 matchede udløb, samme
konvention som andre reelt tomme søer).

**VIGTIGT ved lignende fremtidige rapporter**: dette er IKKE en generel
ID15-svaghed, kun relevant for vandområder med bekræftet menneskeskabt
afvanding (dige/pumpestation/kanal), som en DEM pr. definition ikke kan
repræsentere. Brug IKKE denne sag som præcedens for at fjerne udløb uden
en konkret, bekræftet fysisk begrundelse — se MANUAL_GEOMETRY_OVERRIDES'
og MANUAL_ENGINEERED_BYPASS_EXCLUSIONS' egne filhoveder i
resolve-canal-ambiguity.py for hvornår hver af de to er relevante.

**Opfølgning samme dag**: da brugeren spurgte "hvor mange søer er
påvirket", viste et tjek af hvilke ANDRE søer der deler nogen af de
samme 9 PULS-ID'er, at "Mulen" (0,02 km²) og "Krageø Sø" (0,11 km²) —
to små damme lige ved Saltbæk Vigs nordkant, begge allerede nævnt i
vigens eget `stoppedAtLakes` — hver havde et ID15-match på 108 udløb
(identisk sæt for begge, `viaOwnCatchment: 0` for alle), som INKLUDEREDE
de samme 9. Brugeren bekræftede at begge ligger i samme digede reservat
og afvandes via samme kanal-/pumpestation-system. Tilføjet til samme
`MANUAL_ENGINEERED_BYPASS_EXCLUSIONS`, samme id15-lake-matches.json-
rettelse, samme regenerering. `lakeCount` i lake-substance-load.json:
640 → 639 (Saltbæk Vig) → 637 (Mulen + Krageø Sø). Alle tre optræder nu
korrekt slet ikke i nogen af de to rapporter.

**Metodenote til fremtidige lignende sager**: tjek ALTID om andre søer
deler udløb med den korrigerede sø (`id15-lake-matches.json`), særligt
hvis den korrigerede sø har et `stoppedAtLakes`-felt — ID15's opstrøms-
sporing rammer ofte flere navngivne vandområder i samme fysiske
afvandingskompleks, som kan dele nøjagtig samme underliggende
menneskeskabte hydrologi-fejl. Antag IKKE automatisk at delte udløb
betyder samme fejl (kan også være to reelt forbundne, begge-korrekte
søer) — bekræft altid geografi + den fysiske begrundelse pr. sø, som her.

## Diagnosemetode ved mistanke om forkerte tal

To uafhængige krydstjek, der ikke kræver kørsel af koden, kun regnestykker
på de viste tal:

1. **Implicit-volumen-konsistens**: to stoffer der KUN har typetal for
   samme kloaktype (fx Paracetamol og Ibuprofen, begge kun fælleskloak)
   skal give samme udledte volumen, når man dividerer belastning med
   typetal — uanset om enheden er kg eller gram, da forholdet er
   enheds-uafhængigt. Falder de ikke sammen, er der en regnefejl.
2. **Plausibilitets-tjek mod total volumen**: udledt volumen for en
   delmængde udløb (fx alle fælleskloak-klassificerede) skal være en
   *mindre andel* af søens totale, matchede volumen (fra N/P/COD/BOD-
   panelet) — aldrig større, og typisk ikke i nærheden af 100%, medmindre
   næsten alle udløb er af samme type.

## Verificeret eksempel: Farum Sø (efter rettelsen)

36 matchede udløb, 23 via eget opland (usikker), 13 via opstrøms
(sikker), kvalitetskoder 7/6/23/0 (reel/nul/estimeret/ingen).

| | Konkretår |
|---|---|
| Volumen | 885.253 m³ |
| COD | 59.214 kg |
| BOD | 8.074 kg |
| Kvælstof | 2.920 kg |
| Fosfor | 461,1 kg |
| Aluminium (MFS) | 1.224 kg |
| Zink (MFS) | 120 kg |
| Alkylbenzensulfonat (MFS) | 30,8 kg |

Krydstjekket via implicit-volumen-metoden (Paracetamol og Ibuprofen, begge
8/36-dækning) — begge gav 115,0 m³, som forventet.

## Kendte begrænsninger (ikke fejl, men vigtige forbehold)

- **Renseanlæg er IKKE inkluderet.** `update-puls.js` henter kun
  `puls:Regnbetingedeudloeb` (regnbetingede udløb/RBU) — det separate
  WFS-lag `puls:Renseanlaegudloeb` (renseanlægs kontinuerlige udledning,
  typisk langt større volumen end RBU) hentes ikke. Søer med et
  renseanlæg i oplandet vil derfor vise en **undervurderet** samlet
  belastning. Ikke bygget endnu — kræver nyt udtræksscript + ID15-matching
  + udvidet aggregering (se samtalehistorik for detaljer, hvis det skal
  bygges).
- **MFS-typetal gælder kun boligoplande.** MST's egne typetal er ikke
  retvisende for industri- eller trafiktunge oplande — ingen
  oplandskarakteristik-data findes til at identificere hvilke af de
  matchede udløb der afviger (undersøgt og bekræftet umuligt at hente via
  åben API, se samtalehistorik).
- **86 grupper af søer deler præcis samme udløbssæt** (delt ID15-
  terrænopland) — deres belastningstal er identiske og dækker reelt hele
  gruppen, ikke søen isoleret. Flaget i UI (`lakeSiblingNoteHtml()`), men
  ikke dedupliceret i selve dataene.
- **Datakvalitet varierer stærkt.** Kun ~14-19% af udløb har "reelle"
  (kvalitetskode 0) volumendata — resten er verificeret nul, estimeret,
  eller mangler helt. Se `check-stof-coverage.js` for dækningstjek.
- **Ingen flow-routing/henfald.** Belastningen er en rå sum af matchede
  udløb, ikke vægtet efter afstand eller rejsetid til søen, selvom
  `travelTimeHours` findes per udløb-sø-par i `id15-lake-matches.json`.

## Filer

- `scripts/mst-typetal-mfs.json` — typetal-opslag (76 stoffer)
- `scripts/id15/aggregate-lake-substance-load.js` — N/P/COD/BOD
- `scripts/id15/aggregate-lake-mfs-load.js` — miljøfremmede stoffer
- `lake-substance-load.json`, `lake-mfs-load.json` — output, deployet via
  Dockerfile `COPY`, serveret statisk, hentet client-side i
  `dansk-overloeb-kort.html` (`showLakeLoadPanel()`)
