'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button, Input, Toast, useToasts } from '@govyzer/ui';
import { apiFetch, useSession } from '@/lib/api-client';
import { useI18n, useTheme } from '@/lib/i18n';
import { initials } from '@/lib/format';
import CommandPalette from './command-palette';
import GlobalSearch from './global-search';

const NAV = [
  { group: 'Overview', items: [{ href: '/dashboard', key: 'nav.executive', icon: '◈', permission: 'reports.read' }] },
  {
    group: 'Modules',
    items: [
      { href: '/ready', key: 'nav.ready', icon: '⌂', module: 'ready', permission: 'listings.read' },
      { href: '/offplan', key: 'nav.offplan', icon: '⌗', module: 'offplan', permission: 'projects.read' },
    ],
  },
  {
    group: 'Pipeline',
    items: [
      { href: '/leads', key: 'nav.leads', icon: '◎', permission: 'leads.read' },
      { href: '/contacts', key: 'nav.contacts', icon: '☰', permission: 'contacts.read' },
      { href: '/deals', key: 'nav.deals', icon: '⇄', permission: 'deals.read' },
      { href: '/calendar', key: 'nav.calendar', icon: '▤', permission: 'activities.read' },
      { href: '/communications', key: 'nav.communications', icon: '✉', permission: 'communications.read' },
      { href: '/documents', key: 'nav.documents', icon: '▣', permission: 'documents.read' },
    ],
  },
  {
    group: 'Insight & setup',
    items: [
      { href: '/reports', key: 'nav.reports', icon: '◑', permission: 'reports.read' },
      { href: '/automations', key: 'nav.automations', icon: '⚙', permission: 'workflows.read' },
      { href: '/integrations', key: 'nav.integrations', icon: '⇋', permission: 'integrations.read' },
      { href: '/sales-screen', key: 'nav.salesScreen', icon: '▶', module: 'sales_screen', permission: 'sales_screen.read' },
      { href: '/settings', key: 'nav.settings', icon: '⚑', permission: 'organization.read' },
    ],
  },
];

export default function AppShell({ children }) {
  const { session, loading } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const { t, locale, setLocale, dir } = useI18n();
  const { theme, toggle } = useTheme();
  const { toasts, dismiss } = useToasts();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!loading && !session) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [loading, session, router, pathname]);

  const nav = useMemo(() => {
    if (!session) return [];
    return NAV.map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if (item.module && !session.hasModule(item.module)) return false;
        return !item.permission || session.can(item.permission);
      }),
    })).filter((group) => group.items.length > 0);
  }, [session]);

  async function signOut() {
    await apiFetch('/v1/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
  }

  if (loading || !session) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <p className="muted">{t('common.loading')}</p>
      </div>
    );
  }

  const organizationName = session.organization?.slug ?? 'Workspace';

  return (
    <div className="shell" dir={dir}>
      <nav className={`shell__sidebar${sidebarOpen ? ' is-open' : ''}`} aria-label="Main navigation">
        <div className="shell__brand">
          <span className="shell__brand-mark" aria-hidden="true">
            {initials(organizationName)}
          </span>
          <span>
            <span className="shell__brand-name">{organizationName}</span>
            <span className="shell__brand-plan">{session.organization?.plan_code ?? 'workspace'}</span>
          </span>
        </div>

        {nav.map((group) => (
          <div key={group.group}>
            <p className="shell__group-label">{group.group}</p>
            {group.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link key={item.href} href={item.href} className={`shell__link${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined}>
                  <span className="shell__link-icon" aria-hidden="true">{item.icon}</span>
                  {t(item.key)}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="shell__main">
        {!online ? <div className="offline-banner">You are offline. Data shown may be out of date.</div> : null}
        <header className="shell__topbar">
          <Button variant="ghost" size="sm" onClick={() => setSidebarOpen((value) => !value)} aria-label="Toggle navigation" className="only-mobile">
            ☰
          </Button>
          <div className="shell__search">
            <GlobalSearch />
          </div>
          <div className="shell__topbar-actions">
            <Button variant="ghost" size="sm" onClick={() => setPaletteOpen(true)} title="Command palette (⌘K)">
              ⌘K
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setLocale(locale === 'en' ? 'ar' : 'en')} title={t('common.language')}>
              {locale === 'en' ? 'العربية' : 'EN'}
            </Button>
            <Button variant="ghost" size="sm" onClick={toggle} title={t('common.theme')} aria-label={t('common.theme')}>
              {theme === 'light' ? '☾' : '☀'}
            </Button>
            <Link href="/settings/profile" className="avatar" title={session.user?.email}>
              {initials(`${session.user?.first_name ?? ''} ${session.user?.last_name ?? ''}`)}
            </Link>
            <Button variant="ghost" size="sm" onClick={signOut}>
              {t('common.signOut')}
            </Button>
          </div>
        </header>

        <main className="shell__content">{children}</main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} session={session} />
      <Toast toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
