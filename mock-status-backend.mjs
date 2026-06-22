import http from "node:http";

const PORT = Number(process.env.PORT || 4178);

let mode = "all-up";

const baseServices = [
  {
    id: "test-gateway",
    name: "Gateway",
    network: "testnet",
    environment: "testnet",
    group: "Testnet",
    url: "https://gate-test.liberdus.com/api/status",
    latencyMs: 190,
  },
  {
    id: "test-explorer",
    name: "Explorer",
    network: "testnet",
    environment: "testnet",
    group: "Testnet",
    url: "https://exp-test.liberdus.com/api/cycleinfo?count=1",
    latencyMs: 220,
  },
  {
    id: "discord-status-bot",
    name: "Discord Status Bot",
    network: "testnet",
    environment: "testnet",
    group: "Testnet",
    url: "http://demo.local/discord/health",
    latencyMs: 95,
  },
  {
    id: "test-monitor",
    name: "Monitor",
    network: "testnet",
    environment: "testnet",
    group: "Testnet",
    url: "http://demo.local/api/status",
    latencyMs: 155,
  },
];

function serviceState(service) {
  if (mode === "discord-down" && service.id === "discord-status-bot") {
    return {
      state: "outage",
      detail: "Simulated Discord bot health endpoint failure",
      healthPct: 0,
    };
  }
  if (mode === "site-down" && service.id === "test-gateway") {
    return {
      state: "outage",
      detail: "Simulated gateway endpoint failure",
      healthPct: 0,
    };
  }
  return {
    state: "operational",
    detail: null,
    healthPct: 100,
  };
}

function services() {
  const now = new Date().toISOString();
  return baseServices.map((service) => ({
    ...service,
    ...serviceState(service),
    lastCheckedAt: now,
  }));
}

function statusDescription(serviceList) {
  const down = serviceList.filter((service) => service.state === "outage");
  if (!down.length) return "All Systems Operational";
  if (down.some((service) => service.id === "discord-status-bot")) {
    return "Discord Status Bot is down";
  }
  return "Partial System Outage";
}

function historyFor(service) {
  const state = serviceState(service);
  const value = state.healthPct;
  return Array.from({ length: 24 }, (_, index) =>
    index === 23 ? value : 100
  );
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    sendJson(response, 200, {});
    return;
  }

  if (url.pathname === "/demo/mode") {
    const nextMode = url.searchParams.get("mode");
    if (["all-up", "discord-down", "site-down"].includes(nextMode)) {
      mode = nextMode;
    }
    sendJson(response, 200, { mode });
    return;
  }

  if (url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      mode,
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === "/api/summary") {
    const serviceList = services();
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(),
      services: serviceList,
      indicator: serviceList.some((service) => service.state === "outage")
        ? "major"
        : "none",
      statusDescription: statusDescription(serviceList),
      demoMode: mode,
    });
    return;
  }

  if (url.pathname === "/api/history") {
    sendJson(response, 200, {
      days: 1,
      intervalMinutes: 5,
      startTimeMs: Date.now() - 23 * 5 * 60 * 1000,
      services: baseServices.map((service) => ({
        id: service.id,
        history: historyFor(service),
        counts: {
          up: historyFor(service).map((value) => (value === 100 ? 1 : 0)),
          slow: historyFor(service).map(() => 0),
          issue: historyFor(service).map(() => 0),
          down: historyFor(service).map((value) => (value === 0 ? 1 : 0)),
          total: historyFor(service).map(() => 1),
        },
      })),
    });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Mock status backend running at http://localhost:${PORT}`);
  console.log("Modes:");
  console.log(`  http://localhost:${PORT}/demo/mode?mode=all-up`);
  console.log(`  http://localhost:${PORT}/demo/mode?mode=discord-down`);
  console.log(`  http://localhost:${PORT}/demo/mode?mode=site-down`);
});
