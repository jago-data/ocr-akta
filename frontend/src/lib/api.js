// Session helpers — localStorage keys mirror the osg convention (akta_ prefix).
export const API_BASE = '/api'

export function session() {
  return {
    auth: localStorage.getItem('akta_auth') === 'true',
    user: localStorage.getItem('akta_user') || '',
    name: localStorage.getItem('akta_name') || '',
    role: localStorage.getItem('akta_role') || '',
    token: localStorage.getItem('akta_token') || '',
    adminToken: localStorage.getItem('akta_admin_token') || '',
  }
}

export function storeSession(data) {
  localStorage.setItem('akta_auth', 'true')
  localStorage.setItem('akta_user', data.username)
  localStorage.setItem('akta_name', data.name || data.username)
  localStorage.setItem('akta_role', data.role || 'employee')
  if (data.session_token) localStorage.setItem('akta_token', data.session_token)
  if (data.token) localStorage.setItem('akta_admin_token', data.token)
}

export function clearSession() {
  for (const k of ['akta_auth', 'akta_user', 'akta_name', 'akta_role', 'akta_token', 'akta_admin_token']) {
    localStorage.removeItem(k)
  }
}

export function userHeaders() {
  // No per-user token by deployment decision — identity travels as the username
  // param; the function stays so call sites don't churn if that ever changes.
  return {}
}

export function adminHeaders() {
  return { 'X-Akta-Admin-Token': localStorage.getItem('akta_admin_token') || '' }
}
