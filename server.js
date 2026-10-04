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

// Tracker to avoid re-emitting alerts for unchanged station readings
const alertedStations = new Map();

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
// triggers hazard alerts, and returns the mapped station list.
async function fetchStations() {
  const bounds = "14.35,120.85,14.80,121.15";
  const boundsUrl = `https://api.waqi.info/v2/map/bounds/?latlng=${bounds}&token=${process.env.WAQI_TOKEN}`;

  const boundsResponse = await axios.get(boundsUrl, { timeout: 8000 });
  const activeStations = boundsResponse.data?.data || [];

  return activeStations.map(station => {
    const aqiData = getAqiStatus(station.aqi);

    // Deduplicated Alert Trigger
    if (Number(station.aqi) > 100) {
      const stationName = station.station.name;
      const prevAlert = alertedStations.get(stationName);
      const now = Date.now();

      if (!prevAlert || prevAlert.aqi !== station.aqi || (now - prevAlert.time > 10 * 60 * 1000)) {
        alertedStations.set(stationName, { aqi: station.aqi, time: now });
        aqiEmitter.emit('unhealthy-air', {
          station: stationName,
          aqi: station.aqi,
          status: aqiData.status
        });
      }
    }

    return {
      uid: station.uid,
      name: station.station.name,
      lat: station.lat,
      lng: station.lon,
      aqi: station.aqi,
      pollutant: 'PM2.5',
      status: aqiData.status,
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

// Runs every 30 minutes, independent of whether anyone is on the site
cron.schedule('*/30 * * * *', logAqiSnapshot);

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
    status: "Unhealthy"
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

// 5. HISTORY ENDPOINT: Returns logged readings for a given day (defaults to today)
// Examples:
//   /api/history                                  -> today, all stations
//   /api/history?date=2026-10-03                  -> a specific day, all stations
//   /api/history?station=EDSA%20Shaw%20Boulevard   -> today, one station
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

app.listen(process.env.PORT || 5000, () => console.log('Backend mapping server active.'));
