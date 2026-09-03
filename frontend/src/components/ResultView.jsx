import React, { useEffect, useState } from 'react'
import {
  Briefcase, Building2, CalendarClock, Check, Columns, Download, FileJson2, Loader2,
  Gauge, Pencil, Plus, Trash2, UserCog, Users, X,
} from 'lucide-react'
import clsx from 'clsx'
import { userHeaders } from '../lib/api'
import { exportJobsToExcel } from '../lib/excel'

// Labels stay Bahasa Indonesia — the vocabulary of the akta itself, tidied for
// reading rather than the raw API keys. Fields are grouped the way a reviewer
// reads a deed: the company first, then the terms of its boards.
const COMPANY_FIELDS = [
  ['nama_perusahaan', 'Nama Perusahaan'],
  ['nama_perusahaan_cleaned', 'Nama Perusahaan (Bersih)'],
  ['nomor_akta', 'Nomor Akta'],
  ['tanggal_akta', 'Tanggal Akta'],
  ['tanggal_perusahaan_berdiri', 'Tanggal Perusahaan Berdiri'],
  ['tempat_perusahaan_berdiri', 'Tempat Kedudukan'],
  ['jangka_waktu_perseroan', 'Jangka Waktu Perseroan'],
]

const BOARD_TERM_FIELDS = [
  ['masa_berlaku_direksi_dalam_tahun', 'Masa Jabatan Direksi (Tahun)'],
  ['masa_berlaku_komisaris_dalam_tahun', 'Masa Jabatan Komisaris (Tahun)'],
  ['tanggal_berlaku_direksi', 'Tanggal Berlaku Direksi'],
  ['tanggal_berlaku_komisaris', 'Tanggal Berlaku Komisaris'],
  ['pengurus_dan_pemegang_saham_tertinggi', 'Pengurus & Pemegang Saham Tertinggi'],
]

// every person key from the JSON record except nama/jabatan (the card header)
// and alamat (full-width at the bottom) — nothing in the record is hidden
const PERSON_DETAIL_FIELDS = [
  ['no_ktp_passport', 'No. KTP / Paspor'],
  ['tempat_lahir', 'Tempat Lahir'],
  ['tanggal_lahir', 'Tanggal Lahir'],
  ['warga_negara', 'Warga Negara'],
  ['jumlah_lembar_saham', 'Jumlah Saham'],
  ['persentase_saham', '% Saham'],
]

// The OCR API reports how long each of its own stages took (latency_data). Surfacing it
// answers the question a slow extraction actually raises — WHERE did the time go — which
// a single wall-clock figure cannot. The stages are the API's, named as it names them.
const STAGES = [
  ['pdf_to_images_time', 'PDF → images', 'bg-brand', 'text-brand'],
  ['images_to_md_time', 'Images → markdown', 'bg-navy', 'text-navy'],
  ['parallel_prompt_time', 'Extraction prompts', 'bg-amber', 'text-amber'],
]

// "+120s outside the API" is a symptom, not a diagnosis. These are the phases the backend
// measures around the API call, so a slow document can be attributed rather than guessed
// at: waiting for a concurrency permit and uploading a 40 MB body want opposite fixes, and
// from a single overhead figure they look identical.
const CLIENT_PHASES = [
  ['slot_wait_s', 'queued for a slot', 'AKTA_CONCURRENT_PER_USER — your other documents were still running'],
  ['api_wait_s', 'waiting for the API', 'AKTA_OCR_CONCURRENCY — every API call slot was in use'],
  ['read_s', 'read file', 'reading the PDF back off disk'],
  ['page_count_s', 'count pages', 'opening the PDF to count its pages'],
  ['encode_s', 'base64 encode', 'preparing the PDF as base64 inside the JSON body'],
  ['retry_wait_s', 'retry backoff', 'pausing before another attempt after the API returned 5xx'],
  ['failed_http_s', 'failed attempts', 'time spent on calls the API did not answer, before the one that did'],
]

function OutsideApi({ phases, apiTotal }) {
  if (!phases) return null      // older jobs and mock mode carry no detail — say nothing
  const rows = CLIENT_PHASES
    .map(([key, label, why]) => ({ label, why, seconds: Number(phases[key] || 0) }))
    .filter((row) => row.seconds >= 0.05)
  // What the HTTP call took beyond what the API says it spent: sending the body up, and
  // the API's own queue before its clock starts. Neither side measures this directly.
  const transit = Math.max(0, Number(phases.http_s || 0) - apiTotal)
  if (transit >= 0.05) {
    rows.push({
      label: 'transit & API queue',
      why: `${phases.body_mb || '?'} MB of base64 sent to the API, before its own clock started`,
      seconds: transit,
    })
  }
  if (!rows.length) return null
  const attempts = Number(phases.attempts || 0)

  return (
    <div className="mt-2.5 border-t border-line pt-2">
      <p className="text-[10.5px] text-ink-faint">
        Outside the time the API reports
        {attempts > 1 && (
          <span className="text-alert"> · answered on attempt {attempts} of {attempts}</span>
        )}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
        {rows.map((row) => (
          <span key={row.label} className="text-[11.5px] text-ink-soft" title={row.why}>
            {row.label} <b className="font-semibold tabular-nums text-ink">{row.seconds.toFixed(1)}s</b>
          </span>
        ))}
      </div>
    </div>
  )
}

function StageTimings({ latency, wallClock }) {
  const stages = STAGES
    .map(([key, label, bar, text]) => ({ label, bar, text, seconds: Number(latency?.[key] || 0) }))
    .filter((stage) => stage.seconds > 0)
  if (!stages.length) return null

  const apiTotal = Number(latency?.total_time || 0)
  const measured = stages.reduce((sum, stage) => sum + stage.seconds, 0)
  // Segments are drawn as shares of the API's OWN total, not of their sum. When the stages
  // account for all of it the bar fills; when they do not, the gap is left visible rather
  // than scaled away — unattributed time inside the API is worth seeing, not hiding.
  const scale = apiTotal > 0 ? apiTotal : measured
  const overhead = wallClock && apiTotal ? Math.max(0, wallClock - apiTotal) : 0

  return (
    <div className="mt-2.5 rounded-xl border border-line bg-canvas/60 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="label flex items-center gap-1.5">
          <Gauge size={12} className="text-brand" /> Processing time
        </span>
        <span className="ml-auto text-[11.5px] text-ink-soft">
          <b className="font-semibold text-ink tabular-nums">{apiTotal.toFixed(1)}s</b> in the OCR API
          {overhead > 0.05 && (
            <> · <span className="tabular-nums">+{overhead.toFixed(1)}s</span> outside it</>
          )}
        </span>
      </div>

      {/* One bar across the full width — three narrow bars in a column left most of the
          header empty and made the stages look unrelated to each other. */}
      <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-line-soft">
        {stages.map((stage) => (
          <span key={stage.label} className={stage.bar}
                style={{ width: `${(stage.seconds / scale) * 100}%` }}
                title={`${stage.label} — ${stage.seconds.toFixed(1)}s`} />
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
        {stages.map((stage) => (
          <span key={stage.label} className="flex items-center gap-1.5 text-[11.5px]">
            <span className={`h-2 w-2 shrink-0 rounded-full ${stage.bar}`} />
            <span className="text-ink-soft">{stage.label}</span>
            <b className={`font-semibold tabular-nums ${stage.text}`}>{stage.seconds.toFixed(1)}s</b>
          </span>
        ))}
      </div>

      <OutsideApi phases={latency?.client_phases} apiTotal={apiTotal} />
    </div>
  )
}

const EMPTY_PERSON = {
  nama: '', jabatan: '', no_ktp_passport: '', tempat_lahir: '',
  tanggal_lahir: '', warga_negara: '', alamat: '', jumlah_lembar_saham: '', persentase_saham: '',
}

// Fetch the stored upload with the auth header and hand the browser's native
// viewer a blob URL — an <iframe src="/api/..."> could not send X-Akta-Token.
function usePdfUrl(jobId, username) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let objectUrl = ''
    let alive = true
    setUrl(''); setFailed(false)
    fetch(`/api/jobs/${jobId}/pdf?username=${encodeURIComponent(username)}`, { headers: userHeaders() })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('unavailable'))))
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob)
        if (alive) setUrl(objectUrl)
      })
      .catch(() => { if (alive) setFailed(true) })
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [jobId, username])
  return { url, failed }
}

export function PdfPane({ jobId, username }) {
  const { url, failed } = usePdfUrl(jobId, username)
  if (failed) {
    return (
      <div className="flex h-full min-h-[300px] items-center justify-center text-[12.5px] text-ink-faint">
        The original PDF is no longer stored for this job.
      </div>
    )
  }
  if (!url) {
    return (
      <div className="flex h-full min-h-[300px] items-center justify-center text-ink-faint">
        <Loader2 size={18} className="animate-spin" />
      </div>
    )
  }
  return <iframe title="akta" src={url} className="h-full w-full rounded-xl border border-line bg-mute" />
}

// Each section carries its own colour so the record's big blocks read at a glance:
// navy = the company, amber = its business, green = terms, red/navy = the boards.
const SECTION_STYLES = {
  company: { icon: Building2, chip: 'bg-navy-tint text-navy' },
  industry: { icon: Briefcase, chip: 'bg-amber-tint text-amber' },
  terms: { icon: CalendarClock, chip: 'bg-okay-tint text-okay' },
  direksi: { icon: UserCog, chip: 'bg-brand-tint text-brand' },
  komisaris: { icon: Users, chip: 'bg-navy-tint text-navy-light' },
}

function Section({ title, kind, children, edited }) {
  const { icon: Icon, chip } = SECTION_STYLES[kind] || SECTION_STYLES.company
  return (
    <section className="overflow-hidden rounded-xl border border-line-soft">
      <div className="flex items-center gap-2 border-b border-line-soft bg-surface px-3.5 py-1.5">
        <span className={`flex items-center justify-center rounded-md p-1 ${chip}`}>
          <Icon size={13} />
        </span>
        <span className="label">{title}</span>
        {edited && <EditedDot />}
      </div>
      <div className="px-3.5">{children}</div>
    </section>
  )
}

function EditedDot() {
  return <span title="Edited by the user"
               className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
}

// Label left, value right — a definition list reads far better in the narrow
// split column than a checkerboard of boxes with wrapping labels.
function Row({ label, value, edited }) {
  return (
    <div className={clsx('flex items-baseline justify-between gap-6 py-1',
      edited && '-mx-3.5 rounded bg-amber-tint/70 px-3.5')}>
      <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-faint">
        {label}{edited && <EditedDot />}
      </span>
      <span className={`break-words text-right text-[12px] font-medium ${value ? 'text-ink' : 'text-ink-faint'}`}>
        {value || '-'}
      </span>
    </div>
  )
}

function PersonCard({ person, path, editedKeys }) {
  const has = (sub) => editedKeys?.has(`${path}.${sub}`)
  const wholeMember = editedKeys?.has(path)
  return (
    <div className={`rounded-xl border p-3 ${wholeMember
      ? 'border-amber/50 bg-amber-tint/40' : 'border-line-soft bg-surface/60'}`}>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
          {person.nama || '-'}{(has('nama') || wholeMember) && <EditedDot />}
        </span>
        <span className="chip !border-navy-tint !bg-navy-tint font-semibold text-navy">
          {person.jabatan || '-'}{has('jabatan') && <EditedDot />}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-1">
        {PERSON_DETAIL_FIELDS.map(([k, label]) => (
          <div key={k} className={clsx(has(k) && '-mx-1.5 rounded bg-amber-tint/70 px-1.5')}>
            <div className="flex items-center gap-1 text-[10.5px] text-ink-faint">
              {label}{has(k) && <EditedDot />}
            </div>
            <div className="text-[12px] font-medium text-ink">{person[k] || '-'}</div>
          </div>
        ))}
      </div>
      <div className={clsx('mt-2 border-t border-line-soft pt-2',
        has('alamat') && '-mx-1.5 rounded bg-amber-tint/70 px-1.5')}>
        <div className="flex items-center gap-1 text-[10.5px] text-ink-faint">
          Alamat{has('alamat') && <EditedDot />}
        </div>
        <div className="text-[11.5px] leading-relaxed text-ink">{person.alamat || '-'}</div>
      </div>
    </div>
  )
}

function BoardSection({ name, kind, boardKey, people, editedKeys }) {
  // the same boxed chrome as the Perusahaan section, so every block matches
  return (
    <Section kind={kind} title={`${name} (${people.length})`}>
      {people.length === 0 ? (
        <p className="py-2.5 text-[12.5px] text-ink-faint">Tidak tercatat dalam akta ini.</p>
      ) : (
        <div className="space-y-2 py-2.5">
          {people.map((p, i) => (
            <PersonCard key={i} person={p} path={`${boardKey}[${i}]`} editedKeys={editedKeys} />
          ))}
        </div>
      )}
    </Section>
  )
}

function DataPane({ job }) {
  const r = job.result
  const edited = new Set(job.edited_keys || [])
  return (
    <div className="space-y-3">
      <Section kind="company" title="Perusahaan">
        <div className="divide-y divide-line-soft">
          {COMPANY_FIELDS.map(([k, label]) => (
            <Row key={k} label={label} value={r[k]} edited={edited.has(k)} />
          ))}
        </div>
      </Section>

      <Section kind="terms" title="Masa Jabatan & Pengurus">
        <div className="divide-y divide-line-soft">
          {BOARD_TERM_FIELDS.map(([k, label]) => (
            <Row key={k} label={label} value={r[k]} edited={edited.has(k)} />
          ))}
        </div>
      </Section>

      <BoardSection name="Direksi" kind="direksi" boardKey="board_of_directors"
                    people={r.board_of_directors || []} editedKeys={edited} />
      <BoardSection name="Dewan Komisaris" kind="komisaris" boardKey="board_of_commissioners"
                    people={r.board_of_commissioners || []} editedKeys={edited} />

      <Section kind="industry" title="Bidang Industri (Pasal 3)"
               edited={edited.has('bidang_industri_perusahaan')}>
        {(r.bidang_industri_perusahaan || []).length === 0 ? (
          <div className="py-2 text-[13px] text-ink-faint">-</div>
        ) : (
          <ul className="space-y-1 py-2.5 text-[12px] font-medium text-ink">
            {r.bidang_industri_perusahaan.map((b, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-brand" /> {b}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

/* ------------------------------------------------------------ edit mode */
function EditField({ label, value, onChange, textarea = false }) {
  return (
    <label className="block py-1.5">
      <span className="text-[11px] text-ink-faint">{label}</span>
      {textarea ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2}
                  className="field !mt-1 !py-1.5 text-[12.5px]" />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)}
               className="field !mt-1 !py-1.5 text-[12.5px]" />
      )}
    </label>
  )
}

function EditPersonCard({ person, onChange, onRemove }) {
  return (
    <div className="rounded-xl border border-line-soft bg-surface/60 p-3">
      <div className="grid grid-cols-2 gap-x-4">
        <EditField label="Nama" value={person.nama} onChange={(v) => onChange('nama', v)} />
        <EditField label="Jabatan" value={person.jabatan} onChange={(v) => onChange('jabatan', v)} />
        {PERSON_DETAIL_FIELDS.map(([k, label]) => (
          <EditField key={k} label={label} value={person[k]} onChange={(v) => onChange(k, v)} />
        ))}
      </div>
      <EditField label="Alamat" value={person.alamat} textarea
                 onChange={(v) => onChange('alamat', v)} />
      <button type="button" onClick={onRemove}
              className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-ink-faint transition-colors hover:text-alert">
        <Trash2 size={12} /> Hapus anggota
      </button>
    </div>
  )
}

function EditPane({ draft, setDraft }) {
  const setField = (k, v) => setDraft((d) => ({ ...d, [k]: v }))
  const setPerson = (board, i, k, v) => setDraft((d) => ({
    ...d, [board]: d[board].map((p, j) => (j === i ? { ...p, [k]: v } : p)),
  }))
  const removePerson = (board, i) => setDraft((d) => ({
    ...d, [board]: d[board].filter((_, j) => j !== i),
  }))
  const addPerson = (board) => setDraft((d) => ({
    ...d, [board]: [...(d[board] || []), { ...EMPTY_PERSON }],
  }))

  const boards = [
    ['board_of_directors', 'Direksi', 'direksi'],
    ['board_of_commissioners', 'Dewan Komisaris', 'komisaris'],
  ]
  return (
    <div className="space-y-3">
      <Section kind="company" title="Perusahaan">
        {COMPANY_FIELDS.map(([k, label]) => (
          <EditField key={k} label={label} value={draft[k] || ''} onChange={(v) => setField(k, v)} />
        ))}
      </Section>
      <Section kind="terms" title="Masa Jabatan & Pengurus">
        {BOARD_TERM_FIELDS.map(([k, label]) => (
          <EditField key={k} label={label} value={draft[k] || ''} onChange={(v) => setField(k, v)} />
        ))}
      </Section>
      {boards.map(([board, title, kind]) => (
        <Section key={board} kind={kind} title={`${title} (${(draft[board] || []).length})`}>
          <div className="space-y-2 py-2.5">
            {(draft[board] || []).map((p, i) => (
              <EditPersonCard key={i} person={p}
                              onChange={(k, v) => setPerson(board, i, k, v)}
                              onRemove={() => removePerson(board, i)} />
            ))}
            <button type="button" onClick={() => addPerson(board)}
                    className="btn-ghost w-full !py-1.5 text-[12px]">
              <Plus size={13} /> Tambah anggota
            </button>
          </div>
        </Section>
      ))}
      <Section kind="industry" title="Bidang Industri (Pasal 3), satu per baris">
        <textarea rows={3} value={(draft.bidang_industri_perusahaan || []).join('\n')}
                  onChange={(e) => setField('bidang_industri_perusahaan', e.target.value.split('\n'))}
                  className="field my-2 text-[12.5px]" />
      </Section>
    </div>
  )
}

export default function ResultView({ job, username, onJobUpdated }) {
  // Side by side IS the review mode (PDF + data together, stacking on narrow
  // screens) — separate Data/PDF tabs would just repeat its two halves.
  const [tab, setTab] = useState('split')
  const [exporting, setExporting] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const r = job.result

  async function downloadExcel() {
    setExporting(true)
    try {
      exportJobsToExcel([job])
    } finally {
      setExporting(false)
    }
  }

  function startEdit() {
    setDraft(JSON.parse(JSON.stringify(r)))
    setSaveError('')
    setEditing(true)
  }

  async function saveEdit() {
    setSaving(true)
    setSaveError('')
    try {
      const resp = await fetch(`/api/jobs/${job.id}/result?username=${encodeURIComponent(username)}`, {
        method: 'PUT',
        headers: { ...userHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ result: draft }),
      })
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}))
        setSaveError(d.detail || 'Failed to save the corrections.')
      } else {
        const updated = await resp.json()
        onJobUpdated?.(updated)
        setEditing(false)
      }
    } catch {
      setSaveError('Failed to save. Could not reach the server.')
    }
    setSaving(false)
  }

  const TABS = [
    ['split', 'Side by side', Columns],
    ['json', 'JSON', FileJson2],
  ]

  return (
    <div className="animate-fade-up space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[16px] font-semibold text-ink">
            <Building2 size={17} className="text-brand" /> {r.nama_perusahaan || job.filename}
            {job.edited && (
              <span className="chip !border-amber/30 !bg-amber-tint font-semibold text-amber"
                    title="Corrected by the user after extraction">
                edited{job.edited_fields ? ` · ${job.edited_fields} field${job.edited_fields > 1 ? 's' : ''}` : ''}
              </span>
            )}
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-faint">
            {job.filename} · {job.pages} pages · {job.duration_s}s
          </p>
          <StageTimings latency={job.latency_data} wallClock={job.duration_s} />
        </div>
        <div className="flex shrink-0 gap-2">
          {editing ? (
            <>
              <button onClick={() => setEditing(false)} disabled={saving} className="btn-ghost">
                <X size={14} /> Cancel
              </button>
              <button onClick={saveEdit} disabled={saving} className="btn-primary">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
              </button>
            </>
          ) : (
            <>
              <button onClick={startEdit} className="btn-ghost">
                <Pencil size={14} /> Edit
              </button>
              <button onClick={downloadExcel} disabled={exporting} className="btn-primary">
                {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Excel
              </button>
            </>
          )}
        </div>
      </div>

      {saveError && (
        <p className="rounded-lg border border-alert/30 bg-alert-tint px-3 py-2 text-[12.5px] text-alert">
          {saveError}
        </p>
      )}

      {editing ? (
        // review-and-correct: the akta on the left, editable fields on the right
        <div className="grid grid-cols-1 gap-4 lg:h-[70vh] lg:grid-cols-2">
          <div className="h-[55vh] lg:h-auto"><PdfPane jobId={job.id} username={username} /></div>
          <div className="lg:overflow-y-auto lg:pr-1"><EditPane draft={draft} setDraft={setDraft} /></div>
        </div>
      ) : (
        <>
          <div className="flex gap-1 rounded-xl bg-mute p-1 text-[12.5px] font-medium">
            {TABS.map(([key, label, Icon]) => (
              <button key={key} onClick={() => setTab(key)}
                      className={clsx('flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 transition-all',
                        tab === key ? 'bg-paper text-ink shadow-panel' : 'text-ink-soft hover:text-ink')}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>

          {tab === 'json' && (
            <pre className="overflow-x-auto rounded-xl bg-navy-dark p-4 font-mono text-[11.5px] leading-relaxed text-white/90">
              {JSON.stringify(r, null, 2)}
            </pre>
          )}
          {tab === 'split' && (
            <div className="grid grid-cols-1 gap-4 lg:h-[70vh] lg:grid-cols-2">
              <div className="h-[55vh] lg:h-auto"><PdfPane jobId={job.id} username={username} /></div>
              <div className="lg:overflow-y-auto lg:pr-1"><DataPane job={job} /></div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
