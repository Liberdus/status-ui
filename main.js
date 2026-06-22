function getApiBase() {
  return typeof window !== "undefined" &&
    window.LIBERDUS_STATUS_API &&
    typeof window.LIBERDUS_STATUS_API === "string"
    ? window.LIBERDUS_STATUS_API
    : "https://status.liberdus.com";
}

let CURRENT_NETWORK =
  typeof window !== "undefined" &&
  window.LIBERDUS_STATUS_NETWORK &&
  typeof window.LIBERDUS_STATUS_NETWORK === "string"
    ? window.LIBERDUS_STATUS_NETWORK
    : "devnet";

const INTERVAL_OPTIONS = [
  { value: "5m", label: "5 minutes" },
  { value: "10m", label: "10 minutes" },
  { value: "20m", label: "20 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "1d", label: "1 day" },
];

const NETWORK_OPTIONS = [
  { value: "devnet", label: "Devnet" },
  { value: "testnet", label: "Testnet" },
];

const MAX_HISTORY_DAYS = 7;
const STATUS_FETCH_FAILED_MESSAGE =
  "Status fetch failed. Please check again later.";

const CATEGORY_DEFINITIONS = [
  { id: "gateways", label: "Gateways" },
  { id: "archivers", label: "Archivers" },
  { id: "explorers", label: "Explorers" },
  { id: "monitors", label: "Monitors" },
  { id: "notification", label: "Notification" },
  { id: "faucet", label: "Faucet" },
  { id: "oauth", label: "OAuth" },
  { id: "goldenticket", label: "Golden Ticket" },
  { id: "discordBot", label: "Discord Bot" },
];

let backendHistory = null;
let backendOnline = true;

let currentInterval = "5m";
let currentBarsCount = null;
let currentServices = [];
let currentIncidents = [];
let currentSnapshot = null;
let refreshIntervalId = null;
let backendHealthIntervalId = null;

function normalizeServiceStatus(value) {
  const status = String(value || "unknown").toLowerCase();
  if (
    status === "operational" ||
    status === "healthy" ||
    status === "active" ||
    status === "up" ||
    status === "ok"
  ) {
    return "operational";
  }
  if (
    status === "degraded" ||
    status === "slow" ||
    status === "warning" ||
    status === "warn"
  ) {
    return "degraded";
  }
  if (
    status === "outage" ||
    status === "down" ||
    status === "offline" ||
    status === "failed" ||
    status === "error"
  ) {
    return "outage";
  }
  return "unknown";
}

function isBotService(service) {
  const text = `${service.id || ""} ${service.name || ""}`.toLowerCase();
  return text.includes("discord") || text.includes("bot");
}

function getServiceStatusText(service) {
  const status = service.status || "unknown";
  if (isBotService(service)) {
    if (status === "operational") return "Active";
    if (status === "outage") return "Down";
    if (status === "degraded") return "Degraded";
    return "Status Unknown";
  }
  if (status === "operational") return "Operational";
  if (status === "degraded") return "Degraded Performance";
  if (status === "outage") return "Major Outage";
  return "Status Unknown";
}

function buildFetchFailedSnapshot() {
  return {
    services: [],
    incidents: [],
    generatedAt: null,
    indicator: "critical",
    statusDescription: STATUS_FETCH_FAILED_MESSAGE,
    fetchFailed: true,
  };
}

async function loadBackendHistory(days, interval) {
  try {
    const params = new URLSearchParams();
    if (days != null) {
      params.set("days", String(days));
    }
    if (interval) {
      params.set("interval", interval);
    }
    if (CURRENT_NETWORK) {
      params.set("network", CURRENT_NETWORK);
    }
    const url = `${getApiBase()}/api/history?${params.toString()}`;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const historyByService = new Map();
    const services = data.services || [];
    const intervalMinutesValue =
      typeof data.intervalMinutes === "number"
        ? data.intervalMinutes
        : 5;
    const intervalMs = intervalMinutesValue * 60 * 1000;
    const servicesArray = Array.isArray(services) ? services : [];
    for (const service of servicesArray) {
      const rawHistory = Array.isArray(service.history)
        ? service.history
        : [];
      const counts = service.counts || {};
      const countsUp = Array.isArray(counts.up) ? counts.up : [];
      const countsSlow = Array.isArray(counts.slow) ? counts.slow : [];
      const countsIssue = Array.isArray(counts.issue) ? counts.issue : [];
      const countsDown = Array.isArray(counts.down) ? counts.down : [];
      const countsTotal = Array.isArray(counts.total) ? counts.total : [];
      const firstDownAtArray = Array.isArray(service.firstDownAt)
        ? service.firstDownAt
        : [];
      if (!rawHistory.length) {
        historyByService.set(service.id, []);
        continue;
      }
      const startTimeMs =
        typeof data.startTimeMs === "number"
          ? data.startTimeMs
          : Date.now() - rawHistory.length * intervalMs;
      const list = [];
      for (let index = 0; index < rawHistory.length; index += 1) {
        const pctRaw = rawHistory[index];
        const successPctValue =
          pctRaw == null || Number.isNaN(Number(pctRaw))
            ? null
            : Number(pctRaw);
        const timestamp = startTimeMs + index * intervalMs;
        const date = new Date(timestamp);
        const firstDownMs = firstDownAtArray[index];
        const firstDownAt =
          typeof firstDownMs === "number" && Number.isFinite(firstDownMs)
            ? new Date(firstDownMs)
            : null;
        const state =
          successPctValue == null || Number.isNaN(successPctValue)
            ? "up"
            : classifyStateFromPct(successPctValue);
        list.push({
          date,
          state,
          successPct: successPctValue,
          total: countsTotal[index] != null ? countsTotal[index] : null,
          upCount: countsUp[index] != null ? countsUp[index] : null,
          slowCount: countsSlow[index] != null ? countsSlow[index] : null,
          issueCount: countsIssue[index] != null ? countsIssue[index] : null,
          downCount: countsDown[index] != null ? countsDown[index] : null,
          firstDownAt,
        });
      }
      historyByService.set(service.id, list);
    }
    backendHistory = {
      days: data.days || days || null,
      intervalMinutes: intervalMinutesValue,
      historyByService,
    };
    return backendHistory;
  } catch (error) {
    return null;
  }
}

async function loadBackendSnapshot() {
  try {
    const params = new URLSearchParams();
    if (CURRENT_NETWORK) {
      params.set("network", CURRENT_NETWORK);
    }
    const url = `${getApiBase()}/api/summary?${params.toString()}`;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error("Non-200 response");
    }
    const data = await response.json();
    const rawServices = Array.isArray(data.services) ? data.services : null;
    if (!rawServices) {
      throw new Error("Invalid summary response");
    }
    const services = rawServices.map((service) => {
      const status = normalizeServiceStatus(service.state || service.status);
      const environmentLabel = service.environment
        ? service.environment.toUpperCase()
        : "";
      const groupLabel = service.group || "";
      const descriptionParts = [];
      if (environmentLabel) {
        descriptionParts.push(environmentLabel);
      }
      if (groupLabel) {
        descriptionParts.push(groupLabel);
      }
      return {
        id: service.id,
        name: service.name,
        description: descriptionParts.join(" • "),
        group: groupLabel || environmentLabel || "–",
        status,
        uptime30d:
          typeof service.healthPct === "number" ? service.healthPct : null,
        lastIncidentAt: null,
      };
    });
    const incidents = [];
    return {
      services,
      incidents,
      generatedAt: data.generatedAt || null,
      indicator: data.indicator || "none",
      statusDescription: data.statusDescription || null,
      fetchFailed: false,
    };
  } catch (error) {
    return buildFetchFailedSnapshot();
  }
}

function summarizeOverallStatus(services, incidents) {
  let status = "operational";
  const total = services.length;
  if (total > 0) {
    let outageCount = 0;
    let degradedCount = 0;
    for (const service of services) {
      if (service.status === "outage") {
        outageCount += 1;
      } else if (service.status === "degraded") {
        degradedCount += 1;
      }
    }
    if (outageCount > total / 2) {
      status = "outage";
    } else if (outageCount > 0 || degradedCount > 0) {
      status = "degraded";
    } else {
      status = "operational";
    }
  }
  const activeIncidents = incidents.filter((incident) => !incident.resolvedAt);
  const statusLabel =
    status === "operational"
      ? activeIncidents.length === 0
        ? "All Systems Operational"
        : "Operational with active incidents"
      : status === "degraded"
      ? "Partial System Outage"
      : status === "outage"
      ? "Major Service Outage"
      : "Status Unknown";
  return {
    status,
    statusLabel,
    activeIncidentsCount: activeIncidents.length,
  };
}

function classifyUptime(uptime) {
  if (uptime == null) return "unknown";
  if (uptime >= 99.95) return "good";
  if (uptime >= 99.0) return "warn";
  return "bad";
}

function formatPercent(value) {
  if (value == null || Number.isNaN(value)) return "–";
  return `${value.toFixed(3)}%`;
}

function formatDate(value) {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return date.toLocaleString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatShortDate(value) {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return date.toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "2-digit",
  });
}

function updateBackendStatusIndicator(isOnline) {
  const label = document.getElementById("backend-status-label");
  if (!label) return;
  if (typeof isOnline === "boolean") {
    backendOnline = isOnline;
  }
  label.classList.toggle("backend-status-down", !backendOnline);
  if (backendOnline) {
    label.textContent = "Status server: online";
  } else {
    label.textContent = "Status server is down";
  }
}

function renderOverview(services, incidents, snapshot) {
  const overall = summarizeOverallStatus(services, incidents);
  const fetchFailed = Boolean(snapshot && snapshot.fetchFailed);

  const pill = document.getElementById("overall-status-pill");
  const label = document.getElementById("overall-status-label");
  const lastUpdated = document.getElementById("last-updated-label");

  if (pill) {
    pill.classList.remove("degraded", "outage");
    if (fetchFailed) {
      pill.classList.add("outage");
    } else if (overall.status === "degraded") {
      pill.classList.add("degraded");
    } else if (overall.status === "outage") {
      pill.classList.add("outage");
    }
  }

  if (label) {
    if (fetchFailed) {
      label.textContent = STATUS_FETCH_FAILED_MESSAGE;
    } else if (snapshot && snapshot.statusDescription) {
      label.textContent = snapshot.statusDescription;
    } else {
      label.textContent = overall.statusLabel;
    }
  }

  if (lastUpdated) {
    if (fetchFailed) {
      lastUpdated.textContent = "Last updated: unavailable";
    } else if (snapshot && snapshot.generatedAt) {
      const date = new Date(snapshot.generatedAt);
      if (!Number.isNaN(date.getTime())) {
        lastUpdated.textContent = `Last updated: ${date.toLocaleTimeString()}`;
      } else {
        lastUpdated.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
      }
    } else {
      lastUpdated.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
    }
  }
}

function renderServicesTable(services) {
  const tbody = document.getElementById("services-table-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!services.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No services configured yet.";
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  for (const service of services) {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    const nameWrapper = document.createElement("div");
    nameWrapper.className = "service-name";
    const primary = document.createElement("div");
    primary.className = "service-name-primary";
    primary.textContent = service.name;
    const secondary = document.createElement("div");
    secondary.className = "service-name-secondary";
    secondary.textContent = service.description;
    nameWrapper.appendChild(primary);
    nameWrapper.appendChild(secondary);
    nameCell.appendChild(nameWrapper);

    const groupCell = document.createElement("td");
    groupCell.textContent = service.group || "–";

    const statusCell = document.createElement("td");
    const statusPill = document.createElement("span");
    const status = service.status || "unknown";
    statusPill.className = `status-pill ${status}`;
    statusPill.textContent = getServiceStatusText(service);
    statusCell.appendChild(statusPill);

    const uptimeCell = document.createElement("td");
    const uptimeClassification = classifyUptime(service.uptime30d);
    const uptimeSpan = document.createElement("span");
    uptimeSpan.className = `uptime-value${
      uptimeClassification === "good"
        ? " uptime-good"
        : uptimeClassification === "warn"
        ? " uptime-warn"
        : uptimeClassification === "bad"
        ? " uptime-bad"
        : ""
    }`;
    uptimeSpan.textContent = formatPercent(service.uptime30d);
    uptimeCell.appendChild(uptimeSpan);

    const lastIncidentCell = document.createElement("td");
    lastIncidentCell.textContent = formatShortDate(service.lastIncidentAt);

    row.appendChild(nameCell);
    row.appendChild(groupCell);
    row.appendChild(statusCell);
    row.appendChild(uptimeCell);
    row.appendChild(lastIncidentCell);

    tbody.appendChild(row);
  }
}

function renderIncidentHistory(incidents, services) {
  const container = document.getElementById("incident-list");
  if (!container) return;
  container.innerHTML = "";

  if (!incidents.length) {
    const empty = document.createElement("div");
    empty.className = "incident-empty";
    empty.textContent = "No incidents recorded yet.";
    container.appendChild(empty);
    return;
  }

  const serviceMap = new Map(services.map((service) => [service.id, service]));

  for (const incident of incidents) {
    const card = document.createElement("article");
    card.className = "incident-card";

    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "incident-title";
    title.textContent = incident.title;
    const meta = document.createElement("div");
    meta.className = "incident-meta";
    const started = formatDate(incident.startedAt);
    const resolved = incident.resolvedAt ? formatDate(incident.resolvedAt) : "";
    meta.textContent = resolved
      ? `${started} → ${resolved}`
      : `${started} • ongoing`;
    left.appendChild(title);
    left.appendChild(meta);

    const middle = document.createElement("div");
    middle.className = "incident-services";
    for (const serviceId of incident.services || []) {
      const service = serviceMap.get(serviceId);
      const badge = document.createElement("span");
      badge.className = "incident-service-pill";
      badge.textContent = service ? service.name : serviceId;
      middle.appendChild(badge);
    }

    const right = document.createElement("div");
    const severity = document.createElement("div");
    severity.className = `incident-severity ${incident.severity}`;
    severity.textContent =
      incident.severity === "critical"
        ? "Critical"
        : incident.severity === "major"
        ? "Major"
        : incident.severity === "minor"
        ? "Minor"
        : "Info";
    right.appendChild(severity);

    card.appendChild(left);
    card.appendChild(middle);
    card.appendChild(right);

    container.appendChild(card);
  }
}

function getDaysToDisplay() {
  const width = window.innerWidth || 0;
  if (width >= 1200) return 90;
  if (width >= 900) return 60;
  if (width >= 640) return 30;
  return 14;
}

function getMaxHistoryPoints() {
  if (currentInterval === "1d") {
    return 7;
  }
  return getDaysToDisplay();
}

function classifyStateFromPct(successPct) {
  if (successPct == null || Number.isNaN(successPct)) return "up";
  if (successPct <= 0) return "down";
  if (successPct <= 20) return "issue";
  if (successPct < 100) return "slow";
  return "up";
}

function groupServicesByCategory(services) {
  const groups = new Map();
  for (const def of CATEGORY_DEFINITIONS) {
    groups.set(def.id, { id: def.id, label: def.label, services: [] });
  }
  for (const service of services) {
    const name = (service.name || "").toLowerCase();
    let categoryId = null;
    if (name.includes("gateway")) {
      categoryId = "gateways";
    } else if (name.includes("archiver")) {
      categoryId = "archivers";
    } else if (name.includes("explorer")) {
      categoryId = "explorers";
    } else if (name.includes("monitor")) {
      categoryId = "monitors";
    } else if (name.includes("notification")) {
      categoryId = "notification";
    } else if (name.includes("faucet")) {
      categoryId = "faucet";
    } else if (name.includes("oauth")) {
      categoryId = "oauth";
    } else if (name.includes("golden")) {
      categoryId = "goldenticket";
    } else if (
      name.includes("discord") ||
      name.includes("bot") ||
      String(service.id || "").toLowerCase().includes("discord") ||
      String(service.id || "").toLowerCase().includes("bot")
    ) {
      categoryId = "discordBot";
    }
    if (!categoryId) {
      continue;
    }
    const group = groups.get(categoryId);
    if (group) {
      group.services.push(service);
    }
  }
  const result = [];
  for (const def of CATEGORY_DEFINITIONS) {
    const group = groups.get(def.id);
    if (group && group.services.length) {
      result.push(group);
    }
  }
  return result;
}

function summarizeCategoryStatus(services) {
  let status = "operational";
  for (const service of services) {
    const value = service.status || "unknown";
    if (value === "outage") {
      status = "outage";
      break;
    }
    if (value === "degraded" && status === "operational") {
      status = "degraded";
    }
  }
  return status;
}

function summarizeCategoryUptime30d(services) {
  let minUptime = null;
  for (const service of services) {
    const value =
      typeof service.uptime30d === "number" &&
      !Number.isNaN(service.uptime30d)
        ? service.uptime30d
        : null;
    if (value == null) {
      continue;
    }
    if (minUptime == null || value < minUptime) {
      minUptime = value;
    }
  }
  return minUptime;
}

function buildCategoryHistory(services, days) {
  if (!services || !services.length || !days) {
    return [];
  }
  const histories = [];
  for (const service of services) {
    const history = buildServiceHistory(service, days);
    if (history && history.length) {
      histories.push(history);
    }
  }
  if (!histories.length) {
    return [];
  }
  let maxLength = 0;
  for (const history of histories) {
    if (history.length > maxLength) {
      maxLength = history.length;
    }
  }
  const effectiveDays = Math.min(days, maxLength);
  const result = [];
  for (let index = 0; index < effectiveDays; index += 1) {
    let minPct = null;
    let date = null;
    for (const history of histories) {
      const startIndex = history.length - effectiveDays;
      const entryIndex = startIndex + index;
      if (entryIndex < 0 || entryIndex >= history.length) {
        continue;
      }
      const entry = history[entryIndex];
      const value =
        entry && entry.successPct != null && !Number.isNaN(entry.successPct)
          ? entry.successPct
          : null;
      if (value == null) {
        continue;
      }
      if (minPct == null || value < minPct) {
        minPct = value;
        date = entry.date;
      }
    }
    if (minPct == null) {
      result.push({
        date: date || null,
        state: null,
        successPct: null,
      });
      continue;
    }
    const successPctValue = minPct;
    const state = classifyStateFromPct(successPctValue);
    result.push({
      date,
      state,
      successPct: successPctValue,
    });
  }
  return result;
}

function buildServiceHistory(service, days) {
  if (backendHistory && backendHistory.historyByService) {
    const entries = backendHistory.historyByService.get(service.id) || [];
    if (entries.length) {
      const result = [];
      const sliceStart =
        entries.length > days ? entries.length - days : 0;
      for (let index = sliceStart; index < entries.length; index += 1) {
        const entry = entries[index];
        const date =
          entry.date instanceof Date && !Number.isNaN(entry.date.getTime())
            ? entry.date
            : new Date();
        const successPctValue =
          entry.successPct == null || Number.isNaN(entry.successPct)
            ? 100
            : entry.successPct;
        const state = classifyStateFromPct(successPctValue);
        result.push({
          date,
          state,
          successPct: successPctValue,
          total:
            entry.total != null && !Number.isNaN(entry.total)
              ? entry.total
              : null,
          upCount:
            entry.upCount != null && !Number.isNaN(entry.upCount)
              ? entry.upCount
              : null,
          slowCount:
            entry.slowCount != null && !Number.isNaN(entry.slowCount)
              ? entry.slowCount
              : null,
          issueCount:
            entry.issueCount != null && !Number.isNaN(entry.issueCount)
              ? entry.issueCount
              : null,
          downCount:
            entry.downCount != null && !Number.isNaN(entry.downCount)
              ? entry.downCount
              : null,
          firstDownAt:
            entry.firstDownAt instanceof Date &&
            !Number.isNaN(entry.firstDownAt.getTime())
              ? entry.firstDownAt
              : null,
        });
      }
      if (result.length) {
        return result;
      }
    }
  }
  const today = new Date();
  const successPct =
    typeof service.uptime30d === "number" && !Number.isNaN(service.uptime30d)
      ? service.uptime30d
      : null;
  if (successPct == null) {
    return [];
  }
  return [
    {
      date: today,
      state: classifyStateFromPct(successPct),
      successPct,
    },
  ];
}

function handleBarEnter(event) {
  const bar = event.currentTarget;
  const tooltip = document.getElementById("uptime-tooltip");
  if (!tooltip) return;
  const status = bar.dataset.status;
  const serviceName = bar.dataset.service;
  const dateValue = bar.dataset.date;
  const pctValue = bar.dataset.pct;
  const pctNumber = pctValue ? Number(pctValue) : null;
  const totalValue = bar.dataset.total ? Number(bar.dataset.total) : null;
  const upValue = bar.dataset.up ? Number(bar.dataset.up) : null;
  const slowValue = bar.dataset.slow ? Number(bar.dataset.slow) : null;
  const issueValue = bar.dataset.issue ? Number(bar.dataset.issue) : null;
  const downValue = bar.dataset.down ? Number(bar.dataset.down) : null;
  const firstDownAtValue = bar.dataset.firstDownAt;
  const date = dateValue ? new Date(dateValue) : null;
  const firstDownAt =
    firstDownAtValue && typeof firstDownAtValue === "string"
      ? new Date(firstDownAtValue)
      : null;
  let statusLabel = "Unknown";
  let description = "";
  if (status === "up") {
    statusLabel = "Operational";
  } else if (status === "slow") {
    statusLabel = "Latency detected";
  } else if (status === "issue") {
    statusLabel = "Degraded";
  } else if (status === "down") {
    statusLabel = "Complete outage";
  }
  if (
    totalValue != null &&
    !Number.isNaN(totalValue) &&
    totalValue > 0 &&
    (upValue != null ||
      slowValue != null ||
      issueValue != null ||
      downValue != null)
  ) {
    const upCount = upValue != null && !Number.isNaN(upValue) ? upValue : 0;
    const slowCount =
      slowValue != null && !Number.isNaN(slowValue) ? slowValue : 0;
    const issueCount =
      issueValue != null && !Number.isNaN(issueValue) ? issueValue : 0;
    const downCount =
      downValue != null && !Number.isNaN(downValue) ? downValue : 0;
    const parts = [];
    if (downCount > 0) {
      const pct = (downCount / totalValue) * 100;
      parts.push(
        `Down: ${downCount}/${totalValue} (${pct.toFixed(1)}%)`
      );
    }
    if (issueCount > 0) {
      const pct = (issueCount / totalValue) * 100;
      parts.push(
        `Degraded: ${issueCount}/${totalValue} (${pct.toFixed(1)}%)`
      );
    }
    if (slowCount > 0) {
      const pct = (slowCount / totalValue) * 100;
      parts.push(
        `Latency: ${slowCount}/${totalValue} (${pct.toFixed(1)}%)`
      );
    }
    if (upCount > 0) {
      const pct = (upCount / totalValue) * 100;
      parts.push(
        `Up: ${upCount}/${totalValue} (${pct.toFixed(1)}%)`
      );
    }
    if (parts.length) {
      description = parts.join(" • ");
    } else if (pctNumber != null && !Number.isNaN(pctNumber)) {
      description = `${pctNumber.toFixed(
        1
      )}% successful checks during this period.`;
    }
    if (
      status === "down" &&
      firstDownAt &&
      !Number.isNaN(firstDownAt.getTime()) &&
      downCount > 0 &&
      downCount < totalValue
    ) {
      const firstDownLabel = `${firstDownAt.toLocaleDateString(undefined, {
        timeZone: "UTC",
        month: "short",
        day: "2-digit",
      })} ${firstDownAt.toLocaleTimeString(undefined, {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
      })} UTC`;
      statusLabel = `First outage detected: ${firstDownLabel}`;
    }
  } else if (pctNumber != null && !Number.isNaN(pctNumber)) {
    description = `${pctNumber.toFixed(
      1
    )}% successful checks during this period.`;
  } else if (status === "up") {
    description = "No downtime recorded during this period.";
  } else if (status === "slow") {
    description = "Latency detected during this period.";
  } else if (status === "issue") {
    description = "Degraded performance recorded during this period.";
  } else if (status === "down") {
    description = "Complete outage recorded during this period.";
  }
  const dateLabel =
    date && !Number.isNaN(date.getTime())
      ? `${date.toLocaleDateString(undefined, {
          timeZone: "UTC",
          month: "short",
          day: "2-digit",
        })} ${date.toLocaleTimeString(undefined, {
          timeZone: "UTC",
          hour: "2-digit",
          minute: "2-digit",
        })} UTC`
      : "";
  const firstLine = dateLabel || serviceName;
  const secondLine =
    dateLabel && serviceName ? `${serviceName} – ${statusLabel}` : statusLabel;
  const details = description;
  tooltip.innerHTML = `${firstLine}<br>${secondLine}<br>${details}`;
  const rect = bar.getBoundingClientRect();
  tooltip.style.left = `${rect.left + rect.width / 2}px`;
  tooltip.style.top = `${rect.bottom + 8}px`;
  tooltip.classList.add("visible");
}

function handleBarLeave() {
  const tooltip = document.getElementById("uptime-tooltip");
  if (!tooltip) return;
  tooltip.classList.remove("visible");
}

function renderServiceUptimeList(services, days) {
  const container = document.getElementById("service-uptime-list");
  if (!container) return;
  container.innerHTML = "";

  if (!services.length) {
    const empty = document.createElement("div");
    empty.className = currentSnapshot && currentSnapshot.fetchFailed
      ? "incident-empty status-fetch-error"
      : "incident-empty";
    empty.textContent =
      currentSnapshot && currentSnapshot.fetchFailed
        ? STATUS_FETCH_FAILED_MESSAGE
        : "No services configured yet.";
    container.appendChild(empty);
    return;
  }

  const categories = groupServicesByCategory(services);
  for (const category of categories) {
    const section = document.createElement("section");
    section.className = "category-section";

    const header = document.createElement("div");
    header.className = "category-header";

    const headerLeft = document.createElement("div");
    headerLeft.className = "category-header-left";

    const title = document.createElement("div");
    title.className = "category-title";
    title.textContent = category.label;

    headerLeft.appendChild(title);

    header.appendChild(headerLeft);
    const servicesContainer = document.createElement("div");
    servicesContainer.className = "category-services";

    // No collapse/expand; categories are always visible

    for (const service of category.services) {
      const rowSection = document.createElement("section");
      rowSection.className = "service-row";

      const rowHeader = document.createElement("div");
      rowHeader.className = "service-row-header";

      const titleWrapper = document.createElement("div");
      titleWrapper.className = "service-row-title";

      const nameLabel = document.createElement("span");
      nameLabel.className = "service-name-label";
      nameLabel.textContent = service.name;

      const help = document.createElement("span");
      help.className = "service-help";
      help.textContent = "?";

      titleWrapper.appendChild(nameLabel);
      titleWrapper.appendChild(help);

      const statusLabel = document.createElement("div");
      statusLabel.className = "service-status-label";
      const status = service.status || "unknown";
      if (status === "operational") {
        statusLabel.classList.add("status-operational");
      } else if (status === "degraded") {
        statusLabel.classList.add("status-degraded");
      } else if (status === "outage") {
        statusLabel.classList.add("status-outage");
      }
      statusLabel.textContent = getServiceStatusText(service);

      rowHeader.appendChild(titleWrapper);
      rowHeader.appendChild(statusLabel);

      const body = document.createElement("div");
      body.className = "service-row-body";

      const bars = document.createElement("div");
      bars.className = "uptime-bars";
      const history = buildServiceHistory(service, days);
      for (const entry of history) {
        const bar = document.createElement("span");
        bar.className = "uptime-bar";
        if (entry.state === "up") {
          bar.classList.add("uptime-bar-up");
        } else if (entry.state === "slow") {
          bar.classList.add("uptime-bar-slow");
        } else if (entry.state === "issue") {
          bar.classList.add("uptime-bar-issue");
        } else if (entry.state === "down") {
          bar.classList.add("uptime-bar-down");
        }
        bar.dataset.date = entry.date.toISOString();
        bar.dataset.status = entry.state;
        bar.dataset.service = service.name;
        bar.dataset.pct = entry.successPct.toFixed(1);
        if (entry.total != null && !Number.isNaN(entry.total)) {
          bar.dataset.total = String(entry.total);
        }
        if (entry.upCount != null && !Number.isNaN(entry.upCount)) {
          bar.dataset.up = String(entry.upCount);
        }
        if (entry.slowCount != null && !Number.isNaN(entry.slowCount)) {
          bar.dataset.slow = String(entry.slowCount);
        }
        if (entry.issueCount != null && !Number.isNaN(entry.issueCount)) {
          bar.dataset.issue = String(entry.issueCount);
        }
        if (entry.downCount != null && !Number.isNaN(entry.downCount)) {
          bar.dataset.down = String(entry.downCount);
        }
        if (
          entry.firstDownAt instanceof Date &&
          !Number.isNaN(entry.firstDownAt.getTime())
        ) {
          bar.dataset.firstDownAt = entry.firstDownAt.toISOString();
        }
        bar.addEventListener("mouseenter", handleBarEnter);
        bar.addEventListener("mouseleave", handleBarLeave);
        bars.appendChild(bar);
      }

      const axis = document.createElement("div");
      axis.className = "uptime-axis";

      const leftLabel = document.createElement("span");
      const firstEntry = history[0];
      leftLabel.textContent = firstEntry
        ? formatShortDate(firstEntry.date)
        : "";

      const centerLabel = document.createElement("span");
      centerLabel.className = "uptime-axis-center";
      centerLabel.textContent = `${formatPercent(service.uptime30d)} uptime`;

      const rightLabel = document.createElement("span");
      const lastEntry = history.length
        ? history[history.length - 1]
        : null;
      rightLabel.textContent = lastEntry
        ? formatShortDate(lastEntry.date)
        : "Today";

      axis.appendChild(leftLabel);
      axis.appendChild(centerLabel);
      axis.appendChild(rightLabel);

      body.appendChild(bars);
      body.appendChild(axis);

      rowSection.appendChild(rowHeader);
      rowSection.appendChild(body);

      servicesContainer.appendChild(rowSection);
    }

    section.appendChild(header);
    section.appendChild(servicesContainer);

    container.appendChild(section);
  }
}

function buildDailyHistoryMap() {
  if (!backendHistory || !backendHistory.historyByService) {
    return null;
  }
  const dayStates = new Map();
  let earliestDay = null;
  for (const [, entries] of backendHistory.historyByService.entries()) {
    for (const entry of entries) {
      const date =
        entry.date instanceof Date && !Number.isNaN(entry.date.getTime())
          ? entry.date
          : null;
      if (!date) continue;
      const iso = date.toISOString();
      const dayKey = iso.slice(0, 10);
      const state = classifyStateFromPct(entry.successPct);
      const prev = dayStates.get(dayKey);
      let nextState = state;
      if (prev) {
        if (prev === "down" || state === "down") {
          nextState = "down";
        } else if (prev === "issue" || state === "issue") {
          nextState = "issue";
        } else if (prev === "slow" || state === "slow") {
          nextState = "slow";
        } else {
          nextState = "up";
        }
      }
      dayStates.set(dayKey, nextState);
      if (!earliestDay || dayKey < earliestDay) {
        earliestDay = dayKey;
      }
    }
  }
  if (!earliestDay) {
    return null;
  }
  const start = new Date(`${earliestDay}T00:00:00.000Z`);
  const days = [];
  for (let offset = 0; offset < 90; offset += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + offset);
    const key = date.toISOString().slice(0, 10);
    const state = dayStates.get(key) || null;
    days.push({ date, state });
  }
  return days;
}

function renderHistoricalCalendar() {
  const panel = document.getElementById("historical-uptime-panel");
  const grid = document.getElementById("historical-calendar-grid");
  if (!panel || !grid) return;
  grid.innerHTML = "";
  const days = buildDailyHistoryMap();
  if (!days || !days.length) {
    const empty = document.createElement("div");
    empty.className = "incident-empty";
    empty.textContent = "No historical data available yet.";
    grid.appendChild(empty);
    return;
  }
  const byMonth = new Map();
  for (const item of days) {
    const year = item.date.getUTCFullYear();
    const month = item.date.getUTCMonth();
    const monthKey = `${year}-${month}`;
    let bucket = byMonth.get(monthKey);
    if (!bucket) {
      bucket = { year, month, days: [] };
      byMonth.set(monthKey, bucket);
    }
    bucket.days.push(item);
  }
  const sortedMonths = Array.from(byMonth.values()).sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });
  for (const monthBucket of sortedMonths) {
    const monthContainer = document.createElement("div");
    monthContainer.className = "historical-month";
    const title = document.createElement("div");
    title.className = "historical-month-title";
    const monthDate = new Date(Date.UTC(monthBucket.year, monthBucket.month, 1));
    const label = monthDate.toLocaleDateString(undefined, {
      timeZone: "UTC",
      month: "long",
      year: "numeric",
    });
    title.textContent = label;
    const daysGrid = document.createElement("div");
    daysGrid.className = "historical-month-days";
    for (const item of monthBucket.days) {
      const cell = document.createElement("div");
      cell.className = "calendar-day";
      const dayNumber = item.date.getUTCDate();
      if (item.state === "up") {
        cell.classList.add("calendar-day-up");
      } else if (item.state === "partial") {
        cell.classList.add("calendar-day-partial");
      } else if (item.state === "down") {
        cell.classList.add("calendar-day-down");
      } else {
        cell.classList.add("calendar-day-empty");
      }
      cell.textContent = String(dayNumber);
      daysGrid.appendChild(cell);
    }
    monthContainer.appendChild(title);
    monthContainer.appendChild(daysGrid);
    grid.appendChild(monthContainer);
  }
}

function setupIntervalFilter() {
  const select = document.getElementById("uptime-interval-select");
  const label = document.getElementById("uptime-interval-label");
  if (!select) return;
  select.value = currentInterval;
  if (label) {
    const selected = INTERVAL_OPTIONS.find(
      (option) => option.value === currentInterval
    );
    label.textContent = selected
      ? `Interval: ${selected.label}`
      : "Interval";
  }
  select.addEventListener("change", async (event) => {
    const next = event.target.value || "5m";
    if (next === currentInterval) {
      return;
    }
    currentInterval = next;
    if (label) {
      const selected = INTERVAL_OPTIONS.find(
        (option) => option.value === currentInterval
      );
      label.textContent = selected
        ? `Interval: ${selected.label}`
        : "Interval";
    }
    await loadBackendHistory(MAX_HISTORY_DAYS, currentInterval);
    const maxPoints = getMaxHistoryPoints();
    currentBarsCount = maxPoints;
    renderServiceUptimeList(currentServices, currentBarsCount);
  });
}

function setupNetworkFilter() {
  const select = document.getElementById("network-filter-select");
  const label = document.getElementById("network-filter-label");
  if (!select) return;
  select.value = CURRENT_NETWORK || "devnet";
  if (label) {
    const selected = NETWORK_OPTIONS.find(
      (option) => option.value === CURRENT_NETWORK
    );
    label.textContent = selected
      ? `Network: ${selected.label}`
      : "Network";
  }
  select.addEventListener("change", async (event) => {
    const next = event.target.value || "devnet";
    if (next === CURRENT_NETWORK) {
      return;
    }
    CURRENT_NETWORK = next;
    if (label) {
      const selected = NETWORK_OPTIONS.find(
        (option) => option.value === CURRENT_NETWORK
      );
      label.textContent = selected
        ? `Network: ${selected.label}`
        : "Network";
    }
    await refreshData();
  });
}

function setupHistoricalLink() {
  const link = document.getElementById("uptime-history-link");
  const panel = document.getElementById("historical-uptime-panel");
  const closeButton = document.getElementById(
    "historical-close-button"
  );
  if (!link || !panel) return;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const isHidden = panel.classList.contains("hidden");
    if (isHidden) {
      panel.classList.remove("hidden");
      renderHistoricalCalendar();
    } else {
      panel.classList.add("hidden");
    }
  });
  if (closeButton) {
    closeButton.addEventListener("click", () => {
      panel.classList.add("hidden");
    });
  }
}

async function refreshData() {
  const snapshot = await loadBackendSnapshot();
  currentSnapshot = snapshot;
  currentServices = snapshot.services;
  currentIncidents = snapshot.incidents;
  if (snapshot.fetchFailed) {
    backendHistory = null;
    updateBackendStatusIndicator(false);
    renderOverview(currentServices, currentIncidents, currentSnapshot);
    renderServiceUptimeList(currentServices, currentBarsCount);
    return;
  }
  updateBackendStatusIndicator(true);
  await loadBackendHistory(MAX_HISTORY_DAYS, currentInterval);
  if (!currentBarsCount) {
    currentBarsCount = getMaxHistoryPoints();
  }
  currentBarsCount = getMaxHistoryPoints();
  renderOverview(currentServices, currentIncidents, currentSnapshot);
  renderServiceUptimeList(currentServices, currentBarsCount);
  const panel = document.getElementById("historical-uptime-panel");
  if (panel && !panel.classList.contains("hidden")) {
    renderHistoricalCalendar();
  }
}

if (typeof window !== "undefined") {
  window.refreshLiberdusStatus = refreshData;
}

async function checkBackendHealth() {
  const previousOnline = backendOnline;
  try {
    const response = await fetch(`${getApiBase()}/health`, { method: "GET" });
    if (!response.ok) {
      updateBackendStatusIndicator(false);
      return false;
    }
    updateBackendStatusIndicator(true);
    if (!previousOnline) {
      await refreshData();
    }
    return true;
  } catch (error) {
    updateBackendStatusIndicator(false);
    return false;
  }
}

async function initializeDashboard() {
  await refreshData();
  setupIntervalFilter();
  setupNetworkFilter();
  setupHistoricalLink();
  let resizeTimeoutId;
  window.addEventListener("resize", () => {
    if (resizeTimeoutId) {
      window.clearTimeout(resizeTimeoutId);
    }
    resizeTimeoutId = window.setTimeout(() => {
      const nextDays = getMaxHistoryPoints();
      if (nextDays !== currentBarsCount) {
        currentBarsCount = nextDays;
        renderServiceUptimeList(currentServices, currentBarsCount);
      }
    }, 120);
  });
  if (!refreshIntervalId) {
    refreshIntervalId = window.setInterval(() => {
      refreshData();
    }, 5 * 60 * 1000);
  }
  if (!backendHealthIntervalId) {
    checkBackendHealth();
    backendHealthIntervalId = window.setInterval(() => {
      checkBackendHealth();
    }, 30 * 1000);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeDashboard);
} else {
  initializeDashboard();
}
