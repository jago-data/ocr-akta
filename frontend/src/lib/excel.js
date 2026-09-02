import * as XLSX from 'xlsx'
import { userHeaders } from './api'

const SCALAR_KEYS = [
  'nama_perusahaan', 'nama_perusahaan_cleaned', 'nomor_akta', 'tanggal_akta',
  'tanggal_perusahaan_berdiri', 'tempat_perusahaan_berdiri', 'jangka_waktu_perseroan',
  'masa_berlaku_direksi_dalam_tahun', 'masa_berlaku_komisaris_dalam_tahun',
  'tanggal_berlaku_direksi', 'tanggal_berlaku_komisaris',
  'pengurus_dan_pemegang_saham_tertinggi',
]
const PERSON_KEYS = [
  'nama', 'nama_cleaned', 'jabatan', 'no_ktp_passport', 'tempat_lahir',
  'tanggal_lahir', 'warga_negara', 'alamat', 'jumlah_lembar_saham', 'persentase_saham',
]

export async function fetchFullJobs(ids, username) {
  const results = await Promise.all(ids.map(async (id) => {
    const r = await fetch(`/api/jobs/${id}?username=${encodeURIComponent(username)}`,
      { headers: userHeaders() })
    return r.ok ? r.json() : null
  }))
  return results.filter((j) => j && j.status === 'done' && j.result)
}

// Two sheets: one row per document, one row per board member — the shape reviewers
// actually filter and pivot on, rather than one JSON blob per cell.
export function exportJobsToExcel(jobsWithResults) {
  const companies = jobsWithResults.map((job) => {
    // job.result IS the reviewed record: saving an edit overwrites it, so the
    // export always carries the corrections — these columns make that auditable
    const r = job.result
    const row = {
      file: job.filename,
      extracted_at: job.finished,
      pages: job.pages,
      edited: job.edited ? 'YES' : '',
      edited_fields: job.edited_fields || '',
    }
    for (const k of SCALAR_KEYS) row[k] = r[k] || ''
    row.bidang_industri_perusahaan = (r.bidang_industri_perusahaan || []).join('; ')
    row.directors = (r.board_of_directors || []).length
    row.commissioners = (r.board_of_commissioners || []).length
    return row
  })

  const people = jobsWithResults.flatMap((job) => {
    const r = job.result
    const boards = [
      ['DIREKSI', r.board_of_directors || []],
      ['KOMISARIS', r.board_of_commissioners || []],
    ]
    return boards.flatMap(([board, members]) => members.map((p) => {
      const row = { file: job.filename, company: r.nama_perusahaan || '', board }
      for (const k of PERSON_KEYS) row[k] = p[k] || ''
      return row
    }))
  })

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(companies), 'Companies')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(people), 'Board Members')
  XLSX.writeFile(wb, `ocr-akta-export-${new Date().toISOString().slice(0, 10)}.xlsx`)
}
