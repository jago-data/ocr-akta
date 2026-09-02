import React, { createContext, useContext, useEffect, useState } from 'react'

const BrandContext = createContext({ name: 'OCR Akta', tagline: '', model: '' })

// GET /api/app once — AKTA_APP_NAME / AKTA_APP_TAGLINE rebrand without a rebuild.
export function BrandProvider({ children }) {
  const [brand, setBrand] = useState({ name: 'OCR Akta', tagline: '', model: '' })
  useEffect(() => {
    let alive = true
    fetch('/api/app')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setBrand(d) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>
}

export function useBrand() {
  return useContext(BrandContext)
}
