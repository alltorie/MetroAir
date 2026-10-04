import { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, useMap, CircleMarker, Popup } from 'react-leaflet';
import axios from 'axios';
import L from 'leaflet';

// Restricts map bounds strictly to Metro Manila
const MetroManilaBounds = () => {
  const map = useMap();
  const bounds = L.latLngBounds([14.35, 120.85], [14.80, 121.15]);
  map.setMaxBounds(bounds);
  map.options.minZoom = 11;
  return null;
};

export default function App() {
  const [mapData, setMapData] = useState([]);
  const [alertQueue, setAlertQueue] = useState([]);
  const [currentAlert, setCurrentAlert] = useState(null);
  const [activeStation, setActiveStation] = useState(null);

  // New states for User Health Profiling & Location Tracking
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [isVulnerable, setIsVulnerable] = useState(false);
  const [userLoc, setUserLoc] = useState(null);

  // --- NEW: Tracks if the user is on a mobile screen ---
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  
  const recentAlertsRef = useRef(new Map());
  const currentAlertRef = useRef(null);
  const warnedProximityStationsRef = useRef(new Set()); // Tracks nearby hazard alerts

  useEffect(() => {
    currentAlertRef.current = currentAlert;
  }, [currentAlert]);

  // 1. Fetch Map Data and Connect SSE
  useEffect(() => {
    const fetchAqiData = () => {
      axios.get(`${API_URL}/api/map-aqi`);
        .then(res => {
          if (Array.isArray(res.data)) setMapData(res.data);
        })
        .catch(err => console.error("Error fetching map AQI:", err));
    };

    fetchAqiData();
    const intervalId = setInterval(fetchAqiData, 300000);

    const eventSource = new EventSource(`${API_URL}/api/map-aqi`);
    eventSource.onmessage = (event) => {
      const newAlert = JSON.parse(event.data);
      const now = Date.now();
      const lastSeen = recentAlertsRef.current.get(newAlert.station);

      if (newAlert.station && !newAlert.station.includes("Simulated")) {
        if (lastSeen && now - lastSeen < 45000) return;
        recentAlertsRef.current.set(newAlert.station, now);
      }

      setAlertQueue(prev => {
        if (currentAlertRef.current && currentAlertRef.current.station === newAlert.station) return prev;
        if (prev.some(item => item.station === newAlert.station)) return prev;
        return [...prev, newAlert];
      });
    };

    return () => {
      clearInterval(intervalId);
      eventSource.close();
    };
  }, []);

  // 2. Geolocation Tracker (Only runs if user is vulnerable)
  useEffect(() => {
    if (!isVulnerable) return;

    if (!navigator.geolocation) {
      console.error("Geolocation is not supported by your browser");
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setUserLoc({ lat: position.coords.latitude, lng: position.coords.longitude });
      },
      (err) => console.error("Location tracking error:", err),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 5000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [isVulnerable]);

  // 3. Proximity Safety Check (Runs when user moves or map updates)
  useEffect(() => {
    if (!userLoc || mapData.length === 0 || !isVulnerable) return;

    const thresholdMeters = 3000; // 3km danger radius

    mapData.forEach(station => {
      const numAqi = Number(station.aqi);
      if (!isNaN(numAqi) && numAqi > 100) {
        // Calculate distance between user and hazardous station
        const distance = L.latLng(userLoc.lat, userLoc.lng).distanceTo(L.latLng(station.lat, station.lng));

        if (distance <= thresholdMeters) {
          if (!warnedProximityStationsRef.current.has(station.uid)) {
            warnedProximityStationsRef.current.add(station.uid);
            
            // Push proximity warning to the banner queue
            setAlertQueue(prev => [...prev, {
              station: `PROXIMITY HAZARD: ${station.name}`,
              aqi: station.aqi,
              status: `You are within ${(distance / 1000).toFixed(1)}km of this area. Please limit exposure.`
            }]);

            // Attempt to trigger native OS notification
            if (Notification.permission === "granted") {
              new Notification("Air Quality Proximity Alert", {
                body: `You are nearing ${station.name} (AQI: ${station.aqi}). Advising against prolonged outdoor exertion.`
              });
            }
          }
        } else {
          // If they leave the radius, remove from warned set so it can trigger again if they return
          warnedProximityStationsRef.current.delete(station.uid);
        }
      }
    });
  }, [userLoc, mapData, isVulnerable]);

  // Alert Queue Consumers
  useEffect(() => {
    if (!currentAlert && alertQueue.length > 0) {
      setCurrentAlert(alertQueue[0]);
      setAlertQueue(prev => prev.slice(1));
    }
  }, [currentAlert, alertQueue]);

  useEffect(() => {
    if (!currentAlert) return;
    const timer = setTimeout(() => setCurrentAlert(null), 4500);
    return () => clearTimeout(timer);
  }, [currentAlert]);

  const triggerSimulation = () => axios.post('http://localhost:5000/api/simulate-alert');

  // --- NEW: Simulates walking into a hazardous zone ---
  const triggerWalkSimulation = () => {
    // 1. Force the app to treat the user as vulnerable so the proximity hook runs
    setIsVulnerable(true);
    setShowOnboarding(false);

    if (mapData.length > 0) {
      // 2. Find the station with the highest AQI to target
      const sorted = [...mapData].sort((a, b) => Number(b.aqi) - Number(a.aqi));
      const target = sorted[0];

      // 3. If no station is currently hazardous, artificially spike the top station to 155
      if (Number(target.aqi) <= 100) {
        setMapData(prev => prev.map(s => 
          s.uid === target.uid ? { ...s, aqi: 155, color: '#ff0000' } : s
        ));
      }

      // 4. Teleport the user 1km away from the target station (0.009 lat offset is ~1km)
      // This places them well inside the 3km danger radius.
      setUserLoc({
        lat: target.lat + 0.009,
        lng: target.lng
      });
    }
  };

  const handleHealthResponse = (isAsthmatic) => {
    if (isAsthmatic && Notification.permission !== "granted") {
      Notification.requestPermission();
    }
    setIsVulnerable(isAsthmatic);
    setShowOnboarding(false);
  };

  const createWaqiIcon = (aqi, color) => {
    const numAqi = Number(aqi);
    const textColor = (color === '#cccc00' || color === '#ffde33') ? 'black' : 'white';
    const displayAqi = aqi === undefined || isNaN(numAqi) ? '-' : aqi;
    const isHazard = !isNaN(numAqi) && numAqi > 100;

    return L.divIcon({
      className: 'waqi-icon-wrapper',
      html: `<div class="${isHazard ? 'hazard-blink' : ''}" style="
        background-color: ${color}; color: ${textColor}; font-weight: 900; 
        font-size: 14px; border: 2px solid white; border-radius: 6px; 
        padding: 4px 8px; box-shadow: 0 3px 6px rgba(0,0,0,0.4); 
        text-align: center; min-width: 25px;
      ">${displayAqi}</div>`,
      iconSize: [45, 30],
      iconAnchor: [22, 15]
    });
  };

  // Sleek, pill-style badge for the Quezon City LGU portal marker
  const qcPortalIcon = L.divIcon({
    className: 'waqi-icon-wrapper',
    html: `<div style="
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: #0f172a;
      color: #38bdf8;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 11.5px;
      font-weight: 700;
      letter-spacing: 0.3px;
      padding: 5px 12px;
      border-radius: 20px;
      border: 2px solid #38bdf8;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.45);
      white-space: nowrap;
      cursor: pointer;
      box-sizing: border-box;
    ">
      <span style="font-size: 13px; line-height: 1;">🏛️</span>
      <span style="line-height: 1;">QC Portal</span>
    </div>`,
    iconSize: [115, 32],
    iconAnchor: [57, 16]
  });

  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      
      {/* Onboarding Health Modal */}
      {showOnboarding && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, 
          backgroundColor: 'rgba(15, 23, 42, 0.85)', zIndex: 9999, 
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          padding: '20px'
        }}>
          <div style={{
            background: 'white', padding: isMobile ? '30px 20px' : '40px 30px', borderRadius: '16px', 
            width: '100%', maxWidth: '450px', textAlign: 'center', boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
            boxSizing: 'border-box'
          }}>
            <h2 style={{ margin: '0 0 15px 0', color: '#0f172a', fontSize: isMobile ? '1.5rem' : '1.8rem' }}>Welcome to MetroAir</h2>
            <p style={{ fontSize: isMobile ? '0.95rem' : '1.05rem', color: '#475569', lineHeight: '1.6', margin: '0 0 30px 0' }}>
              To personalize your experience, please let us know: Do you currently have a respiratory condition such as asthma?
            </p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexDirection: isMobile ? 'column' : 'row' }}>
              <button 
                onClick={() => handleHealthResponse(true)}
                style={{ background: '#3b82f6', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1rem', flex: 1 }}
              >
                Yes, I do
              </button>
              <button 
                onClick={() => handleHealthResponse(false)}
                style={{ background: '#e2e8f0', color: '#475569', border: 'none', padding: '12px 24px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '1rem', flex: 1 }}
              >
                No, I don't
              </button>
            </div>
            <small style={{ display: 'block', marginTop: '20px', color: '#94a3b8', fontSize: '0.75rem' }}>
              If yes, we will request location permissions to alert you when entering unhealthy air zones.
            </small>
          </div>
        </div>
      )}

      {/* Navigation Header */}
      <header style={{ 
        backgroundColor: '#0f172a', color: 'white', padding: isMobile ? '12px 15px' : '15px 25px', 
        display: 'flex', flexDirection: isMobile ? 'column' : 'row', justifyContent: 'space-between', alignItems: isMobile ? 'flex-start' : 'center',
        gap: isMobile ? '12px' : '0', boxShadow: '0 4px 6px rgba(0,0,0,0.3)', zIndex: 2000
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ backgroundColor: '#3b82f6', color: 'white', padding: '5px 10px', borderRadius: '4px', fontWeight: 'bold', fontSize: isMobile ? '0.85rem' : '1rem' }}>AQI</div>
          <h2 style={{ margin: 0, fontSize: isMobile ? '1.2rem' : '1.4rem' }}>Real-Time Air Quality</h2>
        </div>
        
        <div style={{ display: 'flex', gap: '10px', width: isMobile ? '100%' : 'auto' }}>
          <button onClick={triggerWalkSimulation} style={{ flex: isMobile ? 1 : 'none', backgroundColor: '#f59e0b', color: 'white', border: 'none', padding: '8px 12px', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: isMobile ? '0.9rem' : '1rem' }}>
            🚶 Walk
          </button>
          <button onClick={triggerSimulation} style={{ flex: isMobile ? 1 : 'none', backgroundColor: '#ef4444', color: 'white', border: 'none', padding: '8px 12px', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: isMobile ? '0.9rem' : '1rem' }}>
            🚨 Spike
          </button>
        </div>
      </header>
      
      {/* Alert Banner Container */}
      {currentAlert && (
        <div style={{
          position: 'absolute', top: isMobile ? '105px' : '75px', left: '50%', transform: 'translateX(-50%)', 
          zIndex: 3000, animation: 'fadeInDown 0.3s ease-out', width: isMobile ? '92%' : 'auto'
        }}>
          <div style={{
            backgroundColor: '#ff4a4a', color: 'white', padding: isMobile ? '10px 15px' : '12px 24px', borderRadius: '8px', 
            boxShadow: '0 8px 20px rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', gap: '10px', minWidth: isMobile ? '100%' : '340px', boxSizing: 'border-box'
          }}>
            <span style={{ fontSize: isMobile ? '1.2rem' : '1.4rem' }}>⚠️</span>
            <div style={{ flex: 1 }}>
              <strong style={{ display: 'block', fontSize: isMobile ? '0.9rem' : '1rem' }}>Health Advisory</strong>
              <span style={{ fontSize: isMobile ? '0.8rem' : '0.9rem', display: 'block', lineHeight: 1.2 }}>
                {currentAlert.station} AQI: {currentAlert.aqi}. {currentAlert.status}
              </span>
            </div>
            {alertQueue.length > 0 && (
              <span style={{ backgroundColor: 'rgba(0, 0, 0, 0.25)', padding: '3px 8px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                +{alertQueue.length} more
              </span>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, position: 'relative' }}>
        
        {/* Map Viewport */}
        <MapContainer center={[14.5995, 121.0500]} zoom={11} style={{ flex: 1, zIndex: 1 }}>
          <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}" attribution="Tiles &copy; Esri" />
          <MetroManilaBounds />
          
          {userLoc && (
            <CircleMarker center={[userLoc.lat, userLoc.lng]} radius={8} pathOptions={{ color: 'white', weight: 2, fillOpacity: 1, fillColor: '#3b82f6' }}>
              <Popup>Your current location</Popup>
            </CircleMarker>
          )}

          <Marker
            position={[14.6488, 121.0509]}
            icon={qcPortalIcon}
            eventHandlers={{
              click: () => setActiveStation({ isQcPortal: true, name: "Quezon City LGU Air Quality Portal", url: "https://quezoncity.gov.ph/air-quality-index/" })
            }}
          />

          {mapData.map((station, index) => (
            <Marker key={index} position={[station.lat, station.lng]} icon={createWaqiIcon(station.aqi, station.color)}
              eventHandlers={{
                click: () => {
                  setActiveStation({ ...station, waqiTime: "Fetching..." });
                  if (station.uid) {
                    axios.get(`http://localhost:5000/api/station/${station.uid}`)
                      .then(res => {
                        const timeObj = res.data?.time;
                        const sensorTime = timeObj?.iso || (timeObj?.s ? timeObj.s.replace(' ', 'T') : null);
                        setActiveStation(prev => (prev && prev.uid === station.uid ? {
                          ...prev, waqiTime: sensorTime || "Recently", pollutant: res.data?.dominentpol ? res.data.dominentpol.toUpperCase() : prev.pollutant
                        } : prev));
                      }).catch(() => setActiveStation(prev => (prev ? { ...prev, waqiTime: "Recently" } : prev)));
                  }
                }
              }}
            />
          ))}
        </MapContainer>

        {/* Station Detail Side Panel (Transforms to a Bottom Sheet on Mobile) */}
        {activeStation && (
          activeStation.isQcPortal ? (
            /* QC SPECIFIC SIDEBAR */
            <div style={{
              position: 'absolute', top: isMobile ? 'auto' : '20px', bottom: isMobile ? '0' : 'auto', right: isMobile ? '0' : '20px', left: isMobile ? '0' : 'auto',
              width: isMobile ? '100%' : '340px', backgroundColor: 'white', borderRadius: isMobile ? '20px 20px 0 0' : '8px', 
              boxShadow: isMobile ? '0 -10px 25px rgba(0,0,0,0.2)' : '0 10px 25px rgba(0,0,0,0.25)', zIndex: 2000, overflow: 'hidden'
            }}>
              <div style={{ backgroundColor: '#0f172a', padding: '18px 20px', color: 'white', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '3px solid #38bdf8' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '1.4rem' }}>🏛️</span>
                  <strong style={{ fontSize: '1.1rem' }}>QC Government Feed</strong>
                </div>
                <button onClick={() => setActiveStation(null)} style={{ background: 'transparent', border: 'none', color: 'white', fontSize: '1.4rem', cursor: 'pointer' }}>✖</button>
              </div>
              <div style={{ padding: '20px', maxHeight: isMobile ? '50vh' : 'auto', overflowY: 'auto' }}>
                <h3 style={{ margin: '0 0 10px 0', color: '#1e293b' }}>{activeStation.name}</h3>
                <p style={{ fontSize: '0.9rem', color: '#64748b', lineHeight: '1.5', margin: '0 0 15px 0' }}>
                  Quezon City publishes official 24-hour PM2.5 bulletins across its 6 legislative districts.
                </p>
                <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '12px', marginBottom: '15px' }}>
                  <span style={{ fontSize: '0.8rem', color: '#64748b', display: 'block', marginBottom: '4px' }}>Official Source Link:</span>
                  <a href={activeStation.url} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', fontSize: '0.85rem', wordBreak: 'break-all', fontWeight: 'bold', textDecoration: 'underline' }}>
                    {activeStation.url}
                  </a>
                </div>
                <a href={activeStation.url} target="_blank" rel="noopener noreferrer" style={{ display: 'block', textAlign: 'center', backgroundColor: '#2563eb', color: 'white', padding: '10px 14px', borderRadius: '6px', fontWeight: 'bold', textDecoration: 'none', fontSize: '0.9rem' }}>
                  Visit Official QC Portal ↗
                </a>
              </div>
            </div>
          ) : (
            /* REGULAR METRO MANILA STATIONS */
            <div style={{
              position: 'absolute', top: isMobile ? 'auto' : '20px', bottom: isMobile ? '0' : 'auto', right: isMobile ? '0' : '20px', left: isMobile ? '0' : 'auto',
              width: isMobile ? '100%' : '320px', backgroundColor: 'white', borderRadius: isMobile ? '20px 20px 0 0' : '8px', 
              boxShadow: isMobile ? '0 -10px 25px rgba(0,0,0,0.2)' : '0 10px 25px rgba(0,0,0,0.2)', zIndex: 2000, overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: isMobile ? '60vh' : 'auto'
            }}>
              <div style={{ backgroundColor: activeStation.color, padding: '20px', color: (activeStation.color === '#cccc00' || activeStation.color === '#ffde33') ? 'black' : 'white', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h1 style={{ margin: 0, fontSize: '3rem', fontWeight: '900' }}>{activeStation.aqi}</h1>
                  <p style={{ margin: '5px 0 0 0', fontWeight: 'bold', fontSize: '1.2rem' }}>{activeStation.status}</p>
                </div>
                <button onClick={() => setActiveStation(null)} style={{ background: 'transparent', border: 'none', color: 'inherit', fontSize: '1.5rem', cursor: 'pointer' }}>✖</button>
              </div>
              <div style={{ padding: '20px', overflowY: 'auto' }}>
                <h3 style={{ margin: '0 0 15px 0', color: '#333' }}>{activeStation.name}</h3>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #eee', paddingBottom: '10px', marginBottom: '10px' }}>
                  <span style={{ color: '#666' }}>Primary Pollutant</span>
                  <strong style={{ color: '#333' }}>{activeStation.pollutant}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #eee', paddingBottom: '10px' }}>
                  <span style={{ color: '#666' }}>Last Updated</span>
                  <strong style={{ color: '#333' }}>
                    {activeStation.waqiTime === "Fetching..." ? "Fetching..." : activeStation.waqiTime && activeStation.waqiTime !== "Recently" ? (() => {
                      const d = new Date(activeStation.waqiTime); return isNaN(d.getTime()) ? activeStation.waqiTime : `${d.toLocaleDateString('en-US', { weekday: 'long' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
                    })() : "Recently"}
                  </strong>
                </div>
                <p style={{ fontSize: '0.85rem', color: '#666', marginTop: '15px', lineHeight: '1.4', fontStyle: 'italic' }}>
                  *Health recommendations: {getHealthRecommendation(activeStation.color, activeStation.aqi)}
                </p>
              </div>
            </div>
          )
        )}

        {/* Floating 6-Tier AQI Legend (Hidden on small screens to save map space) */}
        {!isMobile && (
          <div style={{ position: 'absolute', bottom: '30px', left: '30px', zIndex: 1000, backgroundColor: 'rgba(255,255,255,0.95)', padding: '15px', borderRadius: '8px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
            <h4 style={{ margin: '0 0 10px 0', color: '#333' }}>US AQI Scale</h4>
            {[
              { range: '0 - 50', label: 'Good', color: '#00e400' },
              { range: '51 - 100', label: 'Moderate', color: '#ffde33' },
              { range: '101 - 150', label: 'Unhealthy for Sensitive Groups', color: '#ff7e00' },
              { range: '151 - 200', label: 'Unhealthy', color: '#ff0000' },
              { range: '201 - 300', label: 'Very Unhealthy', color: '#800080' },
              { range: '300+', label: 'Hazardous', color: '#7e0023' }
            ].map((tier, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px', fontSize: '0.9rem' }}>
                <div style={{ width: '85px', textAlign: 'center', backgroundColor: tier.color, color: tier.color === '#ffde33' ? 'black' : 'white', padding: '4px 6px', borderRadius: '4px', fontWeight: 'bold' }}>{tier.range}</div>
                <span style={{ color: '#444' }}>{tier.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

