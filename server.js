const express = require("express");
const cors    = require("cors");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Credentials (set in Render environment variables) ─────────────────────
const APIFY_TOKEN      = process.env.APIFY_TOKEN;
const APIFY_ACTOR_ID   = process.env.APIFY_ACTOR_ID   || "apify/web-scraper";
const APIFY_DATASET_ID = process.env.APIFY_DATASET_ID || "rcEKHccRtnYL70XU9";
const SUPABASE_URL     = process.env.SUPABASE_URL     || "https://dmeigygmmxwmkyniizzj.supabase.co";
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRtZWlneWdtbXh3bWt5bmlpenpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1NzU2NDEsImV4cCI6MjA4ODE1MTY0MX0.hTv4RICUBNWFNLsQEaZVqcbviqD0ZZSinwCzdSLRDJo";

app.use(cors());
app.use(express.json());

// ── In-memory cache ───────────────────────────────────────────────────────
let cachedInventory = [];
let lastFetched     = null;
const CACHE_TTL_MS  = 30 * 60 * 1000; // 30 min

// Track active sync so we never run two at once
let syncInProgress  = false;
let syncStartedAt   = null;
const SYNC_TIMEOUT_MS = 20 * 60 * 1000; // 20 min hard timeout

// ── Supabase helper ───────────────────────────────────────────────────────
async function supa(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        method === "POST" ? "return=representation" : "return=minimal",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${txt}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

// ── Normalize Apify vehicle record ────────────────────────────────────────
function normalize(v, i) {
  return {
    stock:       v.stock       || v.stockNumber || `HOC-${i}`,
    year:        v.year        || 0,
    make:        v.make        || "",
    model:       v.model       || "",
    price:       v.price       || 0,
    mileage:     v.mileage     || "",
    location:    v.location    || "",
    type:        v.bodyType    || v.type || "",
    color:       v.color       || "",
    image:       v.image       || "",
    listing_url: v.listingUrl  || v.url || "",
    condition:   v.condition   || "Used",
    raw:         v,
  };
}

// ── Pull current dataset from Apify (does NOT trigger a new run) ──────────
async function fetchDataset(datasetId) {
  if (!APIFY_TOKEN) throw new Error("APIFY_TOKEN not set.");
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items?format=json&clean=true&token=${APIFY_TOKEN}&limit=5000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Apify dataset fetch → ${res.status}`);
  return res.json();
}

// ── Trigger a new Apify actor run and return the runId ────────────────────
async function triggerApifyRun() {
  if (!APIFY_TOKEN) throw new Error("APIFY_TOKEN not set.");
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memory: 512 }), // keep memory low
  });
  if (!res.ok) throw new Error(`Apify trigger → ${res.status}`);
  const j = await res.json();
  return { runId: j.data.id, datasetId: j.data.defaultDatasetId };
}

// ── Poll Apify run status every 60s until SUCCEEDED or timeout ────────────
async function waitForRun(runId) {
  if (!APIFY_TOKEN) throw new Error("APIFY_TOKEN not set.");
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(60000); // poll every 60 seconds — keeps resource usage minimal
    const res = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    if (!res.ok) throw new Error(`Apify poll → ${res.status}`);
    const j = await res.json();
    const status = j.data.status;
    console.log(`[sync] Apify run ${runId} status: ${status}`);
    if (status === "SUCCEEDED") return j.data.defaultDatasetId;
    if (["FAILED","ABORTED","TIMED-OUT"].includes(status)) throw new Error(`Apify run ${status}`);
  }
  throw new Error("Sync timed out after 20 minutes.");
}

// ── Diff + write inventory to Supabase in batches ─────────────────────────
async function diffAndPersist(freshVehicles, syncRequestId) {
  const BATCH = 50;
  let added = 0, removed = 0;

  // 1. Fetch all currently active stocks from Supabase
  const existing = await supa("GET", "/inventory?select=stock&active=eq.true&limit=10000");
  const existingStocks = new Set((existing || []).map(r => r.stock));
  const freshStocks    = new Set(freshVehicles.map(v => v.stock));

  // 2. Upsert fresh vehicles in batches
  for (let i = 0; i < freshVehicles.length; i += BATCH) {
    const batch = freshVehicles.slice(i, i + BATCH).map(v => ({
      ...v,
      active:    true,
      last_seen: new Date().toISOString(),
    }));
    await supa("POST", "/inventory?on_conflict=stock", batch);
    // small pause between batches — keeps DB load low
    if (i + BATCH < freshVehicles.length) await sleep(500);
  }

  // 3. Count newly added
  for (const v of freshVehicles) {
    if (!existingStocks.has(v.stock)) added++;
  }

  // 4. Mark removed vehicles inactive in batches
  const toRemove = [...existingStocks].filter(s => !freshStocks.has(s));
  for (let i = 0; i < toRemove.length; i += BATCH) {
    const batch = toRemove.slice(i, i + BATCH);
    const inList = batch.map(s => `"${s}"`).join(",");
    await supa("PATCH", `/inventory?stock=in.(${inList})`, {
      active:    false,
      last_seen: new Date().toISOString(),
    });
    if (i + BATCH < toRemove.length) await sleep(300);
  }
  removed = toRemove.length;

  // 5. Update sync_request record
  await supa("PATCH", `/sync_requests?id=eq.${syncRequestId}`, {
    status:           "completed",
    completed_at:     new Date().toISOString(),
    vehicles_added:   added,
    vehicles_removed: removed,
    total_vehicles:   freshVehicles.length,
  });

  return { added, removed, total: freshVehicles.length };
}

// ── Notify all admin/site-admin users in Supabase ─────────────────────────
async function notifyAdmins(message, linkTab = "inventory") {
  try {
    const admins = await supa("GET", "/users?select=id&status=eq.active&or=(role.eq.Admin,role.eq.Site Admin)");
    if (!admins || !admins.length) return;
    const notifs = admins.map(u => ({
      user_id:    u.id,
      message,
      link_tab:   linkTab,
      read:       false,
    }));
    await supa("POST", "/notifications", notifs);
  } catch (e) {
    console.error("[notify] Failed:", e.message);
  }
}

async function notifyAll(message, linkTab = "inventory") {
  try {
    const users = await supa("GET", "/users?select=id&status=eq.active");
    if (!users || !users.length) return;
    const notifs = users.map(u => ({
      user_id:  u.id,
      message,
      link_tab: linkTab,
      read:     false,
    }));
    // batch to avoid one massive insert
    const BATCH = 50;
    for (let i = 0; i < notifs.length; i += BATCH) {
      await supa("POST", "/notifications", notifs.slice(i, i + BATCH));
      if (i + BATCH < notifs.length) await sleep(200);
    }
  } catch (e) {
    console.error("[notifyAll] Failed:", e.message);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────
// BACKGROUND SYNC RUNNER
// Called after an admin approves — runs async, does not block the response
// ─────────────────────────────────────────────────────────────────────────
async function runSync(syncRequestId, approvedByName) {
  if (syncInProgress) {
    console.log("[sync] Already in progress, skipping.");
    return;
  }

  // Guard against zombie syncs (if server restarted mid-sync)
  if (syncStartedAt && Date.now() - syncStartedAt > SYNC_TIMEOUT_MS) {
    syncInProgress = false;
  }

  syncInProgress = true;
  syncStartedAt  = Date.now();
  console.log(`[sync] Starting sync for request ${syncRequestId}`);

  try {
    // Mark as running
    await supa("PATCH", `/sync_requests?id=eq.${syncRequestId}`, {
      status:     "running",
      started_at: new Date().toISOString(),
    });

    let freshRaw;

    // Try to trigger a new Apify run. If that fails (e.g. no actor configured),
    // fall back to pulling the existing dataset — this way the server never crashes.
    try {
      console.log("[sync] Triggering Apify actor run…");
      const { runId, datasetId } = await triggerApifyRun();
      console.log(`[sync] Run started: ${runId}. Polling every 60s…`);
      const freshDatasetId = await waitForRun(runId);
      freshRaw = await fetchDataset(freshDatasetId);
    } catch (apifyErr) {
      console.warn("[sync] Actor trigger failed, falling back to existing dataset:", apifyErr.message);
      freshRaw = await fetchDataset(APIFY_DATASET_ID);
    }

    if (!freshRaw || !freshRaw.length) {
      throw new Error("Apify returned 0 vehicles — aborting to avoid wiping inventory.");
    }

    console.log(`[sync] Got ${freshRaw.length} vehicles from Apify. Diffing…`);
    const normalized = freshRaw.map(normalize);
    const { added, removed, total } = await diffAndPersist(normalized, syncRequestId);

    // Update in-memory cache
    cachedInventory = normalized.map((v, i) => ({ id: i + 1, ...v, listingUrl: v.listing_url }));
    lastFetched     = Date.now();

    const msg = `✅ Inventory sync complete · ${total} vehicles · ${added} added · ${removed} removed`;
    console.log("[sync]", msg);
    await notifyAll(msg, "inventory");

  } catch (err) {
    console.error("[sync] Error:", err.message);
    await supa("PATCH", `/sync_requests?id=eq.${syncRequestId}`, {
      status:        "failed",
      completed_at:  new Date().toISOString(),
      error_message: err.message,
    });
    await notifyAdmins(`❌ Inventory sync failed: ${err.message}`, "inventory");
  } finally {
    syncInProgress = false;
    syncStartedAt  = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────

// GET /inventory — serve cached or Supabase inventory
app.get("/inventory", async (req, res) => {
  try {
    // Check if a sync is running
    const syncStatus = await getSyncStatus();

    // If we have a good in-memory cache, serve it
    const now          = Date.now();
    const cacheExpired = !lastFetched || (now - lastFetched) > CACHE_TTL_MS;

    if (!cacheExpired && cachedInventory.length) {
      return res.json({
        success:     true,
        count:       cachedInventory.length,
        lastFetched: new Date(lastFetched).toISOString(),
        syncStatus,
        vehicles:    cachedInventory,
      });
    }

    // Cache expired — try to load from Supabase inventory table
    try {
      const rows = await supa("GET", "/inventory?select=*&active=eq.true&limit=5000&order=year.desc");
      if (rows && rows.length) {
        cachedInventory = rows.map((v, i) => ({
          id:         i + 1,
          stock:      v.stock,
          year:       v.year,
          make:       v.make,
          model:      v.model,
          price:      v.price,
          mileage:    v.mileage,
          location:   v.location,
          type:       v.type,
          color:      v.color,
          image:      v.image,
          listingUrl: v.listing_url,
          condition:  v.condition,
        }));
        lastFetched = now;
        return res.json({
          success:     true,
          count:       cachedInventory.length,
          lastFetched: new Date(lastFetched).toISOString(),
          syncStatus,
          vehicles:    cachedInventory,
        });
      }
    } catch (dbErr) {
      console.warn("[inventory] Supabase load failed, falling back to Apify:", dbErr.message);
    }

    // Last resort — pull directly from Apify dataset (read-only, no new run)
    console.log("[inventory] Fetching directly from Apify dataset…");
    const raw = await fetchDataset(APIFY_DATASET_ID);
    cachedInventory = raw.map((v, i) => ({ id: i + 1, ...normalize(v, i), listingUrl: v.listingUrl || v.url || "" }));
    lastFetched = now;

    res.json({
      success:     true,
      count:       cachedInventory.length,
      lastFetched: new Date(lastFetched).toISOString(),
      syncStatus,
      vehicles:    cachedInventory,
    });
  } catch (err) {
    console.error("[inventory] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /inventory/sync-status — lightweight poll endpoint for the frontend
app.get("/inventory/sync-status", async (req, res) => {
  try {
    const status = await getSyncStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /inventory/request-sync — any logged-in user requests a sync
app.post("/inventory/request-sync", async (req, res) => {
  try {
    const { userId, userName } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: "userId required" });

    // Check 2-day cooldown
    const cooldownCheck = await checkCooldown();
    if (cooldownCheck.locked) {
      return res.status(429).json({
        success: false,
        error:   `Sync cooldown active. Next sync available ${cooldownCheck.nextAvailable}.`,
        cooldown: cooldownCheck,
      });
    }

    // Check for pending/running sync
    const existing = await supa("GET", "/sync_requests?status=in.(pending,running)&limit=1");
    if (existing && existing.length) {
      return res.status(409).json({
        success: false,
        error:   "A sync request is already pending or running.",
      });
    }

    // Create the request
    const rows = await supa("POST", "/sync_requests", [{
      requested_by:      userId,
      requested_by_name: userName || "Unknown",
      status:            "pending",
    }]);

    const request = rows[0];

    // Notify admins and site admins
    await notifyAdmins(
      `🔄 ${userName || "A user"} has requested an inventory sync. Open the Inventory tab to approve.`,
      "inventory"
    );

    res.json({ success: true, requestId: request.id, message: "Sync request submitted. Awaiting admin approval." });
  } catch (err) {
    console.error("[request-sync]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /inventory/approve-sync — admin/site-admin approves a pending request
app.post("/inventory/approve-sync", async (req, res) => {
  try {
    const { requestId, approvedById, approvedByName, userRole } = req.body;

    if (!["Admin","Site Admin"].includes(userRole)) {
      return res.status(403).json({ success: false, error: "Only Admins and Site Admins can approve syncs." });
    }
    if (!requestId) return res.status(400).json({ success: false, error: "requestId required" });

    // Guard — only approve if still pending
    const rows = await supa("GET", `/sync_requests?id=eq.${requestId}&status=eq.pending&limit=1`);
    if (!rows || !rows.length) {
      return res.status(409).json({ success: false, error: "Request not found or already processed." });
    }

    // Mark approved
    await supa("PATCH", `/sync_requests?id=eq.${requestId}`, {
      status:          "approved",
      approved_by:     approvedById,
      approved_at:     new Date().toISOString(),
    });

    // Notify everyone that sync is starting
    await notifyAll(`🔄 Inventory sync approved by ${approvedByName}. Updating inventory — check back in 10–20 minutes.`, "inventory");

    // Fire off background sync — intentionally NOT awaited so response returns immediately
    runSync(requestId, approvedByName).catch(e => console.error("[runSync unhandled]", e.message));

    res.json({ success: true, message: "Sync approved and started." });
  } catch (err) {
    console.error("[approve-sync]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /inventory/deny-sync — admin denies a request
app.post("/inventory/deny-sync", async (req, res) => {
  try {
    const { requestId, deniedByName, userRole } = req.body;
    if (!["Admin","Site Admin"].includes(userRole)) {
      return res.status(403).json({ success: false, error: "Unauthorized." });
    }
    await supa("PATCH", `/sync_requests?id=eq.${requestId}`, {
      status:       "denied",
      completed_at: new Date().toISOString(),
      error_message: `Denied by ${deniedByName}`,
    });

    // Notify requester
    const rows = await supa("GET", `/sync_requests?id=eq.${requestId}&select=requested_by`);
    if (rows && rows[0]?.requested_by) {
      await supa("POST", "/notifications", [{
        user_id:  rows[0].requested_by,
        message:  `❌ Your inventory sync request was denied by ${deniedByName}.`,
        link_tab: "inventory",
        read:     false,
      }]);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────
async function getSyncStatus() {
  try {
    // Get latest sync request
    const rows = await supa("GET", "/sync_requests?order=created_at.desc&limit=1");
    const latest = rows?.[0];
    if (!latest) return { status: "none", syncInProgress: false };

    // Check 2-day cooldown based on last completed sync
    const cooldown = await checkCooldown();

    return {
      status:           latest.status,
      syncInProgress:   latest.status === "running",
      requestId:        latest.id,
      requestedBy:      latest.requested_by_name,
      approvedAt:       latest.approved_at,
      completedAt:      latest.completed_at,
      vehiclesAdded:    latest.vehicles_added,
      vehiclesRemoved:  latest.vehicles_removed,
      totalVehicles:    latest.total_vehicles,
      errorMessage:     latest.error_message,
      cooldownLocked:   cooldown.locked,
      nextAvailable:    cooldown.nextAvailable,
      hoursRemaining:   cooldown.hoursRemaining,
    };
  } catch (e) {
    return { status: "unknown", syncInProgress: false };
  }
}

async function checkCooldown() {
  try {
    const rows = await supa("GET", "/sync_requests?status=eq.completed&order=completed_at.desc&limit=1");
    const last = rows?.[0];
    if (!last || !last.completed_at) return { locked: false };

    const completedAt  = new Date(last.completed_at).getTime();
    const cooldownMs   = 2 * 24 * 60 * 60 * 1000; // 48 hours
    const nextMs       = completedAt + cooldownMs;
    const now          = Date.now();

    if (now < nextMs) {
      const hoursRemaining = Math.ceil((nextMs - now) / (1000 * 60 * 60));
      const nextAvailable  = new Date(nextMs).toLocaleDateString("en-CA", {
        weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
      });
      return { locked: true, hoursRemaining, nextAvailable };
    }
    return { locked: false };
  } catch (e) {
    return { locked: false };
  }
}

// ── Health check ──────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:      "ok",
    vehicles:    cachedInventory.length,
    lastFetched: lastFetched ? new Date(lastFetched).toISOString() : null,
    syncInProgress,
  });
});

app.listen(PORT, () => console.log(`HOCRM backend running on port ${PORT}`));
