const http = require("http");
const { Client } = require("pg");

const PORT = process.env.PORT || 8080;
const PG_HOST = process.env.PG_HOST;
const PG_USER = process.env.PG_USER || "pgadmin";
const PG_PASS = process.env.PG_PASS;
const PG_DB = process.env.PG_DB || "postgres";

// Deliberate memory leak — grows with each request
// On a 256Mi container limit, this will OOMKill after ~200-300 requests
const leakedData = [];

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) }));
    return;
  }

  if (req.url === "/api/data") {
    // Leak ~500KB per request
    leakedData.push(Buffer.alloc(512 * 1024, "x").toString());

    const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`Memory: ${memMB}MB, Leaked buffers: ${leakedData.length}`);

    // Query PostgreSQL
    const client = new Client({
      host: PG_HOST,
      user: PG_USER,
      password: PG_PASS,
      database: PG_DB,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
    });

    try {
      await client.connect();
      const result = await client.query("SELECT count(*) FROM pg_stat_activity");
      await client.end();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        memoryMB: memMB,
        leakedBuffers: leakedData.length,
        activeConnections: result.rows[0].count,
      }));
    } catch (err) {
      console.error("PostgreSQL error:", err.message);
      // Connection not properly closed on error — leaks the connection
      try { await client.end(); } catch {}
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Database query failed", detail: err.message, memoryMB: memMB }));
    }
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    app: "azdoctor-aks-demo",
    endpoints: ["/health", "/api/data"],
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  }));
});

server.listen(PORT, () => {
  console.log(`AKS demo app listening on port ${PORT}`);
});
