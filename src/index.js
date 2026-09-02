export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    return new Response(
      `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ACMERD · 探知 · Image Manager</title>
  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f6f7f9;
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        "PingFang SC",
        "Microsoft YaHei",
        sans-serif;
      color: #111827;
    }

    .card {
      width: min(90%, 680px);
      padding: 56px 48px;
      background: #ffffff;
      border-radius: 24px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.08);
      text-align: center;
    }

    .brand {
      font-size: 14px;
      letter-spacing: 0.18em;
      color: #6b7280;
      margin-bottom: 18px;
    }

    h1 {
      margin: 0;
      font-size: 42px;
      font-weight: 700;
    }

    .subtitle {
      margin-top: 12px;
      font-size: 18px;
      color: #6b7280;
    }

    .status {
      display: inline-block;
      margin-top: 32px;
      padding: 10px 18px;
      border-radius: 999px;
      background: #ecfdf5;
      color: #047857;
      font-size: 14px;
      font-weight: 600;
    }

    .info {
      margin-top: 32px;
      font-size: 14px;
      line-height: 1.8;
      color: #6b7280;
    }

    code {
      padding: 3px 7px;
      border-radius: 6px;
      background: #f3f4f6;
      font-family: Consolas, monospace;
    }
  </style>
</head>

<body>
  <main class="card">
    <div class="brand">ACMERD · 探知</div>

    <h1>Image Manager</h1>

    <div class="subtitle">
      Research · Discover · Create
    </div>

    <div class="status">
      ● Cloudflare Worker 正常运行
    </div>

    <div class="info">
      这是 ACMERD Image Manager 的第一阶段测试页面。<br />
      当前请求路径：<code>${escapeHtml(url.pathname)}</code>
    </div>
  </main>
</body>
</html>`,
      {
        headers: {
          "content-type": "text/html; charset=UTF-8",
        },
      }
    );
  },
};

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}