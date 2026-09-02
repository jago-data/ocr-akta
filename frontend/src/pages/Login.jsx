import React, { useState } from 'react'
import { ArrowRight, Check, Copy, LifeBuoy, Loader2, ScanText } from 'lucide-react'
import clsx from 'clsx'
import { storeSession } from '../lib/api'
import { useBrand } from '../lib/brand'

const FEATURES = [
  'Works with scanned and digital akta PDFs',
  'Extracts the company profile, Direksi and Dewan Komisaris automatically',
  'Checks NIK and dates so the record stays consistent',
  'Review side by side with the PDF, edit, then export to Excel',
]

export default function Login({ onLogin, adminMode = false }) {
  const brand = useBrand()
  const [username, setUsername] = useState(() =>
    localStorage.getItem('akta_remember') === 'true' ? localStorage.getItem('akta_saved_user') || '' : '')
  const [password, setPassword] = useState(() => {
    if (localStorage.getItem('akta_remember') !== 'true') return ''
    try {
      return decodeURIComponent(escape(atob(localStorage.getItem('akta_saved_pass') || '')))
    } catch { return '' }
  })
  const [remember, setRemember] = useState(() => localStorage.getItem('akta_remember') === 'true')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  async function copyHelpdesk() {
    try {
      await navigator.clipboard.writeText(brand.helpdesk)
    } catch {
      // Clipboard access is refused on http:// origins in some browsers; fall back
      // to a selection-based copy so the button still does what it says.
      const field = document.createElement('textarea')
      field.value = brand.helpdesk
      field.setAttribute('readonly', '')
      field.style.position = 'fixed'
      field.style.opacity = '0'
      document.body.appendChild(field)
      field.select()
      try { document.execCommand('copy') } catch { /* nothing more to try */ }
      field.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      if (r.status === 429) {
        setError('Too many failed attempts. Try again in a few minutes.')
      } else {
        const data = await r.json()
        if (r.ok && data.success) {
          if (adminMode && data.role !== 'admin') {
            setError('This account is not an administrator.')
          } else {
            if (remember) {
              localStorage.setItem('akta_remember', 'true')
              localStorage.setItem('akta_saved_user', username)
              localStorage.setItem('akta_saved_pass', btoa(unescape(encodeURIComponent(password))))
            } else {
              for (const k of ['akta_remember', 'akta_saved_user', 'akta_saved_pass']) {
                localStorage.removeItem(k)
              }
            }
            storeSession(data)
            onLogin(data.role)
          }
        } else {
          setError('Those credentials were not accepted.')
        }
      }
    } catch {
      setError('We could not reach the server. Please try again.')
    }
    setBusy(false)
  }

  return (
    // A single deep-night field: indigo core with a warm red aurora top-left and a
    // cool steel glow bottom-right, both drifting slowly. No light seam — the white
    // card carries all the contrast.
    <div className="relative min-h-screen overflow-hidden bg-[#080F22]">
      <div className="absolute inset-0 bg-[radial-gradient(1300px_900px_at_72%_18%,#28477E_0%,#16294E_44%,#0A142C_78%,#080F22_100%)]" />
      <div className="absolute inset-0 animate-drift bg-[radial-gradient(950px_700px_at_2%_-10%,rgba(222,44,72,.42),rgba(150,20,60,.16)_45%,transparent_66%)] will-change-transform" />
      <div className="absolute inset-0 animate-drift-slow bg-[radial-gradient(850px_640px_at_96%_104%,rgba(96,150,220,.32),transparent_60%)] will-change-transform" />
      <div className="absolute inset-0 bg-[linear-gradient(160deg,transparent_55%,rgba(8,15,34,.55)_100%)]" />


      <div className="relative mx-auto flex min-h-screen max-w-7xl items-center justify-center px-6 py-10">
        {/* items-start keeps the hero text level with the top of the sign-in card */}
        <div className="grid w-full items-start gap-12 lg:grid-cols-[1.05fr_minmax(320px,360px)] lg:gap-16">

          {/* Left: what this thing is. */}
          <section className="stagger hidden text-white lg:block [--step:90ms]">
            <div className="animate-rise" style={{ '--i': 0 }}><Logo name={brand.name} /></div>

            <h1 className="animate-rise mt-10 text-[44px] font-semibold leading-[1.08] tracking-tight"
                style={{ '--i': 1 }}>
              Upload the akta.<br />Get the data.
            </h1>

            <p className="animate-rise mt-5 max-w-xl text-[15px] leading-relaxed text-white/75"
               style={{ '--i': 2 }}>
              {brand.name} reads an Indonesian akta pendirian, scanned or typed, and returns
              one structured, validated record: the company, its boards, and who holds what.
            </p>

            <ul className="stagger mt-8 space-y-3 text-[13.5px] text-white/80 [--step:80ms]">
              {FEATURES.map((f, i) => (
                <li key={f} className="animate-rise flex items-center gap-3" style={{ '--i': i + 3 }}>
                  <span className="relative flex h-1.5 w-1.5 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ring rounded-full bg-brand-light"
                          style={{ animationDelay: `${i * 700}ms` }} />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-light" />
                  </span>
                  {f}
                </li>
              ))}
            </ul>

          </section>

          {/* Right: the form, in a gradient-edged box with the OCR scan animation. */}
          <div className="w-full animate-zoom-in rounded-3xl bg-gradient-to-br from-brand via-navy-light to-navy
                          p-[1.5px] shadow-lift [animation-delay:220ms]">
            <form onSubmit={submit}
                  className="space-y-4 rounded-3xl bg-paper/95 p-6 backdrop-blur-sm">
              <div className="lg:hidden"><Logo name={brand.name} dark /></div>

              <div>
                <h2 className="bg-gradient-to-r from-navy-dark via-navy to-brand bg-clip-text text-lg
                               font-semibold text-transparent">
                  {adminMode ? 'Admin sign in' : 'Sign in'}
                </h2>
                <p className="mt-1 text-[12.5px] text-ink-soft">
                  Sign in with your employee access.
                </p>
              </div>

              <label className="block">
                <span className="label">Username</span>
                <input value={username} onChange={(e) => setUsername(e.target.value)}
                       autoFocus autoComplete="username" className="field" />
              </label>
              <label className="block">
                <span className="label">Password</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                       autoComplete="current-password" className="field" />
              </label>

              <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-soft">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)}
                       className="accent-brand" />
                Remember me
              </label>

              {error && (
                <p className="animate-fade-up rounded-lg border border-alert/30 bg-alert-tint px-3 py-2 text-[12.5px] text-alert">
                  {error}
                </p>
              )}

              <button type="submit" disabled={busy || !username || !password}
                      className="btn group w-full bg-gradient-to-r from-brand via-brand-dark to-navy
                                 bg-[length:200%_100%] bg-left text-white shadow-panel transition-all
                                 duration-300 hover:bg-right">
                {busy ? <Loader2 size={15} className="animate-spin" />
                      : <>Enter {brand.name} <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" /></>}
              </button>

              {/* Who to write to when the sign-in itself is the problem (osg pattern).
                  An empty AKTA_HELPDESK_EMAIL hides the box. */}
              {brand.helpdesk && (
                // Fixed structure (title / email line / note) so the box stays tidy
                // whatever address is configured — long emails truncate, never wrap.
                <div className="rounded-2xl border border-line-soft bg-surface px-4 py-3">
                  <div className="flex items-start gap-2.5">
                    <LifeBuoy size={15} className="mt-0.5 shrink-0 text-brand" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-medium text-ink">
                        Trouble signing in or need access?
                      </p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <a href={`mailto:${brand.helpdesk}`} title={brand.helpdesk}
                           className="truncate text-[12px] font-semibold text-brand">
                          {brand.helpdesk}
                        </a>
                        <button type="button" onClick={copyHelpdesk}
                                title={copied ? 'Copied' : 'Copy email address'}
                                aria-label={copied ? 'Email address copied' : 'Copy email address'}
                                className={clsx('shrink-0 rounded p-0.5 transition-colors',
                                  copied ? 'text-okay' : 'text-ink-faint hover:text-ink')}>
                          {copied ? <Check size={12} /> : <Copy size={12} />}
                        </button>
                      </div>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">
                        Email the Help Desk with your username and the team will get back to you.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}

function Logo({ name, dark = false }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-white shadow-panel">
        <ScanText size={18} />
      </div>
      <div className={dark ? 'text-ink' : 'text-white'}>
        <div className="text-[15px] font-semibold uppercase tracking-tight">{name}</div>
        <div className={`text-[10px] uppercase tracking-[0.18em] ${dark ? 'text-ink-faint' : 'text-white/55'}`}>
          Akta Pendirian Extraction
        </div>
      </div>
    </div>
  )
}
