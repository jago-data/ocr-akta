import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, CheckCircle2, Clock, Download, FileText, LayoutDashboard, Layers,
  LogOut, ScanText, Trash2, Users, XCircle,
} from 'lucide-react'
import clsx from 'clsx'
import * as XLSX from 'xlsx'
import { adminHeaders, clearSession, session } from '../lib/api'
import { useBrand } from '../lib/brand'

const POLL_MS = 15000

const NAV = [
  ['overview', 'Overview', LayoutDashboard],
  ['users', 'Users', Users],
  ['activity', 'Activity', Activity],
]

// Series drawn on the trend chart — same treatment as osg-prod's TrendChart.
const TREND_SERIES = [
  { key: 'total', label: 'Extractions', color: '#16325C' },
  { key: 'users', label: 'Unique users', color: '#3A5D96' },
  { key: 'failed', label: 'Failed', color: '#D42030' },
]

/* ------------------------------------------------------------------ chart */
// Ported from osg-prod's AdminDashboard TrendChart: drawn in real pixels
// (a scaled viewBox letterboxes wide panels), fixed-step Y axis, and a
// nearest-day hover so the whole plot is the pointer target.
function niceStep(peak) {
  const raw = Math.max(1, peak) / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) {
    if (raw <= m * mag) return m * mag
  }
  return 10 * mag
}

function TrendChart({ data, height = 230 }) {
  const box = useRef(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState(null)

  useEffect(() => {
    const el = box.current
    if (!el) return undefined
    const measure = () => setWidth(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const PAD_L = 40, PAD_R = 14, PAD_T = 10, PAD_B = 24
  const plotW = Math.max(0, width - PAD_L - PAD_R)
  const peak = Math.max(1, ...data.flatMap((d) => TREND_SERIES.map((s) => d[s.key])))
  const step = niceStep(peak)
  const top = Math.max(step, Math.ceil(peak / step) * step)
  const x = (i) => (data.length === 1 ? PAD_L + plotW / 2 : PAD_L + (i * plotW) / (data.length - 1))
  const y = (v) => PAD_T + (1 - v / top) * (height - PAD_T - PAD_B)
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step)
  const labelEvery = Math.ceil(ticks.length / 8)
  const every = Math.max(1, Math.ceil(data.length / Math.max(4, Math.floor(width / 90))))

  function onMove(event) {
    if (!data.length || !plotW) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = data.length === 1 ? 0 : (event.clientX - rect.left - PAD_L) / plotW
    setHover(Math.max(0, Math.min(data.length - 1, Math.round(ratio * (data.length - 1)))))
  }

  if (!data.length) {
    return <p className="py-10 text-center text-[12px] text-ink-faint">No activity yet.</p>
  }
  const point = hover == null ? null : data[hover]

  return (
    <div ref={box} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Extractions, users and failures per day"
             onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {ticks.map((t, i) => (
            <g key={t}>
              <line x1={PAD_L} x2={width - PAD_R} y1={y(t)} y2={y(t)} stroke="#DDE4EF" />
              {i % labelEvery === 0 && (
                <text x={PAD_L - 8} y={y(t) + 3} textAnchor="end" fontSize="10" fill="#8892A8">{t}</text>
              )}
            </g>
          ))}
          {point && (
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={height - PAD_B}
                  stroke="#D42030" strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
          )}
          {TREND_SERIES.map((s) => (
            <polyline key={s.key} fill="none" stroke={s.color} strokeWidth="2"
                      strokeLinejoin="round" strokeLinecap="round"
                      points={data.map((d, i) => `${x(i)},${y(d[s.key])}`).join(' ')} />
          ))}
          {/* a dot per data point — a one-day history has no line segment to show,
              so without these the chart looks empty on the first day of use */}
          {TREND_SERIES.map((s) => data.map((d, i) => (
            <circle key={`${s.key}-${i}`} cx={x(i)} cy={y(d[s.key])}
                    r={data.length === 1 ? 4 : 2.5} fill={s.color} />
          )))}
          {point && TREND_SERIES.map((s) => (
            <circle key={s.key} cx={x(hover)} cy={y(point[s.key])} r="4"
                    fill="#fff" stroke={s.color} strokeWidth="2" />
          ))}
          {data.map((d, i) => (i % every === 0 ? (
            <text key={d.date} x={x(i)} y={height - 6} textAnchor="middle" fontSize="9.5" fill="#8892A8">
              {d.date.slice(5)}
            </text>
          ) : null))}
        </svg>
      )}
      {point && (
        <div className="pointer-events-none absolute rounded-lg border border-line bg-paper px-2.5 py-1.5 shadow-lift"
             style={{ top: 4, left: x(hover) + (x(hover) > width - 150 ? -138 : 10), minWidth: 126 }}>
          <div className="mb-0.5 text-[10.5px] font-bold text-ink">{point.date}</div>
          {TREND_SERIES.map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-3 text-[11px]">
              <span className="flex items-center gap-1.5 text-ink-soft">
                <span className="rounded-full" style={{ width: 8, height: 3, background: s.color }} />
                {s.label}
              </span>
              <span className="font-semibold text-ink">{point[s.key]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ stats */
function StatCard({ icon: Icon, label, value, sub, i }) {
  return (
    <div className="panel animate-rise p-4" style={{ '--i': i }}>
      <div className="flex items-center gap-1.5 text-ink-faint">
        <Icon size={13} /> <span className="label">{label}</span>
      </div>
      <div className="mt-1 text-[22px] font-semibold tracking-tight text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-faint">{sub}</div>}
    </div>
  )
}

function computeStats(events) {
  const ok = events.filter((e) => e.status === 'done' || e.status === 'ok')
  const users = new Set(events.map((e) => e.username))
  const pages = events.reduce((s, e) => s + (e.pages || 0), 0)
  const avgLatency = ok.length
    ? (ok.reduce((s, e) => s + (e.duration_s || 0), 0) / ok.length).toFixed(1)
    : '0'
  const byUser = {}
  for (const e of events) {
    const u = (byUser[e.username] ||= { username: e.username, total: 0, ok: 0, pages: 0, last: '' })
    u.total += 1
    if (e.status === 'done' || e.status === 'ok') u.ok += 1
    u.pages += e.pages || 0
    if (e.ts > u.last) u.last = e.ts
  }
  const byDay = {}
  for (const e of events) {
    const day = (e.ts || '').slice(0, 10)
    if (!day) continue
    const d = (byDay[day] ||= { date: day, total: 0, failed: 0, userSet: new Set() })
    d.total += 1
    if (!(e.status === 'done' || e.status === 'ok')) d.failed += 1
    d.userSet.add(e.username)
  }
  const trend = Object.values(byDay)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30)
    .map((d) => ({ date: d.date, total: d.total, failed: d.failed, users: d.userSet.size }))
  return { ok: ok.length, failed: events.length - ok.length, users: users.size, pages, avgLatency, byUser, trend }
}

/* ------------------------------------------------------------------ page */
export default function AdminDashboard({ onLogout }) {
  const brand = useBrand()
  const { name } = session()
  const [view, setView] = useState('overview')
  const [events, setEvents] = useState([])
  const [error, setError] = useState('')
  const [clearing, setClearing] = useState(false)
  // Two-step, because this cannot be undone: the first press arms, the second commits.
  // Disarms on its own so a stray click cannot leave a live delete button sitting there.
  const [armed, setArmed] = useState(false)
  const stamp = useRef('')

  async function clearFailed() {
    setClearing(true)
    try {
      const r = await fetch('/api/admin/usage/clear-failed', {
        method: 'POST', headers: adminHeaders(),
      })
      if (r.status === 401) { setError('Your admin session has expired. Please sign in again.'); return }
      if (!r.ok) { setError('Could not clear the failed events. Please try again.'); return }
      setArmed(false)
      await load()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setClearing(false)
    }
  }

  useEffect(() => {
    if (!armed) return undefined
    const t = setTimeout(() => setArmed(false), 5000)
    return () => clearTimeout(t)
  }, [armed])

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/analytics', { headers: adminHeaders() })
      if (r.status === 401) { setError('Your admin session has expired. Please sign in again.'); return }
      if (!r.ok) return
      setEvents((await r.json()).events || [])
      setError('')
      const sr = await fetch('/api/admin/analytics/stamp', { headers: adminHeaders() })
      if (sr.ok) stamp.current = (await sr.json()).stamp || ''
    } catch { /* transient — next poll retries */ }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(async () => {
      try {
        const r = await fetch('/api/admin/analytics/stamp', { headers: adminHeaders() })
        if (r.ok && ((await r.json()).stamp || '') === stamp.current) return
        load()
      } catch { /* transient */ }
    }, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const stats = useMemo(() => computeStats(events), [events])
  // computeStats already counts these; naming it here keeps the button honest about how
  // many records it is about to delete.
  const failedCount = stats.failed
  const recent = useMemo(() => [...events].reverse().slice(0, 100), [events])
  const userRows = useMemo(
    () => Object.values(stats.byUser).sort((a, b) => b.total - a.total),
    [stats],
  )

  function exportXlsx() {
    const ws = XLSX.utils.json_to_sheet(events)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'usage')
    XLSX.writeFile(wb, `ocr-akta-usage-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  function signOut() {
    clearSession()
    onLogout()
  }

  return (
    <div className="flex min-h-screen">
      {/* --------------------------------------------- sidebar (same as workspace) */}
      <aside className="fixed inset-y-0 left-0 z-20 flex w-56 flex-col bg-navy-dark text-white">
        <div className="flex items-center gap-2.5 px-5 pb-6 pt-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand shadow-panel">
            <ScanText size={16} />
          </div>
          <div>
            <div className="text-[13px] font-semibold uppercase tracking-tight">{brand.name}</div>
            <div className="text-[9px] uppercase tracking-[0.16em] text-white/50">Admin Dashboard</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {NAV.map(([key, label, Icon]) => (
            <button key={key} onClick={() => setView(key)}
                    className={clsx('flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all',
                      view === key
                        ? 'bg-white/10 text-white shadow-panel'
                        : 'text-white/60 hover:bg-white/5 hover:text-white')}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </nav>

        <div className="border-t border-white/10 px-5 py-4">
          <div className="truncate text-[12.5px] font-medium">{name}</div>
          <button onClick={signOut}
                  className="mt-1.5 flex items-center gap-1.5 text-[12px] text-white/55 transition-colors hover:text-brand-light">
            <LogOut size={13} /> Sign out
          </button>
        </div>
      </aside>

      {/* --------------------------------------------- content */}
      <main className="ml-56 flex-1 space-y-5 px-8 py-7">
        {error && (
          <p className="rounded-lg border border-alert/30 bg-alert-tint px-3 py-2 text-[12.5px] text-alert">{error}</p>
        )}

        {view === 'overview' && (
          <div className="mx-auto max-w-5xl space-y-5">
            <header className="flex flex-wrap items-end justify-between gap-3 animate-fade-up">
              <div>
                <h1 className="text-[19px] font-semibold text-ink">Overview</h1>
                <p className="mt-0.5 text-[13px] text-ink-soft">Usage across every account, refreshed live.</p>
              </div>
              <button onClick={exportXlsx} className="btn-ghost">
                <Download size={14} /> Export usage XLSX
              </button>
            </header>

            <div className="stagger grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6 [--step:60ms]">
              <StatCard i={0} icon={Activity} label="Extractions" value={events.length} />
              <StatCard i={1} icon={CheckCircle2} label="Succeeded" value={stats.ok} />
              <StatCard i={2} icon={XCircle} label="Failed" value={stats.failed}
                        sub={events.length ? `${((stats.ok / events.length) * 100).toFixed(1)}% success` : ''} />
              <StatCard i={3} icon={Users} label="Users" value={stats.users} />
              <StatCard i={4} icon={Layers} label="Pages Read" value={stats.pages} />
              <StatCard i={5} icon={Clock} label="Avg Duration" value={`${stats.avgLatency}s`} sub="successful jobs" />
            </div>

            <div className="panel animate-fade-up p-5">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[13px] font-semibold text-ink">Daily trend (last 30 days)</h2>
                <div className="flex items-center gap-3">
                  {TREND_SERIES.map((s) => (
                    <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-ink-soft">
                      <span className="rounded-full" style={{ width: 10, height: 3, background: s.color }} />
                      {s.label}
                    </span>
                  ))}
                </div>
              </div>
              <TrendChart data={stats.trend} />
            </div>
          </div>
        )}

        {view === 'users' && (
          <div className="mx-auto max-w-4xl space-y-4">
            <header className="animate-fade-up">
              <h1 className="text-[19px] font-semibold text-ink">Usage by user</h1>
              <p className="mt-0.5 text-[13px] text-ink-soft">Who is extracting, and how much.</p>
            </header>
            <div className="panel animate-fade-up overflow-x-auto p-5">
              <table className="min-w-full text-[12.5px]">
                <thead className="text-left">
                  <tr>
                    <th className="label py-2 pr-3">Username</th>
                    <th className="label py-2 pr-3">Jobs</th>
                    <th className="label py-2 pr-3">OK</th>
                    <th className="label py-2 pr-3">Pages</th>
                    <th className="label py-2">Last active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {userRows.map((u) => (
                    <tr key={u.username}>
                      <td className="py-2 pr-3 font-medium text-ink">{u.username}</td>
                      <td className="py-2 pr-3">{u.total}</td>
                      <td className="py-2 pr-3">{u.ok}</td>
                      <td className="py-2 pr-3">{u.pages}</td>
                      <td className="py-2 text-ink-faint">
                        {u.last ? new Date(u.last).toLocaleString('en-GB') : '-'}
                      </td>
                    </tr>
                  ))}
                  {userRows.length === 0 && (
                    <tr><td colSpan={5} className="py-6 text-center text-ink-faint">No data yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {view === 'activity' && (
          <div className="mx-auto max-w-5xl space-y-4">
            <header className="animate-fade-up flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="text-[19px] font-semibold text-ink">Recent activity</h1>
                <p className="mt-0.5 text-[13px] text-ink-soft">The last 100 extraction events.</p>
              </div>
              {failedCount > 0 && (
                <div className="flex items-center gap-2">
                  {armed && (
                    <span className="text-[12px] text-ink-soft">
                      Deletes {failedCount} record{failedCount > 1 ? 's' : ''} permanently.
                    </span>
                  )}
                  <button onClick={armed ? clearFailed : () => setArmed(true)} disabled={clearing}
                          className={armed ? 'btn bg-alert text-white hover:opacity-90' : 'btn-ghost'}>
                    <Trash2 size={14} />
                    {clearing ? 'Clearing…'
                      : armed ? 'Yes, delete them'
                        : `Clear ${failedCount} failed`}
                  </button>
                  {armed && !clearing && (
                    <button onClick={() => setArmed(false)} className="btn-ghost">Cancel</button>
                  )}
                </div>
              )}
            </header>
            <div className="panel animate-fade-up overflow-x-auto p-5">
              <table className="min-w-full text-[12.5px]">
                <thead className="text-left">
                  <tr>
                    <th className="label py-2 pr-3">When</th>
                    <th className="label py-2 pr-3">User</th>
                    <th className="label py-2 pr-3">Document</th>
                    <th className="label py-2 pr-3">Company</th>
                    <th className="label py-2 pr-3">Pages</th>
                    <th className="label py-2 pr-3">Time</th>
                    <th className="label py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {recent.map((e, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap py-2 pr-3 text-ink-faint">
                        {new Date(e.ts).toLocaleString('en-GB')}
                      </td>
                      <td className="py-2 pr-3">{e.username}</td>
                      <td className="max-w-[180px] truncate py-2 pr-3" title={e.filename}>{e.filename}</td>
                      <td className="max-w-[180px] truncate py-2 pr-3 text-ink-soft" title={e.company}>{e.company || '-'}</td>
                      <td className="py-2 pr-3">{e.pages || '-'}</td>
                      <td className="py-2 pr-3">{e.duration_s ? `${e.duration_s}s` : '-'}</td>
                      <td className="py-2">
                        {e.status === 'done' || e.status === 'ok'
                          ? <span className="text-[11px] font-semibold text-okay">OK</span>
                          : <span className="text-[11px] font-semibold text-alert" title={e.error}>FAILED</span>}
                      </td>
                    </tr>
                  ))}
                  {recent.length === 0 && (
                    <tr><td colSpan={7} className="py-6 text-center text-ink-faint">
                      <span className="inline-flex items-center gap-1.5"><FileText size={13} /> No activity yet.</span>
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
