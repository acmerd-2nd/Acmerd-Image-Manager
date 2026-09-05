import { lazy } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { AppShell } from '@/components/layout/AppShell'
import { AdminLayout } from '@/components/layout/AdminLayout'
import { RequireAuth, RequireRole } from '@/components/guards'
import { LoginPage } from '@/routes/pages/LoginPage'
import { RegisterPage } from '@/routes/pages/RegisterPage'
import { ForbiddenPage, NotFoundPage } from '@/routes/pages/ErrorPages'

// Phase 9 D3：路由级代码分割。AuthProvider / 布局 / Guard 保持 eager，
// 保证顺序 Auth → Guard → Lazy Page（不会"先渲染页面再发现无权限"）。
// Suspense 边界在 AppShell / AdminLayout 的 <Outlet/> 处（导航稳定，仅内容区回落）。
const HomePage = lazy(() => import('@/routes/pages/HomePage').then((m) => ({ default: m.HomePage })))
const SearchPage = lazy(() => import('@/routes/pages/SearchPage').then((m) => ({ default: m.SearchPage })))
const AssetDetailPage = lazy(() => import('@/routes/pages/AssetDetailPage').then((m) => ({ default: m.AssetDetailPage })))
const CollectionDetailPage = lazy(() =>
  import('@/routes/pages/CollectionDetailPage').then((m) => ({ default: m.CollectionDetailPage })),
)
const SchedulePage = lazy(() => import('@/routes/pages/SchedulePage').then((m) => ({ default: m.SchedulePage })))
const ProfilePage = lazy(() => import('@/routes/pages/ProfilePage').then((m) => ({ default: m.ProfilePage })))

const AdminDashboardPage = lazy(() => import('@/routes/pages/admin/AdminDashboardPage').then((m) => ({ default: m.AdminDashboardPage })))
const AdminUsersPage = lazy(() => import('@/routes/pages/admin/AdminUsersPage').then((m) => ({ default: m.AdminUsersPage })))
const AdminStoragePage = lazy(() => import('@/routes/pages/admin/AdminStoragePage').then((m) => ({ default: m.AdminStoragePage })))
const AdminAuditLogsPage = lazy(() => import('@/routes/pages/admin/AdminAuditLogsPage').then((m) => ({ default: m.AdminAuditLogsPage })))
const AdminTagsPage = lazy(() => import('@/routes/pages/admin/AdminTagsPage').then((m) => ({ default: m.AdminTagsPage })))
const AdminAssetsPage = lazy(() => import('@/routes/pages/admin/AdminAssetsPage').then((m) => ({ default: m.AdminAssetsPage })))
const AdminAssetNewPage = lazy(() => import('@/routes/pages/admin/AdminAssetNewPage').then((m) => ({ default: m.AdminAssetNewPage })))
const AdminAssetEditorPage = lazy(() => import('@/routes/pages/admin/AdminAssetEditorPage').then((m) => ({ default: m.AdminAssetEditorPage })))
const AdminCollectionsPage = lazy(() =>
  import('@/routes/pages/admin/AdminCollectionsPage').then((m) => ({ default: m.AdminCollectionsPage })),
)

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
            <Route path="/collection/:slug" element={<CollectionDetailPage />} />
            <Route path="/schedule" element={<SchedulePage />} />
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
              <Route path="collections" element={<AdminCollectionsPage />} />
              <Route path="assets" element={<AdminAssetsPage />} />
              <Route path="assets/new" element={<AdminAssetNewPage />} />
              <Route path="assets/:id" element={<AdminAssetEditorPage />} />
              <Route path="users" element={<AdminUsersPage />} />
              <Route path="tags" element={<AdminTagsPage />} />
              <Route path="storage" element={<AdminStoragePage />} />
              <Route path="audit-logs" element={<AdminAuditLogsPage />} />
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
