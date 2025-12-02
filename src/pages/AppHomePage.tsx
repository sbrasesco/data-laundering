import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function AppHomePage() {
  const { signOut, session } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
  };

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Panel Data Laundering</h1>
      <p>Área privada Data Laundering</p>
      {session?.user?.email && (
        <p style={{ color: '#666', marginTop: '1rem' }}>
          Sesión iniciada como: {session.user.email}
        </p>
      )}
      <div style={{ marginTop: '2rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <button
          onClick={() => navigate('/app/mis-procesos')}
          style={{
            padding: '0.75rem 1.5rem',
            backgroundColor: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontSize: '1rem',
            fontWeight: '500',
            cursor: 'pointer',
          }}
        >
          Ir a Mis Procesos
        </button>
        <button
          onClick={() => navigate('/app/subir-zip')}
          style={{
            padding: '0.75rem 1.5rem',
            backgroundColor: '#28a745',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontSize: '1rem',
            fontWeight: '500',
            cursor: 'pointer',
          }}
        >
          Subir nuevo ZIP
        </button>
        <button
          onClick={handleSignOut}
          style={{
            padding: '0.75rem 1.5rem',
            backgroundColor: '#dc3545',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontSize: '1rem',
            fontWeight: '500',
            cursor: 'pointer',
          }}
        >
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}

