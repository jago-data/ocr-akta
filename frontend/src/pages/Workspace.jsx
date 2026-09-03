import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, CheckCircle2, ChevronRight, Clock, Download, FileText, History,
  LayoutDashboard, Layers, Loader2, LogOut, PencilLine, RotateCcw, ScanText, Search,
  StopCircle, UploadCloud,
} from 'lucide-react'
import clsx from 'clsx'
import { clearSession, session, userHeaders } from '../lib/api'
import { useBrand } from '../lib/brand'
import { exportJobsToExcel, fetchFullJobs } from '../lib/excel'
import ResultView, { PdfPane } from '../components/ResultView'
import StatusBadge from '../components/StatusBadge'

const ACTIVE = new Set(['queued', 'ocr', 'extract'])

const NAV = [
  ['dashboard', 'Dashboard', LayoutDashboard],
  ['upload', 'Upload', UploadCloud],
  ['history', 'History', History],
]

export default function Workspace({ onLogout }) {
  const brand = useBrand()
  const { user, name, role } = session()
  const [view, setView] = useState('dashboard')
  const [jobList, setJobList] = useState([])
  const [selected, setSelected] = useState(null) // full job record, opened over any view
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const openRequest = useRef('') // guards against out-of-order job fetches

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/jobs?username=${encodeURIComponent(user)}&limit=1000`,
        { headers: userHeaders() })
      if (r.status === 401) { onLogout(); return }
      if (r.ok) setJobList((await r.json()).jobs || [])
    } catch { /* transient — next poll retries */ }
  }, [user, onLogout])

  const openJob = useCallback(async (id) => {
    openRequest.current = id
    try {
      const r = await fetch(`/api/jobs/${id}?username=${encodeURIComponent(user)}`, { headers: userHeaders() })
      if (r.ok) {
        const job = await r.json()
        if (openRequest.current === id) setSelected(job) // drop stale responses
      }
    } catch { /* keep the current view */ }
  }, [user])

  const selectedId = selected?.id
  const anyActive = jobList.some((j) => ACTIVE.has(j.status)) ||
    (selected && ACTIVE.has(selected.status))

  // reopening a document must always start at the top, not wherever the
  // list (or the previous document) was scrolled to
  useEffect(() => {
    if (selectedId) window.scrollTo({ top: 0 })
  }, [selectedId])

  useEffect(() => {
    refresh()
    if (!anyActive) return undefined
    const t = setInterval(() => {
      refresh()
      if (selectedId && openRequest.current === selectedId) openJob(selectedId)
    }, 3000)
    return () => clearInterval(t)
  }, [refresh, openJob, selectedId, anyActive])

  async function upload(files) {
    setError('')
    const pdfs = [...files].filter((f) => f.name.toLowerCase().endsWith('.pdf'))
    if (pdfs.length === 0) { setError('Only PDF files are accepted.'); return }
    // per-user processing cap: refuse the whole batch up front rather than
    // letting half of it queue and half of it bounce off the server limit
    const maxActive = brand.max_active || 10
    const active = jobList.filter((j) => ACTIVE.has(j.status)).length
    if (active + pdfs.length > maxActive) {
      setError(`You can have at most ${maxActive} documents queued at once` +
        (active ? ` and ${active} are still in the queue` : '') +
        `. You selected ${pdfs.length} — nothing was uploaded.`)
      return
    }
    setUploading(true)
    const accepted = []
    // Sent a few at a time rather than one after another: with ten files, strictly
    // sequential POSTs make the last one wait for nine full uploads before it is even
    // queued. Kept small on purpose — the server checks the per-user cap and creates the
    // job in two steps, so firing all ten at once could slip past the limit.
    const UPLOAD_LANES = 3
    async function send(f) {
      const fd = new FormData()
      fd.append('file', f)
      try {
        const r = await fetch(`/api/extract?username=${encodeURIComponent(user)}`, {
          method: 'POST', headers: userHeaders(), body: fd,
        })
        if (r.status === 401) return 'unauthorized'
        const d = await r.json().catch(() => ({}))
        if (r.ok) {
          if (d.job_id) accepted.push(d.job_id)
        } else {
          setError(`${f.name}: ${d.detail || 'upload failed'}`)
        }
      } catch {
        setError(`${f.name}: upload failed. Could not reach the server.`)
      }
      return ''
    }
    const queue = [...pdfs]
    const lanes = Array.from({ length: Math.min(UPLOAD_LANES, queue.length) }, async () => {
      while (queue.length) {
        if (await send(queue.shift()) === 'unauthorized') { queue.length = 0; return 'unauthorized' }
      }
      return ''
    })
    if ((await Promise.all(lanes)).includes('unauthorized')) { setUploading(false); onLogout(); return }
    setUploading(false)
    refresh()
    // a single upload has one obvious next screen — open it so the user watches
    // the akta being read instead of hunting for it in the list
    if (pdfs.length === 1 && accepted.length === 1) openJob(accepted[0])
  }

  async function signOut() {
    // Tell the server first: it stops whatever is still extracting for this user, so
    // nothing keeps burning OCR capacity on a result nobody is waiting for. Best effort
    // — a failed call must never trap someone in a session they asked to leave.
    try {
      await fetch(`/api/auth/logout?username=${encodeURIComponent(user)}`,
        { method: 'POST', headers: userHeaders() })
    } catch { /* sign out regardless */ }
    clearSession()
    onLogout()
  }

  async function stopJob(id) {
    try {
      await fetch(`/api/jobs/${id}/stop?username=${encodeURIComponent(user)}`,
        { method: 'POST', headers: userHeaders() })
    } catch {
      setError('Could not stop that document. Please try again.')
      return
    }
    await refresh()
    if (openRequest.current === id) openJob(id)
  }

  async function retryJob(id) {
    try {
      const r = await fetch(`/api/jobs/${id}/retry?username=${encodeURIComponent(user)}`,
        { method: 'POST', headers: userHeaders() })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        setError(d.detail || 'Could not run that document again.')
        return
      }
      setError('')
    } catch {
      setError('Could not run that document again. Could not reach the server.')
      return
    }
    await refresh()
    if (openRequest.current === id) openJob(id)
  }

  const goTo = (v) => { setSelected(null); openRequest.current = ''; setView(v) }

  return (
    <div className="flex min-h-screen">
      {/* ------------------------------------------------ sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 flex w-56 flex-col bg-navy-dark text-white">
        <div className="flex items-center gap-2.5 px-5 pb-6 pt-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand shadow-panel">
            <ScanText size={16} />
          </div>
          <div>
            <div className="text-[13px] font-semibold uppercase tracking-tight">{brand.name}</div>
            <div className="text-[9px] uppercase tracking-[0.16em] text-white/50">Akta Extraction</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {NAV.map(([key, label, Icon]) => (
            <button key={key} onClick={() => goTo(key)}
                    className={clsx('flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all',
                      view === key && !selected
                        ? 'bg-white/10 text-white shadow-panel'
                        : 'text-white/60 hover:bg-white/5 hover:text-white')}>
              <Icon size={15} /> {label}
              {key === 'upload' && jobList.some((j) => ACTIVE.has(j.status)) && (
                <span className="ml-auto h-1.5 w-1.5 animate-pulse-dot rounded-full bg-brand-light" />
              )}
            </button>
          ))}
          {role === 'admin' && (
            <a href="/admin"
               className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] font-medium text-white/60 transition-all hover:bg-white/5 hover:text-white">
              <LayoutDashboard size={15} /> Admin Dashboard
            </a>
          )}
        </nav>

        <div className="border-t border-white/10 px-5 py-4">
          <div className="truncate text-[12.5px] font-medium">{name}</div>
          <button onClick={signOut}
                  className="mt-1.5 flex items-center gap-1.5 text-[12px] text-white/55 transition-colors hover:text-brand-light">
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </aside>

      {/* ------------------------------------------------ content */}
      <main className="ml-56 flex-1 px-8 py-7">
        {selected ? (
          <div className="mx-auto max-w-5xl">
            <div className="mb-4 flex items-center justify-between gap-3">
              <button onClick={() => { setSelected(null); openRequest.current = '' }}
                      className="btn-ghost">
                <ArrowLeft size={14} /> Back
              </button>
              <button onClick={() => goTo('upload')} className="btn-primary">
                <UploadCloud size={14} /> Upload another akta
              </button>
            </div>
            <div className="panel p-6">
              {selected.status === 'done' ? (
                <ResultView key={selected.id} job={selected} username={user}
                            onJobUpdated={(j) => { setSelected(j); refresh() }} />
              ) : selected.status === 'error' ? (
                <div className="text-[13px] text-alert">
                  <p className="mb-1 font-semibold">{selected.filename} failed:</p>
                  <p>{selected.error}</p>
                </div>
              ) : selected.status === 'stopped' ? (
                <Stopped job={selected} username={user} onRetry={() => retryJob(selected.id)} />
              ) : (
                <Processing job={selected} username={user}
                            onStop={() => stopJob(selected.id)} />
              )}
            </div>
          </div>
        ) : view === 'dashboard' ? (
          <DashboardView jobs={jobList} onOpen={openJob} onGoTo={goTo} />
        ) : view === 'upload' ? (
          <UploadView jobs={jobList} onUpload={upload} uploading={uploading}
                      error={error} onOpen={openJob} />
        ) : (
          <HistoryView jobs={jobList} onOpen={openJob} onStop={stopJob}
                       onRetry={retryJob} user={user} />
        )}
      </main>
    </div>
  )
}

function Processing({ job, username, onStop }) {
  const [stopping, setStopping] = useState(false)
  const label = job.status === 'ocr'
    ? `Reading page ${job.stage_done} of ${job.stage_total}…`
    : job.status === 'extract'
      ? `Extracting the record (chunk ${job.stage_done}/${job.stage_total})…`
      : 'Waiting in the queue…'
  // The akta itself is readable the moment it is uploaded — show the PDF while
  // the pipeline works so the user can already start reviewing the document.
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-xl border border-amber/30 bg-amber-tint px-4 py-3">
        <Loader2 size={18} className="animate-spin text-amber" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">{label}</p>
          <p className="truncate text-[12px] text-ink-faint">{job.filename}</p>
        </div>
        {/* Stopping is not an error path — someone uploaded the wrong file, or wants the
            queue behind this one to move. It stays in history and can be run again. */}
        <button onClick={() => { setStopping(true); onStop() }} disabled={stopping}
                className="btn-ghost ml-auto shrink-0">
          <StopCircle size={14} /> {stopping ? 'Stopping…' : 'Stop'}
        </button>
      </div>
      <div className="h-[65vh]"><PdfPane jobId={job.id} username={username} /></div>
    </div>
  )
}


function Stopped({ job, username, onRetry }) {
  const [retrying, setRetrying] = useState(false)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-xl border border-line bg-canvas px-4 py-3">
        <StopCircle size={18} className="text-ink-faint" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">Stopped before it finished</p>
          <p className="truncate text-[12px] text-ink-faint">
            {job.filename}
            {job.error ? ` · ${job.error}` : ''}
          </p>
        </div>
        <button onClick={() => { setRetrying(true); onRetry() }} disabled={retrying}
                className="btn-primary ml-auto shrink-0">
          <RotateCcw size={14} /> {retrying ? 'Starting…' : 'Run again'}
        </button>
      </div>
      {/* The upload is kept, which is what makes a re-run possible at all — so it is
          still worth showing rather than leaving an empty panel. */}
      <div className="h-[65vh]"><PdfPane jobId={job.id} username={username} /></div>
    </div>
  )
}


/* ------------------------------------------------------------- Dashboard */
function StatCard({ icon: Icon, label, value, sub, tone = 'navy', i }) {
  const TONES = {
    navy: 'bg-navy-tint text-navy',
    okay: 'bg-okay-tint text-okay',
    amber: 'bg-amber-tint text-amber',
    brand: 'bg-brand-tint text-brand',
  }
  return (
    <div className="panel animate-rise p-4" style={{ '--i': i }}>
      <div className="flex items-center gap-2">
        <span className={`flex items-center justify-center rounded-md p-1 ${TONES[tone]}`}>
          <Icon size={13} />
        </span>
        <span className="label">{label}</span>
      </div>
      <div className="mt-1.5 text-[22px] font-semibold tracking-tight text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-faint">{sub}</div>}
    </div>
  )
}

// Everything here is derived from the caller's own job list, which the workspace
// already polls — no extra endpoint, and it stays correct while a job is running.
function summarise(jobs) {
  const done = jobs.filter((j) => j.status === 'done')
  const active = jobs.filter((j) => ACTIVE.has(j.status))
  const pages = done.reduce((n, j) => n + (j.pages || 0), 0)
  const durations = done.map((j) => j.duration_s || 0).filter(Boolean)
  const avg = durations.length
    ? durations.reduce((a, b) => a + b, 0) / durations.length : 0
  const edited = done.filter((j) => j.edited).length

  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
  const weekAgo = Date.now() - 7 * 86400e3
  const today = done.filter((j) => new Date(j.created) >= startOfToday).length
  const week = done.filter((j) => new Date(j.created).getTime() >= weekAgo).length

  // last 14 days, oldest first
  const byDay = new Map()
  for (let d = 13; d >= 0; d -= 1) {
    const day = new Date(Date.now() - d * 86400e3)
    byDay.set(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`, 0)
  }
  for (const j of done) {
    const d = new Date(j.created)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (byDay.has(key)) byDay.set(key, byDay.get(key) + 1)
  }
  return {
    done, active, pages, avg, edited, today, week,
    days: [...byDay.entries()],
  }
}


// Y axis with a flexible interval: pick a 1/2/5/10 step so the top is a round
// number at or above the peak, then draw bars against THAT top so every bar
// lands exactly on the gridline scale. Counts are integers, so the step never
// goes below 1 (a 0.5 step would print duplicate labels).
const PLOT_H = 110

function niceAxis(peak) {
  const p = Math.max(1, peak)
  const raw = p / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  let step = 10 * mag
  for (const m of [1, 2, 5, 10]) {
    if (raw <= m * mag) { step = m * mag; break }
  }
  step = Math.max(1, Math.round(step))
  const top = Math.max(step, Math.ceil(p / step) * step)
  const ticks = []
  for (let t = 0; t <= top; t += step) ticks.push(t)
  return { top, ticks }
}

const fmtSeconds = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)}s`)

function DashboardView({ jobs, onOpen, onGoTo }) {
  const s = useMemo(() => summarise(jobs), [jobs])
  const axis = useMemo(() => niceAxis(Math.max(...s.days.map(([, n]) => n), 0)), [s.days])
  const recent = s.done.slice(0, 50)

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3 animate-fade-up">
        <div>
          <h1 className="text-[19px] font-semibold text-ink">Dashboard</h1>
          <p className="mt-0.5 text-[13px] text-ink-soft">
            A summary of the akta you have processed.
          </p>
        </div>
        <button onClick={() => onGoTo('upload')} className="btn-primary">
          <UploadCloud size={14} /> Upload akta
        </button>
      </header>

      <div className="stagger grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6 [--step:60ms]">
        <StatCard i={0} tone="okay" icon={CheckCircle2} label="Processed" value={s.done.length}
                  sub={s.active.length ? `${s.active.length} in progress` : 'all finished'} />
        <StatCard i={1} icon={Layers} label="Pages read" value={s.pages}
                  sub={s.done.length ? `${(s.pages / s.done.length).toFixed(1)} avg/doc` : ''} />
        <StatCard i={2} tone="brand" icon={Clock} label="Avg time"
                  value={s.avg ? fmtSeconds(s.avg) : '-'} sub="per document" />
        <StatCard i={3} icon={FileText} label="Today" value={s.today} sub="documents" />
        <StatCard i={4} icon={History} label="Last 7 days" value={s.week} sub="documents" />
        <StatCard i={5} tone="amber" icon={PencilLine} label="Reviewed" value={s.edited}
                  sub={s.done.length
                    ? (s.edited
                        ? `${((s.edited / s.done.length) * 100).toFixed(0)}% of documents needed a fix`
                        : 'no corrections needed')
                    : ''} />
      </div>

      <div className="panel animate-fade-up p-5">
        <h2 className="mb-4 text-[13px] font-semibold text-ink">Documents per day (last 14 days)</h2>
        {s.done.length === 0 ? (
          <p className="py-6 text-center text-[12.5px] text-ink-faint">
            Nothing processed yet. Upload an akta to get started.
          </p>
        ) : (
          <div className="pl-7">
            <div className="relative" style={{ height: PLOT_H }}>
              {/* gridlines + y labels, positioned by value so bars line up with them */}
              {axis.ticks.map((t) => (
                <div key={t} className="absolute inset-x-0 flex items-center"
                     style={{ bottom: `${(t / axis.top) * PLOT_H}px` }}>
                  <span className="absolute -left-7 w-6 text-right text-[10px] leading-none text-ink-faint">
                    {t}
                  </span>
                  <div className={`h-px w-full ${t === 0 ? 'bg-line' : 'bg-line-soft'}`} />
                </div>
              ))}
              {/* bars share the same scale as the axis */}
              <div className="absolute inset-0 flex items-end gap-1.5">
                {s.days.map(([day, n]) => (
                  <div key={day} className="group flex h-full min-w-[22px] flex-1 items-end"
                       title={`${day}: ${n} document${n === 1 ? '' : 's'}`}>
                    <div className={`w-full rounded-t transition-colors ${
                      n ? 'bg-brand/80 group-hover:bg-brand' : 'bg-transparent'}`}
                         style={{ height: `${(n / axis.top) * PLOT_H}px` }} />
                  </div>
                ))}
              </div>
            </div>
            {/* x labels sit under the plot, on the same flex rhythm as the bars */}
            <div className="mt-1.5 flex gap-1.5">
              {s.days.map(([day]) => (
                <span key={day} className="min-w-[22px] flex-1 text-center text-[9px] text-ink-faint">
                  {day.slice(5)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <div className="panel animate-fade-up overflow-hidden">
          <div className="flex items-center justify-between border-b border-line-soft px-5 py-3">
            <span className="label">Latest documents</span>
            <button onClick={() => onGoTo('history')}
                    className="inline-flex items-center gap-0.5 text-[11.5px] font-medium text-ink-faint transition-colors hover:text-brand">
              View all <ChevronRight size={13} />
            </button>
          </div>
          <ul className="max-h-[42vh] divide-y divide-line-soft overflow-y-auto">
            {recent.map((j) => (
              <li key={j.id}>
                <button onClick={() => onOpen(j.id)} title="View extraction result"
                        className="group flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-surface">
                  <FileText size={15} className="shrink-0 text-navy-light" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{j.filename}</div>
                    <div className="truncate text-[11.5px] text-ink-faint">{j.company || '-'}</div>
                  </div>
                  <span className="shrink-0 text-[11.5px] text-ink-faint">
                    {j.pages} pages · {j.duration_s}s
                  </span>
                  <ChevronRight size={14}
                                className="shrink-0 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:text-brand" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- Upload */
function UploadView({ jobs, onUpload, uploading, error, onOpen }) {
  const brand = useBrand()
  const maxActive = brand.max_active || 10
  const atOnce = brand.concurrent_per_user || 2
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef(null)
  const recent = jobs.slice(0, 30)

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="animate-fade-up">
        <h1 className="text-[19px] font-semibold text-ink">Upload Akta</h1>
        <p className="mt-0.5 text-[13px] text-ink-soft">
          Drop an akta pendirian or akta perubahan PDF, scanned or typed, and get back the structured record.
        </p>
      </header>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); onUpload(e.dataTransfer.files) }}
        onClick={() => fileRef.current?.click()}
        className={clsx('panel animate-fade-up cursor-pointer p-10 text-center transition-all',
          dragOver ? 'border-brand bg-brand-tint shadow-lift' : 'hover:border-navy-light hover:shadow-lift')}
      >
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-tint">
          <UploadCloud size={22} className="text-brand" />
        </div>
        <p className="text-[13.5px] font-medium text-ink">
          {uploading ? 'Uploading…' : 'Drag PDFs here, or click to browse'}
        </p>
        <p className="mt-1 text-[12px] text-ink-faint">
          Up to {maxActive} PDFs at once — {atOnce} are processed at a time, the rest queue
        </p>
        <input ref={fileRef} type="file" accept=".pdf" multiple hidden
               onChange={(e) => { onUpload(e.target.files); e.target.value = '' }} />
      </div>
      {error && (
        <p className="animate-fade-up rounded-lg border border-alert/30 bg-alert-tint px-3 py-2 text-[12.5px] text-alert">
          {error}
        </p>
      )}

      {recent.length > 0 && (
        <div className="panel animate-fade-up overflow-hidden">
          <div className="flex items-center justify-between border-b border-line-soft px-5 py-3">
            <span className="label">Recent</span>
            <span className="text-[11px] text-ink-faint">Click a document to view its result</span>
          </div>
          <ul className="max-h-[45vh] divide-y divide-line-soft overflow-y-auto">
            {recent.map((j) => (
              <li key={j.id}>
                <button onClick={() => onOpen(j.id)} title="View extraction result"
                        className="group flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-surface">
                  <FileText size={15} className="shrink-0 text-navy-light" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{j.filename}</div>
                    <div className="truncate text-[11.5px] text-ink-faint">{j.company || '-'}</div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <StatusBadge job={j} />
                    <span className="text-[10.5px] text-ink-faint">
                      {new Date(j.created).toLocaleString('en-GB')}
                    </span>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-[11.5px] font-medium text-ink-faint transition-colors group-hover:text-brand">
                    View
                    <ChevronRight size={14} className="transition-transform group-hover:translate-x-0.5" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- History */
// Quick relative ranges; a custom start/end date clears the quick pick and vice
// versa, so exactly one time filter is ever active.
const QUICK_RANGES = [
  ['', 'All time'],
  ['5m', 'Last 5 min'],
  ['15m', 'Last 15 min'],
  ['1h', 'Last 1 hour'],
  ['24h', 'Last 24 hours'],
  ['2d', 'Last 2 days'],
  ['7d', 'Last 7 days'],
  ['1mo', 'Last 1 month'],
  ['3mo', 'Last 3 months'],
  ['1y', 'Last 1 year'],
]
const DAY_MS = 86400e3
const QUICK_MS = {
  '5m': 5 * 60e3, '15m': 15 * 60e3, '1h': 3600e3, '24h': DAY_MS,
  '2d': 2 * DAY_MS, '7d': 7 * DAY_MS, '1mo': 30 * DAY_MS, '3mo': 91 * DAY_MS, '1y': 365 * DAY_MS,
}

function HistoryView({ jobs, onOpen, onStop, onRetry, user }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [quick, setQuick] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [checked, setChecked] = useState(new Set())
  const [exporting, setExporting] = useState(false)

  const pickQuick = (q) => { setQuick(q); setFromDate(''); setToDate('') }
  const pickFrom = (v) => { setFromDate(v); setQuick('') }
  const pickTo = (v) => { setToDate(v); setQuick('') }

  const filtered = useMemo(() => {
    const cutoff = quick ? Date.now() - QUICK_MS[quick] : 0
    return jobs.filter((j) => {
      if (status === 'done' && j.status !== 'done') return false
      if (cutoff && new Date(j.created).getTime() < cutoff) return false
      // date range in the user's local time, inclusive on both ends
      if (fromDate && new Date(j.created) < new Date(`${fromDate}T00:00:00`)) return false
      if (toDate && new Date(j.created) > new Date(`${toDate}T23:59:59.999`)) return false
      const q = query.trim().toLowerCase()
      return !q || j.filename.toLowerCase().includes(q) || (j.company || '').toLowerCase().includes(q)
    })
  }, [jobs, query, status, quick, fromDate, toDate])

  const exportable = filtered.filter((j) => j.status === 'done')
  const editedCount = filtered.filter((j) => j.edited).length
  const selectedDone = exportable.filter((j) => checked.has(j.id))

  const toggle = (id) => setChecked((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const toggleAll = () => setChecked((prev) =>
    prev.size >= exportable.length ? new Set() : new Set(exportable.map((j) => j.id)))

  async function exportSelected() {
    const ids = selectedDone.length ? selectedDone.map((j) => j.id) : exportable.map((j) => j.id)
    if (!ids.length) return
    setExporting(true)
    try {
      exportJobsToExcel(await fetchFullJobs(ids, user))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3 animate-fade-up">
        <div>
          <h1 className="text-[19px] font-semibold text-ink">History</h1>
          <p className="mt-0.5 text-[13px] text-ink-soft">
            {filtered.length} document{filtered.length === 1 ? '' : 's'}
            {editedCount > 0 && (
              <span className="text-amber"> · {editedCount} edited</span>
            )}
            <span className="text-ink-faint"> · Click a document to view its result</span>
          </p>
        </div>
        <button onClick={exportSelected} disabled={exporting || exportable.length === 0}
                className="btn-primary">
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {selectedDone.length ? `Export ${selectedDone.length} to Excel` : 'Export all to Excel'}
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2 animate-fade-up">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search file or company…"
                 className="w-64 rounded-xl border border-line bg-paper py-2 pl-9 pr-3 text-[12.5px] outline-none transition focus:border-brand focus:shadow-focus" />
        </div>
        {[['all', 'All'], ['done', 'Done']].map(([key, label]) => (
          <button key={key} onClick={() => setStatus(key)}
                  className={clsx('chip transition-all', status === key && 'border-navy bg-navy text-white')}>
            {label}
          </button>
        ))}
        <select value={quick} onChange={(e) => pickQuick(e.target.value)} aria-label="Time range"
                className="rounded-xl border border-line bg-paper px-2.5 py-1.5 text-[12px] text-ink outline-none transition focus:border-navy-light">
          {QUICK_RANGES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <div className="flex items-center gap-1.5 text-[12px] text-ink-soft">
          <input type="date" value={fromDate} onChange={(e) => pickFrom(e.target.value)}
                 aria-label="Start date"
                 className="rounded-xl border border-line bg-paper px-2.5 py-1.5 text-[12px] text-ink outline-none transition focus:border-navy-light" />
          <span className="text-ink-faint">-</span>
          <input type="date" value={toDate} onChange={(e) => pickTo(e.target.value)}
                 aria-label="End date"
                 className="rounded-xl border border-line bg-paper px-2.5 py-1.5 text-[12px] text-ink outline-none transition focus:border-navy-light" />
          {(fromDate || toDate) && (
            <button onClick={() => { setFromDate(''); setToDate('') }}
                    className="text-[11.5px] text-ink-faint underline-offset-2 hover:text-ink hover:underline">
              clear
            </button>
          )}
        </div>
      </div>

      {/* the body scrolls under a sticky header, so a long history stays one screen */}
      <div className="panel animate-fade-up max-h-[62vh] overflow-auto">
        <table className="min-w-full text-[12.5px]">
          <thead className="sticky top-0 z-10 border-b border-line-soft bg-surface text-left">
            <tr>
              <th className="px-4 py-2.5">
                <input type="checkbox" className="accent-brand"
                       checked={exportable.length > 0 && checked.size >= exportable.length}
                       onChange={toggleAll} />
              </th>
              <th className="label px-3 py-2.5">File</th>
              <th className="label px-3 py-2.5">Company</th>
              <th className="label px-3 py-2.5">Status</th>
              <th className="label px-3 py-2.5">Pages</th>
              <th className="label px-3 py-2.5">Time</th>
              <th className="label px-3 py-2.5">Uploaded</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {filtered.map((j) => (
              <tr key={j.id} title="View extraction result"
                  className="group cursor-pointer transition-colors hover:bg-surface"
                  onClick={() => onOpen(j.id)}>
                <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  {j.status === 'done' && (
                    <input type="checkbox" className="accent-brand"
                           checked={checked.has(j.id)} onChange={() => toggle(j.id)} />
                  )}
                </td>
                <td className="max-w-[220px] truncate px-3 py-2.5 font-medium text-ink" title={j.filename}>
                  {j.filename}
                </td>
                <td className="max-w-[220px] truncate px-3 py-2.5 text-ink-soft" title={j.company}>
                  {j.company || '-'}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <StatusBadge job={j} />
                    {j.edited && (
                      <span className="rounded-full bg-amber-tint px-2 py-0.5 text-[11px] font-semibold text-amber"
                            title="Corrected by the user after extraction">
                        edited{j.edited_fields ? ` · ${j.edited_fields} field${j.edited_fields > 1 ? 's' : ''}` : ''}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-ink-soft">{j.pages || '-'}</td>
                <td className="px-3 py-2.5 text-ink-soft">
                  {j.status === 'done' || (j.status === 'stopped' && j.duration_s)
                    ? `${j.duration_s}s` : '-'}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-ink-faint">
                  {new Date(j.created).toLocaleString('en-GB')}
                </td>
                <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1.5">
                    {ACTIVE.has(j.status) && (
                      <button onClick={() => onStop(j.id)} title="Stop this document"
                              className="text-[11.5px] font-medium text-ink-faint hover:text-alert">
                        <StopCircle size={14} className="inline" /> Stop
                      </button>
                    )}
                    {j.status === 'stopped' && (
                      <button onClick={() => onRetry(j.id)} title="Run this document again"
                              className="text-[11.5px] font-medium text-ink-faint hover:text-brand">
                        <RotateCcw size={14} className="inline" /> Run again
                      </button>
                    )}
                    <span onClick={() => onOpen(j.id)}
                          className="inline-flex cursor-pointer items-center gap-0.5 text-[11.5px] font-medium text-ink-faint transition-colors group-hover:text-brand">
                      View
                      <ChevronRight size={14} className="transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-[12.5px] text-ink-faint">
                Nothing here yet. Upload an akta to get started.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
