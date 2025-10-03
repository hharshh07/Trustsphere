// Replace with your actual Alchemy API key
const ALCHEMY_API_KEY = "8ZceSXgfWKNVJbsQa97OJ";

// DOM
const appContent = document.getElementById("app-content");
const scanBtn = document.getElementById("scanBtn");
const spinner = document.getElementById("loadingSpinner");
const statusText = document.getElementById("statusText");
const sidebar = document.getElementById("sidebar"); // Sidebar reference

// State
let currentData = null;   // persists across views
let refreshTimer = null;  // polling timer

// Navigation
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelector(".nav-item.active")?.classList.remove("active");
    item.classList.add("active");
    showView(item.dataset.view);
  });
});

// View switcher (uses currentData if available)
function showView(view) {
  appContent.classList.remove("active");
  setTimeout(() => {
    if (!currentData) {
      // pre-scan placeholders
      if (view === "dashboard") {
        appContent.innerHTML = `<div class="card"><h3>Dashboard</h3><p>Scan a wallet to see portfolio and risk analysis.</p></div>`;
      } else if (view === "transactions") {
        appContent.innerHTML = `<div class="card"><h3>Transactions</h3><p>No data yet. Please scan a wallet first.</p></div>`;
      } else if (view === "alerts") {
        appContent.innerHTML = `<div class="card"><h3>Alerts</h3><p>No data yet. Please scan a wallet first.</p></div>`;
      } else {
        appContent.innerHTML = `<div class="card"><h3>${view}</h3><p>Scan a wallet to view ${view} data.</p></div>`;
      }
      appContent.classList.add("active");
      return;
    }

    // render from persisted data
    if (view === "dashboard") {
      renderDashboard(currentData);
    } else if (view === "transactions") {
      renderTransactions(currentData);
    } else if (view === "alerts") {
      renderAlerts(currentData);
    } else {
      renderDashboard(currentData);
    }

    appContent.classList.add("active");
  }, 180);
}

// Scan handler
scanBtn.addEventListener("click", async () => {
  const inputEl = document.getElementById("addressInput");
  const input = (inputEl?.value || "").trim();
  if (!input) return alert("Enter wallet address (0x...)");
  if (!/^0x[a-fA-F0-9]{40}$/.test(input)) return alert("Invalid address format.");

  setStatus("Scanning wallet...");
  spinner.classList.remove("hidden");

  // stop previous polling
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  try {
    const data = await fetchWalletData(input);
    currentData = data; // persist

    // Reveal sidebar after scan
    sidebar?.classList.remove("hidden");

    // Default to Dashboard view
    document.querySelectorAll(".nav-item").forEach(item => item.classList.remove("active"));
    document.querySelector('.nav-item[data-view="dashboard"]')?.classList.add("active");

    renderDashboard(data);
    setStatus("Scan complete. Live updates enabled.");

    // auto-refresh every 30s
    refreshTimer = setInterval(async () => {
      try {
        const fresh = await fetchWalletData(input);
        currentData = fresh;
        const activeView = document.querySelector(".nav-item.active")?.dataset.view || "dashboard";
        showView(activeView);
        setStatus("Live data updated.");
      } catch (err) {
        console.error(err);
        setStatus("Update failed. Retrying next cycle.");
      }
    }, 30000);
  } catch (err) {
    console.error(err);
    renderErrorCard(err);
    setStatus("Error scanning wallet: " + (err?.message || "Unknown error"));
  } finally {
    spinner.classList.add("hidden");
  }
});

// Status
function setStatus(text) {
  statusText.textContent = text || "";
}

// Data fetch
async function fetchWalletData(address) {
  const [balanceHex, transfersIn, transfersOut, priceUSD] = await Promise.all([
    alchemyRPC("eth_getBalance", [address, "latest"]),
    alchemyTransfers({ toAddress: address }),
    alchemyTransfers({ fromAddress: address }),
    getEthPriceUSD(),
  ]);

  const wei = hexToBigInt(balanceHex);
  const ethBalance = Number(wei) / 1e18;
  const totalUSD = ethBalance * priceUSD;

  const transfers = mergeTransfers(transfersIn, transfersOut);
  const risk = computeRisk(address, transfers);
  const alerts = computeAlerts(address, transfers);

  return { address, ethBalance, priceUSD, totalUSD, transfers, risk, alerts };
}

// Alchemy RPC helper
async function alchemyRPC(method, params) {
  const endpoint = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed (${res.status})`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || `RPC ${method} error`);
  return json.result;
}

// Alchemy transfers (native + internal + erc20/nft categories)
async function alchemyTransfers(filter) {
  const endpoint = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
  const params = {
    fromBlock: "0x0",
    toBlock: "latest",
    category: ["external", "internal", "erc20", "erc721", "erc1155"],
    maxCount: "0x64", // 100
    withMetadata: true,
    order: "desc",
    ...filter,
  };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "alchemy_getAssetTransfers", params: [params] }),
  });
  if (!res.ok) throw new Error(`Transfers fetch failed (${res.status})`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "Transfers error");
  return Array.isArray(json.result?.transfers) ? json.result.transfers : [];
}

// Merge, dedupe, sort desc by block number
function mergeTransfers(inbound, outbound) {
  const combined = [...inbound, ...outbound];
  const seen = new Set();
  const unique = [];

  for (const t of combined) {
    const key = `${t.hash || t.uniqueId || `${t.blockNum}-${t.from}-${t.to}`}-${t.logIndex ?? "x"}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(t);
    }
  }
  unique.sort((a, b) => parseInt(b.blockNum || "0x0", 16) - parseInt(a.blockNum || "0x0", 16));
  return unique.slice(0, 100);
}

// Risk heuristic (last 30 days)
function computeRisk(address, txs) {
  const now = Date.now();
  const last30d = txs.filter((t) => {
    const ts = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() : 0;
    return ts && (now - ts) <= 30 * 24 * 60 * 60 * 1000;
  });

  const sends = last30d.filter((t) => (t.from || "").toLowerCase() === address.toLowerCase());
  const uniqueTo = new Set(sends.map((t) => (t.to || "").toLowerCase()).filter(Boolean));
  const largeSends = sends.filter((t) => toEth(t.value) > 5);

  let score = 50;
  let label = "Medium Risk";
  let color = "warn";

  if (sends.length >= 50 || uniqueTo.size >= 30 || largeSends.length >= 5) {
    score = 75; label = "Elevated Risk"; color = "danger";
  } else if (sends.length <= 5 && uniqueTo.size <= 3 && largeSends.length === 0) {
    score = 30; label = "Lower Risk"; color = "success";
  }

  return {
    score, label, color,
    last30Count: last30d.length,
    sendsCount: sends.length,
    uniqueRecipients: uniqueTo.size,
    largeSends: largeSends.length,
  };
}

// Alerts from transfers
function computeAlerts(address, txs) {
  const alerts = [];
  const byDay = new Map();

  for (const t of txs) {
    const ts = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp) : null;
    const dayKey = ts ? ts.toISOString().slice(0, 10) : "unknown";
    const val = toEth(t.value);

    byDay.set(dayKey, (byDay.get(dayKey) || 0) + 1);

    if (val >= 10 && (t.from || "").toLowerCase() === address.toLowerCase()) {
      alerts.push(`High-value outgoing transfer: ${val.toFixed(4)} ETH`);
    }
  }

  for (const [day, count] of byDay.entries()) {
    if (count >= 100) alerts.push(`Unusual activity spike: ${count} transfers on ${day}`);
  }

  return alerts;
}

// Price via Coingecko
async function getEthPriceUSD() {
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
  if (!res.ok) throw new Error("ETH price fetch failed");
  const data = await res.json();
  const price = data?.ethereum?.usd;
  if (typeof price !== "number") throw new Error("Invalid ETH price response");
  return price;
}

// Render Dashboard
function renderDashboard({ address, ethBalance, priceUSD, totalUSD, risk, transfers }) {
  const recentKPIs = transfers.slice(0, 6).map((t, i) => {
    const isOut = (t.from || "").toLowerCase() === address.toLowerCase();
    const valueEth = toEth(t.value);
    const dir = isOut ? "Sent" : "Received";
    const hashShort = short(t.hash || "—");
    return `
      <div class="kpi ${isOut ? "danger" : "success"}" title="${t.hash || ""}">
        <span class="dot"></span>
        <strong>#${i + 1} ${dir}:</strong> ${valueEth.toFixed(6)} ETH
        <span style="color:#94a3b8;">(${hashShort})</span>
      </div>
    `;
  }).join("");

  appContent.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <h3>Portfolio overview</h3>
        <p><strong>Address:</strong> ${address}</p>
        <p><strong>Ethereum holdings:</strong> ${ethBalance.toFixed(6)} ETH</p>
        <p><strong>ETH price:</strong> $${priceUSD.toLocaleString()}</p>
        <p><strong>Total wallet value:</strong> $${totalUSD.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
      </div>

      <div class="card">
        <h3>Risk analysis</h3>
        <div class="kpi ${risk.color}">
          <span class="dot"></span>
          <strong>Risk score:</strong> ${risk.score}/100 – ${risk.label}
        </div>
        <p style="margin-top:8px;">
          <strong>Recent activity (30d):</strong> ${risk.last30Count} tx • ${risk.sendsCount} sends • ${risk.uniqueRecipients} unique recipients • ${risk.largeSends} large sends
        </p>
      </div>
    </div>

    <div class="card">
      <h3>Recent transactions</h3>
      <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        ${recentKPIs || "<span style='color:#94a3b8;'>No recent transactions.</span>"}
      </div>
      ${renderTransactionsTable(transfers, address)}
    </div>
  `;
}

// Render Transactions tab
function renderTransactions({ transfers, address }) {
  appContent.innerHTML = `
    <div class="card">
      <h3>Transactions</h3>
      ${renderTransactionsTable(transfers, address)}
    </div>
  `;
}

// Build transactions table HTML
function renderTransactionsTable(transfers, address) {
  const rows = transfers.slice(0, 100).map((t) => {
    const valEth = toEth(t.value).toFixed(6);
    const dir = (t.from || "").toLowerCase() === (address || "").toLowerCase() ? "Out" : "In";
    const ts = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).toLocaleString() : "—";
    return `
      <tr>
        <td>${short(t.hash || "—")}</td>
        <td>${short(t.from || "—")}</td>
        <td>${short(t.to || "—")}</td>
        <td>${valEth}</td>
        <td>${dir}</td>
        <td>${ts}</td>
      </tr>
    `;
  }).join("");

  return `
    <table class="tx-table" aria-label="Recent transactions table">
      <thead>
        <tr>
          <th>Hash</th>
          <th>From</th>
          <th>To</th>
          <th>Value (ETH)</th>
          <th>Dir</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="6" style="color:#94a3b8;">No transactions found.</td></tr>`}
      </tbody>
    </table>
  `;
}

// Render Alerts tab
function renderAlerts({ alerts }) {
  const list = alerts?.length
    ? alerts.map(a => `<p>⚠️ ${a}</p>`).join("")
    : "<p>No alerts detected from recent transfers.</p>";

  appContent.innerHTML = `
    <div class="card">
      <h3>Alerts</h3>
      ${list}
    </div>
  `;
}

// Helpers
function short(s, head = 10, tail = 6) {
  if (!s || s.length <= head + tail) return s || "—";
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}

function hexToBigInt(hex) {
  try {
    if (typeof hex !== "string") return 0n;
    return BigInt(hex);
  } catch {
    return 0n;
  }
}

// Convert Alchemy transfer value (may be hex or decimal string) to ETH number
function toEth(value) {
  if (value == null) return 0;
  try {
    if (typeof value === "string") {
      if (value.startsWith("0x")) {
        const wei = BigInt(value);
        return Number(wei) / 1e18;
      } else {
        const wei = BigInt(value);
        return Number(wei) / 1e18;
      }
    }
    const wei = BigInt(value);
    return Number(wei) / 1e18;
  } catch {
    return 0;
  }
}

// Error card
function renderErrorCard(err) {
  appContent.innerHTML = `
    <div class="card">
      <h3>Scan error</h3>
      <p>${(err?.message || "Unknown error")}</p>
      <p style="color:#94a3b8;">Check the address and network connection, then try again.</p>
    </div>
  `;
}

// Cleanup on unload
window.addEventListener("beforeunload", () => {
  if (refreshTimer) clearInterval(refreshTimer);
});