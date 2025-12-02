export function LoadingSpinner() {
  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <div className="spinner"></div>
      <p style={{ marginTop: '1rem', color: 'var(--color-text-secondary)' }}>Cargando…</p>
    </div>
  );
}

