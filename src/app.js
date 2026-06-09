// UI-tråden. Talar med pdf-worker.js via ett litet request/response-protokoll.
//
// KOORDINATSYSTEM — den största fällan i appen. Tre system:
//   1. Skärm/canvas:  pixlar, origo ÖVRE-vänster, y nedåt.
//   2. PDF native:    punkter, origo NEDRE-vänster, y uppåt (getBounds, pdf-lib).
//   3. MuPDF API:     punkter, origo ÖVRE-vänster, y nedåt (setRect/setPageBox).
//
// Canvas och MuPDF delar origo → redaktion/crop behöver bara skalning, ingen
// y-flip. Textläget går via pdf-lib (origo NEDRE-vänster) och kräver y-flip där.
//
// ROTATION: appliceras DIREKT på workerns dokument när användaren klickar, och
// sidan renderas om. Då ritas alla efterföljande redaktioner/crop på den sida
// användaren faktiskt ser — vilket fixar buggen där redaktioner hamnade fel
// efter rotation. Rotation rensar därför sidans befintliga redaktioner/crop
// (deras koordinater gäller inte längre efter vridning).

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const RENDER_SCALE = 1.5

// --- Worker-protokoll --------------------------------------------------------

const worker = new Worker(new URL('./pdf-worker.js', import.meta.url), { type: 'module' })
let reqId = 0
const pending = new Map()
worker.onmessage = (e) => {
  const { id, ok, result, error } = e.data
  const p = pending.get(id); if (!p) return
  pending.delete(id)
  ok ? p.resolve(result) : p.reject(new Error(error))
}
function call(type, payload, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++reqId
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, type, payload }, transfer)
  })
}

// --- App-state ---------------------------------------------------------------

// Varje sida: srcIndex (index i workerns dok), markedDelete, redactions[],
// crop, rotation (för visning/Display), textEdits[] (pdf-lib, appliceras vid export).
let pages = []
let mode = 'none' // 'none' | 'redact' | 'crop' | 'text'
let busy = false

const $ = (id) => document.getElementById(id)
const statusEl = $('status'), gridEl = $('grid'), emptyEl = $('empty')

function setStatus(t) { statusEl.textContent = t }
function setBusy(b) {
  busy = b
  document.querySelectorAll('button, label.filebtn').forEach(el => {
    if (el.id === 'btnExport') el.disabled = b || pages.length === 0
    else if (el.id === 'btnUndo') el.disabled = b || history.length === 0
    else if (el.tagName === 'BUTTON') el.disabled = b
  })
}
function freshPage(srcIndex) {
  return { srcIndex, markedDelete: false, redactions: [], crop: null, rotation: 0, textEdits: [] }
}

// --- Ångra-historik ----------------------------------------------------------
// Vi tar en djup ögonblicksbild av `pages` före varje förändring. Rotation
// muterar workern, så dess ångra kräver en invers rotate (hanteras särskilt).

const history = []
const MAX_HISTORY = 30

function snapshot() {
  // Spara nuvarande tillstånd + ev. inversa worker-kommandon för att backa.
  const snap = {
    pages: pages.map(p => ({
      ...p,
      redactions: p.redactions.map(r => ({ ...r })),
      crop: p.crop ? { ...p.crop } : null,
      textEdits: p.textEdits.map(t => ({ ...t })),
    })),
    inverse: null, // ev. { type, payload } som backar en worker-mutation
  }
  history.push(snap)
  if (history.length > MAX_HISTORY) history.shift()
  updateUndoBtn()
}
function setInverse(cmd) {
  if (history.length) history[history.length - 1].inverse = cmd
}
function updateUndoBtn() {
  $('btnUndo').disabled = busy || history.length === 0
}

async function undo() {
  if (history.length === 0) return
  const snap = history.pop()
  if (snap.inverse) {
    // Backa worker-mutation (t.ex. rotation) innan vi återställer UI-state.
    try { await call(snap.inverse.type, snap.inverse.payload) } catch (_) {}
  }
  pages = snap.pages
  await renderAll()
  updateUndoBtn()
  setStatus('Ångrade senaste ändringen')
}
$('btnUndo').addEventListener('click', async () => { setBusy(true); try { await undo() } finally { setBusy(false) } })

// --- Ladda / slå ihop --------------------------------------------------------

$('fileOpen').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return
  setBusy(true); setStatus('Laddar…')
  try {
    const buf = await file.arrayBuffer()
    const { pageCount } = await call('load', { bytes: buf }, [buf])
    pages = Array.from({ length: pageCount }, (_, i) => freshPage(i))
    history.length = 0
    await renderAll()
    setStatus(`${pageCount} sidor`)
  } catch (err) { setStatus('Fel: ' + err.message) }
  finally { setBusy(false); e.target.value = ''; updateUndoBtn() }
})

$('fileAppend').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  if (!file || pages.length === 0) { if (!pages.length) setStatus('Öppna ett dokument först'); e.target.value = ''; return }
  setBusy(true); setStatus('Slår ihop…')
  try {
    snapshot()
    const buf = await file.arrayBuffer()
    const { pageCount } = await call('append', { bytes: buf }, [buf])
    for (let i = pages.length; i < pageCount; i++) pages.push(freshPage(i))
    await renderAll()
    setStatus(`${pageCount} sidor`)
  } catch (err) { setStatus('Fel: ' + err.message) }
  finally { setBusy(false); e.target.value = '' }
})

// --- Rendering ---------------------------------------------------------------

async function renderAll() {
  gridEl.innerHTML = ''
  if (pages.length === 0) { emptyEl.classList.remove('hidden'); gridEl.classList.add('hidden'); return }
  emptyEl.classList.add('hidden'); gridEl.classList.remove('hidden')
  for (let i = 0; i < pages.length; i++) gridEl.appendChild(await renderCard(i))
  $('btnExport').disabled = false
}

async function renderCard(viewIndex) {
  const page = pages[viewIndex]
  const r = await call('renderPage', { pageIndex: page.srcIndex, scale: RENDER_SCALE })

  const card = document.createElement('div')
  card.className = 'page-card'; card.draggable = true; card.dataset.viewIndex = viewIndex
  if (page.markedDelete) card.classList.add('marked-delete')

  const wrap = document.createElement('div')
  wrap.className = 'canvas-wrap'
  if (mode === 'redact') wrap.classList.add('redact-mode')
  if (mode === 'crop') wrap.classList.add('crop-mode')
  if (mode === 'text') wrap.classList.add('text-mode')

  const canvas = document.createElement('canvas')
  canvas.width = r.width; canvas.height = r.height
  const bmp = await createImageBitmap(new Blob([r.png], { type: 'image/png' }))
  canvas.getContext('2d').drawImage(bmp, 0, 0); bmp.close()
  wrap.appendChild(canvas)
  page._rw = r.width; page._rh = r.height

  for (const box of page.redactions) wrap.appendChild(makeRedactEl(box, r.width, r.height, page))
  if (page.crop) wrap.appendChild(makeCropEl(page.crop, r.width, r.height))
  for (const te of page.textEdits) wrap.appendChild(makeTextEl(te, r.width, r.height, page))

  attachDrawing(wrap, page, r.width, r.height)

  const meta = document.createElement('div')
  meta.className = 'page-meta'
  const label = document.createElement('span'); label.textContent = `#${viewIndex + 1}`
  const controls = document.createElement('span'); controls.className = 'rotate-btns'
  const rotL = document.createElement('button'); rotL.textContent = '⟲'; rotL.title = 'Rotera moturs'
  rotL.addEventListener('click', (ev) => { ev.stopPropagation(); rotatePage(viewIndex, -90) })
  const rotR = document.createElement('button'); rotR.textContent = '⟳'; rotR.title = 'Rotera medurs'
  rotR.addEventListener('click', (ev) => { ev.stopPropagation(); rotatePage(viewIndex, 90) })
  const delBtn = document.createElement('button')
  delBtn.textContent = page.markedDelete ? 'Ångra borttag' : 'Ta bort'
  delBtn.addEventListener('click', (ev) => {
    ev.stopPropagation(); snapshot()
    page.markedDelete = !page.markedDelete
    card.classList.toggle('marked-delete', page.markedDelete)
    delBtn.textContent = page.markedDelete ? 'Ångra borttag' : 'Ta bort'
  })
  controls.append(rotL, rotR)
  meta.append(label, controls, delBtn)
  card.append(wrap, meta)
  attachDragHandlers(card)
  return card
}

async function renderCardInPlace(viewIndex) {
  const old = gridEl.children[viewIndex]
  const fresh = await renderCard(viewIndex)
  if (old) gridEl.replaceChild(fresh, old)
}

// --- Rotation (appliceras direkt på workern) ---------------------------------

async function rotatePage(viewIndex, delta) {
  const page = pages[viewIndex]
  setBusy(true)
  try {
    snapshot()
    // Rotation ändrar koordinatsystemet → rensa sidans redaktioner/crop.
    page.redactions = []
    page.crop = null
    // textEdits ligger i pdf-lib-koordinater på den oroterade sidan; vi rensar
    // dem också för att undvika felplacering efter vridning (ärligt val).
    page.textEdits = []
    await call('rotate', { pageIndex: page.srcIndex, delta })
    // Invers för ångra: rotera tillbaka.
    setInverse({ type: 'rotate', payload: { pageIndex: page.srcIndex, delta: -delta } })
    page.rotation = (page.rotation + delta + 360) % 360
    await renderCardInPlace(viewIndex)
    setStatus('Sida roterad')
  } catch (err) { setStatus('Fel: ' + err.message) }
  finally { setBusy(false) }
}

// --- Overlay-element ----------------------------------------------------------

function pct(box, rw, rh) {
  return { left: box.x / rw * 100, top: box.y / rh * 100, width: box.w / rw * 100, height: box.h / rh * 100 }
}
function makeRedactEl(box, rw, rh, page) {
  const el = document.createElement('div'); el.className = 'redact-box'
  const p = pct(box, rw, rh)
  el.style.left = p.left + '%'; el.style.top = p.top + '%'; el.style.width = p.width + '%'; el.style.height = p.height + '%'
  el.title = 'Klicka för att ta bort denna redaktion'
  el.addEventListener('click', (ev) => {
    ev.stopPropagation(); snapshot()
    const i = page.redactions.indexOf(box); if (i >= 0) page.redactions.splice(i, 1)
    el.remove()
  })
  return el
}
function makeCropEl(box, rw, rh) {
  const el = document.createElement('div'); el.className = 'crop-box'
  const p = pct(box, rw, rh)
  el.style.left = p.left + '%'; el.style.top = p.top + '%'; el.style.width = p.width + '%'; el.style.height = p.height + '%'
  return el
}
function makeTextEl(te, rw, rh, page) {
  const el = document.createElement('div'); el.className = 'text-edit'
  const p = pct(te, rw, rh)
  el.style.left = p.left + '%'; el.style.top = p.top + '%'; el.style.width = p.width + '%'; el.style.minHeight = p.height + '%'
  if (te.cover) el.classList.add('covered')
  el.textContent = te.text
  el.style.fontSize = (te.h * 0.62 / rh * 100) + 'cqh' // ungefärlig visning
  el.title = 'Klicka för att ta bort denna text'
  el.addEventListener('click', (ev) => {
    ev.stopPropagation(); snapshot()
    const i = page.textEdits.indexOf(te); if (i >= 0) page.textEdits.splice(i, 1)
    el.remove()
  })
  return el
}

// --- Ritning (redaktion / crop / text) ---------------------------------------

function attachDrawing(wrap, page, rw, rh) {
  let start = null, preview = null
  const toCanvas = (e) => {
    const rect = wrap.getBoundingClientRect()
    return { x: (e.clientX - rect.left) * (rw / rect.width), y: (e.clientY - rect.top) * (rh / rect.height) }
  }
  wrap.addEventListener('pointerdown', (e) => {
    if (mode === 'none') return
    e.preventDefault(); start = toCanvas(e)
    preview = document.createElement('div')
    preview.className = mode === 'crop' ? 'crop-box' : (mode === 'text' ? 'text-edit covered' : 'redact-box')
    wrap.appendChild(preview); wrap.setPointerCapture(e.pointerId)
  })
  wrap.addEventListener('pointermove', (e) => {
    if (!start || !preview) return
    const cur = toCanvas(e)
    const x = Math.min(start.x, cur.x), y = Math.min(start.y, cur.y)
    const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y)
    preview.style.left = (x / rw * 100) + '%'; preview.style.top = (y / rh * 100) + '%'
    preview.style.width = (w / rw * 100) + '%'; preview.style.height = (h / rh * 100) + '%'
  })
  wrap.addEventListener('pointerup', async (e) => {
    if (!start || !preview) return
    const cur = toCanvas(e)
    const x = Math.min(start.x, cur.x), y = Math.min(start.y, cur.y)
    const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y)
    preview.remove(); const _start = start; start = null; preview = null
    if (w <= 4 || h <= 4) return

    if (mode === 'crop') {
      snapshot()
      page.crop = { x, y, w, h }
      wrap.querySelectorAll('.crop-box').forEach(el => el.remove())
      wrap.appendChild(makeCropEl(page.crop, rw, rh))
    } else if (mode === 'text') {
      // Fråga efter texten. (prompt är enkelt och fungerar; kan bytas mot inline-fält.)
      const txt = window.prompt('Text att infoga (täcker ytan under):', '')
      if (txt === null || txt === '') return
      snapshot()
      const te = { x, y, w, h, text: txt, cover: true }
      page.textEdits.push(te)
      wrap.appendChild(makeTextEl(te, rw, rh, page))
    } else { // redact
      snapshot()
      const box = { x, y, w, h }
      page.redactions.push(box)
      wrap.appendChild(makeRedactEl(box, rw, rh, page))
    }
  })
}

// --- Lägesväxling ------------------------------------------------------------

function setMode(newMode) {
  mode = (mode === newMode) ? 'none' : newMode
  const upd = (id, label, on) => { $(id).textContent = label + (on ? 'på' : 'av'); $(id).classList.toggle('danger-active', on) }
  upd('btnRedact', 'Redaktionsläge: ', mode === 'redact')
  upd('btnCrop', 'Beskärningsläge: ', mode === 'crop')
  upd('btnText', 'Textläge: ', mode === 'text')
  $('redactBanner').classList.toggle('hidden', mode !== 'redact')
  $('cropBanner').classList.toggle('hidden', mode !== 'crop')
  $('textBanner').classList.toggle('hidden', mode !== 'text')
  document.querySelectorAll('.canvas-wrap').forEach(w => {
    w.classList.toggle('redact-mode', mode === 'redact')
    w.classList.toggle('crop-mode', mode === 'crop')
    w.classList.toggle('text-mode', mode === 'text')
  })
}
$('btnRedact').addEventListener('click', () => setMode('redact'))
$('btnCrop').addEventListener('click', () => setMode('crop'))
$('btnText').addEventListener('click', () => setMode('text'))

// --- Dra-och-släpp omsortering -----------------------------------------------

let dragSrc = null
function attachDragHandlers(card) {
  card.addEventListener('dragstart', (e) => {
    if (mode !== 'none') { e.preventDefault(); return }
    dragSrc = parseInt(card.dataset.viewIndex, 10)
    card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'
  })
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging')
    document.querySelectorAll('.drop-target').forEach(c => c.classList.remove('drop-target'))
  })
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop-target') })
  card.addEventListener('dragleave', () => card.classList.remove('drop-target'))
  card.addEventListener('drop', (e) => {
    e.preventDefault(); card.classList.remove('drop-target')
    const target = parseInt(card.dataset.viewIndex, 10)
    if (dragSrc === null || dragSrc === target) return
    snapshot()
    const [moved] = pages.splice(dragSrc, 1)
    pages.splice(target, 0, moved); dragSrc = null
    renderAll()
  })
}

// --- Formulär ----------------------------------------------------------------

let formFields = []
$('btnForms').addEventListener('click', async () => {
  if (pages.length === 0) { setStatus('Öppna ett dokument först'); return }
  setBusy(true); setStatus('Läser formulärfält…')
  try {
    const { fields } = await call('getForm', {})
    formFields = fields; renderFormPanel()
    $('formPanel').classList.remove('hidden')
    setStatus(fields.length ? `${fields.length} fält` : 'Inga formulärfält hittades')
  } catch (err) { setStatus('Fel: ' + err.message) }
  finally { setBusy(false) }
})
$('btnClosePanel').addEventListener('click', () => $('formPanel').classList.add('hidden'))

function renderFormPanel() {
  const body = $('formFields'); body.innerHTML = ''
  if (formFields.length === 0) {
    body.innerHTML = '<div class="field-empty">Det här dokumentet har inga ifyllbara formulärfält.</div>'; return
  }
  formFields.forEach((f, idx) => {
    const row = document.createElement('div'); row.className = 'field-row'
    const label = document.createElement('label')
    label.textContent = (f.name || `Fält ${idx + 1}`) + `  ·  ${f.type}`
    row.appendChild(label)
    if (f.type === 'checkbox' || f.type === 'radiobutton') {
      const sel = document.createElement('select')
      sel.innerHTML = '<option value="off">Av</option><option value="on">På</option>'
      sel.value = (f.value && f.value !== 'Off') ? 'on' : 'off'; sel.dataset.idx = idx
      row.appendChild(sel)
    } else if ((f.type === 'combobox' || f.type === 'listbox') && f.options) {
      const sel = document.createElement('select')
      for (const opt of f.options) {
        const o = document.createElement('option'); o.value = opt; o.textContent = opt
        if (opt === f.value) o.selected = true; sel.appendChild(o)
      }
      sel.dataset.idx = idx; row.appendChild(sel)
    } else {
      const inp = document.createElement('input'); inp.type = 'text'
      inp.value = f.value || ''; inp.dataset.idx = idx; row.appendChild(inp)
    }
    body.appendChild(row)
  })
}
$('btnApplyForm').addEventListener('click', async () => {
  const values = []
  $('formFields').querySelectorAll('[data-idx]').forEach(el => {
    const f = formFields[parseInt(el.dataset.idx, 10)]
    values.push({ pageIndex: f.pageIndex, widgetIndex: f.widgetIndex, value: el.value })
  })
  if (values.length === 0) return
  setBusy(true); setStatus('Fyller i fält…')
  try {
    await call('fillForm', { values })
    setStatus('Fält ifyllda'); $('formPanel').classList.add('hidden')
    await renderAll()
  } catch (err) { setStatus('Fel: ' + err.message) }
  finally { setBusy(false) }
})

// --- Export ------------------------------------------------------------------

$('btnExport').addEventListener('click', async () => {
  if (pages.length === 0) return
  setBusy(true); setStatus('Exporterar…')
  try {
    // Rotation är redan applicerad i workern. Kvar: redaktion, crop, text,
    // rearrange. canvas-px → MuPDF-punkt (samma origo, bara skala).
    const redactions = []
    for (const page of pages) {
      if (!page.redactions.length) continue
      redactions.push({
        pageIndex: page.srcIndex,
        rects: page.redactions.map(b => [b.x / RENDER_SCALE, b.y / RENDER_SCALE,
          (b.x + b.w) / RENDER_SCALE, (b.y + b.h) / RENDER_SCALE])
      })
    }
    if (redactions.length) await call('redact', { redactions })

    for (const page of pages) {
      if (!page.crop) continue
      const b = page.crop
      await call('crop', { pageIndex: page.srcIndex,
        box: [b.x / RENDER_SCALE, b.y / RENDER_SCALE, (b.x + b.w) / RENDER_SCALE, (b.y + b.h) / RENDER_SCALE] })
    }

    const order = pages.filter(p => !p.markedDelete).map(p => p.srcIndex)
    if (order.length === 0) throw new Error('Alla sidor är markerade för borttagning')

    // Samla textredigeringar per BEHÅLLEN sida (i ny ordning) för pdf-lib-steget.
    // Vi mappar srcIndex → ny position i den exporterade filen.
    const keptPages = pages.filter(p => !p.markedDelete)
    const textByNewIndex = keptPages.map(p => p.textEdits)

    await call('rearrange', { order })
    const { bytes } = await call('export', {})

    // pdf-lib-steg: applicera textredigeringar (täck-och-ersätt + ny text).
    let finalBytes = bytes
    const hasText = textByNewIndex.some(arr => arr.length > 0)
    if (hasText) {
      const pdf = await PDFDocument.load(bytes)
      const helv = await pdf.embedFont(StandardFonts.Helvetica)
      const docPages = pdf.getPages()
      for (let i = 0; i < docPages.length; i++) {
        const edits = textByNewIndex[i] || []
        if (!edits.length) continue
        const pg = docPages[i]
        const { height } = pg.getSize()
        for (const te of edits) {
          // te i canvas-px → PDF-punkt. pdf-lib origo NEDRE-vänster → y-flip.
          const x = te.x / RENDER_SCALE
          const w = te.w / RENDER_SCALE
          const h = te.h / RENDER_SCALE
          const yTop = te.y / RENDER_SCALE
          const yPdf = height - yTop - h // nedre kant av rutan
          if (te.cover) pg.drawRectangle({ x, y: yPdf, width: w, height: h, color: rgb(1, 1, 1) })
          const size = Math.max(6, h * 0.7)
          pg.drawText(te.text, { x: x + 2, y: yPdf + (h - size) / 2 + size * 0.15, size, font: helv, color: rgb(0, 0, 0) })
        }
      }
      finalBytes = await pdf.save()
    }

    const blob = new Blob([finalBytes], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'redigerad.pdf'; a.click()
    URL.revokeObjectURL(url)

    pages = order.map((_, i) => freshPage(i))
    history.length = 0; updateUndoBtn()
    await renderAll()
    setStatus(`Exporterad · ${pages.length} sidor`)
  } catch (err) { setStatus('Fel: ' + err.message) }
  finally { setBusy(false) }
})
