import './globals.css';
import { I18nProvider } from '@/lib/i18n';

export const metadata = {
  title: { default: 'Govyzer CRM', template: '%s · Govyzer' },
  description: 'Multi-tenant real estate CRM for UAE brokerages and developers.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Govyzer',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Govyzer' },
  formatDetection: { telephone: false },
};

export const viewport = {
  themeColor: '#0F5132',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
