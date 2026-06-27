import { Routes, Route } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedLayout, SuperadminRoute } from './components/auth/ProtectedRoute';

// Lazy-load de páginas: cada ruta es su propio chunk (no entran todas al bundle inicial).
// Patrón con `.then` porque las páginas son named exports, no default.
const LoginPage          = lazy(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })));
const LandingPage        = lazy(() => import('./pages/LandingPage').then(m => ({ default: m.LandingPage })));
const ClientsPage        = lazy(() => import('./pages/ClientsPage').then(m => ({ default: m.ClientsPage })));
const SubirZipPage       = lazy(() => import('./pages/SubirZipPage').then(m => ({ default: m.SubirZipPage })));
const ProcesoDetailPage  = lazy(() => import('./pages/ProcesoDetailPage').then(m => ({ default: m.ProcesoDetailPage })));
const DocumentsPage      = lazy(() => import('./pages/DocumentsPage').then(m => ({ default: m.DocumentsPage })));
const ClientDashboardPage= lazy(() => import('./pages/ClientDashboardPage').then(m => ({ default: m.ClientDashboardPage })));
const MonitoringPage     = lazy(() => import('./pages/MonitoringPage').then(m => ({ default: m.MonitoringPage })));
const IntegracionesPage  = lazy(() => import('./pages/IntegracionesPage').then(m => ({ default: m.IntegracionesPage })));
const MisProcesosPage    = lazy(() => import('./pages/MisProcesosPage').then(m => ({ default: m.MisProcesosPage })));
const SettingsPage       = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const PaymentSuccessPage = lazy(() => import('./pages/PaymentSuccessPage').then(m => ({ default: m.PaymentSuccessPage })));
const PaymentFailurePage = lazy(() => import('./pages/PaymentFailurePage').then(m => ({ default: m.PaymentFailurePage })));

function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="h-8 w-8 rounded-full border-2 border-gray-200 border-t-gray-600 animate-spin" />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<RouteFallback />}>
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
      </Suspense>
    </AuthProvider>
  );
}

export default App;
