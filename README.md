# PDF-arbetsbord

Lokalt, webbläsarbaserat PDF-verktyg. All bearbetning sker i din webbläsare.
Byggt på mupdf.js (WASM) och pdf-lib.

## Köra

```bash
npm install
npm run dev      # Vite på http://localhost:5173
```

(Windows/PowerShell: använd `npm.cmd` om skriptkörning är blockerad, eller kör
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` en gång.) Node 20+ krävs.

## Funktioner

- Öppna / slå ihop PDF:er
- Sortera om sidor (dra-och-släpp)
- Ta bort sidor
- Rotera enskilda sidor (appliceras direkt)
- Beskär sidor (CropBox)
- Permanent redaktion (raderas destruktivt vid export)
- Textläge: täck-och-ersätt samt infoga ny text
- Formulär: läs och fyll i AcroForm-fält
- Ångra (upp till 30 steg)
- Metadata-rensning vid export

## Ändringar i denna version

- **OCR borttaget.** Lade dubbla textlager på sidor som redan hade text och
  gjorde mer skada än nytta. Helt utplockat (även tesseract-beroendet).
- **Redaktion-efter-rotation fixat.** Rotation appliceras nu DIREKT på
  dokumentet och sidan renderas om, så redaktioner/crop ritas alltid på den
  sida du faktiskt ser. Rotation rensar sidans befintliga redaktioner/crop/text
  eftersom deras koordinater inte längre gäller efter vridning.
- **Ångra tillagt.** Tar ögonblicksbilder före varje ändring; rotation backas
  med en invers rotation i workern.
- **Textläge tillagt.** Rita en ruta, skriv text — ytan täcks med vitt och
  texten läggs ovanpå som permanent sidinnehåll (via pdf-lib).

## Verifieringsstatus (ärlig)

Verifierat med körda tester (Node, mupdf 1.27.0, pdf-lib 1.17.1):

- Redaktion raderar permanent (borta ur textlager + råbytes).
- Rotation/crop persisterar; rotation följs av rendering så koordinater stämmer.
- Textläge (täck-och-ersätt) ger korrekt täckt + ny text som permanent innehåll.
- Kombination redaktion + text i samma export fungerar.
- Exportkedjan mappar textredigeringar till RÄTT sida även efter omsortering
  och radering (verifierat med 3-sidigt testfall).
- Bygger rent (vite build, 200 moduler).

INTE verifierat (kräver webbläsare):

- DOM-interaktioner: dra-och-släpp, ritning, ångra-knapp, textläge-prompt,
  formulärpanel, rotationsknappar.
- Prestanda på stora dokument.

## Kända begränsningar / medvetna avgränsningar

- **Textläget redigerar INTE befintlig text in-place.** Det täcker över och
  skriver nytt. Befintlig text kan ligga kvar i textlagret under den vita rutan
  (till skillnad från redaktion, som raderar). Detta är ett medvetet val —
  äkta in-place-redigering kräver parsning av content streams och fonthantering
  som varken pdf-lib eller mupdf.js stödjer enkelt.
- **Text infogas med Helvetica**, oavsett sidans originalfont. Matchar inte
  alltid omgivande text typografiskt.
- **Rotation rensar sidans redaktioner/crop/text.** Rita dem efter att du
  roterat klart.
- Formulärfältnamn kan komma tomt (namn på AcroForm-förälder); värdet fylls
  ändå i.
- Stora dokument är minnestunga (WASM frigörs manuellt i workern).

## Arkitektur

- src/pdf-worker.js — mupdf/WASM i Web Worker (load, append, renderPage,
  rearrange, redact, rotate, crop, getForm, fillForm, export).
- src/app.js — UI, koordinattransformer, ångra-historik, textläge (pdf-lib),
  worker-protokoll.
- index.html — skal + stil.

### Exportordning

I workern: redaktion → crop → rearrange → metadata-rensning + spara.
(Rotation är redan applicerad.) Därefter pdf-lib-steg: textredigeringar
(täck-och-ersätt + ny text) på de behållna sidorna i ny ordning.

## Publicera på GitHub Pages (för att dela via länk)

Appen kan hostas så att en kollega bara klickar på en länk — ingen
installation behövs hos dem. Dokumenten bearbetas fortfarande helt lokalt i
kollegans webbläsare; bara själva app-koden hämtas från GitHub.

Engångsuppsättning:

1. Skapa ett GitHub-repo och pusha projektet dit (mappen som innehåller
   package.json). `.github/workflows/deploy.yml` följer med.
2. Gå till repo → **Settings → Pages** och välj **GitHub Actions** som källa
   (Source).
3. Pusha till `main` (eller kör arbetsflödet manuellt under fliken Actions).
   Bygget körs automatiskt.
4. När det är klart ligger appen på
   `https://<ditt-användarnamn>.github.io/<repo-namn>/` — det är länken du
   delar.

Vid varje framtida push till `main` byggs och deployas appen om automatiskt.

Teknisk not: `vite.config.js` läser `VITE_BASE` (satt av arbetsflödet till
repo-namnet) så att asset-, worker- och WASM-sökvägar pekar rätt i Pages
underkatalog. Lokalt (`npm run dev`) används `/` som vanligt.
