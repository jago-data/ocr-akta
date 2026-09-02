import React from 'react'
import { Loader2 } from 'lucide-react'

export default function StatusBadge({ job }) {
  const s = job.status
  if (s === 'done') {
    return <span className="rounded-full bg-okay-tint px-2 py-0.5 text-[11px] font-semibold text-okay">done</span>
  }
  if (s === 'error') {
    return <span className="rounded-full bg-alert-tint px-2 py-0.5 text-[11px] font-semibold text-alert">failed</span>
  }
  const label = s === 'ocr' ? `reading ${job.stage_done}/${job.stage_total}`
    : s === 'extract' ? `extracting ${job.stage_done}/${job.stage_total}` : 'queued'
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-tint px-2 py-0.5 text-[11px] font-semibold text-amber">
      <Loader2 size={11} className="animate-spin" /> {label}
    </span>
  )
}
