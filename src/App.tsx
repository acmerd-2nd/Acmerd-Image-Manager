import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { AppShell } from '@/components/layout/AppShell'
import { AdminLayout } from '@/components/layout/AdminLayout'
import { RequireAuth, RequireRole } from '@/components/guards'
import { HomePage } from '@/routes/pages/HomePage'
import { SearchPage } from '@/routes/pages/SearchPage'
import { AssetDetailPage } from '@/routes/pages/AssetDetailPage'
import { ProfilePage } from '@/routes/pages/ProfilePage'
import { LoginPage } from '@/routes/pages/LoginPage'
import { RegisterPage } from '@/routes/pages/RegisterPage'
import { ForbiddenPage, NotFoundPage } from '@/routes/pages/ErrorPages'
import {
  AdminDashboardPage,
  AdminUsersPage,
  AdminStoragePage,
  AdminAuditLogsPage,
  AdminSettingsPage,
} from '@/routes/pages/admin/AdminPlaceholderPages'
import { AdminTagsPage } from '@/routes/pages/admin/AdminTagsPage'
import { AdminAssetsPage } from '@/routes/pages/admin/AdminAssetsPage'
import { AdminAssetNewPage } from '@/routes/pages/admin/AdminAssetNewPage'
import { AdminAssetEditorPage } from '@/routes/pages/admin/AdminAssetEditorPage'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/explore" element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/asset/:slug" element={<AssetDetailPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route
              path="/profile"
              element={
                <RequireAuth>
                  <ProfilePage />
                </RequireAuth>
              }
            />
            <Route path="/403" element={<ForbiddenPage />} />

            <Route
              path="/admin"
              element={
                <RequireRole allow={['admin']}>
                  <AdminLayout />
                </RequireRole>
              }
            >
              <Route index element={<AdminDashboardPage />} />
              <Route path="dashboard" element={<AdminDashboardPage />} />
              <Route path="assets" element={<AdminAssetsPage />} />
              <Route path="assets/new" element={<AdminAssetNewPage />} />
              <Route path="assets/:id" element={<AdminAssetEditorPage />} />
              <Route path="users" element={<AdminUsersPage />} />
              <Route path="tags" element={<AdminTagsPage />} />
              <Route path="storage" element={<AdminStoragePage />} />
              <Route path="audit-logs" element={<AdminAuditLogsPage />} />
              <Route path="settings" element={<AdminSettingsPage />} />
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
