require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
const EventEmitter = require('events');

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

// Station Schema
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

// 1. STANDARD ENDPOINT: Fetches live map data within Metro Manila bounds
app.get('/api/map-aqi', async (req, res) => {
  try {
    const bounds = "14.35,120.85,14.80,121.15";
    const boundsUrl = `https://api.waqi.info/v2/map/bounds/?latlng=${bounds}&token=${process.env.WAQI_TOKEN}`;

    const boundsResponse = await axios.get(boundsUrl, { timeout: 8000 });
    const activeStations = boundsResponse.data?.data || [];

    if (activeStations.length > 0) {
      const mapData = activeStations.map(station => {
        const aqiData = getAqiStatus(station.aqi);

        // Deduplicated Alert Trigger
        if (Number(station.aqi) > 100) {
          const stationName = station.station.name;
          const prevAlert = alertedStations.get(stationName);
          const now = Date.now();

          // Only emit if never alerted, AQI changed, or cooling period expired (10 mins)
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

app.listen(process.env.PORT || 5000, () => console.log('Backend mapping server active.'));