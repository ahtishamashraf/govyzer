export default function AuthLayout({ children }) {
  return (
    <div className="auth">
      <div className="auth__panel">{children}</div>
      <aside className="auth__aside">
        <div>
          <div className="auth__brand">
            <span className="shell__brand-mark" aria-hidden="true">G</span>
            <strong style={{ fontSize: 16 }}>Govyzer</strong>
          </div>
          <h2>One platform for ready property, off-plan stock and the sales floor.</h2>
          <ul>
            <li>Ready listings with portal validation before you publish</li>
            <li>Off-plan inventory with holds, reservations and no double bookings</li>
            <li>Lead routing, SLAs and an auditable assignment trail</li>
            <li>Commission splits snapshotted the moment a deal is won</li>
            <li>A Sales Screen that celebrates real, approved results</li>
          </ul>
        </div>
        <p style={{ fontSize: 13, opacity: 0.75 }}>Built for the UAE first — AED, Asia/Dubai, English and Arabic.</p>
      </aside>
    </div>
  );
}
