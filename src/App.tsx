import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedRoute } from './components/auth/ProtectedRoute';
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
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/clients"
          element={
            <ProtectedRoute>
              <ClientsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <ClientDashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/jobs/new"
          element={
            <ProtectedRoute>
              <SubirZipPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/jobs/:id"
          element={
            <ProtectedRoute>
              <ProcesoDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/documents"
          element={
            <ProtectedRoute>
              <DocumentsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/monitoring"
          element={
            <ProtectedRoute>
              <MonitoringPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/integrations"
          element={
            <ProtectedRoute>
              <IntegracionesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/mis-procesos"
          element={
            <ProtectedRoute>
              <MisProcesosPage />
            </ProtectedRoute>
          }
        />
        <Route path="/" element={<LandingPage />} />
        {/* Payment pages — public, MercadoPago redirects here after checkout */}
        <Route path="/payment/success" element={<PaymentSuccessPage />} />
        <Route path="/payment/failure" element={<PaymentFailurePage />} />
        <Route path="/payment/pending" element={<PaymentFailurePage />} />
      </Routes>
    </AuthProvider>
  );
}

export default App;
