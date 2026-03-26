const appInsights = require("applicationinsights");

// Initialize Application Insights before anything else
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  appInsights
    .setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
    .setAutoCollectRequests(true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectPerformance(true)
    .start();
  console.log("Application Insights initialized");
}

const express = require("express");
const { Connection, Request: SqlRequest } = require("tedious");

const app = express();
const PORT = process.env.PORT || 8080;
const GENERATE_ERRORS = process.env.GENERATE_ERRORS === "true";

// Parse SQL connection string into tedious config
function parseSqlConfig() {
  const connStr = process.env.SQL_CONNECTION_STRING;
  if (!connStr) return null;

  const parts = {};
  connStr.split(";").forEach((part) => {
    const [key, ...rest] = part.split("=");
    if (key && rest.length) parts[key.trim()] = rest.join("=").trim();
  });

  const serverMatch = (parts["Server"] || "").match(/tcp:([^,]+)/);
  return {
    server: serverMatch ? serverMatch[1] : parts["Server"],
    authentication: {
      type: "default",
      options: {
        userName: parts["User ID"],
        password: parts["Password"],
      },
    },
    options: {
      database: parts["Database"],
      encrypt: true,
      trustServerCertificate: false,
      connectTimeout: 15000,
      requestTimeout: 15000,
    },
  };
}

// Execute a SQL query and return a promise
function executeSql(query) {
  return new Promise((resolve, reject) => {
    const config = parseSqlConfig();
    if (!config) return reject(new Error("No SQL_CONNECTION_STRING configured"));

    const connection = new Connection(config);
    connection.on("connect", (err) => {
      if (err) return reject(err);

      const rows = [];
      const request = new SqlRequest(query, (err, rowCount) => {
        connection.close();
        if (err) return reject(err);
        resolve({ rowCount, rows });
      });

      request.on("row", (columns) => {
        const row = {};
        columns.forEach((col) => (row[col.metadata.colName] = col.value));
        rows.push(row);
      });

      connection.execSql(request);
    });

    connection.connect();
  });
}

// --- Endpoints ---

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Query SQL — generates dependency telemetry
// The heavy query is intentional: on a Basic 5-DTU database, concurrent requests
// will exhaust DTU capacity, causing timeouts and connection failures — exactly
// the cascading failure scenario we want to demonstrate.
app.get("/api/data", async (req, res) => {
  try {
    const result = await executeSql(
      "SELECT TOP 500 o.name, o.type_desc, c.name as col_name FROM sys.objects o CROSS JOIN sys.columns c CROSS JOIN sys.types t ORDER BY o.name, c.name"
    );
    res.json({
      status: "ok",
      rowCount: result.rowCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("SQL error:", err.message);
    if (appInsights.defaultClient) {
      appInsights.defaultClient.trackException({ exception: err });
      appInsights.defaultClient.trackDependency({
        target: process.env.SQL_CONNECTION_STRING?.match(/Server=tcp:([^,]+)/)?.[1] ?? "sql",
        name: "SQL query",
        data: "SELECT FROM sys.objects",
        duration: 0,
        resultCode: "timeout",
        success: false,
        dependencyTypeName: "SQL",
      });
    }
    res.status(500).json({ error: "Database query failed", detail: err.message });
  }
});

// Intentional 500 errors — generates Http5xx metrics and AppExceptions
app.get("/api/error", (req, res) => {
  if (GENERATE_ERRORS) {
    const error = new Error("Simulated application error — bad deployment v1.1.0");
    console.error(error.message);
    if (appInsights.defaultClient) {
      appInsights.defaultClient.trackException({ exception: error });
    }
    res.status(500).json({
      error: "Internal Server Error",
      message: error.message,
      version: "1.1.0-bad",
    });
  } else {
    res.json({ status: "ok", message: "Error generation disabled in this environment" });
  }
});

// Slow responses — generates high DurationMs in AppRequests
app.get("/api/slow", (req, res) => {
  const delay = parseInt(req.query.delay) || 3000;
  const capped = Math.min(delay, 30000);
  setTimeout(() => {
    res.json({ status: "ok", delayMs: capped, timestamp: new Date().toISOString() });
  }, capped);
});

// CPU burn — triggers CpuPercentage metric spikes
app.get("/api/cpu", (req, res) => {
  const duration = Math.min(parseInt(req.query.duration) || 5000, 30000);
  const start = Date.now();

  // Busy loop to burn CPU
  while (Date.now() - start < duration) {
    Math.random() * Math.random();
  }

  res.json({
    status: "ok",
    burnedMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  });
});

// Intermittent failures — alternating 200/500
let flapState = false;
app.get("/api/flap", (req, res) => {
  flapState = !flapState;
  if (flapState) {
    res.status(500).json({ error: "Intermittent failure", timestamp: new Date().toISOString() });
  } else {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  }
});

// Info endpoint
app.get("/", (req, res) => {
  res.json({
    app: "azdoctor-demo",
    version: process.env.DEPLOY_VERSION || "1.0.0",
    generateErrors: GENERATE_ERRORS,
    endpoints: ["/health", "/api/data", "/api/error", "/api/slow", "/api/cpu", "/api/flap"],
  });
});

app.listen(PORT, () => {
  console.log(`AZ Doctor demo app listening on port ${PORT}`);
  console.log(`GENERATE_ERRORS=${GENERATE_ERRORS}`);
});
