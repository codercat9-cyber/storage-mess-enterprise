// Проверка живости для контейнера: /api/health по http или https (если в certs/ лежит сертификат).
const fs = require('fs');
const tls = fs.existsSync('/app/server/certs/key.pem') || fs.existsSync('/app/server/certs/server.pfx');
const mod = require(tls ? 'https' : 'http');
const req = mod.get({
  host: '127.0.0.1', port: Number(process.env.PORT || 8080), path: '/api/health',
  rejectUnauthorized: false, timeout: 4000,
  // Без имени клиента встроенный фильтр сервера отвечает 403
  headers: { 'User-Agent': 'Mozilla/5.0 (container healthcheck)' },
}, res => process.exit(res.statusCode === 200 ? 0 : 1));
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
