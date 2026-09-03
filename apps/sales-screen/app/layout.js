import './globals.css';

export const metadata = {
  title: 'Govyzer Sales Screen',
  description: 'Live, approved sales results for office displays.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Govyzer Sales Screen',
};

export const viewport = {
  themeColor: '#070b12',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-theme="midnight">
      <body>{children}</body>
    </html>
  );
}
