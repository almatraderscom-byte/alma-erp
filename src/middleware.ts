import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { rateLimit } from '@/lib/rate-limit'
import { isPathAllowedForRole, normalizeAlmaRole, roleHomePath } from '@/lib/roles'
import type { BusinessId } from '@/lib/businesses'
import { businessAllowed } from '@/lib/business-access'

const AUTH_PAGES = ['/login', '/forgot-password', '/reset-password']

function isPublicApiOrShare(pathname: string) {
  if (pathname.startsWith('/invoice/share')) return true
  if (pathname.startsWith('/api/auth')) return true
  if (pathname.startsWith('/api/cron/')) return true
  if (pathname === '/api/sms/process' || pathname === '/api/sms/trading-daily-summary') return true
  if (pathname === '/api/trading/screenshots/cleanup') return true
  if (pathname === '/api/trading/balance-reconcile') return true
  if (pathname === '/api/trading/screenshot-compliance') return true
  if (pathname.startsWith('/api/invoice/public')) return true
  if (pathname === '/api/telegram/webhook') return true
  if (/^\/api\/trading\/screenshots\/[^/]+\/telegram$/.test(pathname)) return true
  if (pathname === '/api/health') return true
  if (pathname === '/api/test-email') return process.env.NODE_ENV !== 'production'
  return false
}

function apiRoleDenied(pathname: string, method: string, role: ReturnType<typeof normalizeAlmaRole>) {
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
  if (role === 'VIEWER' && isWrite) return true

  if (pathname.startsWith('/api/business-archive')) {
    return role !== 'SUPER_ADMIN'
  }
  if (pathname.startsWith('/api/operational-tasks')) {
    if (pathname.includes('/my') || pathname.includes('/spotlight') || pathname.includes('/assignees')) {
      return false
    }
    if (pathname.includes('/assignments/') && isWrite) return false
    if (isWrite || pathname === '/api/operational-tasks') return role !== 'SUPER_ADMIN'
    return role !== 'SUPER_ADMIN'
  }
  if (pathname.startsWith('/api/audit')) return role !== 'SUPER_ADMIN'
  if (pathname.startsWith('/api/approvals')) return false
  if (pathname === '/api/users/me' || pathname === '/api/users/me/password') return false
  if (pathname === '/api/users/me/profile-image') return false
  if (/^\/api\/users\/[^/]+\/profile-image$/.test(pathname)) {
    if (!isWrite) return false
    return !['SUPER_ADMIN', 'ADMIN'].includes(role)
  }
  if (pathname.startsWith('/api/users')) return !['SUPER_ADMIN', 'ADMIN'].includes(role)
  if (pathname.startsWith('/api/settings/database-status')) return !['SUPER_ADMIN', 'ADMIN', 'HR'].includes(role)
  if (pathname.startsWith('/api/notifications/broadcast') || pathname.startsWith('/api/notifications/stats') || pathname.startsWith('/api/notifications/reminders')) {
    return !['SUPER_ADMIN', 'ADMIN'].includes(role)
  }
  if (pathname.startsWith('/api/sms')) return !['SUPER_ADMIN', 'ADMIN'].includes(role)
  if (pathname.startsWith('/api/settings/telegram-ops')) return !['SUPER_ADMIN', 'ADMIN'].includes(role)
  if (pathname.startsWith('/api/payroll/wallet/automation') || pathname.startsWith('/api/payroll/wallet/accruals') || pathname.startsWith('/api/payroll/wallet/migrate') || pathname.startsWith('/api/payroll/wallet/reports')) {
    return !['SUPER_ADMIN', 'HR'].includes(role)
  }
  if (pathname.startsWith('/api/hr')) return !['SUPER_ADMIN', 'HR'].includes(role)
  if (pathname.startsWith('/api/branding') && isWrite) return role !== 'SUPER_ADMIN'
  if (pathname.startsWith('/api/products') && isWrite) return !['SUPER_ADMIN', 'ADMIN'].includes(role)
  if (pathname.startsWith('/api/customers') && isWrite) return !['SUPER_ADMIN', 'ADMIN'].includes(role)
  if (pathname.startsWith('/api/supplier-import') && isWrite) return !['SUPER_ADMIN', 'ADMIN'].includes(role)
  if (pathname.startsWith('/api/invoice') && isWrite) return !['SUPER_ADMIN', 'ADMIN'].includes(role)
  if (pathname.startsWith('/api/digital') && isWrite) return !['SUPER_ADMIN', 'ADMIN'].includes(role)
  if (
    pathname.startsWith('/api/orders/orders/status')
    || pathname.startsWith('/api/orders/orders/field')
    || pathname.startsWith('/api/orders/orders/tracking')
  ) return !['SUPER_ADMIN', 'ADMIN'].includes(role)
  if (pathname.startsWith('/api/finance') && isWrite) return !['SUPER_ADMIN', 'ADMIN', 'HR'].includes(role)

  return false
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const secret = process.env.NEXTAUTH_SECRET

  if (!secret) {
    console.error('[middleware] NEXTAUTH_SECRET missing')
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const token = await getToken({ req, secret })

  if (AUTH_PAGES.some(p => pathname === p || pathname.startsWith(`${p}/`))) {
    if (token?.sub) {
      const url = req.nextUrl.clone()
      url.pathname = '/'
      url.search = ''
      return NextResponse.redirect(url)
    }
    return NextResponse.next()
  }

  if (pathname.startsWith('/api/')) {
    const limited = rateLimit(req, pathname.startsWith('/api/auth') ? 'auth' : 'api', pathname.startsWith('/api/auth') ? 20 : 180)
    if (limited) return limited
  }

  if (isPublicApiOrShare(pathname)) {
    return NextResponse.next()
  }

  if (!token?.sub) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('callbackUrl', pathname + req.nextUrl.search)
    return NextResponse.redirect(url)
  }

  if (pathname.startsWith('/api/')) {
    const role = normalizeAlmaRole(token.role as string)
    const requestedBusiness = req.nextUrl.searchParams.get('business_id')
    if (requestedBusiness && role !== 'SUPER_ADMIN' && !businessAllowed(token.businessAccess as string, requestedBusiness)) {
      return NextResponse.json({ error: 'Business not permitted for this user.' }, { status: 403 })
    }
    if (apiRoleDenied(pathname, req.method, role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  if (!pathname.startsWith('/api/')) {
    const role = normalizeAlmaRole(token.role as string)
    const businessId: BusinessId = pathname.startsWith('/trading')
      ? 'ALMA_TRADING'
      : pathname.startsWith('/digital')
        ? 'CREATIVE_DIGITAL_IT'
        : 'ALMA_LIFESTYLE'
    if (!isPathAllowedForRole(pathname, role, businessId)) {
      const url = req.nextUrl.clone()
      url.pathname = roleHomePath(role, businessId)
      url.search = ''
      return NextResponse.redirect(url)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|OneSignalSDKWorker.js|OneSignalSDKUpdaterWorker.js|offline.html|fonts/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
