/**
 * HOUSE OF CARS — Facebook Marketplace Agent v5
 * Methodical scroll-then-fill approach
 */
const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const PORT        = 7823;
const PROFILE_DIR = path.join(process.env.APPDATA || __dirname, "HOC-Agent", "chrome-profile");
const LOG_FILE    = path.join(__dirname, "agent.log");

function log(msg, type = "info") {
  const icons = { info: "→", success: "✅", error: "❌", warn: "⚠️", step: "▶" };
  const ts = new Date().toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const line = `[${ts}] ${icons[type] || "→"} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch(e) {}
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let agentStatus = { state: "idle", message: "Ready", progress: 0 };
let activeJob = null, activeBrowser = null, waitingForConfirm = false;

function setStatus(state, message, progress = 0, jobId = null, extra = {}) {
  agentStatus = { state, message, progress, jobId, ...extra, updatedAt: new Date().toISOString() };
  log(`[${state}] ${message}`);
}

// ── Get the left sidebar scrollable container ─────────────────
async function getSidebar(page) {
  return page.evaluateHandle(() => {
    const divs = Array.from(document.querySelectorAll("div"));
    return divs.find(d => {
      const s = window.getComputedStyle(d);
      const r = d.getBoundingClientRect();
      return r.left < 350 && r.width > 150 && r.width < 600
        && d.scrollHeight > d.clientHeight + 100
        && (s.overflow + s.overflowY).match(/auto|scroll/);
    }) || document.body;
  });
}

// ── Scroll sidebar until element with text is visible ─────────
async function scrollUntilVisible(page, labelText, maxScrolls = 15) {
  for (let i = 0; i < maxScrolls; i++) {
    const visible = await page.evaluate((txt) => {
      const all = Array.from(document.querySelectorAll(
        'input, textarea, [role="combobox"], [role="button"], label, span, div'
      ));
      const el = all.find(e => {
        const t = (e.innerText || e.getAttribute("aria-label") || e.getAttribute("placeholder") || "").trim().toLowerCase();
        return t === txt.toLowerCase() || t.includes(txt.toLowerCase());
      });
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.top > 60 && r.bottom < window.innerHeight - 60;
    }, labelText);
    if (visible) return true;
    // Scroll sidebar down
    await page.evaluate(() => {
      const divs = Array.from(document.querySelectorAll("div"));
      const sidebar = divs.find(d => {
        const s = window.getComputedStyle(d);
        const r = d.getBoundingClientRect();
        return r.left < 350 && r.width > 150 && r.width < 600
          && d.scrollHeight > d.clientHeight + 100
          && (s.overflow + s.overflowY).match(/auto|scroll/);
      });
      if (sidebar) sidebar.scrollTop += 250;
    });
    await sleep(500);
  }
  return false;
}

// ── Click a dropdown and select an option ─────────────────────
async function selectDropdown(page, labelText, optionText, useTyping = true) {
  try {
    await scrollUntilVisible(page, labelText);
    const clicked = await page.evaluate((lbl) => {
      const all = Array.from(document.querySelectorAll('[role="combobox"],[role="button"],[aria-haspopup="listbox"]'));
      const el = all.find(e => {
        const t = (e.innerText || e.getAttribute("aria-label") || e.getAttribute("placeholder") || "").trim().toLowerCase();
        return t === lbl.toLowerCase() || t.includes(lbl.toLowerCase());
      });
      if (el) { el.click(); return true; }
      return false;
    }, labelText);
    if (!clicked) { log(`Dropdown not found: "${labelText}"`, "warn"); return false; }
    await sleep(1200);

    // Try clicking option directly WITHOUT typing first
    // Typing can leak text into subsequent fields
    const foundDirect = await page.evaluate((opt) => {
      const lc   = opt.toLowerCase();
      const opts = Array.from(document.querySelectorAll('[role="option"]'));
      const match = opts.find(o => (o.innerText||"").trim().toLowerCase() === lc)
        || opts.find(o => (o.innerText||"").trim().toLowerCase().includes(lc));
      if (match) { match.scrollIntoView({ block: "nearest" }); match.click(); return true; }
      // Scroll listbox to find it
      const lb = document.querySelector('[role="listbox"]');
      if (lb) {
        lb.scrollTop = 0;
        for (let i = 0; i < 20; i++) {
          const m2 = Array.from(lb.querySelectorAll('[role="option"]')).find(o => (o.innerText||"").toLowerCase().includes(lc));
          if (m2) { m2.scrollIntoView({ block: "nearest" }); m2.click(); return true; }
          lb.scrollTop += 150;
        }
      }
      return false;
    }, optionText);

    if (foundDirect) {
      await sleep(700);
      log(`Dropdown "${labelText}" → "${optionText}"`, "success");
      return true;
    }

    // Only type to filter if scrolling didn't find it (Year/Make have long lists)
    if (useTyping) {
      await page.keyboard.type(optionText, { delay: 50 });
      await sleep(800);
      const foundAfterType = await page.evaluate((opt) => {
        const lc  = opt.toLowerCase();
        const opts = Array.from(document.querySelectorAll('[role="option"]'));
        const match = opts.find(o => (o.innerText||"").trim().toLowerCase() === lc)
          || opts.find(o => (o.innerText||"").trim().toLowerCase().includes(lc));
        if (match) { match.scrollIntoView({ block: "nearest" }); match.click(); return true; }
        return false;
      }, optionText);
      if (!foundAfterType) {
        await page.keyboard.press("ArrowDown");
        await sleep(200);
        await page.keyboard.press("Enter");
      }
    }

    await sleep(700);
    log(`Dropdown "${labelText}" → "${optionText}"`, "success");
    return true;
  } catch(e) { log(`Dropdown failed "${labelText}": ${e.message}`, "warn"); return false; }
}

// ── Type into a field found by label ─────────────────────────
async function typeField(page, labelText, value) {
  try {
    await scrollUntilVisible(page, labelText);
    const focused = await page.evaluate((lbl) => {
      const inputs = Array.from(document.querySelectorAll("input, textarea"));
      const el = inputs.find(e =>
        (e.getAttribute("aria-label")||"").toLowerCase().includes(lbl.toLowerCase()) ||
        (e.getAttribute("placeholder")||"").toLowerCase().includes(lbl.toLowerCase())
      );
      if (el) { el.focus(); el.click(); return true; }
      // Try via label element
      const labels = Array.from(document.querySelectorAll("label, div, span"));
      const lel = labels.find(e => (e.innerText||"").trim().toLowerCase() === lbl.toLowerCase());
      if (lel) {
        const inp = lel.querySelector("input,textarea")
          || lel.nextElementSibling?.querySelector("input,textarea")
          || lel.parentElement?.querySelector("input,textarea");
        if (inp) { inp.focus(); inp.click(); return true; }
      }
      return false;
    }, labelText);
    if (!focused) { log(`Input not found: "${labelText}"`, "warn"); return false; }
    await sleep(400);
    // Select all and delete existing content before typing
    await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
    await sleep(100);
    await page.keyboard.press("Delete");
    await sleep(100);
    await page.keyboard.press("Backspace");
    await sleep(200);
    await page.keyboard.type(value, { delay: 40 });
    await sleep(400);
    log(`Typed "${labelText}" → "${value}"`, "success");
    return true;
  } catch(e) { log(`typeField failed "${labelText}": ${e.message}`, "warn"); return false; }
}

// ── Click a button by its text ────────────────────────────────
async function clickButton(page, texts) {
  const btns = await page.$$('[role="button"],button');
  for (const btn of btns) {
    try {
      const txt = await page.evaluate(el => el.innerText?.trim(), btn);
      if (texts.some(t => txt?.includes(t))) { await btn.click(); await sleep(800); log(`Clicked: "${txt}"`); return true; }
    } catch(e) {}
  }
  return false;
}

// ── Detect body style from vehicle data ───────────────────────
function detectBodyStyle(vehicle) {
  const m = (vehicle.model || "").toLowerCase();
  const t = (vehicle.type || vehicle.bodyType || "").toLowerCase();
  if (["f-150","f150","silverado","ram 1500","ram 2500","tacoma","tundra","canyon","colorado","frontier","ridgeline","f250","f350"].some(x=>m.includes(x))) return "Truck";
  if (["civic","corolla","camry","accord","altima","malibu","sentra","elantra","fusion","jetta","passat"].some(x=>m.includes(x))) return "Sedan";
  if (["golf","yaris","fit","fiesta","hatchback"].some(x=>m.includes(x))) return "Hatchback";
  if (t.includes("truck")||t.includes("pickup")) return "Truck";
  if (t.includes("sedan")) return "Sedan";
  if (t.includes("coupe")) return "Coupe";
  if (t.includes("hatch")) return "Hatchback";
  if (t.includes("van")||t.includes("minivan")) return "Minivan";
  if (t.includes("wagon")) return "Wagon";
  if (t.includes("convertible")) return "Convertible";
  return "SUV";
}

// ── Build description ─────────────────────────────────────────
function buildDescription(vehicle, features, customNote, cleanModel) {
  const fmt = n => n ? "$" + Number(n).toLocaleString() : "";
  const m = cleanModel.toLowerCase();
  let typeLabel = "car";
  if (["f-150","f150","silverado","ram","tacoma","tundra","canyon","colorado","frontier","ridgeline"].some(x=>m.includes(x))) typeLabel = "truck";
  else if (m.includes("suv")||(vehicle.type||"").toLowerCase().includes("suv")) typeLabel = "SUV";
  else if (m.includes("van")) typeLabel = "van";
  else if (["civic","corolla","camry","accord","altima","sentra","elantra","malibu"].some(x=>m.includes(x))) typeLabel = "sedan";

  const mileage = String(vehicle.mileage||"").replace(/[^0-9,]/g,"");
  const checks  = [`✔ ${mileage ? mileage + " KM" : "[Mileage] KM"}`];
  (features||"").split("\n").map(f=>f.trim()).filter(Boolean).forEach(f=>checks.push(`✔ ${f}`));

  return [
    `💰 Price: ${fmt(vehicle.price)} + GST`,
    `📍 Location: Calgary, AB`,
    `📦 Stock #: ${vehicle.stock}`,
    "",
    `Looking for a reliable ${typeLabel} that's ready for the road? This ${vehicle.year} ${vehicle.make} ${cleanModel} is a great option whether you're looking for a daily driver, work vehicle, or something comfortable for Alberta roads year-round.`,
    "",
    ...(customNote ? [customNote, ""] : []),
    "Vehicle Highlights:",
    ...checks,
    "",
    "This vehicle has been fully inspected and professionally detailed, making it ready for its next owner.",
    "",
    "🚗 Financing Available",
    "We work with multiple lenders and can help with good credit, bad credit, or no credit situations.",
    "",
    "📩 Message me directly for more information, to schedule a test drive, or to get started on financing.",
    "",
    "We are an AMVIC licensed dealer.",
  ].join("\n");
}

// ── Main post flow ────────────────────────────────────────────
async function postToMarketplace(job) {
  const { vehicle, features, customNote, photos, jobId } = job;
  let puppeteer;
  try { puppeteer = require("puppeteer"); }
  catch(e) { throw new Error("Puppeteer not installed. Run INSTALL-AGENT.bat first."); }

  setStatus("launching", "Opening Facebook…", 5, jobId);
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const path2 = require("path");
  const fs2   = require("fs");

  // Search for chrome.exe in multiple possible locations
  const chromeCandidates = [
    path2.join(__dirname, "chrome-win64", "chrome.exe"),
    path2.join(__dirname, "puppeteer", "chrome-win64", "chrome.exe"),
    path2.join(__dirname, "node_modules", "puppeteer", ".local-chromium", "win64-*", "chrome-win64", "chrome.exe"),
  ];

  // Also search cache
  const userCache = process.env.USERPROFILE || "C:\Users\User";
  const cacheBase = path2.join(userCache, ".cache", "puppeteer", "chrome");
  if (fs2.existsSync(cacheBase)) {
    try {
      const versions = fs2.readdirSync(cacheBase);
      for (const v of versions) {
        chromeCandidates.push(path2.join(cacheBase, v, "chrome-win64", "chrome.exe"));
      }
    } catch(e) {}
  }

  let executablePath = undefined;
  for (const candidate of chromeCandidates) {
    if (fs2.existsSync(candidate)) {
      executablePath = candidate;
      log("Using Chrome: " + candidate);
      break;
    }
  }
  if (!executablePath) log("No bundled Chrome found — Puppeteer will use its default", "warn");

  log("Launching Chrome from: " + (executablePath || "puppeteer default"));
  log("Profile dir: " + PROFILE_DIR);

  // Verify chrome.exe exists before trying to launch
  if (executablePath && !require("fs").existsSync(executablePath)) {
    throw new Error("chrome.exe not found at: " + executablePath + " — make sure chrome-win64 folder is in the same folder as hoc-agent.js");
  }

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: PROFILE_DIR,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--start-maximized",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    defaultViewport: null,
  });
  activeBrowser = browser;
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

  setStatus("checking", "Checking Facebook login…", 8, jobId);
  await page.goto("https://www.facebook.com/marketplace/create/vehicle", { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(2500);

  const needsLogin = await page.evaluate(() => !!document.querySelector('input[name="email"]') || window.location.href.includes("/login"));
  if (needsLogin) {
    setStatus("waiting_login", "Please log into Facebook in the browser — agent will continue automatically.", 8, jobId);
    for (let i = 0; i < 36; i++) {
      await sleep(5000);
      const still = await page.evaluate(() => !!document.querySelector('input[name="email"]') || window.location.href.includes("/login"));
      if (!still) break;
    }
    await page.goto("https://www.facebook.com/marketplace/create/vehicle", { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(2500);
  }

  // Clean model — replace underscores, remove body type suffix, remove make name if prepended
  const cleanModel = (vehicle.model||"")
    .replace(/_/g, " ")                          // underscores to spaces
    .replace(/\s+/g, " ")                        // collapse double spaces
    .replace(/\s*(SUV|Truck|Sedan|Coupe|Hatchback|Wagon|Minivan|Van|Convertible|Pickup)\s*$/i, "")
    .replace(new RegExp("^" + (vehicle.make||"").replace(/[-\/\^$*+?.()|[\]{}]/g,"\$&") + "\s*", "i"), "")
    .trim();
  const bodyStyle   = detectBodyStyle(vehicle);
  // Sanitize mileage — digits only, max 999999
  const mileageRaw = String(vehicle.mileage||"").replace(/[^0-9]/g,"");
  const mileageNum = mileageRaw && parseInt(mileageRaw) <= 999999 ? mileageRaw : mileageRaw.slice(0, 6);
  const description = buildDescription(vehicle, features, customNote, cleanModel);

  // ── PAGE 1: scroll sidebar top, fill each field in order ──
  // Reset sidebar to top
  await page.evaluate(() => {
    const divs = Array.from(document.querySelectorAll("div"));
    const sb = divs.find(d => {
      const s = window.getComputedStyle(d);
      const r = d.getBoundingClientRect();
      return r.left < 350 && r.width > 150 && r.width < 600
        && d.scrollHeight > d.clientHeight + 100
        && (s.overflow + s.overflowY).match(/auto|scroll/);
    });
    if (sb) sb.scrollTop = 0;
  });
  await sleep(500);

  setStatus("filling", "Selecting vehicle type…", 15, jobId);
  await selectDropdown(page, "Vehicle type", "Car/Truck", false);

  setStatus("filling", `Selecting year: ${vehicle.year}…`, 22, jobId);
  await selectDropdown(page, "Year", String(vehicle.year));

  setStatus("filling", `Selecting make: ${vehicle.make}…`, 29, jobId);
  await selectDropdown(page, "Make", vehicle.make);

  setStatus("filling", `Typing model: ${cleanModel}…`, 36, jobId);
  await typeField(page, "Model", cleanModel);

  setStatus("filling", `Selecting body style: ${bodyStyle}…`, 40, jobId);
  await selectDropdown(page, "Body style", bodyStyle, false);

  setStatus("filling", "Entering mileage…", 45, jobId);
  await typeField(page, "Mileage", mileageNum);

  // Upload photos — max 10, uploaded in batches of 3 to avoid bot detection
  if (photos && photos.length > 0) {
    const maxPhotos  = Math.min(photos.length, 10);
    const batchSize  = 3;
    setStatus("uploading", `Uploading ${maxPhotos} photo(s) in batches…`, 52, jobId);
    try {
      // Write all temp files first
      const tempFiles = [];
      for (let i = 0; i < maxPhotos; i++) {
        const tp  = path.join(__dirname, `temp_photo_${i}.jpg`);
        const b64 = photos[i].replace(/^data:image\/\w+;base64,/, "");
        fs.writeFileSync(tp, Buffer.from(b64, "base64"));
        tempFiles.push(tp);
      }

      // Upload in batches with a pause between each
      for (let i = 0; i < tempFiles.length; i += batchSize) {
        const batch = tempFiles.slice(i, i + batchSize);
        const fileInput = await page.$('input[type="file"]');
        if (!fileInput) { log("File input not found", "warn"); break; }
        await fileInput.uploadFile(...batch);
        log(`Uploaded batch ${Math.floor(i/batchSize)+1}: ${batch.length} photo(s)`);
        // Wait between batches — gives Facebook time to process
        await sleep(4000 + Math.random() * 2000);
      }

      // Clean up temp files
      tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
      await sleep(2000);
    } catch(e) { log("Photo upload: " + e.message, "warn"); }
  }

  // Continue scrolling down — price and description are below on the same page

  setStatus("filling", "Entering price…", 63, jobId);
  try {
    await sleep(500);
    // Find and click the price input — same as mileage, just a plain input
    const priceEl = await page.$('input[placeholder="Price"]')
      || await page.$('input[aria-label="Price"]')
      || await page.$('input[placeholder*="price" i]')
      || await page.$('input[aria-label*="price" i]');
    if (priceEl) {
      await priceEl.click({ clickCount: 3 });
      await sleep(200);
      await page.keyboard.type(String(vehicle.price || "").replace(/[$,]/g, ""), { delay: 40 });
      log("Price entered: " + vehicle.price, "success");
    } else {
      // Fallback — price field is focused after page load, just type
      await page.keyboard.press("Tab");
      await sleep(200);
      await page.keyboard.type(String(vehicle.price || "").replace(/[$,]/g, ""), { delay: 40 });
      log("Price entered via Tab fallback", "success");
    }
  } catch(e) { log("Price error: " + e.message, "warn"); }

  setStatus("filling", "Writing description…", 70, jobId);
  await scrollUntilVisible(page, "Description");
  try {
    const descEl = await page.$('textarea[aria-label*="Description" i]') || await page.$('textarea');
    if (descEl) {
      await descEl.click({ clickCount: 3 });
      await sleep(300);
      await page.keyboard.type(description, { delay: 8 });
      log("Description written", "success");
    }
  } catch(e) { log("Description error: " + e.message, "warn"); }

  await sleep(500);

  // ── PAUSE for review ──────────────────────────────────
  setStatus("review",
    "✋ Ready for review! Check the browser window, make any changes, then click Confirm & Post in the CRM.",
    80, jobId,
    { preview: { title: `${vehicle.year} ${vehicle.make} ${cleanModel}`, price: vehicle.price, mileage: vehicle.mileage, description } }
  );
  waitingForConfirm = true;
  log("Paused — waiting for rep to confirm…", "step");

  for (let i = 0; i < 180; i++) {
    await sleep(5000);
    if (!waitingForConfirm) break;
    if (!activeJob) return;
  }
  if (waitingForConfirm) throw new Error("Timed out after 15 minutes.");

  setStatus("publishing", "Publishing…", 90, jobId);
  await sleep(1000);
  await clickButton(page, ["Publish","Post","List vehicle"]);
  await sleep(4000);

  setStatus("complete", `✅ ${vehicle.year} ${vehicle.make} ${cleanModel} posted to Marketplace!`, 100, jobId);
  log("Done!", "success");
  await sleep(5000);
  await browser.close();
  activeBrowser = null; activeJob = null;
}

// ── HTTP Server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Content-Type","application/json");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }
  let body = "";
  req.on("data", c => body += c);
  await new Promise(r => req.on("end", r));
  const url = req.url.split("?")[0];

  if (req.method === "GET" && url === "/status") {
    res.writeHead(200); res.end(JSON.stringify({ success:true, agent:"running", ...agentStatus })); return;
  }
  if (req.method === "POST" && url === "/post") {
    if (activeJob) { res.writeHead(409); res.end(JSON.stringify({ success:false, error:"Agent busy." })); return; }
    let job; try { job = JSON.parse(body); } catch(e) { res.writeHead(400); res.end(JSON.stringify({ success:false, error:"Bad body" })); return; }
    res.writeHead(200); res.end(JSON.stringify({ success:true, message:"Job started!", jobId:job.jobId }));
    activeJob = job; waitingForConfirm = false;
    postToMarketplace(job).catch(err => {
      setStatus("error", err.message, 0, job?.jobId);
      activeJob = null; activeBrowser = null; waitingForConfirm = false;
    });
    return;
  }
  if (req.method === "POST" && url === "/confirm") {
    if (!waitingForConfirm) { res.writeHead(400); res.end(JSON.stringify({ success:false, error:"Not waiting." })); return; }
    waitingForConfirm = false;
    setStatus("publishing","Confirmed! Publishing now…", 88, activeJob?.jobId);
    res.writeHead(200); res.end(JSON.stringify({ success:true })); return;
  }
  if (req.method === "POST" && url === "/stop") {
    if (activeBrowser) { try { await activeBrowser.close(); } catch(e) {} activeBrowser = null; }
    waitingForConfirm = false; activeJob = null;
    setStatus("idle","Stopped by user",0);
    res.writeHead(200); res.end(JSON.stringify({ success:true })); return;
  }
  res.writeHead(404); res.end(JSON.stringify({ success:false, error:"Not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("\n╔═══════════════════════════════════════════╗");
  console.log("║   HOUSE OF CARS — Facebook Agent v5       ║");
  console.log(`║   Running on localhost:${PORT}             ║`);
  console.log("║   Waiting for jobs from the CRM           ║");
  console.log("╚═══════════════════════════════════════════╝\n");
  setStatus("idle","Ready — waiting for a job from the CRM");
});

server.on("error", err => {
  if (err.code === "EADDRINUSE") console.error(`\n❌ Port ${PORT} already in use.\n`);
  else console.error("Server error:", err.message);
  process.exit(1);
});

process.on("SIGINT", async () => {
  if (activeBrowser) { try { await activeBrowser.close(); } catch(e) {} }
  server.close(); process.exit(0);
});
