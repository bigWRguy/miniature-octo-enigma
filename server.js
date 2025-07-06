// server.js on Glitch (Complete - Simplified Manual Refresh + File Cache)

const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const app = express();

// --- Configuration ---
const CACHE_FILE_PATH = path.join(__dirname, '.data', 'sheet_cache.json');
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

// --- Environment Variables ---
const API_KEY = process.env.GOOGLE_SHEETS_API_KEY;
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const SHEET_NAME = 'All';

console.log('--- DIAGNOSTIC CHECK ---');
console.log('API Key Loaded:', !!process.env.GOOGLE_SHEETS_API_KEY);
console.log('Spreadsheet ID Loaded:', !!process.env.GOOGLE_SPREADSHEET_ID);
console.log('--- END DIAGNOSTIC ---');

// --- State Variables for Caching ---
let memoryCache = null;
let memoryCacheTimestamp = 0;
let initialCacheLoadPromise = null;
let isRefreshing = false; // To prevent multiple simultaneous refresh calls

// --- CORS Setup ---
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// --- Helper to load cache from file to memory ---
async function loadCacheFromFileToMemory() {
    try {
        const fileData = await fs.readFile(CACHE_FILE_PATH, 'utf-8');
        const cacheEntry = JSON.parse(fileData);
        if (Date.now() - cacheEntry.lastCacheUpdateTime < CACHE_MAX_AGE_MS) {
            memoryCache = cacheEntry.data;
            memoryCacheTimestamp = cacheEntry.lastCacheUpdateTime;
            console.log(`(${new Date().toISOString()}) Valid cache loaded from file. Last update: ${new Date(memoryCacheTimestamp).toLocaleTimeString()}`);
            return true;
        }
        console.log(`(${new Date().toISOString()}) Cache file stale.`);
        memoryCache = null; memoryCacheTimestamp = 0; return false;
    } catch (error) {
        if (error.code === 'ENOENT') console.log(`(${new Date().toISOString()}) Cache file not found.`);
        else console.error(`(${new Date().toISOString()}) Error reading cache file:`, error);
        memoryCache = null; memoryCacheTimestamp = 0; return false;
    }
}

// --- Helper to write data to file and memory cache ---
async function writeDataToCache(data) {
    try {
        const newTimestamp = Date.now();
        const cacheEntry = { lastCacheUpdateTime: newTimestamp, data: data };
        await fs.writeFile(CACHE_FILE_PATH, JSON.stringify(cacheEntry, null, 2), 'utf-8');
        memoryCache = data; memoryCacheTimestamp = newTimestamp;
        console.log(`(${new Date().toISOString()}) Data written to file & memory. Last update: ${new Date(newTimestamp).toLocaleTimeString()}`);
    } catch (error) {
        console.error(`(${new Date().toISOString()}) Error writing to cache file:`, error);
    }
}

// --- Function to fetch from Google and update cache ---
async function fetchFromGoogleAndCache(isManualRefresh = false) {
    if (isRefreshing && !isManualRefresh) {
        console.log(`(${new Date().toISOString()}) Refresh already in progress, skipping automatic fetch.`);
        return { success: true, data: memoryCache }; // Return success with existing data
    }
    isRefreshing = true;

    if (!API_KEY || !SPREADSHEET_ID) {
        const errorMsg = "Cannot fetch: API_KEY or SPREADSHEET_ID not set.";
        console.error(errorMsg);
        isRefreshing = false;
        return { success: false, error: errorMsg };
    }
    console.log(`(${new Date().toISOString()}) Fetching fresh data from Google Sheets...`);
    try {
        const sheetsApiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${SHEET_NAME}!A:AZ?key=${API_KEY}`;
        const sheetsResponse = await fetch(sheetsApiUrl);
        if (!sheetsResponse.ok) {
            const errorText = await sheetsResponse.text();
            console.error(`(${new Date().toISOString()}) Google Sheets API Error (${sheetsResponse.status}):`, errorText);
            isRefreshing = false;
            return { success: false, error: errorText, status: sheetsResponse.status };
        }
        const newData = await sheetsResponse.json();
        await writeDataToCache(newData);
        isRefreshing = false;
        return { success: true, data: newData };
    } catch (error) {
        const errorMsg = `Error fetching/processing data from Google: ${error.message}`;
        console.error(`(${new Date().toISOString()})`, errorMsg);
        isRefreshing = false;
        return { success: false, error: errorMsg };
    }
}

// --- Endpoint to SERVE data to your Netlify app ---
app.get('/get-sheet-data', async (req, res) => {
    if (initialCacheLoadPromise) {
        try { await initialCacheLoadPromise; } catch (err) { /* ignore, will be handled by subsequent checks */ }
    }
    if (memoryCache && (Date.now() - memoryCacheTimestamp < CACHE_MAX_AGE_MS)) {
        return res.json(memoryCache);
    }
    const loadedFromFile = await loadCacheFromFileToMemory();
    if (loadedFromFile && memoryCache) return res.json(memoryCache);

    const freshData = await fetchFromGoogleAndCache();
    if (freshData) return res.json(freshData);
    return res.status(503).json({ error: "Service temporarily unavailable: Could not load data." });
});

// --- Endpoint to MANUALLY REFRESH the cache ---
app.get('/refresh-data', async (req, res) => {
    console.log(`(${new Date().toISOString()}) MANUAL REFRESH triggered via /refresh-data`);
    if (isRefreshing) {
        return res.status(429).send("A cache refresh is already in progress. Please try again in a moment.");
    }
    const freshData = await fetchFromGoogleAndCache(true); // true for manual refresh
    if (freshData) {
        res.status(200).send(`Cache refreshed successfully at ${new Date().toLocaleTimeString()}! New data loaded. Your website will now get this new data.`);
    } else {
        res.status(500).send("Failed to refresh cache. Check server logs on Glitch for details (e.g., Google Sheets API errors).");
    }
});

// --- Root route for status ---
app.get('/', async (req, res) => {
    let statusMessage = `Backend with File-Based Cache is running.<br>
        App data endpoint: <a href="/get-sheet-data">/get-sheet-data</a><br>
        <b>To MANUALLY REFRESH cache: <a href="/refresh-data">/refresh-data</a></b> (Visit this link to force an update from Google Sheets)<br><br>
        --- Cache Status ---<br>`;

    let fileCacheInfo = 'File cache status: Checking...';
    try {
        // Check if file exists first without trying to read content immediately
        await fs.access(CACHE_FILE_PATH); // Throws error if doesn't exist
        const stats = await fs.stat(CACHE_FILE_PATH);
        const lastModifiedInFile = new Date(stats.mtimeMs); // When the file itself was last written

        // To get the 'lastCacheUpdateTime' FROM INSIDE the file (more accurate for data freshness)
        let lastDataUpdateInFile = 'Unknown (file might be empty or unreadable)';
        let isDataStaleInFile = true; // Assume stale if we can't read it
        try {
            const fileContent = await fs.readFile(CACHE_FILE_PATH, 'utf-8');
            const cacheEntryInFile = JSON.parse(fileContent);
            if (cacheEntryInFile && cacheEntryInFile.lastCacheUpdateTime) {
                lastDataUpdateInFile = new Date(cacheEntryInFile.lastCacheUpdateTime).toLocaleString();
                isDataStaleInFile = (Date.now() - cacheEntryInFile.lastCacheUpdateTime >= CACHE_MAX_AGE_MS);
            }
        } catch (readErr) {
            // Could happen if file exists but is corrupted or empty
            console.warn("Could not read content from cache file for status page:", readErr.message);
        }

        fileCacheInfo = `Cache file last modified (on disk): ${lastModifiedInFile.toLocaleString()}<br>`;
        fileCacheInfo += `Data timestamp inside file: ${lastDataUpdateInFile}<br>`;
        fileCacheInfo += `Is data in file considered stale (older than ${CACHE_MAX_AGE_MS / (60*60*1000)} hrs)? ${isDataStaleInFile}.`;

    } catch (error) {
        if (error.code === 'ENOENT') {
            fileCacheInfo = 'Cache file (/ .data / sheet_cache.json) does not currently exist.';
        } else {
            fileCacheInfo = 'Error checking cache file status (see server logs).';
            console.error("Error stating cache file for status page:", error);
        }
    }
    statusMessage += fileCacheInfo;

    statusMessage += "<br><br>--- Memory Cache Status ---<br>";
    if (memoryCache && memoryCacheTimestamp) {
        statusMessage += `In-memory cache is POPULATED.<br>Data timestamp in memory: ${new Date(memoryCacheTimestamp).toLocaleString()}<br>`;
        statusMessage += `Is data in memory stale? ${Date.now() - memoryCacheTimestamp >= CACHE_MAX_AGE_MS}.`;
    } else {
        statusMessage += `In-memory cache is currently EMPTY. It will populate from file or Google Sheets on the next /get-sheet-data request or during startup.`;
    }

    if (!API_KEY || !SPREADSHEET_ID) {
        statusMessage += `<br><br><strong style="color:red;">CRITICAL WARNING: GOOGLE_SHEETS_API_KEY or GOOGLE_SPREADSHEET_ID is not set in the .env file! Data fetching will fail.</strong>`;
    }
    res.send(statusMessage);
});

// --- Initialize and Start Server ---
async function initializeAndStartServer() {
    // Start listening for requests as early as possible
    const listener = app.listen(process.env.PORT || 3000, () => {
        console.log(`(${new Date().toISOString()}) App listening on port ${listener.address().port}.`);
        console.log(`View status or refresh cache at the root URL (e.g., https://your-glitch-project.glitch.me/)`);
        console.log(`Data endpoint: /get-sheet-data`);
        console.log(`Manual cache refresh endpoint: /refresh-data`);
    });

    console.log("Server is now listening for requests. Initiating background cache population...");

    // Assign the promise for the initial cache load so /get-sheet-data can await it if needed
    initialCacheLoadPromise = (async () => {
        try {
            if (!API_KEY || !SPREADSHEET_ID) {
                console.error("SERVER STARTUP ERROR: API_KEY or SPREADSHEET_ID not set in .env. Skipping initial cache load.");
                return; // Don't attempt if keys are missing
            }
            const loadedFromFile = await loadCacheFromFileToMemory(); // Try to load from file into memory
            if (!loadedFromFile) { // If file was not found, stale, or error loading it
                console.log("No valid file cache found on startup or cache is stale. Attempting to fetch initial data from Google Sheets...");
                await fetchFromGoogleAndCache(); // Fetch and write to file & memory
            }

            if (memoryCache) {
                console.log("Initial cache population process completed. Data is available in memory.");
            } else {
                console.error("Initial cache population process completed, but NO data was loaded into memory. This could be due to fetch errors or an empty sheet. Check previous logs.");
            }
        } catch (err) {
            console.error("An error occurred during the initial cache population background task:", err);
        } finally {
            initialCacheLoadPromise = null; // Clear the promise once done (or if it failed)
        }
    })();

    // Schedule subsequent updates (only if keys are present)
    if (API_KEY && SPREADSHEET_ID) {
        setInterval(async () => {
            console.log(`(${new Date().toISOString()}) Scheduled cache update triggered.`);
            await fetchFromGoogleAndCache(); // This will update file and memory cache
        }, CACHE_MAX_AGE_MS);
    } else {
        console.warn("Scheduled cache updates are disabled due to missing API_KEY or SPREADSHEET_ID.");
    }
}

// --- Run the Server ---
initializeAndStartServer();
