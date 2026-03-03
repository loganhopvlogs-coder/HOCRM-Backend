const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

const APIFY_TOKEN      = process.env.APIFY_TOKEN;
const APIFY_DATASET_ID = process.env.APIFY_DATASET_ID;

app.use(cors());
app.use(express.json());

let cachedInventory = [];
let lastFetched     = null;
const CACHE_TTL_MS  = 30 * 60 * 1000;

async function fetchFromApify() {
  if (!APIFY_TOKEN || !APIFY_DATASET_ID) throw new Error("Missing APIFY_TOKEN or APIFY_DATASET_ID environment variables.");
  const url = `https://api.apify.com/v2/datasets/${APIFY_DATASET_ID}/items?format=json&clean=true&token=${APIFY_TOKEN}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Apify returned ${res.status}`);
  const raw  = await res.json();
  return raw.map((v, i) => ({
    id:         i + 1,
    stock:      v.stock      || `HOC-${i}`,
    vin:        v.vin        || "",
    year:       v.year       || 0,
    make:       v.make       || "",
    model:      v.model      || "",
    title:      v.title      || `${v.year} ${v.make} ${v.model}`,
    price:      v.price      || 0,
    mileage:    v.mileage    || "",
    location:   v.location   || "",
    type:       v.bodyType   || v.type || "",
    color:      v.color      || "",
    image:      v.image      || "",
    listingUrl: v.listingUrl || v.url || "",
    condition:  v.condition  || "Used",
  }));
}

app.get("/inventory", async (req, res) => {
  try {
    const now          = Date.now();
    const cacheExpired = !lastFetched || (now - lastFetched) > CACHE_TTL_MS;
    if (cacheExpired || req.query.force === "true") {
      console.log("Fetching fresh inventory from Apify...");
      cachedInventory = await fetchFromApify();
      lastFetched     = now;
      console.log(`Fetched ${cachedInventory.length} vehicles.`);
    }
    res.json({ success: true, count: cachedInventory.length, vehicles: cachedInventory });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", vehicles: cachedInventory.length, lastFetched: lastFetched ? new Date(lastFetched).toISOString() : null });
});

app.listen(PORT, () => console.log(`HOCRM backend running on port ${PORT}`));
