import { Hono } from 'hono'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_PUBLISHABLE_KEY: string
  ASSETS: Fetcher
}

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) =>
  c.json({ status: 'ok', service: 'acmerd-image-manager', time: new Date().toISOString() }),
)

app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404))

app.onError((err, c) => {
  console.error('Unhandled worker error:', err)
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500)
})

// 非 /api 请求交给静态资源层（未命中资源时按 SPA 规则返回 index.html）
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
