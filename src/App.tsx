import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedRoute, ProtectedLayout, SuperadminRoute } from './components/auth/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { LandingPage } from './pages/LandingPage';
import { ClientsPage } from './pages/ClientsPage';
import { SubirZipPage } from './pages/SubirZipPage';
import { ProcesoDetailPage } from './pages/ProcesoDetailPage';
import { DocumentsPage } from './pages/DocumentsPage';
import { ClientDashboardPage } from './pages/ClientDashboardPage';
import { MonitoringPage } from './pages/MonitoringPage';
import { IntegracionesPage } from './pages/IntegracionesPage';
import { MisProcesosPage } from './pages/MisProcesosPage';
import { SettingsPage } from './pages/SettingsPage';
import { PaymentSuccessPage } from './pages/PaymentSuccessPage';
import { PaymentFailurePage } from './pages/PaymentFailurePage';

function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Rutas públicas */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<LandingPage />} />
        <Route path="/payment/success" element={<PaymentSuccessPage />} />
        <Route path="/payment/failure" element={<PaymentFailurePage />} />
        <Route path="/payment/pending" element={<PaymentFailurePage />} />

        {/* Rutas protegidas — AppShell se monta UNA sola vez */}
        <Route element={<ProtectedLayout />}>
          <Route path="/dashboard"    element={<ClientDashboardPage />} />
          <Route path="/jobs/new"     element={<SubirZipPage />} />
          <Route path="/jobs/:id"     element={<ProcesoDetailPage />} />
          <Route path="/documents"    element={<DocumentsPage />} />
          <Route element={<SuperadminRoute />}>
            <Route path="/monitoring" element={<MonitoringPage />} />
          </Route>
          <Route path="/integrations" element={<IntegracionesPage />} />
          <Route path="/settings"     element={<SettingsPage />} />
          <Route path="/mis-procesos" element={<MisProcesosPage />} />
          <Route path="/clients"      element={<ClientsPage />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}

export default App;
