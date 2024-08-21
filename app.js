// Function to fetch ISS data
function fetchIssData() {
  const apiUrl = 'https://api.wheretheiss.at/v1/satellites/25544';

  fetch(apiUrl)
      .then(response => {
          if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
          }
          return response.json();
      })
      .then(data => {
          // Extract the most recent ISS data
          const position = data;

          // Update HTML elements with ISS data
          document.getElementById('lat').innerText = `Latitude: ${position.latitude.toFixed(6)}`;
          document.getElementById('lon').innerText = `Longitude: ${position.longitude.toFixed(6)}`;
          document.getElementById('alt').innerText = `Altitude: ${position.altitude.toFixed(2)} km`; // Altitude is in km
          document.getElementById('velocity').innerText = `Velocity: ${position.velocity.toFixed(2)} km/s`; // Velocity in km/s
          document.getElementById('visibility').innerText = `Visibility: ${position.visibility}`;
          document.getElementById('timestamp').innerText = `Time(IST): ${convertTimestampToIST(position.timestamp)}`;

          // Update the map with the ISS position
          updateMap(position.latitude, position.longitude);

          // Hide loading message
          document.getElementById('map-loading').style.display = 'none';
      })
      .catch(error => {
          console.error('Failed to fetch ISS data:', error);
          document.getElementById('map-loading').innerText = 'Failed to load ISS data.';
      });
}

// Function to convert Unix timestamp to IST
function convertTimestampToIST(timestamp) {
  const date = new Date(timestamp * 1000); // Convert Unix timestamp to milliseconds
  const options = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'Asia/Kolkata',
      hour12: false
  };
  return new Intl.DateTimeFormat('en-GB', options).format(date);
}

// Function to update the map with ISS position
function updateMap(lat, lon) {
  // Remove existing marker
  if (window.marker) {
      window.marker.getSource().clear(); // Clear previous markers
  }

  // Create new marker with ISS icon
  window.marker = new ol.Feature({
      geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat])),
      name: 'ISS'
  });

  const vectorSource = new ol.source.Vector({
      features: [window.marker]
  });

  // Function to calculate icon size based on zoom level
  function getIconScale(zoom) {
      // Larger icon size initially, scales down with zoom level
      return Math.max(0.5, Math.min(zoom / 10, 2.0)); // Example range from 0.5 to 2.0
  }

  const iconStyle = new ol.style.Style({
      image: new ol.style.Icon({
          anchor: [0.5, 0.5],
          anchorXUnits: 'fraction',
          anchorYUnits: 'fraction',
          src: 'iss.png',
          scale: getIconScale(window.map.getView().getZoom()) // Scale based on zoom level
      })
  });

  window.marker.setStyle(iconStyle);

  const vectorLayer = new ol.layer.Vector({
      source: vectorSource
  });

  window.map.addLayer(vectorLayer);

  // Center map on ISS position
  window.map.getView().setCenter(ol.proj.fromLonLat([lon, lat]));
}

// Initialize the map
window.onload = function() {
  window.map = new ol.Map({
      target: 'map',
      layers: [
          new ol.layer.Tile({
              source: new ol.source.OSM()
          })
      ],
      view: new ol.View({
          center: ol.proj.fromLonLat([0, 0]),
          zoom: 2,
          minZoom: 2, // Minimum zoom level
          maxZoom: 12 // Increased maximum zoom level
      })
  });

  // Show loading message initially
  document.getElementById('map-loading').innerText = 'Loading...';

  // Fetch ISS data on load
  fetchIssData();

  // Update ISS position every 3 seconds
  setInterval(fetchIssData, 1000);

  // Update marker size on zoom change
  window.map.getView().on('change:resolution', function() {
      if (window.marker) {
          window.marker.setStyle(new ol.style.Style({
              image: new ol.style.Icon({
                  anchor: [0.5, 0.5],
                  anchorXUnits: 'fraction',
                  anchorYUnits: 'fraction',
                  src: 'iss.png',
                  scale: getIconScale(window.map.getView().getZoom()) // Scale based on zoom level
              })
          }));
      }
  });
};

// Function to calculate icon size based on zoom level
function getIconScale(zoom) {
  // Larger icon size initially, scales down with zoom level
  return Math.max(0.5, Math.min(zoom / 10, 2.0)); // Example range from 0.5 to 2.0
}
