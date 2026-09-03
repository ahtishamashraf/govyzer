export const metadata = { title: 'Offline' };

export default function OfflinePage() {
  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 24, textAlign: 'center' }}>
      <div>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>You are offline</h1>
        <p style={{ color: 'var(--text-muted)', maxWidth: 420 }}>
          Govyzer needs a connection to load live CRM data. Pages you already opened stay available; reconnect to
          continue working.
        </p>
      </div>
    </main>
  );
}
