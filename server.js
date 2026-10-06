require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
const EventEmitter = require('events');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize the Event Broker
const aqiEmitter = new EventEmitter();

// Tracks the last known AQI category per station, so we only alert on a
// genuine category change (e.g. Good -> Moderate), not on every reading.
const lastCategoryPerStation = new Map();

// Ordered worst-to-best so we can tell if a change is an improvement or not
const CATEGORY_ORDER = ['Good', 'Moderate', 'Unhealthy for Sensitive Groups', 'Unhealthy', 'Very Unhealthy', 'Hazardous'];

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Station Schema (live snapshot, gets overwritten each fetch)
const stationSchema = new mongoose.Schema({
  uid: Number,
  name: String,
  lat: Number,
  lng: Number,
  aqi: String,
  pollutant: String,
  status: String,
  color: String,
  waqiTime: String,
  updatedAt: { type: Date, default: Date.now }
});

const Station = mongoose.model('Station', stationSchema);

// AQI Log Schema (append-only history, one row per station per fetch)
const aqiLogSchema = new mongoose.Schema({
  uid: Number,
  station: String,
  aqi: String,
  status: String,
  lat: Number,
  lng: Number,
  loggedAt: { type: Date, default: Date.now }
});

const AqiLog = mongoose.model('AqiLog', aqiLogSchema);

// 6-Tier AQI Classification
function getAqiStatus(aqiValue) {
  const aqi = Number(aqiValue);
  if (isNaN(aqi)) return { status: 'Offline', color: '#808080' };
  if (aqi <= 50) return { status: 'Good', color: '#00e400' };
  if (aqi <= 100) return { status: 'Moderate', color: '#ffde33' };
  if (aqi <= 150) return { status: 'Unhealthy for Sensitive Groups', color: '#ff7e00' };
  if (aqi <= 200) return { status: 'Unhealthy', color: '#ff0000' };
  if (aqi <= 300) return { status: 'Very Unhealthy', color: '#800080' };
  return { status: 'Hazardous', color: '#7e0023' };
}

// Shared fetch logic: pulls live stations from WAQI, classifies them,
// emits an alert only when a station's category actually changes, and
// returns the mapped station list.
async function fetchStations() {
  const bounds = "14.35,120.85,14.80,121.15";
  const boundsUrl = `https://api.waqi.info/v2/map/bounds/?latlng=${bounds}&token=${process.env.WAQI_TOKEN}`;

  const boundsResponse = await axios.get(boundsUrl, { timeout: 8000 });
  const activeStations = boundsResponse.data?.data || [];

  return activeStations.map(station => {
    const aqiData = getAqiStatus(station.aqi);
    const stationName = station.station.name;
    const newStatus = aqiData.status;
    const prevStatus = lastCategoryPerStation.get(stationName);

    // Only emit once we have a previous reading to compare against,
    // and only when the category actually differs from last time.
    if (prevStatus !== undefined && prevStatus !== newStatus) {
      const prevRank = CATEGORY_ORDER.indexOf(prevStatus);
      const newRank = CATEGORY_ORDER.indexOf(newStatus);
      const direction = newRank > prevRank ? 'worsened' : 'improved';

      aqiEmitter.emit('unhealthy-air', {
        station: stationName,
        aqi: station.aqi,
        status: newStatus,
        previousStatus: prevStatus,
        direction
      });
    }
    lastCategoryPerStation.set(stationName, newStatus);

    return {
      uid: station.uid,
      name: stationName,
      lat: station.lat,
      lng: station.lon,
      aqi: station.aqi,
      pollutant: 'PM2.5',
      status: newStatus,
      color: aqiData.color
    };
  });
}

// Writes the current station readings into the append-only log collection.
// Runs on a schedule (below) so history builds up even with nobody on the site.
async function logAqiSnapshot() {
  try {
    const mapData = await fetchStations();

    if (mapData.length > 0) {
      const logs = mapData.map(s => ({
        uid: s.uid,
        station: s.name,
        aqi: s.aqi,
        status: s.status,
        lat: s.lat,
        lng: s.lng
      }));
      await AqiLog.insertMany(logs);

      await Station.deleteMany({});
      await Station.insertMany(mapData);

      console.log(`Logged ${logs.length} readings at ${new Date().toISOString()}`);
    }
  } catch (error) {
    console.error('Scheduled logging failed:', error.message);
  }
}

// Keeps track of when we last wrote to the log, so we can catch up even if
// Render's free tier put the server to sleep and the exact :00/:30 mark was missed.
let lastLoggedAt = 0;
const LOG_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function logIfDue() {
  const now = Date.now();
  if (now - lastLoggedAt >= LOG_INTERVAL_MS) {
    lastLoggedAt = now;
    await logAqiSnapshot();
  }
}

// Still runs on the normal schedule while the server is awake...
cron.schedule('*/30 * * * *', logIfDue);

// ...but ALSO checks on every live map request, so a visit after the server
// wakes from sleep immediately catches up on a missed cycle instead of
// waiting for the next exact :00/:30 mark.
app.use((req, res, next) => {
  if (req.path === '/api/map-aqi') logIfDue();
  next();
});

// 1. STANDARD ENDPOINT: Fetches live map data within Metro Manila bounds
app.get('/api/map-aqi', async (req, res) => {
  try {
    const mapData = await fetchStations();

    if (mapData.length > 0) {
      await Station.deleteMany({});
      await Station.insertMany(mapData);
      return res.json(mapData);
    }

    const cached = await Station.find({});
    res.json(cached);
  } catch (error) {
    console.error("Map AQI fetch error:", error.message);
    const cached = await Station.find({});
    res.json(cached);
  }
});

// 2. SSE ENDPOINT: Event Consumer Gateway
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendAlert = (alertData) => {
    res.write(`data: ${JSON.stringify(alertData)}\n\n`);
  };

  aqiEmitter.on('unhealthy-air', sendAlert);

  req.on('close', () => {
    aqiEmitter.off('unhealthy-air', sendAlert);
  });
});

// 3. SIMULATION ENDPOINT: For testing alert triggers
app.post('/api/simulate-alert', (req, res) => {
  aqiEmitter.emit('unhealthy-air', {
    station: "Simulated Test City",
    aqi: 155,
    status: "Unhealthy",
    previousStatus: "Moderate",
    direction: "worsened"
  });
  res.json({ message: "Simulated alert dispatched!" });
});

// 4. STATION FEED ENDPOINT: Fetches authentic sensor timestamps
app.get('/api/station/:uid', async (req, res) => {
  try {
    const feedUrl = `https://api.waqi.info/feed/@${req.params.uid}/?token=${process.env.WAQI_TOKEN}`;
    const response = await axios.get(feedUrl, { timeout: 6000 });
    res.json(response.data?.data || {});
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch station feed" });
  }
});

// 5. HISTORY ENDPOINT (JSON): Returns logged readings for a given day
app.get('/api/history', async (req, res) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    const filter = { loggedAt: { $gte: start, $lte: end } };
    if (req.query.station) filter.station = req.query.station;

    const logs = await AqiLog.find(filter).sort({ loggedAt: 1 });
    res.json(logs);
  } catch (error) {
    console.error("History fetch error:", error.message);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// Groups a timestamp into Morning (5am-12pm), Afternoon (12pm-6pm), or Evening
// (6pm-5am, wrapping overnight readings into Evening too).
function getPeriod(date) {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'Morning';
  if (h >= 12 && h < 18) return 'Afternoon';
  return 'Evening';
}

// 6. DASHBOARD: Human-readable history view with Morning/Afternoon/Evening
// trend charts. Visit directly in a browser, e.g.:
//   https://metroair.onrender.com/dashboard
//   https://metroair.onrender.com/dashboard?date=2026-10-05
//   https://metroair.onrender.com/dashboard?date=2026-10-05&station=Ortigas
app.get(['/dashboard', '/history'], async (req, res) => {
  try {
    const dateParam = req.query.date;
    const date = dateParam ? new Date(dateParam) : new Date();
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    const filter = { loggedAt: { $gte: start, $lte: end } };
    if (req.query.station) filter.station = req.query.station;

    const logs = await AqiLog.find(filter).sort({ loggedAt: 1 });

    const dateStr = start.toISOString().slice(0, 10);
    const stationList = await AqiLog.distinct('station');
    stationList.sort();

    // --- Morning / Afternoon / Evening averages ---
    const periodStats = {
      Morning: { sum: 0, count: 0 },
      Afternoon: { sum: 0, count: 0 },
      Evening: { sum: 0, count: 0 }
    };
    logs.forEach(log => {
      const aqiNum = Number(log.aqi);
      if (isNaN(aqiNum)) return;
      const period = getPeriod(new Date(log.loggedAt));
      periodStats[period].sum += aqiNum;
      periodStats[period].count += 1;
    });
    const periodAverages = {
      Morning: periodStats.Morning.count ? +(periodStats.Morning.sum / periodStats.Morning.count).toFixed(1) : null,
      Afternoon: periodStats.Afternoon.count ? +(periodStats.Afternoon.sum / periodStats.Afternoon.count).toFixed(1) : null,
      Evening: periodStats.Evening.count ? +(periodStats.Evening.sum / periodStats.Evening.count).toFixed(1) : null
    };

    // --- Trend line across the day (averaged across stations per snapshot,
    //     or just that station's readings if one is selected) ---
    const bySnapshot = {};
    logs.forEach(log => {
      const aqiNum = Number(log.aqi);
      if (isNaN(aqiNum)) return;
      const key = new Date(log.loggedAt).toISOString();
      if (!bySnapshot[key]) bySnapshot[key] = { sum: 0, count: 0 };
      bySnapshot[key].sum += aqiNum;
      bySnapshot[key].count += 1;
    });
    const snapshotPoints = Object.entries(bySnapshot)
      .sort((a, b) => new Date(a[0]) - new Date(b[0]))
      .map(([t, v]) => ({
        label: new Date(t).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: true }),
        avg: +(v.sum / v.count).toFixed(1)
      }));

    const statusColor = (status) => ({
      'Good': '#00e400',
      'Moderate': '#cccc00',
      'Unhealthy for Sensitive Groups': '#ff7e00',
      'Unhealthy': '#ff0000',
      'Very Unhealthy': '#800080',
      'Hazardous': '#7e0023',
      'Offline': '#808080'
    }[status] || '#808080');

    const rows = [...logs].reverse().map(log => {
      const time = new Date(log.loggedAt).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: true });
      const color = statusColor(log.status);
      const textColor = (color === '#cccc00') ? '#111' : '#fff';
      return `
        <tr>
          <td>${time}</td>
          <td>${log.station || '-'}</td>
          <td style="text-align:center;font-weight:700;">${log.aqi ?? '-'}</td>
          <td><span style="background:${color};color:${textColor};padding:3px 10px;border-radius:12px;font-size:0.8rem;font-weight:600;">${log.status || 'Unknown'}</span></td>
        </tr>`;
    }).join('');

    const stationOptions = stationList.map(s =>
      `<option value="${s}" ${req.query.station === s ? 'selected' : ''}>${s}</option>`
    ).join('');

    const periodCard = (label, value, icon) => `
      <div class="card">
        <div class="card-icon">${icon}</div>
        <div class="card-label">${label}</div>
        <div class="card-value">${value === null ? '—' : value}</div>
        <div class="card-sub">${value === null ? 'No data' : 'avg AQI'}</div>
      </div>`;

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>MetroAir | Dashboard</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
        <style>
          body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f1f5f9; margin: 0; padding: 24px; color: #0f172a; }
          .wrap { max-width: 1000px; margin: 0 auto; }
          h1 { font-size: 1.6rem; margin-bottom: 4px; }
          .sub { color: #64748b; margin-bottom: 20px; font-size: 0.9rem; }
          form { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; background: white; padding: 14px; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
          label { font-size: 0.8rem; color: #475569; display: flex; flex-direction: column; gap: 4px; }
          input, select { padding: 6px 10px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 0.9rem; }
          button { align-self: flex-end; background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 6px; font-weight: 600; cursor: pointer; }
          .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 20px; }
          .card { background: white; border-radius: 10px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-align: center; }
          .card-icon { font-size: 1.4rem; }
          .card-label { font-size: 0.85rem; color: #64748b; margin-top: 4px; }
          .card-value { font-size: 1.8rem; font-weight: 800; margin-top: 2px; }
          .card-sub { font-size: 0.75rem; color: #94a3b8; }
          .chart-box { background: white; border-radius: 10px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 20px; }
          .chart-box h3 { margin: 0 0 12px 0; font-size: 1rem; }
          table { width: 100%; border-collapse: collapse; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
          th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 0.9rem; }
          th { background: #0f172a; color: white; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
          tr:last-child td { border-bottom: none; }
          .empty { padding: 40px; text-align: center; color: #94a3b8; background: white; border-radius: 10px; }
          .count { color: #64748b; font-size: 0.85rem; margin-bottom: 10px; }
        </style>
      </head>
      <body>
        <div class="wrap">
          <h1>MetroAir Dashboard</h1>
          <div class="sub">Logged automatically every 30 minutes &middot; alerts fire only when a station's AQI category changes</div>

          <form method="GET" action="/dashboard">
            <label>Date
              <input type="date" name="date" value="${dateStr}" />
            </label>
            <label>Station
              <select name="station">
                <option value="">All stations</option>
                ${stationOptions}
              </select>
            </label>
            <button type="submit">Filter</button>
          </form>

          <div class="cards">
            ${periodCard('Morning', periodAverages.Morning, '🌅')}
            ${periodCard('Afternoon', periodAverages.Afternoon, '☀️')}
            ${periodCard('Evening', periodAverages.Evening, '🌆')}
          </div>

          <div class="chart-box">
            <h3>Morning vs Afternoon vs Evening (avg AQI)</h3>
            <canvas id="periodChart" height="90"></canvas>
          </div>

          <div class="chart-box">
            <h3>AQI Trend Across the Day${req.query.station ? ` &mdash; ${req.query.station}` : ' (all stations averaged)'}</h3>
            <canvas id="trendChart" height="90"></canvas>
          </div>

          <div class="count">${logs.length} reading${logs.length === 1 ? '' : 's'} found for ${dateStr}</div>

          ${logs.length === 0 ? '<div class="empty">No readings logged for this day yet.</div>' : `
          <table>
            <thead>
              <tr><th>Time</th><th>Station</th><th>AQI</th><th>Status</th></tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>`}
        </div>

        <script>
          const periodCtx = document.getElementById('periodChart');
          new Chart(periodCtx, {
            type: 'bar',
            data: {
              labels: ['Morning', 'Afternoon', 'Evening'],
              datasets: [{
                label: 'Average AQI',
                data: [${periodAverages.Morning ?? 'null'}, ${periodAverages.Afternoon ?? 'null'}, ${periodAverages.Evening ?? 'null'}],
                backgroundColor: ['#38bdf8', '#f59e0b', '#6366f1'],
                borderRadius: 6
              }]
            },
            options: {
              plugins: { legend: { display: false } },
              scales: { y: { beginAtZero: true, title: { display: true, text: 'AQI' } } }
            }
          });

          const trendCtx = document.getElementById('trendChart');
          new Chart(trendCtx, {
            type: 'line',
            data: {
              labels: ${JSON.stringify(snapshotPoints.map(p => p.label))},
              datasets: [{
                label: 'AQI',
                data: ${JSON.stringify(snapshotPoints.map(p => p.avg))},
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59,130,246,0.1)',
                tension: 0.3,
                fill: true,
                pointRadius: 2
              }]
            },
            options: {
              plugins: { legend: { display: false } },
              scales: { y: { beginAtZero: true, title: { display: true, text: 'AQI' } } }
            }
          });
        </script>
      </body>
      </html>`;

    res.send(html);
  } catch (error) {
    console.error("Dashboard error:", error.message);
    res.status(500).send('<h2>Failed to load dashboard</h2>');
  }
});

app.listen(process.env.PORT || 5000, () => console.log('Backend mapping server active.'));
