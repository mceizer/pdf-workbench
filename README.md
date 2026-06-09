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

- **Redaktion-efter-rotation fixat.** Rotation appliceras nu DIREKT på
  dokumentet och sidan renderas om, så redaktioner/crop ritas alltid på den
  sida du faktiskt ser. Rotation rensar sidans befintliga redaktioner/crop/text
  eftersom deras koordinater inte längre gäller efter vridning.
- **Ångra tillagt.** Tar ögonblicksbilder före varje ändring; rotation backas
  med en invers rotation i workern.
- **Textläge tillagt.** Rita en ruta, skriv text — ytan täcks med vitt och
  texten läggs ovanpå som permanent sidinnehåll (via pdf-lib).

## Verifieringsstatus 

Verifierat med körda tester (Node, mupdf 1.27.0, pdf-lib 1.17.1):

- Redaktion raderar permanent (borta ur textlager + råbytes).
- Textläge (täck-och-ersätt) ger korrekt täckt + ny text som permanent innehåll.
- Kombination redaktion + text i samma export fungerar.
- Exportkedjan mappar textredigeringar till RÄTT sida även efter omsortering
  och radering

## Kända begränsningar / medvetna avgränsningar

- **Textläget redigerar INTE befintlig text in-place.** Det täcker över och
  skriver nytt. Befintlig text kan ligga kvar i textlagret under den vita rutan
  (till skillnad från redaktion, som raderar).
- **Text infogas med Helvetica**, oavsett sidans originalfont. Matchar inte
  alltid omgivande text typografiskt.
- **Rotation rensar sidans redaktioner/crop/text.** Rita dem efter att du
  roterat klart.

## Arkitektur

- src/pdf-worker.js — mupdf/WASM i Web Worker (load, append, renderPage,
  rearrange, redact, rotate, crop, getForm, fillForm, export).
- src/app.js — UI, koordinattransformer, ångra-historik, textläge (pdf-lib),
  worker-protokoll.
- index.html — skal + stil.
