const express = require("express");
const cors    = require("cors");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Credentials ───────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || "https://dmeigygmmxwmkyniizzj.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRtZWlneWdtbXh3bWt5bmlpenpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1NzU2NDEsImV4cCI6MjA4ODE1MTY0MX0.hTv4RICUBNWFNLsQEaZVqcbviqD0ZZSinwCzdSLRDJo";

app.use(cors());
app.use(express.json());

// ── In-memory cache ───────────────────────────────────────────────────────
let cachedInventory = [];
let lastFetched     = null;
const CACHE_TTL_MS  = 5 * 60 * 1000; // 5 min

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

// normalize() removed — scraper writes data directly to Supabase

// fetchDataset() removed — scraper writes directly to Supabase

// Apify functions removed — scraping handled by local scraper script

// ── Diff + write inventory to Supabase in batches ─────────────────────────
async function diffAndPersist(freshVehicles, syncRequestId) {
  const BATCH = 50;
  let added = 0, removed = 0;

  // 1. Fetch all currently known stocks from Supabase (active only)
  const existing       = await supa("GET", "/inventory?select=stock&active=eq.true&limit=10000");
  const existingStocks = new Set((existing || []).map(r => r.stock));
  const freshStocks    = new Set(freshVehicles.map(v => v.stock));

  // 2. Only insert vehicles NOT already in the DB — skip existing ones entirely
  const newVehicles = freshVehicles.filter(v => !existingStocks.has(v.stock));
  console.log(`[diff] ${freshVehicles.length} fresh · ${existingStocks.size} existing · ${newVehicles.length} new to insert`);

  for (let i = 0; i < newVehicles.length; i += BATCH) {
    const batch = newVehicles.slice(i, i + BATCH).map(v => ({
      ...v,
      active:     true,
      first_seen: new Date().toISOString(),
      last_seen:  new Date().toISOString(),
    }));
    await supa("POST", "/inventory", batch);
    added += batch.length;
    if (i + BATCH < newVehicles.length) await sleep(400);
  }

  // 3. Stocks that existed before but are NOT in the fresh scrape = delisted
  const toRemove = [...existingStocks].filter(s => !freshStocks.has(s));
  console.log(`[diff] ${toRemove.length} vehicles to remove`);

  for (let i = 0; i < toRemove.length; i += BATCH) {
    const batch  = toRemove.slice(i, i + BATCH);
    const inList = batch.map(s => `"${s}"`).join(",");

    // 3a. Delete any user-uploaded photos for these stocks first
    try {
      const photos = await supa("GET", `/vehicle_photos?stock=in.(${inList})&select=id`);
      if (photos && photos.length) {
        console.log(`[diff] Deleting ${photos.length} user photos for removed vehicles`);
        const photoIds = photos.map(p => `"${p.id}"`).join(",");
        await supa("DELETE", `/vehicle_photos?id=in.(${photoIds})`);
      }
    } catch (photoErr) {
      console.warn("[diff] Photo cleanup error (non-fatal):", photoErr.message);
    }

    // 3b. Hard delete the inventory record
    await supa("DELETE", `/inventory?stock=in.(${inList})`);
    removed += batch.length;

    if (i + BATCH < toRemove.length) await sleep(300);
  }

  // 4. Update sync_request record with results
  await supa("PATCH", `/sync_requests?id=eq.${syncRequestId}`, {
    status:           "completed",
    completed_at:     new Date().toISOString(),
    vehicles_added:   added,
    vehicles_removed: removed,
    total_vehicles:   freshVehicles.length,
  });

  console.log(`[diff] Done. +${added} added, -${removed} removed, ${freshVehicles.length} total`);
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
// NOTE: Scraping is now handled by the local scraper script (scraper.js)
// run on any computer. The server just manages sync request state.
// When the local scraper finishes it writes directly to Supabase.
// ─────────────────────────────────────────────────────────────────────────

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

    // Cache expired — load from Supabase inventory table (single source of truth)
    // If the table is empty it means no sync has run yet — return empty with a message
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

    // Table is empty — no sync has run yet, return empty list
    // Do NOT fall back to the static Apify dataset — that causes duplicate key errors on first sync
    console.log("[inventory] Supabase inventory table is empty. Awaiting first sync.");
    return res.json({
      success:     true,
      count:       0,
      lastFetched: new Date(now).toISOString(),
      syncStatus,
      vehicles:    [],
      message:     "No inventory yet — request a sync to populate.",
    });
  } catch (err) {
    console.error("[inventory] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /inventory/bust-cache — called by local scraper after sync completes
app.post("/inventory/bust-cache", async (req, res) => {
  cachedInventory = [];
  lastFetched     = null;
  console.log("[inventory] Cache busted — will reload from Supabase on next request");
  res.json({ success: true, message: "Cache cleared. Inventory will reload on next page visit." });
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

    // Notify everyone — the local scraper script handles the actual scraping
    // Whoever runs RUN-SCRAPER.bat on their computer will do the sync
    res.json({ success: true, message: "Sync approved. Run the RUN-SCRAPER.bat script on your computer to start the sync." });
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
