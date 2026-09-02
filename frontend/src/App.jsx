import React, { useCallback, useState } from 'react'
import { clearSession, session } from './lib/api'
import Login from './pages/Login'
import Workspace from './pages/Workspace'
import AdminDashboard from './pages/AdminDashboard'

// No router library (osg convention): /admin is read straight off the pathname
// and nginx's `try_files ... /index.html` makes the deep link work in prod.
export default function App() {
  const [sess, setSess] = useState(session())

  const onLogin = useCallback(() => setSess(session()), [])
  const onLogout = useCallback(() => {
    clearSession()
    setSess(session())
    window.location.href = '/'
  }, [])

  const isAdminRoute =
    typeof window !== 'undefined' &&
    window.location.pathname.replace(/\/+$/, '').toLowerCase() === '/admin'

  if (isAdminRoute) {
    if (sess.auth && sess.role === 'admin') return <AdminDashboard onLogout={onLogout} />
    return <Login onLogin={onLogin} adminMode />
  }
  if (!sess.auth) return <Login onLogin={onLogin} />
  return <Workspace onLogout={onLogout} />
}
