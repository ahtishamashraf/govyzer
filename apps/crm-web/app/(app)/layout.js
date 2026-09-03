import AppShell from '@/components/app-shell';

export const dynamic = 'force-dynamic';

export default function AppLayout({ children }) {
  return <AppShell>{children}</AppShell>;
}
