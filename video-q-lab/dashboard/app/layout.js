export const metadata = {
  title: 'Chai-Q Lab Dashboard',
  description: 'Video quality research & encoding analysis',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head />
      <body style={{
        margin: 0,
        padding: 0,
        background: '#0d0d0d',
        color: '#e8e8e8',
        fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
        minHeight: '100vh',
      }}>
        <style>{`
          *, *::before, *::after { box-sizing: border-box; }
          a { color: #4da6ff; text-decoration: none; }
          a:hover { text-decoration: underline; }
          button { cursor: pointer; }
        `}</style>
        <header style={{
          borderBottom: '1px solid #222',
          padding: '14px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: '#111',
        }}>
          <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.5px' }}>
            Chai-Q Lab
          </span>
          <span style={{ color: '#555', fontSize: 14 }}>/ Video Encoding Research</span>
        </header>
        <main style={{ padding: '24px' }}>
          {children}
        </main>
      </body>
    </html>
  );
}
