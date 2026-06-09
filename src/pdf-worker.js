// PDF-operationer körs i en Web Worker så att den tunga WASM-motorn (~10 MB)
// inte blockerar UI-tråden. Allt mupdf-arbete sker här.
//
// VIKTIGT om minne: mupdf.js använder WASM-minne som INTE garbage-collectas
// automatiskt. Varje Page/Pixmap/Buffer måste .destroy()-as explicit, annars
// läcker minnet snabbt när man bläddrar i stora dokument. Vi är disciplinerade
// med det nedan.

import * as mupdf from 'mupdf'

// Vi håller exakt ETT aktivt dokument i workern. All state lever här.
let doc = null

// --- Hjälpare ----------------------------------------------------------------

// Rendera en sida till en PNG-blob vid given skala. Anroparen äger bytes:en.
function renderPageToPNG(pageIndex, scale) {
  const page = doc.loadPage(pageIndex)
  let pixmap = null
  try {
    pixmap = page.toPixmap(
      mupdf.Matrix.scale(scale, scale),
      mupdf.ColorSpace.DeviceRGB,
      false, // ingen alfa
      true   // rita på vit bakgrund
    )
    // asPNG() ger en vy mot WASM-heapen. Vi MÅSTE kopiera (.slice()) innan
    // finally-blocket kör pixmap.destroy(), annars frigörs minnet vyn pekar på.
    // Den kopierade bufferten är dessutom transferable, till skillnad från vyn.
    const png = pixmap.asPNG().slice()
    const bounds = page.getBounds() // [x0,y0,x1,y1] i PDF-punkter (origo nedre-vänster)
    return {
      png,
      width: pixmap.getWidth(),
      height: pixmap.getHeight(),
      pdfWidth: bounds[2] - bounds[0],
      pdfHeight: bounds[3] - bounds[1],
    }
  } finally {
    if (pixmap) pixmap.destroy()
    page.destroy()
  }
}

// Antal sidor just nu.
function pageCount() {
  return doc.countPages()
}

// --- Meddelandehantering -----------------------------------------------------

self.onmessage = async (e) => {
  const { id, type, payload } = e.data
  try {
    let result
    switch (type) {
      case 'load': {
        // payload.bytes: ArrayBuffer från användarens fil
        if (doc) { doc.destroy(); doc = null }
        const bytes = new Uint8Array(payload.bytes)
        doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf')
        result = { pageCount: doc.countPages() }
        break
      }

      case 'append': {
        // Slå ihop: grafta in alla sidor från en andra PDF i slutet.
        const bytes = new Uint8Array(payload.bytes)
        const other = mupdf.PDFDocument.openDocument(bytes, 'application/pdf')
        try {
          const n = other.countPages()
          for (let i = 0; i < n; i++) {
            doc.graftPage(-1, other, i)
          }
        } finally {
          other.destroy()
        }
        result = { pageCount: doc.countPages() }
        break
      }

      case 'renderPage': {
        const { pageIndex, scale } = payload
        const r = renderPageToPNG(pageIndex, scale)
        // Skicka PNG som transferable så vi slipper kopiera bytes:en.
        self.postMessage(
          { id, ok: true, result: r },
          [r.png.buffer]
        )
        return // redan postat med transfer
      }

      case 'rearrange': {
        // payload.order: array med de ursprungliga sidindex som ska behållas,
        // i ny ordning. Hanterar både omsortering OCH radering i ett svep.
        doc.rearrangePages(payload.order)
        result = { pageCount: doc.countPages() }
        break
      }

      case 'redact': {
        // payload.redactions: [{ pageIndex, rects: [[x0,y0,x1,y1], ...] }]
        // Rektanglar anges i PDF-punkter, origo NEDRE-vänster (PDF native).
        // mupdf:s setRect förväntar sig dock MuPDF-koordinater (origo ÖVRE-
        // vänster). UI-tråden gör konverteringen innan den skickar hit, så
        // här antar vi redan MuPDF-koordinater. Se kommentar i app.js.
        for (const { pageIndex, rects } of payload.redactions) {
          const page = doc.loadPage(pageIndex)
          try {
            for (const rect of rects) {
              const annot = page.createAnnotation('Redact')
              annot.setRect(rect)
              annot.update()
            }
            page.applyRedactions()
          } finally {
            page.destroy()
          }
        }
        result = { redacted: true }
        break
      }

      case 'rotate': {
        // payload: { pageIndex, delta } där delta är +90 eller -90 (grader medurs).
        // mupdf.js saknar setRotation; vi sätter /Rotate-nyckeln på sidobjektet.
        const page = doc.loadPage(payload.pageIndex)
        try {
          const obj = page.getObject()
          let cur = 0
          const r = obj.get('Rotate')
          if (r && typeof r.asNumber === 'function') cur = r.asNumber()
          else if (typeof r === 'number') cur = r
          let next = ((cur + payload.delta) % 360 + 360) % 360
          obj.put('Rotate', next)
        } finally {
          page.destroy()
        }
        result = { ok: true }
        break
      }

      case 'crop': {
        // payload: { pageIndex, box: [x0,y0,x1,y1] } i MuPDF-punkter (origo övre-vänster).
        const page = doc.loadPage(payload.pageIndex)
        try {
          page.setPageBox('CropBox', payload.box)
        } finally {
          page.destroy()
        }
        result = { ok: true }
        break
      }

      case 'getForm': {
        // Läs alla formulärfält på alla sidor.
        const fields = []
        const n = doc.countPages()
        for (let i = 0; i < n; i++) {
          const page = doc.loadPage(i)
          try {
            const widgets = page.getWidgets()
            for (let wi = 0; wi < widgets.length; wi++) {
              const w = widgets[wi]
              let type = 'unknown', name = '', value = '', options = null
              try { type = w.getFieldType() } catch (_) {}
              try { name = w.getName() } catch (_) {}
              try { value = w.getValue() } catch (_) {}
              if (type === 'combobox' || type === 'listbox') {
                try { options = w.getOptions(false) } catch (_) {}
              }
              fields.push({ pageIndex: i, widgetIndex: wi, type, name, value, options })
            }
          } finally {
            page.destroy()
          }
        }
        result = { fields }
        break
      }

      case 'fillForm': {
        // payload: { values: [{ pageIndex, widgetIndex, value }] }
        // Gruppera per sida så vi laddar varje sida en gång.
        const byPage = new Map()
        for (const v of payload.values) {
          if (!byPage.has(v.pageIndex)) byPage.set(v.pageIndex, [])
          byPage.get(v.pageIndex).push(v)
        }
        for (const [pageIndex, vals] of byPage) {
          const page = doc.loadPage(pageIndex)
          try {
            const widgets = page.getWidgets()
            for (const v of vals) {
              const w = widgets[v.widgetIndex]
              if (!w) continue
              const type = w.getFieldType()
              if (type === 'checkbox' || type === 'radiobutton') {
                // toggle till önskat läge: värdet "on"/"off"
                const isOn = w.getValue() && w.getValue() !== 'Off'
                const wantOn = v.value === 'on' || v.value === true || v.value === 'true'
                if (isOn !== wantOn) w.toggle()
              } else if (type === 'combobox' || type === 'listbox') {
                w.setChoiceValue(v.value)
              } else {
                w.setTextValue(v.value)
              }
              w.update()
            }
          } finally {
            page.destroy()
          }
        }
        result = { ok: true }
        break
      }

      case 'export': {
        // Rensa identifierande metadata före export.
        for (const key of ['info:Author', 'info:Creator', 'info:Producer',
                            'info:Title', 'info:Subject', 'info:Keywords']) {
          try { doc.setMetaData(key, '') } catch (_) { /* nyckel kanske saknas */ }
        }

        // Säker sparning: 'garbage' kör garbage collection av oanvända objekt.
        // Efter applyRedactions kan dokumentet ändå INTE sparas inkrementellt
        // (mupdf vägrar), vilket är precis vad vi vill — ingen gammal version
        // ligger kvar i filen. 'sanitize' rensar dessutom redundanta operationer.
        const buf = doc.saveToBuffer('garbage=compact,sanitize,compress')
        // asUint8Array() ger en vy mot WASM-heapen, som INTE är transferable.
        // .slice() kopierar till en fristående ArrayBuffer som går att överföra.
        const out = buf.asUint8Array().slice()
        buf.destroy()
        self.postMessage(
          { id, ok: true, result: { bytes: out } },
          [out.buffer]
        )
        return
      }

      default:
        throw new Error(`Okänd operation: ${type}`)
    }
    self.postMessage({ id, ok: true, result })
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) })
  }
}
